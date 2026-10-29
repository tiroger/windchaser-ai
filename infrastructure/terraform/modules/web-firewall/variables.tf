variable "web_acl_name" {
  description = "Existing Amplify-created Web ACL to adopt."
  type        = string
}

variable "metric_name" {
  description = "CloudWatch metric name the existing ACL already publishes under."
  type        = string
}

variable "webhook_path" {
  description = "Path that must remain reachable without a User-Agent header."
  type        = string
  default     = "/api/strava/webhook"
}

variable "rate_limits" {
  description = <<-EOT
    Per-address limits on routes that accept guesses or spend money, as
    requests per five minutes from one IP to paths starting with the prefix.
    The application keeps its own caps per compute instance; this is the limit
    that sees real client addresses and holds across instances.
  EOT
  type = map(object({
    path_prefix = string
    limit       = number
  }))
  default = {
    OwnerSignIn = { path_prefix = "/api/training/admin/session", limit = 10 }
    Briefing    = { path_prefix = "/api/briefing", limit = 100 }
    Ask         = { path_prefix = "/api/training/ask", limit = 30 }
  }
}
