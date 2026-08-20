variable "aws_region" {
  description = "Region for the state bucket and IAM resources."
  type        = string
  default     = "us-east-1"
}

variable "github_owner" {
  description = "GitHub account that owns the repository."
  type        = string
  default     = "tiroger"
}

variable "github_repository" {
  description = "Repository allowed to assume the deployment roles."
  type        = string
  default     = "windchaser-ai"
}

variable "state_bucket_name" {
  description = <<-EOT
    Terraform state bucket. Leave null to derive a globally unique name from the
    account ID, which avoids the usual bucket-name collision.
  EOT
  type        = string
  default     = null
}

variable "noncurrent_version_retention_days" {
  description = "How long superseded state versions are kept before expiry."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 30
    error_message = "Keep at least 30 days of state history for recovery."
  }
}

variable "resource_prefix" {
  description = <<-EOT
    Name prefix the apply role is permitted to manage IAM resources under. This
    is what keeps the CI role from creating arbitrary roles in the account.
  EOT
  type        = string
  default     = "windchaser"
}
