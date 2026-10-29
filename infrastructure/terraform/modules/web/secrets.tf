# Provider credentials.
#
# Terraform creates the container and never the contents: no secrets in
# Terraform variables, state, outputs, logs or fixtures. The value is written
# once with the AWS CLI, and rotating it later touches nothing here.
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

# Owner mode for the Training section: the passphrase and the key that signs
# its session cookie. A separate secret from the Strava one, because the
# readers differ. Both workers read and rotate windchaser/{env}/strava; neither
# has any reason to see what unlocks editing in the browser, and a worker that
# can rewrite the Strava document could otherwise rewrite this too.
#
# Container only, as above. The value is a JSON document with
# admin_passphrase (at least 16 characters) and admin_session_secret (at least
# 32), written once with the AWS CLI; see TRAINING_INTEGRATION.md.
resource "aws_secretsmanager_secret" "web" {
  name        = "windchaser/${var.environment}/web"
  description = "Training owner-mode passphrase and session signing secret."

  recovery_window_in_days = 7
}

data "aws_iam_policy_document" "read_web_secret" {
  statement {
    sid       = "ReadWebSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.web.arn]
  }
}

resource "aws_iam_policy" "read_web_secret" {
  name        = "windchaser-${var.environment}-read-web-secret"
  description = "Read the web runtime's owner-mode secret for this environment."
  policy      = data.aws_iam_policy_document.read_web_secret.json
}

resource "aws_iam_role_policy_attachment" "compute_read_web_secret" {
  role       = aws_iam_role.compute.name
  policy_arn = aws_iam_policy.read_web_secret.arn
}
