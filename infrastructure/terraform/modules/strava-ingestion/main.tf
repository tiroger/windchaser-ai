# Strava webhook ingestion.
#
# Strava requires the callback to answer within a couple of seconds and retries
# on failure, so the endpoint validates, enqueues, and returns. Everything that
# might be slow -- fetching the activity, matching efforts, comparing against
# the prediction -- happens off this queue. That is the shape section 5 of the
# project plan asks for, and it is also the only way to stay inside the window
# when Strava's own API is the thing being slow.

locals {
  name = "windchaser-${var.environment}-strava-events"
}

# Failures land here rather than being retried forever or lost silently. Its
# depth is the alarm worth watching: a non-empty dead letter queue means rides
# are not being analysed.
resource "aws_sqs_queue" "dead_letter" {
  name                      = "${local.name}-dlq"
  message_retention_seconds = var.raw_event_retention_days * 24 * 60 * 60
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "events" {
  name                      = local.name
  message_retention_seconds = var.raw_event_retention_days * 24 * 60 * 60
  sqs_managed_sse_enabled   = true

  # Long enough for a worker to fetch an activity and its efforts from Strava,
  # including a rate-limit backoff, before the message becomes visible again.
  visibility_timeout_seconds = 180

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# Only the web runtime may enqueue. Strava talks to the endpoint, never to SQS.
data "aws_iam_policy_document" "enqueue" {
  statement {
    sid    = "EnqueueWebhookEvents"
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:GetQueueUrl",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.events.arn]
  }
}

resource "aws_iam_policy" "enqueue" {
  name        = "windchaser-${var.environment}-enqueue-strava-events"
  description = "Enqueue Strava webhook events for asynchronous processing."
  policy      = data.aws_iam_policy_document.enqueue.json
}

resource "aws_iam_role_policy_attachment" "enqueue" {
  role       = var.consumer_role_name
  policy_arn = aws_iam_policy.enqueue.arn
}
