# Deployment roles.
#
# The plan role is read-only apart from the state lock. The apply roles need to
# create the application's own infrastructure, which is inherently broad, so the
# scoping that matters is: they may only manage IAM under the project prefix,
# and they may never touch the bootstrap roles themselves. That last denial is
# what stops a compromised workflow widening its own permissions.

locals {
  state_resources = [
    aws_s3_bucket.state.arn,
    "${aws_s3_bucket.state.arn}/*",
  ]
  bootstrap_role_arns = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_prefix}-ci-plan",
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_prefix}-ci-apply-development",
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_prefix}-ci-apply-production",
  ]
}

# ----------------------------------------------------------- state access --

data "aws_iam_policy_document" "state_access" {
  statement {
    sid    = "ReadWriteState"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectVersion",
    ]
    resources = local.state_resources
  }
}

resource "aws_iam_policy" "state_access" {
  name        = "${var.resource_prefix}-terraform-state-access"
  description = "Read and write Terraform state, including the S3 native lock."
  policy      = data.aws_iam_policy_document.state_access.json
}

# ------------------------------------------------------------- plan role --

resource "aws_iam_role" "plan" {
  name                 = "${var.resource_prefix}-ci-plan"
  description          = "Read-only role for terraform plan and drift detection."
  assume_role_policy   = data.aws_iam_policy_document.assume_plan.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "plan_state" {
  role       = aws_iam_role.plan.name
  policy_arn = aws_iam_policy.state_access.arn
}

# ------------------------------------------------------------ apply roles --

data "aws_iam_policy_document" "apply_guardrails" {
  # IAM is the escalation path, so it is the one service the apply role may
  # only touch inside the project's own namespace.
  statement {
    sid    = "ManageProjectIam"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:PassRole",
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      # The provider's default_tags block tags every resource it creates,
      # including IAM policies, so tagging is part of creating one.
      "iam:TagPolicy",
      "iam:UntagPolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:ListPolicyVersions",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_prefix}-*",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${var.resource_prefix}-*",
    ]
  }

  statement {
    sid       = "ReadIam"
    effect    = "Allow"
    actions   = ["iam:List*", "iam:Get*"]
    resources = ["*"]
  }

  # A workflow must not be able to widen its own access, or that of the roles
  # beside it, whatever else it is permitted to do.
  statement {
    sid    = "DenyTouchingTheBootstrap"
    effect = "Deny"
    actions = [
      "iam:*",
    ]
    resources = concat(
      local.bootstrap_role_arns,
      [
        aws_iam_policy.state_access.arn,
        aws_iam_openid_connect_provider.github.arn,
      ],
    )
  }

  statement {
    sid       = "DenyDeletingState"
    effect    = "Deny"
    actions   = ["s3:DeleteBucket", "s3:PutBucketPolicy", "s3:PutBucketVersioning"]
    resources = [aws_s3_bucket.state.arn]
  }
}

resource "aws_iam_policy" "apply_guardrails" {
  name        = "${var.resource_prefix}-ci-apply-guardrails"
  description = "Scopes IAM management to the project and protects the bootstrap."
  policy      = data.aws_iam_policy_document.apply_guardrails.json
}

resource "aws_iam_role" "apply" {
  for_each = {
    development = data.aws_iam_policy_document.assume_apply_development.json
    production  = data.aws_iam_policy_document.assume_apply_production.json
  }

  name                 = "${var.resource_prefix}-ci-apply-${each.key}"
  description          = "Terraform apply role for the ${each.key} environment."
  assume_role_policy   = each.value
  max_session_duration = 3600
}

# PowerUserAccess covers the application services and deliberately excludes
# IAM, which the guardrail policy then grants back only under the project
# prefix. Worth revisiting once the resource set stops changing.
resource "aws_iam_role_policy_attachment" "apply_power" {
  for_each   = aws_iam_role.apply
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy_attachment" "apply_guardrails" {
  for_each   = aws_iam_role.apply
  role       = each.value.name
  policy_arn = aws_iam_policy.apply_guardrails.arn
}

resource "aws_iam_role_policy_attachment" "apply_state" {
  for_each   = aws_iam_role.apply
  role       = each.value.name
  policy_arn = aws_iam_policy.state_access.arn
}
