# Application data the runtime reads but that must not live in the repository.
#
# Calibration carries fitted power, best times and attempt dates: personal
# training data, in a public repository. Section 8 of the project plan already
# places large replayable objects in S3, and this is one.
#
# It is generated offline by scripts/build_calibration.py, which needs the full
# effort history and reanalysis weather, so it cannot be produced at build time.

resource "aws_s3_bucket" "app_data" {
  bucket = "windchaser-${var.environment}-data-${data.aws_caller_identity.current.account_id}"
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_public_access_block" "app_data" {
  bucket                  = aws_s3_bucket.app_data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app_data" {
  bucket = aws_s3_bucket.app_data.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "app_data" {
  bucket = aws_s3_bucket.app_data.id

  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_iam_policy_document" "app_data_tls_only" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.app_data.arn,
      "${aws_s3_bucket.app_data.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "app_data" {
  bucket = aws_s3_bucket.app_data.id
  policy = data.aws_iam_policy_document.app_data_tls_only.json

  depends_on = [aws_s3_bucket_public_access_block.app_data]
}

# Read-only, and only the runtime. The build has no reason to see this.
data "aws_iam_policy_document" "read_app_data" {
  statement {
    sid       = "ReadAppData"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.app_data.arn}/*"]
  }

  statement {
    sid       = "ListAppData"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.app_data.arn]
  }
}

resource "aws_iam_policy" "read_app_data" {
  name        = "windchaser-${var.environment}-read-app-data"
  description = "Read application data objects for this environment."
  policy      = data.aws_iam_policy_document.read_app_data.json
}

resource "aws_iam_role_policy_attachment" "compute_read_app_data" {
  role       = aws_iam_role.compute.name
  policy_arn = aws_iam_policy.read_app_data.arn
}

# Versioning keeps every overwrite, and the Training worker overwrites often:
# activities.json and streams-index.json on every ride, and streams/* objects
# are written and deleted as activities change. Superseded versions are kept
# long enough to recover from a bad write and no longer, so the bucket's size
# tracks the data rather than its history.
resource "aws_s3_bucket_lifecycle_configuration" "app_data" {
  bucket = aws_s3_bucket.app_data.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = 30
      newer_noncurrent_versions = 10
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # The provider documents this ordering for rules on noncurrent versions: a
  # lifecycle configuration applied before versioning is enabled can be
  # rejected or silently do nothing.
  depends_on = [aws_s3_bucket_versioning.app_data]
}

# The runtime's only write path into the bucket: the Training owner's edits to
# the maintenance log and to goals and athlete settings. Two named keys, so a
# compromised owner session can overwrite neither the synced Strava data nor
# the calibration the wind view depends on.
data "aws_iam_policy_document" "write_owner_edits" {
  statement {
    sid     = "WriteOwnerEdits"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.app_data.arn}/${var.maintenance_s3_key}",
      "${aws_s3_bucket.app_data.arn}/${var.settings_s3_key}",
    ]
  }
}

resource "aws_iam_policy" "write_owner_edits" {
  name        = "windchaser-${var.environment}-write-owner-edits"
  description = "Write the Training owner's maintenance log and settings."
  policy      = data.aws_iam_policy_document.write_owner_edits.json
}

resource "aws_iam_role_policy_attachment" "compute_write_owner_edits" {
  role       = aws_iam_role.compute.name
  policy_arn = aws_iam_policy.write_owner_edits.arn
}
