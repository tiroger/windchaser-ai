# Development composition.
#
# Modules arrive one vertical slice at a time. The cost and observability
# baseline comes first, deliberately: this account already carries unrelated
# projects, and guardrails are worth far more before there is spend to guard
# than after.

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
}
