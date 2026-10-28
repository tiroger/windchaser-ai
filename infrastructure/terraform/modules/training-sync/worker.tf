# The worker applying Training events. See services/training_sync/handler.py.

locals {
  # Zipped by Terraform rather than a build step, as strava-ingestion is: the
  # worker is pure Python against the standard library and the boto3 the
  # runtime provides, so the artefact cannot differ from the reviewed source.
  # Only its own package -- it shares no code with strava_worker, and leaving
  # the other package out means a change there does not redeploy this.
  worker_sources = {
    for f in fileset("${var.source_root}/services/training_sync", "**/*.py") :
    "training_sync/${f}" => "${var.source_root}/services/training_sync/${f}"
  }

  data_object = "${var.app_data_bucket_arn}/%s"
}

data "archive_file" "worker" {
  type        = "zip"
  output_path = "${path.module}/.terraform-build/training-sync.zip"

  dynamic "source" {
    for_each = local.worker_sources

    content {
      content  = file(source.value)
      filename = source.key
    }
  }
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

resource "aws_iam_role" "worker" {
  name               = local.worker_name
  assume_role_policy = data.aws_iam_policy_document.worker_assume.json
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.worker.arn}:*"]
  }

  statement {
    sid       = "ConsumeEvents"
    effect    = "Allow"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.events.arn]
  }

  # Named keys only. The bucket also holds strava_worker's efforts and the
  # calibration the wind view reads, and this worker has no business near
  # either: object-level grants are what keep the two workers' keys disjoint
  # in fact and not only by convention.
  statement {
    sid     = "ReadAndWriteTrainingData"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject"]
    resources = [
      format(local.data_object, var.activities_s3_key),
      format(local.data_object, var.bikes_s3_key),
      format(local.data_object, var.sync_state_s3_key),
      format(local.data_object, var.streams_index_s3_key),
      format(local.data_object, var.saved_routes_s3_key),
    ]
  }

  # Streams go when their activity is deleted or made private, and a saved
  # route's profile when the route is.
  statement {
    sid     = "ManageTrainingDetail"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [
      format(local.data_object, "${var.streams_s3_prefix}*"),
      format(local.data_object, "${var.saved_routes_s3_prefix}*"),
    ]
  }

  # Without ListBucket, S3 answers a missing object with AccessDenied rather
  # than NoSuchKey, and the very first sync -- before activities.json exists --
  # would fail. Unconditioned because a GetObject's 404 check carries no
  # s3:prefix for a condition to match; listing reveals key names only, and the
  # web runtime already holds the same grant.
  statement {
    sid       = "DistinguishMissingObjects"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.app_data_bucket_arn]
  }

  # Write as well as read: Strava may rotate the refresh token, and the old one
  # stops working once it does. The worker re-reads the secret and replaces only
  # STRAVA_REFRESH_TOKEN, so strava_worker and the web runtime see the new one
  # and nothing else in the document changes.
  statement {
    sid       = "ReadAndRotateStravaSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
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
  handler       = "training_sync.handler.main"
  runtime       = "python3.12"
  architectures = ["arm64"]

  filename         = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256

  # The work is waiting on Strava, not computing, so the smallest sensible size
  # is enough. The queue's visibility timeout is derived from the timeout.
  timeout     = var.worker_timeout_seconds
  memory_size = 256

  # No reserved concurrency, deliberately; see the top of main.tf. The FIFO
  # message group already serialises every write, and a cap would only turn
  # backlog into throttling.

  environment {
    variables = {
      APP_DATA_BUCKET      = var.app_data_bucket
      ACTIVITIES_S3_KEY    = var.activities_s3_key
      BIKES_S3_KEY         = var.bikes_s3_key
      SYNC_STATE_S3_KEY    = var.sync_state_s3_key
      STREAMS_S3_PREFIX    = var.streams_s3_prefix
      STREAMS_INDEX_S3_KEY = var.streams_index_s3_key
      # One backfill batch: inside Strava's 15-minute read window and the
      # worker timeout, which the handler also guards.
      STREAMS_BACKFILL_LIMIT = tostring(var.streams_backfill_limit)
      SAVED_ROUTES_S3_KEY    = var.saved_routes_s3_key
      SAVED_ROUTES_S3_PREFIX = var.saved_routes_s3_prefix
      # Profiles are fetched only for new or edited routes, so this caps the
      # first sync; later runs rarely fetch any.
      SAVED_ROUTES_PROFILE_LIMIT = tostring(var.saved_routes_profile_limit)
      STRAVA_SECRET_ARN          = var.strava_secret_arn
      STRAVA_ATHLETE_ID          = var.strava_athlete_id
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

  # One message per invocation, so one activity Strava refuses to serve cannot
  # send unrelated events back to the queue with it.
  batch_size = 1
}
