output "zone_id" {
  description = "Hosted zone ID, for records managed outside this module."
  value       = aws_route53_zone.primary.zone_id
}

output "domain_name" {
  description = <<-EOT
    The hosted domain, without the trailing dot Route 53 stores it with.

    Derived from the zone resource rather than the input variable, so anything
    consuming it depends on the zone existing.
  EOT
  value       = trimsuffix(aws_route53_zone.primary.name, ".")
}

output "name_servers" {
  description = "Nameservers the registrar must delegate to before anything in this zone resolves."
  value       = aws_route53_zone.primary.name_servers
}
