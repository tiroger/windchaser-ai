output "queue_url" {
  description = "Queue the webhook endpoint writes to."
  value       = aws_sqs_queue.events.url
}

output "queue_arn" {
  description = "ARN of the events queue, for a future worker's event source."
  value       = aws_sqs_queue.events.arn
}

output "dead_letter_queue_url" {
  description = "Where events land after repeated processing failures."
  value       = aws_sqs_queue.dead_letter.url
}
