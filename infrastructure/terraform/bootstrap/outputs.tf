output "state_bucket" {
  description = "Set this as the TERRAFORM_STATE_BUCKET repository variable."
  value       = aws_s3_bucket.state.id
}

output "aws_region" {
  description = "Set this as the AWS_REGION repository variable."
  value       = var.aws_region
}

output "plan_role_arn" {
  description = "Set this as the AWS_TERRAFORM_PLAN_ROLE_ARN repository variable."
  value       = aws_iam_role.plan.arn
}

output "apply_role_arns" {
  description = <<-EOT
    Per-environment apply roles. AWS_TERRAFORM_APPLY_ROLE_ARN is set as an
    environment variable inside each GitHub environment, not repository-wide,
    so a development run cannot reach the production role.
  EOT
  value       = { for k, r in aws_iam_role.apply : k => r.arn }
}

output "github_variable_commands" {
  description = "Copy-paste to configure the repository once this is applied."
  value = join("\n", [
    "gh variable set TERRAFORM_STATE_BUCKET --body ${aws_s3_bucket.state.id}",
    "gh variable set AWS_REGION --body ${var.aws_region}",
    "gh variable set AWS_TERRAFORM_PLAN_ROLE_ARN --body ${aws_iam_role.plan.arn}",
    "gh variable set AWS_TERRAFORM_APPLY_ROLE_ARN --env development --body ${aws_iam_role.apply["development"].arn}",
    "gh variable set AWS_TERRAFORM_APPLY_ROLE_ARN --env production --body ${aws_iam_role.apply["production"].arn}",
  ])
}
