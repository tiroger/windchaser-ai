variable "environment" {
  description = "Environment this baseline guards."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Environment must be dev or prod."
  }
}

variable "application" {
  description = <<-EOT
    Value of the Application tag identifying this project's spend. The account
    holds unrelated work, so budgets are filtered by tag rather than measuring
    the whole account.
  EOT
  type        = string
  default     = "windchaser-ai"
}

variable "monthly_budget_usd" {
  description = "Monthly spend threshold for this environment."
  type        = number

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "The monthly budget must be greater than zero."
  }
}

variable "alert_email" {
  description = <<-EOT
    Address that receives budget and anomaly alerts. AWS sends a confirmation
    request that must be accepted before any alert is delivered. Null creates
    the topic without a subscriber.
  EOT
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = <<-EOT
    Default retention for this environment's log groups. CloudWatch keeps logs
    forever unless told otherwise, which is the usual way a small project's
    bill grows without anyone noticing.
  EOT
  type        = number
  default     = 14

  validation {
    condition = contains(
      [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653],
      var.log_retention_days
    )
    error_message = "Retention must be one of the values CloudWatch accepts."
  }
}

variable "anomaly_threshold_usd" {
  description = "Absolute daily anomaly impact that triggers a notification."
  type        = number
  default     = 5
}

variable "activate_cost_allocation_tag" {
  description = <<-EOT
    Activate the Application cost allocation tag. Requires the organization's
    management account, and AWS must already have observed the tag in billing
    data, which lags roughly a day behind the first tagged spend. Enabling it
    too early fails with "Tag keys not found".
  EOT
  type        = bool
  default     = false
}
