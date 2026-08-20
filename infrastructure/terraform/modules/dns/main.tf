# Authoritative nameservice for the registered domain.
#
# Deliberately its own module rather than part of the web app. A zone outlives
# whatever happens to be serving the site: mail, domain verification records for
# third parties, and any future service all live in this one zone, and coupling
# its lifecycle to an Amplify app would mean replacing the app's DNS authority
# every time the app itself is rebuilt.

resource "aws_route53_zone" "primary" {
  name    = var.domain_name
  comment = "WindChaser ${var.environment}: authoritative zone for ${var.domain_name}."

  # Destroying this zone is not a Terraform-shaped operation. A new zone gets a
  # new set of nameservers, so recovery means going back to the registrar and
  # waiting out propagation again, during which the domain resolves nowhere.
  # Deliberate removal is possible by deleting this block first.
  lifecycle {
    prevent_destroy = true
  }
}
