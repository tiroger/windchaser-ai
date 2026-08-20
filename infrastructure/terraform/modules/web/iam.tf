# Compute role for the server-side rendered app.
#
# This is what the API routes run as, so it is the identity that reaches
# Secrets Manager and, later, Bedrock. Scoped to exactly that.

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

resource "aws_iam_role_policy_attachment" "read_strava_secret" {
  role       = aws_iam_role.amplify.name
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
