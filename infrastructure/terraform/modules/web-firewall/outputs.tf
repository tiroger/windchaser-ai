output "web_acl_arn" {
  description = "ARN of the adopted Web ACL."
  value       = aws_wafv2_web_acl.amplify.arn
}
