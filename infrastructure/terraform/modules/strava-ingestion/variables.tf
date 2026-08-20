variable "environment" {
  description = "Environment this ingestion path serves."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Environment must be dev or prod."
  }
}

variable "consumer_role_name" {
  description = "Role permitted to enqueue webhook events, i.e. the web runtime."
  type        = string
}

variable "max_receive_count" {
  description = <<-EOT
    Deliveries attempted before an event moves to the dead letter queue. Strava
    retries on its side too, so this is about our own transient failures rather
    than theirs.
  EOT
  type        = number
  default     = 5
}

variable "raw_event_retention_days" {
  description = <<-EOT
    How long unprocessed events survive in the queue. Section 8 of the project
    plan retains raw webhook bodies for 14 to 30 days; the queue itself holds
    them far more briefly, and SQS caps retention at 14 days.
  EOT
  type        = number
  default     = 14

  validation {
    condition     = var.raw_event_retention_days >= 1 && var.raw_event_retention_days <= 14
    error_message = "SQS retains messages for between 1 and 14 days."
  }
}

variable "alarm_topic_arn" {
  description = <<-EOT
    Topic receiving dead-letter and staleness alarms. Null creates the alarms
    without notifications, which is worse than useless, so pass the environment's
    alert topic.
  EOT
  type        = string
  default     = null
}

variable "source_root" {
  description = <<-EOT
    Repository root, from which the worker's Python is zipped.

    Terraform builds the deployment package itself rather than consuming one
    from a build step: it is pure Python against the standard library and the
    boto3 the Lambda runtime provides, so there is nothing to compile or
    install, and no opportunity for the artefact to differ from the reviewed
    source.
  EOT
  type        = string
}

variable "strava_secret_arn" {
  description = "Secret holding the Strava credentials the worker reads and may rotate."
  type        = string
}

variable "app_data_bucket" {
  description = "Bucket holding the effort history and the calibration."
  type        = string
}

variable "app_data_bucket_arn" {
  description = "ARN of that bucket, for the worker's object permissions."
  type        = string
}

variable "efforts_s3_key" {
  description = "Object holding the accumulated effort history."
  type        = string
  default     = "efforts.json"
}

variable "calibration_s3_key" {
  description = <<-EOT
    Object the web application reads its calibration from. The worker writes
    the same key the offline script uploads, so a rebuilt calibration reaches
    the app with no further step.
  EOT
  type        = string
  default     = "calibration.json"
}

variable "bundle_s3_key" {
  description = <<-EOT
    The saved opportunity bundle, read by the worker purely as the list of
    segments the rider actually sees. That list is what makes a segment worth
    spending Strava reads to learn about: the worker pulls the history for one
    untracked segment per run, so coverage fills in over a fortnight rather
    than spiking a daily allowance this rider already spends.
  EOT
  type        = string
  default     = "opportunities.json"
}

variable "refresh_schedule" {
  description = <<-EOT
    How often to attach newly available reanalysis weather and rebuild.

    Daily is generous for a source that updates once a day and trails by about
    a week; more often would mostly re-fetch months already held.
  EOT
  type        = string
  default     = "rate(1 day)"
}

variable "log_retention_days" {
  description = "Retention for the worker's logs."
  type        = number
  default     = 14
}

variable "worker_timeout_seconds" {
  description = <<-EOT
    How long the worker may run.

    Sized for the slower of its two paths: the scheduled rebuild, which fetches
    reanalysis for any cell-month it still needs before fitting power across
    every recorded attempt. Ingestion finishes in seconds.

    The queue's visibility timeout is derived from this at six times over, so
    the two cannot drift into the combination Lambda rejects.
  EOT
  type        = number
  default     = 300

  validation {
    condition     = var.worker_timeout_seconds >= 30 && var.worker_timeout_seconds <= 900
    error_message = "Lambda allows between 1 and 900 seconds; below 30 the rebuild cannot finish."
  }
}
