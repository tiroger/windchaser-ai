output "environment" {
  description = "Environment represented by this Terraform root."
  value       = "dev"
}


output "alert_topic_arn" {
  description = "SNS topic carrying budget and anomaly alerts."
  value       = module.observability.alert_topic_arn
}

output "budget_name" {
  description = "Monthly budget guarding this environment."
  value       = module.observability.budget_name
}

output "web_url" {
  description = "URL serving the development web app, once a branch exists."
  value       = module.web.branch_url
}

output "web_repository_connected" {
  description = "False means the repository still needs connecting in the Amplify console."
  value       = module.web.repository_connected
}

output "web_app_id" {
  description = "Amplify application ID, for console links and CLI calls."
  value       = module.web.app_id
}

output "strava_secret_name" {
  description = "Secret to populate with `aws secretsmanager put-secret-value`."
  value       = module.web.strava_secret_name
}
