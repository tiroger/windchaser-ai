# Amplify hosting for the Next.js application.
#
# Platform WEB_COMPUTE is what runs server-side rendering and API routes; the
# static platform would drop them, and with them the Strava credentials that
# must stay off the browser.

# Set on both the app and the branch. App level covers the build; the SSR
# compute runtime reads the branch's variables, and an app-level value alone is
# invisible to it -- which is how a correctly configured secret ARN still
# produced "no credentials" at runtime.
locals {
  runtime_environment = {
    STRAVA_SECRET_ARN         = aws_secretsmanager_secret.strava.arn
    LIVE_AI_ENABLED           = var.enable_bedrock ? "true" : "false"
    WINDCHASER_BRIEFING_MODEL = var.briefing_model
    APP_DATA_BUCKET           = aws_s3_bucket.app_data.id
    CALIBRATION_S3_KEY        = "calibration.json"
  }
}

resource "aws_amplify_app" "web" {
  name        = "windchaser-${var.environment}"
  description = "WindChaser cycling opportunity dashboard (${var.environment})."
  platform    = "WEB_COMPUTE"

  # Amplify's CreateApp rejects a repository without a token, so the app is
  # created unconnected when none is supplied and the repository is attached
  # once through the console with the GitHub App. Both are then ignored, so a
  # console connection is never reverted by a later apply.
  repository   = var.github_access_token == null ? null : var.repository_url
  access_token = var.github_access_token

  iam_service_role_arn = aws_iam_role.amplify.arn

  # Separate from the build role above. Amplify grants this one to the SSR
  # compute functions, and without it the runtime has no AWS identity, so any
  # SDK call fails with "Could not load credentials from any providers".
  compute_role_arn = aws_iam_role.compute.arn

  # No build_spec here. amplify.yml at the repository root takes precedence and
  # is reviewable alongside the code it builds. Terraform emitting the same YAML
  # with quoted keys was parsed only partially by Amplify, which ran the build
  # phase and skipped preBuild entirely.

  environment_variables = merge(local.runtime_environment, {
    # Tells Amplify which application in the monorepo this app builds.
    AMPLIFY_MONOREPO_APP_ROOT = var.app_root
    # Full deploys. Diff deploys skip work based on changed paths and get this
    # wrong for a monorepo whose app depends on files outside its own root.
    AMPLIFY_DIFF_DEPLOY = "false"
  })

  # Amplify would otherwise reset these on every apply where the console has
  # been touched.
  lifecycle {
    ignore_changes = [
      access_token,
      repository,
    ]
  }
}

# A branch cannot exist before the repository is connected, so this is gated
# rather than unconditional. Once connected -- by token or by console -- the
# branch is Terraform's to own, because the console connect flow sets framework
# and stage to values that break server-side rendering.
resource "aws_amplify_branch" "tracked" {
  count = var.repository_connected ? 1 : 0

  app_id      = aws_amplify_app.web.id
  branch_name = var.branch_name

  framework = "Next.js - SSR"
  stage     = var.environment == "prod" ? "PRODUCTION" : "DEVELOPMENT"

  enable_auto_build = var.enable_auto_build

  # Compute logs are the only way to see why an API route failed in production.
  enable_performance_mode = false

  # What the running application actually reads. Amplify also injects
  # AMPLIFY_BACKEND_APP_ID and USER_BRANCH here and re-adds them on each build,
  # so declaring only our own does not lose them. Declaring none at all sends an
  # empty map, which the API rejects with "Environment variables cannot have an
  # empty key" and takes framework and stage down with it.
  environment_variables = local.runtime_environment
}

resource "aws_cloudwatch_log_group" "amplify" {
  name              = "/aws/amplify/${aws_amplify_app.web.id}"
  retention_in_days = var.log_retention_days
}
