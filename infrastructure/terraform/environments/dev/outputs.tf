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

output "strava_events_queue_url" {
  description = "Queue receiving Strava webhook events."
  value       = module.strava_ingestion.queue_url
}

output "domain_nameservers" {
  description = "Nameservers to set at the registrar. Delegation must resolve before domain_delegated is turned on."
  value       = module.dns.name_servers
}

output "domain_verified" {
  description = "True once the custom domain has passed verification; null while domain_delegated is false."
  value       = module.web.domain_verified
}

output "public_url" {
  description = "Address to share: the custom domain once it is live, otherwise the Amplify URL."
  value       = module.web.public_url
}
