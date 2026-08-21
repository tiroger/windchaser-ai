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

variable "repository_connected" {
  description = <<-EOT
    True once the repository is attached, by token or through the console.

    Gates the branch, which cannot be created before a repository exists. Also
    the point at which Terraform starts correcting what the console connect
    flow changes: it resets the app to the static WEB platform and the branch
    framework to "Web", both of which silently disable server-side rendering
    and every API route with it.
  EOT
  type        = bool
  default     = false
}

variable "enable_bedrock" {
  description = <<-EOT
    Grant the runtime permission to invoke Bedrock, and turn the briefing's
    LIVE_AI_ENABLED switch on.

    Off by default so inference spend is always a deliberate act. Turning it off
    again returns briefings to the deterministic template with no other effect,
    which is the degradation ADR-0002 requires.
  EOT
  type        = bool
  default     = false
}

variable "briefing_model" {
  description = <<-EOT
    Bedrock model backing the briefing. COST_STRATEGY.md suggests routing simple
    summarisation to a smaller model once evaluations confirm quality; the
    briefing is cached by evidence hash, so it generates a handful of times a
    day rather than per page view.
  EOT
  type        = string
  default     = "claude-opus-5"
}

variable "strava_events_queue_url" {
  description = <<-EOT
    Queue the webhook endpoint enqueues to. Null leaves the endpoint acknowledging
    Strava and discarding events, which is the correct behaviour before the
    ingestion path exists: a 500 would only make Strava retry a configuration
    problem and count failures against the subscription.
  EOT
  type        = string
  default     = null
}

variable "strava_subscription_id" {
  description = <<-EOT
    The webhook subscription this environment answers for.

    Strava does not sign webhook payloads, so the subscription id on an event is
    the only thing tying it to us. It is weak evidence and treated as such:
    events for another subscription are acknowledged and dropped rather than
    trusted, and nothing downstream believes the body either -- the worker
    re-fetches the activity from the API.

    Null accepts any subscription, which is right before one exists and wrong
    afterwards.
  EOT
  type        = string
  default     = null
}

variable "domain_name" {
  description = <<-EOT
    Custom domain serving the app at both apex and www. Null keeps the app on
    its amplifyapp.com URL, which stays working either way.

    Set this only once the registrar delegates the domain to a Route 53 zone in
    this account. ACM validates over public DNS, so an association made before
    delegation resolves stays pending and then fails.
  EOT
  type        = string
  default     = null
}
