# Terraform

This directory will own all WindChaser AWS infrastructure.

## Structure

```text
bootstrap/          Remote state, GitHub OIDC, and CI roles
environments/dev/   Development composition and variables
environments/prod/  Production composition and variables
modules/            Shared infrastructure modules
```

The environment roots intentionally begin with no AWS resources. Modules will be
introduced incrementally by the vertical slices in the project plan. This prevents
an expensive empty platform from being deployed before the application needs it.

## Planned module order

1. `bootstrap` and `observability-baseline`
2. `web`
3. `identity` and `api`
4. `data` and `strava-ingestion`
5. `forecasting` and `opportunity-engine`
6. `notifications`
7. `ai-agentcore`

## Local validation

```bash
terraform fmt -recursive -check
terraform -chdir=environments/dev init -backend=false
terraform -chdir=environments/dev validate
```

Normal plans and applies run in GitHub Actions through OIDC. Local applies are a
break-glass workflow, not the standard development path.

