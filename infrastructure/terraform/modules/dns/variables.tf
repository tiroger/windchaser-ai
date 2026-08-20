variable "environment" {
  description = "Environment that owns this zone."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Environment must be dev or prod."
  }
}

variable "domain_name" {
  description = <<-EOT
    Registered domain to host. The registrar keeps the registration; this is
    only the authoritative nameservice for it.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$", var.domain_name))
    error_message = "Domain must be a bare hostname such as windchaser.io, with no scheme, path or trailing dot."
  }
}
