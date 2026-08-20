variable "aws_region" {
  description = "AWS region for the development environment."
  type        = string
  default     = "us-east-1"
}

variable "monthly_budget_usd" {
  description = "Monthly development budget threshold in USD."
  type        = number
  default     = 15

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "The monthly budget must be greater than zero."
  }
}


variable "alert_email" {
  description = <<-EOT
    Address receiving budget and anomaly alerts. AWS sends a confirmation
    request that must be accepted before any alert arrives.
  EOT
  type        = string
  default     = null
}

variable "activate_cost_allocation_tag" {
  description = <<-EOT
    Activate the Application cost allocation tag so tag-filtered budgets can
    see spend. Requires the organization's management account, and AWS takes up
    to 24 hours to backfill, during which the budget reports zero.

    Verified valid here: account 755319535705 is the management account of
    organization o-ghem5w883m.
  EOT
  type        = bool
  default     = true
}
