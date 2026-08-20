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
