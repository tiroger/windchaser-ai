# Two roles, because Amplify has two distinct identities and conflating them
# grants the build far more than it needs.
#
#   iam_service_role_arn  build and deploy
#   compute_role_arn      the SSR runtime, where API routes execute
#
# Only the second reaches Secrets Manager. Setting only the first is why the
# runtime reported "Could not load credentials from any providers": it had no
# identity at all.

data "aws_iam_policy_document" "amplify_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["amplify.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "amplify" {
  name               = "windchaser-${var.environment}-amplify"
  description        = "Runtime role for the WindChaser web app."
  assume_role_policy = data.aws_iam_policy_document.amplify_assume.json
}

# The SSR runtime. This is the only identity that may read the credentials.
resource "aws_iam_role" "compute" {
  name               = "windchaser-${var.environment}-amplify-compute"
  description        = "SSR compute role for the WindChaser web app."
  assume_role_policy = data.aws_iam_policy_document.amplify_assume.json
}

resource "aws_iam_role_policy_attachment" "compute_read_strava_secret" {
  role       = aws_iam_role.compute.name
  policy_arn = aws_iam_policy.read_strava_secret.arn
}

# Amplify writes build and compute logs on the app's behalf.
data "aws_iam_policy_document" "amplify_logs" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
    ]
    resources = ["arn:aws:logs:*:*:log-group:/aws/amplify/*"]
  }
}

resource "aws_iam_role_policy" "amplify_logs" {
  name   = "windchaser-${var.environment}-amplify-logs"
  role   = aws_iam_role.amplify.id
  policy = data.aws_iam_policy_document.amplify_logs.json
}
