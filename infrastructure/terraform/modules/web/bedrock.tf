# Bedrock access for the narrative layer.
#
# ADR-0002 keeps this strictly optional: the deterministic engine decides
# everything, and the model only explains evidence it was handed. If this
# permission is removed or LIVE_AI_ENABLED is set false, briefings fall back to
# the deterministic template and nothing else changes.
#
# Scoped to Anthropic models only. The runtime has no reason to invoke anything
# else, and an over-broad grant here is how inference spend appears by accident.

data "aws_region" "current" {}

data "aws_iam_policy_document" "invoke_bedrock" {
  # The Anthropic Messages API on Bedrock is a separate service namespace from
  # classic InvokeModel, with its own action and its own resource shape. The SDK
  # client used here speaks that endpoint, so granting only bedrock:InvokeModel
  # produced a permission_error naming an action that does not appear anywhere
  # in the classic Bedrock docs.
  statement {
    sid       = "CreateInferenceOnMessagesApi"
    effect    = "Allow"
    actions   = ["bedrock-mantle:CreateInference"]
    resources = ["arn:aws:bedrock-mantle:*:${data.aws_caller_identity.current.account_id}:project/*"]
  }

  statement {
    sid    = "InvokeAnthropicModels"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = [
      "arn:aws:bedrock:*::foundation-model/anthropic.*",
      # Newer models are invoked through an inference profile rather than the
      # bare model id, so both forms are needed.
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*anthropic*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:application-inference-profile/*",
    ]
  }
}

resource "aws_iam_policy" "invoke_bedrock" {
  count = var.enable_bedrock ? 1 : 0

  name        = "windchaser-${var.environment}-invoke-bedrock"
  description = "Invoke Anthropic models on Bedrock for the conditions briefing."
  policy      = data.aws_iam_policy_document.invoke_bedrock.json
}

resource "aws_iam_role_policy_attachment" "compute_invoke_bedrock" {
  count = var.enable_bedrock ? 1 : 0

  role       = aws_iam_role.compute.name
  policy_arn = aws_iam_policy.invoke_bedrock[0].arn
}
