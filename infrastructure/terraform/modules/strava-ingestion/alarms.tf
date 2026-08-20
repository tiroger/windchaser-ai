# A dead letter queue nobody looks at is just a slower way to lose data.

resource "aws_cloudwatch_metric_alarm" "dead_letter_depth" {
  alarm_name        = "${local.name}-dlq-not-empty"
  alarm_description = "Strava webhook events are failing processing and accumulating."

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

  alarm_actions = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
  ok_actions    = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
}

# Events sitting unprocessed matter as much as events failing. If the oldest
# message is hours old, nothing is draining the queue at all.
resource "aws_cloudwatch_metric_alarm" "events_stale" {
  alarm_name        = "${local.name}-not-draining"
  alarm_description = "Strava webhook events are queued but not being processed."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateAgeOfOldestMessage"
  dimensions  = { QueueName = aws_sqs_queue.events.name }

  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
  ok_actions    = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
}
