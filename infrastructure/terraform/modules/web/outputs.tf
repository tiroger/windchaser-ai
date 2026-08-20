output "app_id" {
  description = "Amplify application ID."
  value       = aws_amplify_app.web.id
}

output "default_domain" {
  description = "Amplify-provided domain for the app."
  value       = aws_amplify_app.web.default_domain
}

output "branch_url" {
  description = "URL serving the tracked branch, once a branch exists."
  value = length(aws_amplify_branch.tracked) > 0 ? (
    "https://${aws_amplify_branch.tracked[0].branch_name}.${aws_amplify_app.web.default_domain}"
  ) : null
}

output "repository_connected" {
  description = "False means the repository still needs connecting in the console."
  # Whether a token was supplied is not itself sensitive; the token is. Marking
  # this explicitly rather than making the output sensitive keeps it readable
  # in plan output, which is the entire point of surfacing it.
  value = nonsensitive(var.github_access_token != null)
}

output "strava_secret_arn" {
  description = "Secret holding Strava credentials. The ARN is not sensitive; the contents are."
  value       = aws_secretsmanager_secret.strava.arn
}

output "strava_secret_name" {
  description = "Name to pass to `aws secretsmanager put-secret-value`."
  value       = aws_secretsmanager_secret.strava.name
}

output "build_role_arn" {
  description = "Role Amplify uses to build and deploy."
  value       = aws_iam_role.amplify.arn
}

output "runtime_role_arn" {
  description = "Role the SSR compute functions run as."
  value       = aws_iam_role.compute.arn
}

output "app_data_bucket" {
  description = "Bucket holding runtime data such as the calibration bundle."
  value       = aws_s3_bucket.app_data.id
}

output "app_data_bucket_arn" {
  description = "ARN of that bucket, for granting object access outside this module."
  value       = aws_s3_bucket.app_data.arn
}

output "compute_role_name" {
  description = "Name of the SSR compute role, for attaching further policies."
  value       = aws_iam_role.compute.name
}

output "domain_name" {
  description = "Custom domain serving the app, or null while it is only on the Amplify URL."
  value = length(aws_amplify_domain_association.primary) > 0 ? (
    aws_amplify_domain_association.primary[0].domain_name
  ) : null
}

output "domain_verified" {
  description = <<-EOT
    True once every declared hostname has passed verification.

    The association does not block on verification, so this reads false
    immediately after the first apply and is expected to become true within
    minutes. The provider exposes no overall domain status, so this is the
    conjunction of the per-subdomain flags, which is the same question.
  EOT
  value = length(aws_amplify_domain_association.primary) > 0 ? (
    alltrue([for s in aws_amplify_domain_association.primary[0].sub_domain : s.verified])
  ) : null
}

output "domain_verification_record" {
  description = <<-EOT
    Certificate validation record Amplify expects to see in DNS.

    Amplify writes this into Route 53 itself while the zone is in this account.
    It is surfaced because when a domain is stuck pending, whether this record
    resolves publicly is the first thing worth checking.
  EOT
  value = length(aws_amplify_domain_association.primary) > 0 ? (
    aws_amplify_domain_association.primary[0].certificate_verification_dns_record
  ) : null
}

output "public_url" {
  description = "Address to share: the custom domain when there is one, otherwise the Amplify branch URL."
  value = length(aws_amplify_domain_association.primary) > 0 ? (
    "https://${aws_amplify_domain_association.primary[0].domain_name}"
    ) : (
    length(aws_amplify_branch.tracked) > 0 ? "https://${aws_amplify_branch.tracked[0].branch_name}.${aws_amplify_app.web.default_domain}" : null
  )
}
