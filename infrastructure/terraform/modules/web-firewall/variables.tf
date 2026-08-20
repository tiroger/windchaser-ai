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
