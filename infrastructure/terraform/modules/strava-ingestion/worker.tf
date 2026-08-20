# The worker that turns queued events into calibration.
#
# One function, two triggers. Both paths read the effort history from S3, change
# it, and write it back, so two functions could interleave those steps and lose
# whichever write landed first. A single function pinned to one concurrent
# execution cannot: every invocation, from either trigger, is serialised against
# every other. See services/strava_worker/handler.main.

locals {
  worker_name = "windchaser-${var.environment}-strava-worker"

  # Both source trees, zipped by Terraform rather than by a build step. The
  # package is pure Python against the standard library and the boto3 the
  # runtime already provides, so there is nothing to compile and nothing to
  # install -- and no way for the artefact to differ from the source that was
  # reviewed. It also means `terraform plan` works from a clean checkout.
  worker_sources = {
    for f in fileset("${var.source_root}/services/strava_worker", "**/*.py") :
    "strava_worker/${f}" => "${var.source_root}/services/strava_worker/${f}"
  }
  analytics_sources = {
    for f in fileset("${var.source_root}/packages/cycling-analytics/cycling_analytics", "**/*.py") :
    "cycling_analytics/${f}" => "${var.source_root}/packages/cycling-analytics/cycling_analytics/${f}"
  }
}

data "archive_file" "worker" {
  type        = "zip"
  output_path = "${path.module}/.terraform-build/strava-worker.zip"

  dynamic "source" {
    for_each = merge(local.worker_sources, local.analytics_sources)

    content {
      content  = file(source.value)
      filename = source.key
    }
  }
}

resource "aws_iam_role" "worker" {
  name               = local.worker_name
  assume_role_policy = data.aws_iam_policy_document.worker_assume.json
}

data "aws_iam_policy_document" "worker_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.worker.arn}:*"]
  }

  statement {
    sid    = "ConsumeEvents"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.events.arn]
  }

  statement {
    sid    = "ReadAndWriteAppData"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${var.app_data_bucket_arn}/*"]
  }

  # Write as well as read. Strava may hand back a new refresh token, and when it
  # does the old one stops working. Nothing else in the system records that, so
  # an unrecorded rotation would take the worker and the web application down
  # together some days later with nothing to point at the cause.
  statement {
    sid    = "ReadAndRotateStravaSecret"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
    ]
    resources = [var.strava_secret_arn]
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.worker_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "worker" {
  function_name = local.worker_name
  role          = aws_iam_role.worker.arn
  handler       = "strava_worker.handler.main"
  runtime       = "python3.12"

  filename         = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256

  # The queue's visibility timeout is derived from this; see the variable.
  timeout = var.worker_timeout_seconds

  # Sized for processor, not memory. Lambda allocates CPU in proportion to
  # memory, and a full core arrives around 1.8 GB. Rebuilding the calibration is
  # arithmetic -- bisection for speed on every section of every effort, then a
  # search over rider constants -- and at 512 MB it took 247 seconds of a 300
  # second budget while using 100 MB. That is a timeout waiting for the first
  # run that also has reanalysis to fetch. More memory costs no more here,
  # because the bill is memory multiplied by duration and the duration falls by
  # about as much as the memory rises.
  memory_size = 2048

  # Load-bearing, not tuning. See the comment at the top of this file.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      STRAVA_SECRET_ARN  = var.strava_secret_arn
      APP_DATA_BUCKET    = var.app_data_bucket
      EFFORTS_S3_KEY     = var.efforts_s3_key
      CALIBRATION_S3_KEY = var.calibration_s3_key
      BUNDLE_S3_KEY      = var.bundle_s3_key
    }
  }

  depends_on = [
    aws_iam_role_policy.worker,
    aws_cloudwatch_log_group.worker,
  ]
}

resource "aws_lambda_event_source_mapping" "events" {
  event_source_arn = aws_sqs_queue.events.arn
  function_name    = aws_lambda_function.worker.arn

  # One message per invocation. A batch shares a fate: one activity Strava
  # refuses to serve would send its whole batch back to the queue and have the
  # rest reprocessed, and with a rider whose daily read quota is already tight
  # that turns one failure into several wasted calls.
  batch_size = 1

  # Whatever the queue has, without waiting to fill a batch. Rides arrive a few
  # times a week, not a few times a second.
  maximum_batching_window_in_seconds = 0
}

# Reanalysis weather trails real time by about a week, so ingestion cannot
# finish the job. This is the pass that attaches weather once the archive has
# caught up and rebuilds what the application reads.
resource "aws_cloudwatch_event_rule" "refresh" {
  name                = "${local.worker_name}-refresh"
  description         = "Attach reanalysis weather to recorded efforts and rebuild calibration."
  schedule_expression = var.refresh_schedule
}

resource "aws_cloudwatch_event_target" "refresh" {
  rule      = aws_cloudwatch_event_rule.refresh.name
  target_id = "worker"
  arn       = aws_lambda_function.worker.arn
}

resource "aws_lambda_permission" "refresh" {
  statement_id  = "AllowScheduledRefresh"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.refresh.arn
}

# A worker failing repeatedly is how rides stop being analysed while everything
# else looks healthy, so this is worth an alarm of its own rather than leaving
# it to the dead letter queue depth to notice several retries later.
resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${local.worker_name}-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = 3
  period              = 3600
  statistic           = "Sum"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }

  alarm_description = join(" ", [
    "The Strava worker has failed repeatedly within an hour.",
    "Rides are not being turned into calibration; the application keeps",
    "serving the last good calibration meanwhile.",
  ])

  alarm_actions = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
  ok_actions    = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
}
