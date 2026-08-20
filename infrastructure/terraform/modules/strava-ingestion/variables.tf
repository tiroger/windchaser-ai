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
