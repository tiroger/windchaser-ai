variable "environment" {
  description = "Environment this web app serves."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Environment must be dev or prod."
  }
}

variable "repository_url" {
  description = "GitHub repository backing the Amplify app."
  type        = string
  default     = "https://github.com/tiroger/windchaser-ai"
}

variable "branch_name" {
  description = "Branch this environment tracks."
  type        = string
  default     = "main"
}

variable "app_root" {
  description = "Monorepo path containing the Next.js application."
  type        = string
  default     = "apps/web"
}

variable "github_access_token" {
  description = <<-EOT
    Personal access token granting Amplify read access to the repository.

    Optional. Left null, the app is created unconnected and the repository is
    attached once through the console using the GitHub App, which is the more
    secure option and the one Terraform cannot express. Either way the token is
    never written to state as an output.
  EOT
  type        = string
  default     = null
  sensitive   = true
}

variable "log_retention_days" {
  description = "Retention for the app's compute logs."
  type        = number
  default     = 14
}

variable "enable_auto_build" {
  description = "Build automatically when the tracked branch changes."
  type        = bool
  default     = true
}
