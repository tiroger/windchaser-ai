output "alert_topic_arn" {
  description = "SNS topic carrying budget and anomaly alerts."
  value       = aws_sns_topic.alerts.arn
}

output "budget_name" {
  description = "Name of the monthly budget for this environment."
  value       = aws_budgets_budget.monthly.name
}

output "log_retention_days" {
  description = "Retention every log group in this environment should adopt."
  value       = var.log_retention_days
}

output "email_subscription_pending" {
  description = <<-EOT
    True when an email subscriber was created. AWS sends a confirmation link
    that must be clicked, or no alert is ever delivered.
  EOT
  value       = var.alert_email != null
}
