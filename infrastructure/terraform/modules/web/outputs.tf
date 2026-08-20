output "app_id" {
  description = "Amplify application ID."
  value       = aws_amplify_app.web.id
}

output "default_domain" {
  description = "Amplify-provided domain for the app."
  value       = aws_amplify_app.web.default_domain
}

output "branch_url" {
  description = "URL serving the tracked branch."
  value       = "https://${aws_amplify_branch.tracked.branch_name}.${aws_amplify_app.web.default_domain}"
}

output "strava_secret_arn" {
  description = "Secret holding Strava credentials. The ARN is not sensitive; the contents are."
  value       = aws_secretsmanager_secret.strava.arn
}

output "strava_secret_name" {
  description = "Name to pass to `aws secretsmanager put-secret-value`."
  value       = aws_secretsmanager_secret.strava.name
}

output "runtime_role_arn" {
  description = "Role the server-side app runs as."
  value       = aws_iam_role.amplify.arn
}
