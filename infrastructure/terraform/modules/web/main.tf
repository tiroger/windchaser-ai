# Amplify hosting for the Next.js application.
#
# Platform WEB_COMPUTE is what runs server-side rendering and API routes; the
# static platform would drop them, and with them the Strava credentials that
# must stay off the browser.

locals {
  # Amplify builds from the repository root, so the monorepo path is declared
  # here and every command runs relative to it.
  build_spec = yamlencode({
    version = 1
    applications = [{
      appRoot = var.app_root
      frontend = {
        phases = {
          preBuild = {
            commands = [
              # Match the Node version the repository pins, rather than
              # whatever the build image happens to ship.
              "nvm install $(cat ../../.node-version)",
              "nvm use $(cat ../../.node-version)",
              "node --version",
              "npm ci",
            ]
          }
          build = {
            commands = [
              # prebuild syncs the MapLibre worker into public/, which the map
              # cannot render without.
              "npm run build",
            ]
          }
        }
        artifacts = {
          baseDirectory = ".next"
          files         = ["**/*"]
        }
        cache = {
          paths = [
            "node_modules/**/*",
            ".next/cache/**/*",
          ]
        }
      }
    }]
  })
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
  build_spec           = local.build_spec

  environment_variables = {
    # Tells Amplify which application in the monorepo this app builds.
    AMPLIFY_MONOREPO_APP_ROOT = var.app_root
    # Full deploys. Diff deploys skip work based on changed paths and get this
    # wrong for a monorepo whose app depends on files outside its own root.
    AMPLIFY_DIFF_DEPLOY = "false"
    # The app resolves credentials from here at runtime. The ARN is not secret;
    # reading it requires the compute role.
    STRAVA_SECRET_ARN = aws_secretsmanager_secret.strava.arn
    # Bedrock stays off until the briefing is wired to it, so a misconfiguration
    # cannot quietly start spending on inference.
    LIVE_AI_ENABLED = "false"
  }

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
}

resource "aws_cloudwatch_log_group" "amplify" {
  name              = "/aws/amplify/${aws_amplify_app.web.id}"
  retention_in_days = var.log_retention_days
}
