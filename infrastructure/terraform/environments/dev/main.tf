# Development composition.
#
# Modules arrive one vertical slice at a time. The cost and observability
# baseline comes first, deliberately: this account already carries unrelated
# projects, and guardrails are worth far more before there is spend to guard
# than after.

locals {
  # Turned true once `dig +short NS windchaser.io` returns the four servers from
  # the domain_nameservers output, and not before: ACM validates the certificate
  # over public DNS, so an association made ahead of delegation sits pending and
  # then fails, and a failed association must be deleted before another can be
  # created. Recorded here rather than as a CI variable so that plan and apply
  # cannot disagree about it.
  #
  # Delegation confirmed on 2026-08-20 at 19:48Z, and DNSSEC validation passing
  # at 19:58Z once the orphaned DS the registrar had left at the .io registry
  # aged out of resolver caches. Verified over DNS-over-HTTPS against both
  # Google and Cloudflare, because this network intercepts port 53 and answers
  # every query from its own cache regardless of the server asked.
  domain_delegated = true
}

module "observability" {
  source = "../../modules/observability-baseline"

  environment        = "dev"
  monthly_budget_usd = var.monthly_budget_usd
  alert_email        = var.alert_email
  log_retention_days = 14

  # A five dollar daily jump is noise in a large account and a serious signal
  # in this one.
  anomaly_threshold_usd = 5

  # Activated once, from whichever environment applies first. Flipping it on in
  # both roots would have them fight over the same account-level setting.
  activate_cost_allocation_tag = var.activate_cost_allocation_tag
}

module "dns" {
  source = "../../modules/dns"

  environment = "dev"
  domain_name = var.domain_name
}

module "web" {
  source = "../../modules/web"

  environment        = "dev"
  branch_name        = "main"
  log_retention_days = 14

  # Null leaves the app unconnected, and the repository is attached once
  # through the console using the GitHub App. See the module README: this is
  # the documented exception to everything-in-Terraform, because Amplify's
  # GitHub App connection has no Terraform representation.
  github_access_token = var.amplify_github_token

  # Connected through the console on 2026-08-20. Terraform now owns the branch
  # and reasserts the compute platform the console reset.
  repository_connected = true

  # Turns on the generated briefing. Off means the deterministic template, which
  # is the ADR-0002 fallback and stays correct either way. Generation is cached
  # by evidence hash, so this costs a handful of calls a day rather than one per
  # page view, and the tag-filtered budget and anomaly monitor watch it.
  enable_bedrock = true

  # Set after strava_ingestion exists; the endpoint acknowledges and discards
  # until it does, rather than making Strava retry a configuration problem.
  strava_events_queue_url = module.strava_ingestion.queue_url

  # Null until the registrar delegates to the zone above. The Amplify URL keeps
  # working throughout, so this is additive rather than a cutover.
  domain_name = local.domain_delegated ? module.dns.domain_name : null
}

module "strava_ingestion" {
  source = "../../modules/strava-ingestion"

  environment = "dev"

  # The web runtime is what enqueues: Strava calls the endpoint, never SQS.
  consumer_role_name = module.web.compute_role_name

  # Alarms are pointless without somewhere to send them.
  alarm_topic_arn = module.observability.alert_topic_arn
}

module "web_firewall" {
  source = "../../modules/web-firewall"

  # Amplify created this Web ACL and attached it to the app. It is adopted
  # rather than replaced: it was silently blocking Strava's webhook validation
  # and the briefing payload, and an undeclared security control is exactly the
  # kind of thing section 15 says must be imported rather than left implicit.
  web_acl_name = "CreatedByAmplify-d3f0frh0dwcdg7-f2d8f3a8-5639-4758-b8e8-3bfa6775d748"
  metric_name  = "Amplify-d3f0frh0dwcdg7"
}
