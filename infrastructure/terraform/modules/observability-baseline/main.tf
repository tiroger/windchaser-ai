# Cost and observability guardrails.
#
# Deliberately the first slice. The account already carries unrelated projects,
# so every control here is filtered to this application's own tag rather than
# measuring the whole account, and log retention is set before anything starts
# writing logs rather than after the bill explains why it should have been.

locals {
  name = "windchaser-${var.environment}"
}

# ------------------------------------------------------------ alerting --

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

# Budgets publishes through SNS rather than assuming a role, so the topic has
# to allow it explicitly.
data "aws_iam_policy_document" "alerts" {
  statement {
    sid       = "AllowBudgetsAndCostExplorer"
    effect    = "Allow"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type = "Service"
      identifiers = [
        "budgets.amazonaws.com",
        "costalerts.amazonaws.com",
      ]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alert_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# -------------------------------------------------------------- budget --

# AWS refuses to activate a cost allocation tag it has not yet observed in
# billing data, which lags roughly a day behind the first tagged spend. So this
# cannot be switched on in the same breath as creating the first tagged
# resource; it is enabled on a later apply, once the tag exists to be found.
resource "aws_ce_cost_allocation_tag" "application" {
  count = var.activate_cost_allocation_tag ? 1 : 0

  tag_key = "Application"
  status  = "Active"
}

resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Scope to this project's tag. Without this the budget would measure the
  # unrelated work already running in the account and alert on someone else's
  # spend, which trains you to ignore it.
  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:Application$%s", var.application)]
  }

  # Warn on the way up, not once it is too late.
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 50
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 90
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  # Forecast catches a runaway early in the month, when it is still cheap.
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  depends_on = [aws_sns_topic_policy.alerts]
}

# ------------------------------------------------------------- anomaly --

# A budget catches "too much in total". An anomaly monitor catches "this one
# service suddenly costs ten times what it did yesterday", which is the shape a
# runaway Bedrock or SMS loop actually takes.
resource "aws_ce_anomaly_monitor" "application" {
  name         = "${local.name}-anomaly"
  monitor_type = "CUSTOM"

  # AWS stores user-defined tag keys with a "user:" prefix and returns them
  # that way. Declaring the bare key makes every subsequent plan want to
  # replace the monitor, which would also discard its detection history.
  # Two things make this stable across plans. AWS stores user-defined tag keys
  # with a "user:" prefix and returns them that way, and it returns the unused
  # sibling expressions as explicit nulls. Omitting either makes every
  # subsequent plan want to replace the monitor and discard its history.
  monitor_specification = jsonencode({
    And            = null
    CostCategories = null
    Dimensions     = null
    Not            = null
    Or             = null
    Tags = {
      Key          = "user:Application"
      Values       = [var.application]
      MatchOptions = ["EQUALS"]
    }
  })
}

resource "aws_ce_anomaly_subscription" "application" {
  name = "${local.name}-anomaly-alerts"

  # SNS subscribers are only accepted at IMMEDIATE frequency; DAILY and WEEKLY
  # support email subscribers only. Immediate is what you want anyway for a
  # runaway spend loop, where a day's delay is the whole problem.
  frequency = "IMMEDIATE"

  monitor_arn_list = [aws_ce_anomaly_monitor.application.arn]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.alerts.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = [tostring(var.anomaly_threshold_usd)]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }

  depends_on = [aws_sns_topic_policy.alerts]
}
