# Terraform and CI/CD

## Rules

1. Terraform owns every persistent AWS resource.
2. Application deployment and infrastructure promotion happen through GitHub
   Actions, not from a developer laptop in normal operation.
3. GitHub authenticates to AWS with OIDC and short-lived credentials.
4. Development and production use separate state and deployment roles.
5. Production requires an approved GitHub environment.
6. Plans are reviewed before apply; drift is checked on a schedule.
7. Secrets are populated outside Terraform values/state and referenced by ARN/name.

## Layout

```text
infrastructure/terraform/
├── bootstrap/                 Remote state and GitHub OIDC foundation
├── environments/
│   ├── dev/
│   └── prod/
└── modules/
    ├── identity/
    ├── web/
    ├── api/
    ├── data/
    ├── ingestion/
    ├── forecasting/
    ├── notifications/
    ├── ai/
    └── observability/
```

Bootstrap is intentionally isolated because Terraform cannot use a remote backend
before that backend exists. After initial bootstrap, state resources are rarely
changed.

## State

- S3 backend with versioning, encryption, public-access block, and restricted IAM.
- Terraform native S3 locking or a lock table depending on the selected Terraform
  version/backend configuration.
- Unique state key and preferably unique account per environment.
- State access limited to CI plan/apply roles and break-glass administrators.
- Sensitive values are never deliberately passed through Terraform.

## Modules

Modules expose small stable contracts and own cohesive resources. Avoid a single
giant module and avoid wrapping individual AWS resources without adding policy.

Every module must provide:

- required tags;
- encryption defaults;
- logging/retention controls;
- cost-relevant parameters;
- least-privilege policy inputs;
- useful non-sensitive outputs;
- validation and examples where non-obvious.

## Artifact deployment

Terraform creates deployment destinations and references immutable artifact IDs.
CI builds artifacts once per commit:

- Next.js artifact or Amplify-connected Git commit;
- Lambda ZIPs identified by SHA-256;
- Agent/MCP container images tagged by Git SHA and digest;
- schema and fixture bundles versioned by Git SHA.

Production promotes the same tested artifact digest rather than rebuilding source.

## GitHub environments

```text
pull-request   no write credentials; read-only plan role
development    automatic/limited apply role after merge
production     protected apply role with reviewer approval
```

OIDC trust conditions must restrict:

- GitHub organization and repository;
- branch, tag, or environment subject;
- expected audience;
- role session duration.

## Workflows

### `ci.yml`

- install pinned toolchains;
- install Python and dependencies with `uv sync --locked --all-groups`;
- lint, format, type-check, and test application code;
- validate schemas;
- build the web application;
- run fixture-based browser smoke tests;
- upload test reports.

### `terraform-plan.yml`

- Terraform fmt and validate;
- TFLint and security scan;
- assume read-only/plan AWS role through OIDC;
- create plan for the targeted environment;
- publish a redacted plan artifact and PR summary.

### `deploy-dev.yml`

- triggered after merge to `main`;
- build and publish immutable artifacts;
- assume dev apply role;
- apply reviewed Terraform configuration;
- run deployed smoke/contract tests;
- report environment URL and release SHA.

### `deploy-prod.yml`

- triggered by version tag or workflow dispatch;
- production environment approval;
- verify artifact provenance and source SHA;
- plan and apply production Terraform;
- run canary and smoke checks;
- create GitHub release notes.

### `drift.yml`

- scheduled weekly and manually runnable;
- read-only plan with detailed exit code;
- opens or updates an issue when drift exists;
- never auto-applies drift.

## Branch and release policy

- Short-lived feature branches.
- Required pull-request checks and review.
- `main` is deployable and maps to development.
- Semantic version tags promote tested commits to production.
- Conventional commits are optional; generated release notes are required.
- Database/event schema changes are backward compatible across one deployment
  window.

## Terraform coverage gaps

New AgentCore or messaging features may occasionally arrive before first-class AWS
provider resources. The order of preference is:

1. Native Terraform AWS provider resource.
2. Terraform AWS Cloud Control provider resource.
3. A narrow, idempotent deployment adapter invoked by CI with explicit read/update/
   delete behavior and state recorded as data.

Any adapter must have an ADR, tests, least-privilege role, drift check, and a ticket
to replace it when provider support becomes available. Console-only creation is not
an acceptable steady state.

## Rollback

- Application artifacts are immutable and previous digests remain deployable.
- Lambda aliases or configuration allow rapid code rollback.
- AgentCore versions/endpoints support controlled promotion.
- Terraform rollback means applying a reviewed prior configuration, not editing
  state or running destructive reset commands.
- Data migrations are expand/contract and independently reversible where possible.
