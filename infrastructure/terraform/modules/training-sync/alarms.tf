# The same three signals strava-ingestion watches, to the same topic.

# A dead letter queue nobody looks at is just a slower way to lose data.
resource "aws_cloudwatch_metric_alarm" "dead_letter_depth" {
  alarm_name        = "${local.name}-dlq-not-empty"
  alarm_description = "Training sync events failed processing repeatedly and need inspection."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions  = { QueueName = aws_sqs_queue.dead_letter.name }

  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  # Missing data is the normal state for a queue nothing has failed into.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# A failing FIFO message blocks every event behind it while it is retried, so
# an old head of queue matters as much as a failure does.
resource "aws_cloudwatch_metric_alarm" "events_stale" {
  alarm_name        = "${local.name}-not-draining"
  alarm_description = "Training sync events are queued but not being processed."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateAgeOfOldestMessage"
  dimensions  = { QueueName = aws_sqs_queue.events.name }

  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# Strava 429s on a webhook event are retried and usually succeed on the next
# delivery, so a single error is not worth a page; three in an hour is the
# threshold strava-ingestion uses for the same reason.
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
    "The Training sync worker has failed repeatedly within an hour.",
    "New rides are not reaching the Training section; the wind view and",
    "strava_worker are unaffected.",
  ])

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}
