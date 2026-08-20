# Remote state and GitHub OIDC foundation.
#
# Applied once, by hand, with administrator credentials. Everything after this
# runs in CI through short-lived OIDC role sessions, so no long-lived AWS key
# exists on a laptop or in GitHub. See ADR-0003.

data "aws_caller_identity" "current" {}

locals {
  bucket_name = coalesce(
    var.state_bucket_name,
    "${var.resource_prefix}-tfstate-${data.aws_caller_identity.current.account_id}"
  )
  repo = "${var.github_owner}/${var.github_repository}"

  # GitHub presents an ID-qualified subject claim:
  #   repo:<owner>@<owner_id>/<repo>@<repo_id>:environment:<name>
  # The numeric IDs are immutable, so a deleted-and-recreated repository of the
  # same name cannot inherit this trust. Both forms are accepted because the
  # legacy format is still what most documentation shows, and a rollout that
  # flips either way must not lock CI out of the account.
  subject_owners = [
    "repo:${var.github_owner}/${var.github_repository}",
    "repo:${var.github_owner}@*/${var.github_repository}@*",
  ]

  subjects = {
    for scope in ["pull_request", "ref:refs/heads/main", "environment:development", "environment:production"] :
    scope => [for owner in local.subject_owners : "${owner}:${scope}"]
  }
}

# ---------------------------------------------------------------- state --

resource "aws_s3_bucket" "state" {
  bucket = local.bucket_name

  # State is the one thing that must not be casually destroyed. Removing this
  # is a deliberate act, not a side effect of a terraform destroy.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-noncurrent-state"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}

# ----------------------------------------------------------------- oidc --

data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github.certificates[0].sha1_fingerprint]
}

# Trust is scoped by GitHub environment, not just by repository. A workflow
# without `environment: production` cannot assume the production role even if
# it runs in this repository.
data "aws_iam_policy_document" "assume_plan" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = flatten(values(local.subjects))
    }
  }
}

data "aws_iam_policy_document" "assume_apply_development" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.subjects["environment:development"]
    }
  }
}

data "aws_iam_policy_document" "assume_apply_production" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.subjects["environment:production"]
    }
  }
}
