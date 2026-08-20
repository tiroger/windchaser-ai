variable "aws_region" {
  description = "AWS region for the development environment."
  type        = string
  default     = "us-west-2"
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

