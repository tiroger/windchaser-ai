output "queue_url" {
  description = "Queue the webhook endpoint forwards Training events to."
  value       = aws_sqs_queue.events.url
}

output "queue_arn" {
  description = "ARN of the Training events queue."
  value       = aws_sqs_queue.events.arn
}

output "message_group_id" {
  description = "FIFO message group every producer uses, including a manual sync."
  value       = var.message_group_id
}

output "dead_letter_queue_url" {
  description = "Where Training events land after repeated processing failures."
  value       = aws_sqs_queue.dead_letter.url
}

output "worker_function_name" {
  description = "Worker applying Strava events and reconciliation to the Training data."
  value       = aws_lambda_function.worker.function_name
}

output "worker_role_arn" {
  description = "Role the worker runs as."
  value       = aws_iam_role.worker.arn
}
