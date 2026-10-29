variable "environment" {
  description = "Environment this sync serves."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Environment must be dev or prod."
  }
}

variable "consumer_role_name" {
  description = "Role permitted to forward webhook events here, i.e. the web runtime."
  type        = string
}

variable "alarm_topic_arn" {
  description = <<-EOT
    Topic receiving dead-letter, staleness and worker error alarms. Null creates
    the alarms without notifications, which is worse than useless, so pass the
    environment's alert topic.
  EOT
  type        = string
  default     = null
}

variable "source_root" {
  description = "Repository root, from which services/training_sync is zipped."
  type        = string
}

variable "strava_secret_arn" {
  description = <<-EOT
    The shared windchaser/{env}/strava secret. The worker reads STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET and STRAVA_REFRESH_TOKEN, and writes back only a
    rotated STRAVA_REFRESH_TOKEN.
  EOT
  type        = string
}

variable "strava_athlete_id" {
  description = <<-EOT
    The one athlete whose activities are stored. Webhook payloads are
    unauthenticated, so the worker checks every event's owner, and every
    activity Strava returns, against this. Public on the athlete's Strava
    profile URL, so not a secret.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.strava_athlete_id))
    error_message = "The Strava athlete id is numeric."
  }
}

variable "app_data_bucket" {
  description = "Bucket holding the Training objects, shared with the rest of the application."
  type        = string
}

variable "app_data_bucket_arn" {
  description = "ARN of that bucket, for the worker's object permissions."
  type        = string
}

variable "activities_s3_key" {
  description = "Object holding the synced activities."
  type        = string
  default     = "activities.json"
}

variable "bikes_s3_key" {
  description = "Object holding the synced bikes and shoes."
  type        = string
  default     = "bikes.json"
}

variable "sync_state_s3_key" {
  description = "Object recording when reconciliation last ran."
  type        = string
  default     = "sync-state.json"
}

variable "streams_s3_prefix" {
  description = "Prefix under which each activity's detailed streams are stored."
  type        = string
  default     = "streams/"
}

variable "settings_s3_key" {
  description = "The owner's settings, written by the web app; read here for the heart-rate anchors of exercise load."
  type        = string
  default     = "settings.json"
}

variable "streams_index_s3_key" {
  description = "Object summarising which activities have streams, with their effort summaries."
  type        = string
  default     = "streams-index.json"
}

variable "saved_routes_s3_key" {
  description = "Object listing the athlete's public saved routes."
  type        = string
  default     = "saved-routes.json"
}

variable "saved_routes_s3_prefix" {
  description = "Prefix under which each saved route's elevation profile is stored."
  type        = string
  default     = "saved-routes/"
}

variable "message_group_id" {
  description = <<-EOT
    FIFO message group every producer uses. Must match the webhook route's
    TRAINING_MESSAGE_GROUP, or schedules and events could interleave.
  EOT
  type        = string
  default     = "strava-events"
}

variable "reconciliation_schedule" {
  description = "How often to reconcile recent activities, gear and saved routes."
  type        = string
  default     = "rate(1 day)"
}

variable "streams_backfill_schedule" {
  description = "How often to fetch streams for activities that do not have them yet."
  type        = string
  default     = "rate(1 hour)"
}

variable "streams_backfill_limit" {
  description = <<-EOT
    Activities whose streams are fetched per backfill run, one Strava read
    each. 50 an hour is at most 1,200 reads a day against the application's
    2,000, and each batch stays well inside the 200-per-15-minute window. The
    worker stops sooner once the shared daily allowance is 80% spent, so
    strava_worker's own calls always come first.
  EOT
  type        = number
  default     = 50
}

variable "saved_routes_profile_limit" {
  description = "Saved-route profiles fetched per run; each costs one Strava read."
  type        = number
  default     = 100
}

variable "schedules_enabled" {
  description = <<-EOT
    Whether the reconciliation and streams backfill schedules run. Off keeps
    the environment deployed but idle, for example while its credentials are
    being sorted out, when every scheduled run would fail and raise an alarm.
    Forwarded webhook events are unaffected.
  EOT
  type        = bool
  default     = true
}

variable "max_receive_count" {
  description = "Deliveries attempted before an event moves to the dead letter queue."
  type        = number
  default     = 5
}

variable "event_retention_days" {
  description = "How long unprocessed events survive in the queues."
  type        = number
  default     = 14

  validation {
    condition     = var.event_retention_days >= 1 && var.event_retention_days <= 14
    error_message = "SQS retains messages for between 1 and 14 days."
  }
}

variable "worker_timeout_seconds" {
  description = <<-EOT
    How long the worker may run. A first reconciliation pages through the whole
    history; webhook events finish in seconds. The handler stops optional work
    30 seconds short of this to write what it fetched, and the queue's
    visibility timeout is derived from it.
  EOT
  type        = number
  default     = 300

  validation {
    condition     = var.worker_timeout_seconds >= 60 && var.worker_timeout_seconds <= 900
    error_message = "Use between 60 and 900 seconds; the handler reserves 30 to write its results."
  }
}

variable "log_retention_days" {
  description = "Retention for the worker's logs."
  type        = number
  default     = 14
}
