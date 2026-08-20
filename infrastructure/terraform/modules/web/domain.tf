# Custom domain.
#
# There are no record resources here on purpose. With the hosted zone in the
# same account, Amplify writes both the ACM validation record and the app's own
# records itself; declaring them here as well would have Terraform and Amplify
# fighting over the same names.
#
# What Amplify cannot do is validate a certificate against a zone the registrar
# is not yet delegating to. Until the nameservers point at Route 53 the
# association sits in PENDING_VERIFICATION and eventually fails, and a failed
# association has to be deleted before another can be created. That is why the
# environment gates this on delegation rather than applying it blind.

resource "aws_amplify_domain_association" "primary" {
  count = var.domain_name != null && var.repository_connected ? 1 : 0

  app_id      = aws_amplify_app.web.id
  domain_name = var.domain_name

  # Every published hostname is declared below. Automatic sub-domain creation
  # would publish a URL for each new branch, which for short-lived branches
  # means public addresses nobody decided to expose.
  enable_auto_sub_domain = false

  # Certificate issuance and DNS propagation run on AWS's schedule, not the
  # apply's. Blocking holds a CI run open for as long as they take, and a
  # timeout reports failure for something that is still progressing normally.
  # Status is observable afterwards through the domain_status output.
  wait_for_verification = false

  # Apex.
  sub_domain {
    branch_name = aws_amplify_branch.tracked[0].branch_name
    prefix      = ""
  }

  # Served so that www resolves at all; the app-level rule below redirects it.
  sub_domain {
    branch_name = aws_amplify_branch.tracked[0].branch_name
    prefix      = "www"
  }
}
