# Provider credentials.
#
# Terraform creates the container and never the contents. Section 11 of the
# project plan is explicit: no secrets in Terraform variables, state, outputs,
# logs or fixtures. The value is written once with the AWS CLI, and rotating it
# later touches nothing here.
#
# A single secret holding a JSON document rather than three separate secrets:
# Secrets Manager bills per secret, and these three are always read together.

resource "aws_secretsmanager_secret" "strava" {
  name        = "windchaser/${var.environment}/strava"
  description = "Strava OAuth client credentials and refresh token."

  # Long enough to undo a mistake, short enough that a rotated credential
  # actually disappears.
  recovery_window_in_days = 7
}

data "aws_iam_policy_document" "read_strava_secret" {
  statement {
    sid       = "ReadStravaCredentials"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.strava.arn]
  }
}

resource "aws_iam_policy" "read_strava_secret" {
  name        = "windchaser-${var.environment}-read-strava-secret"
  description = "Read the Strava credentials for this environment."
  policy      = data.aws_iam_policy_document.read_strava_secret.json
}
