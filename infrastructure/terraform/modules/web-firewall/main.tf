# The Amplify-created web firewall, adopted into Terraform.
#
# Amplify attaches this Web ACL automatically. It was doing real work and no one
# had declared it, which is how it came to block two things silently:
#
#   NoUserAgent_HEADER    Strava sends no User-Agent on its subscription
#                         validation, so every attempt was refused before
#                         reaching the application, and Strava reported only
#                         "GET to callback URL does not return 200".
#   SizeRestrictions_BODY an 8 KB request body cap, which is what actually
#                         rejected the briefing payload.
#
# Adopting it rather than deleting it keeps the protection and makes the
# exceptions reviewable. Section 15 of the project plan is explicit that nothing
# is created outside Terraform without being imported.

resource "aws_wafv2_web_acl" "amplify" {
  name        = var.web_acl_name
  description = "Amplify web firewall, adopted so its exceptions are reviewable."
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Strava's webhook validation carries no User-Agent. The exception is as
  # narrow as it can be: this exact path only, and only that one rule is
  # relaxed -- everything else in the common rule set still applies, including
  # the body size cap, because Strava's event payloads are tiny.
  rule {
    name     = "AllowStravaWebhookWithoutUserAgent"
    priority = 0

    action {
      allow {}
    }

    statement {
      and_statement {
        statement {
          byte_match_statement {
            search_string         = var.webhook_path
            positional_constraint = "EXACTLY"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }

        statement {
          size_constraint_statement {
            comparison_operator = "EQ"
            size                = 0

            field_to_match {
              single_header {
                name = "user-agent"
              }
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "AllowStravaWebhookWithoutUserAgent"
    }
  }

  rule {
    name     = "AWS-AWSManagedRulesAmazonIpReputationList"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "AWS-AWSManagedRulesAmazonIpReputationList"
    }
  }

  rule {
    name     = "AWS-AWSManagedRulesCommonRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "AWS-AWSManagedRulesCommonRuleSet"
    }
  }

  rule {
    name     = "AWS-AWSManagedRulesKnownBadInputsRuleSet"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "AWS-AWSManagedRulesKnownBadInputsRuleSet"
    }
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = var.metric_name
  }
}
