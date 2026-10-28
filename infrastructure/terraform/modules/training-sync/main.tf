# The Training section's Strava sync (ADR-0004).
#
# A second consumer of the same Strava events, beside strava-ingestion rather
# than inside it. The two workers want opposite serialisation: strava_worker is
# pinned to one concurrent execution because its scheduled rebuild and its
# ingestion share one object, while this worker's writes are serialised by a
# FIFO message group, which hands out one message at a time without capping
# Lambda. A reserved concurrency of one here would throttle a long first sync's
# queue-mates into the dead letter queue. They also write disjoint S3 keys, so
# neither can overwrite the other; docs/architecture/TRAINING_INTEGRATION.md
# lists which keys belong to which.
#
# The webhook endpoint forwards each of the rider's activity events here as the
# raw Strava body. Reconciliation and the streams backfill enter through the
# same queue and the same message group, so no producer can interleave with
# another's read-modify-write of activities.json.

locals {
  name        = "windchaser-${var.environment}-training-events"
  worker_name = "windchaser-${var.environment}-training-sync"

  alarm_actions = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
}

resource "aws_sqs_queue" "dead_letter" {
  name                      = "${local.name}-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = var.event_retention_days * 24 * 60 * 60
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "events" {
  name       = "${local.name}.fifo"
  fifo_queue = true

  # Strava retries a webhook it thinks failed, and the endpoint returns 500
  # whenever forwarding here fails, so the same body can arrive twice within
  # seconds. Deduplicating on content absorbs that without any producer having
  # to invent an idempotency key. Duplicates beyond the five-minute window are
  # harmless anyway: the worker re-reads the activity from Strava.
  content_based_deduplication = true

  message_retention_seconds = var.event_retention_days * 24 * 60 * 60
  sqs_managed_sse_enabled   = true

  # Derived from the worker's timeout: Lambda refuses an event source whose
  # queue could hand a message out again while the function is still running.
  # Six times over is AWS's guidance. In a FIFO queue a failing message also
  # blocks its whole group for this long per attempt, which is why the stale
  # alarm below matters as much as the dead letter one.
  visibility_timeout_seconds = var.worker_timeout_seconds * 6

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# Only the web runtime enqueues: Strava talks to the endpoint, never to SQS.
data "aws_iam_policy_document" "enqueue" {
  statement {
    sid       = "ForwardTrainingEvents"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.events.arn]
  }
}

resource "aws_iam_policy" "enqueue" {
  name        = "windchaser-${var.environment}-enqueue-training-events"
  description = "Forward the rider's Strava activity events to the Training sync."
  policy      = data.aws_iam_policy_document.enqueue.json
}

resource "aws_iam_role_policy_attachment" "enqueue" {
  role       = var.consumer_role_name
  policy_arn = aws_iam_policy.enqueue.arn
}

# The schedules deliver through the queue rather than invoking the function, so
# that they take their turn in the message group like any webhook event.
data "aws_iam_policy_document" "scheduled_enqueue" {
  statement {
    sid       = "AllowTrainingSchedules"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.events.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = [
        aws_cloudwatch_event_rule.reconciliation.arn,
        aws_cloudwatch_event_rule.streams_backfill.arn,
      ]
    }
  }
}

resource "aws_sqs_queue_policy" "events" {
  queue_url = aws_sqs_queue.events.url
  policy    = data.aws_iam_policy_document.scheduled_enqueue.json
}

# The safety net for events Strava never delivered. Also refreshes gear
# distances and saved routes, which no webhook announces.
resource "aws_cloudwatch_event_rule" "reconciliation" {
  name                = "${local.worker_name}-reconciliation"
  description         = "Reconcile recent Strava activities, gear and saved routes for Training."
  schedule_expression = var.reconciliation_schedule
  state               = var.schedules_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "reconciliation" {
  rule      = aws_cloudwatch_event_rule.reconciliation.name
  target_id = "training-events-queue"
  arn       = aws_sqs_queue.events.arn
  input     = jsonencode({ source = "scheduled-reconciliation" })

  sqs_target {
    message_group_id = var.message_group_id
  }

  depends_on = [aws_sqs_queue_policy.events]
}

# Detailed streams cost one Strava read per activity, so history fills in a
# batch at a time. The batch is smaller than my-strava's 50 because the read
# allowance is now shared with strava_worker, and the worker stops early anyway
# once the day's usage passes 80%.
resource "aws_cloudwatch_event_rule" "streams_backfill" {
  name                = "${local.worker_name}-streams-backfill"
  description         = "Fetch detailed streams for Training activities that lack them."
  schedule_expression = var.streams_backfill_schedule
  state               = var.schedules_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "streams_backfill" {
  rule      = aws_cloudwatch_event_rule.streams_backfill.name
  target_id = "training-events-queue"
  arn       = aws_sqs_queue.events.arn
  input     = jsonencode({ source = "streams-backfill" })

  sqs_target {
    message_group_id = var.message_group_id
  }

  depends_on = [aws_sqs_queue_policy.events]
}
