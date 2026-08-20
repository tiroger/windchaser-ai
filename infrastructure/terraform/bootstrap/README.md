# Bootstrap

Creates the things every other Terraform root depends on: the S3 bucket holding
remote state, the GitHub OIDC provider, and the roles CI assumes.

Applied **once, by hand**, with administrator credentials. Everything after this
runs in CI through short-lived OIDC sessions, so no long-lived AWS key ever
exists on a laptop or in GitHub. This root has no backend block of its own,
because it creates the bucket the others store state in.

## One-time setup

### 1. Authenticate

```bash
aws configure sso          # IAM Identity Center
aws sso login
aws sts get-caller-identity   # confirm the account before applying anything
```

### 2. Apply

```bash
cd infrastructure/terraform/bootstrap
terraform init
terraform plan     # read this properly: it creates IAM roles
terraform apply
```

### 3. Configure the repository

`terraform output github_variable_commands` prints the exact commands. It sets
three repository variables and one variable inside each GitHub environment.

The apply role ARN is set **per environment**, not repository-wide, so a
development run cannot reach the production role even by editing a workflow.

### 4. Create the GitHub environments

`development` and `production` must exist in repository settings. Add a required
reviewer to `production` — the deploy workflow assumes an approval gate.

## What the roles can do

| Role | Trust | Permissions |
|---|---|---|
| `windchaser-ci-plan` | PRs, `main`, and both environments | `ReadOnlyAccess` plus state read/write for the lock |
| `windchaser-ci-apply-development` | `environment:development` only | `PowerUserAccess`, IAM scoped to `windchaser-*`, state access |
| `windchaser-ci-apply-production` | `environment:production` only | Same, separate role |

`PowerUserAccess` excludes IAM, which the guardrail policy grants back only for
resources named `windchaser-*`. Two explicit denials sit on top: the apply roles
cannot modify the bootstrap roles, the state-access policy, or the OIDC
provider, and cannot delete or reconfigure the state bucket. That is what stops
a compromised workflow widening its own access.

This is broader than the least-privilege target in section 11 of the project
plan. It is a deliberate starting point while the resource set is still moving,
and should be narrowed to the services actually used once it settles.

## Recovery

State is versioned with 90 days of history and the bucket carries
`prevent_destroy`. To recover a corrupted state file, restore the previous
object version rather than editing state in place.

## Cost

The bucket holds a few hundred kilobytes. IAM roles and the OIDC provider are
free. This root should cost effectively nothing.
