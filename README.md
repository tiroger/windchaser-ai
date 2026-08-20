# WindChaser AI

WindChaser AI is an AWS-native cycling intelligence application that monitors a
rider's Strava segments, evaluates upcoming weather, predicts favorable personal
best (PB) or King/Queen of the Mountain (KOM/QOM) attempt windows, and sends a
concise SMS alert when the conditions are right.

The application is also an AI-engineering portfolio project. It demonstrates:

- route-aware wind and weather analysis;
- personalized prediction with explicit uncertainty;
- Amazon Bedrock reasoning and grounded explanations;
- Model Context Protocol (MCP) tools behind Bedrock AgentCore Gateway;
- event-driven, serverless AWS architecture;
- a polished React/Next.js web experience;
- infrastructure as code with Terraform;
- GitHub Actions CI/CD using short-lived AWS credentials;
- evaluation, observability, security, and cost controls.

## Product promise

> WindChaser finds the best time to attack a favorite segment, explains why the
> conditions are favorable, texts the rider, and closes the loop after Strava
> receives the resulting activity.

## Repository status

This repository currently contains the architecture and delivery plan plus the
initial monorepo layout. Implementation begins with the vertical slice defined in
[docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

## Planned monorepo

```text
apps/web/                       Next.js React web application
services/api/                   Browser-facing API
services/strava-sync/           Strava OAuth, webhooks, and ingestion
services/opportunity-engine/    Deterministic wind and PB/KOM scoring
services/forecast-worker/       Scheduled forecast evaluation
services/notification-worker/   SMS delivery and delivery tracking
agents/cycling-agent/           Bedrock/AgentCore cycling copilot
mcp/                            Domain MCP servers
packages/cycling-analytics/     Reusable Python analytics
packages/contracts/             API and event schemas
packages/ui/                    Shared React UI components
packages/observability/         Logging, metrics, and tracing helpers
infrastructure/terraform/       All AWS infrastructure
evaluation/                     Prediction and agent evaluations
docs/                           Architecture and delivery documentation
```

## Documentation

- [Comprehensive project plan](docs/PROJECT_PLAN.md)
- [AWS architecture](docs/architecture/AWS_ARCHITECTURE.md)
- [Cost strategy](docs/architecture/COST_STRATEGY.md)
- [Terraform and CI/CD](docs/architecture/TERRAFORM_AND_CICD.md)
- [Architecture decisions](docs/decisions/README.md)

## Relationship to `my-strava`

The existing `/Users/rogerlefort/personal/my-strava` project is a reference and
data source, not a code dependency. Historical ride data and proven cycling
calculations may be migrated through explicit, tested adapters. The old repository
will not be modified by this project.

## Guiding principles

1. Deterministic code calculates weather alignment and opportunity scores.
2. Generative AI explains evidence and supports conversation; it does not invent
   measurements or independently decide that an unsafe ride is safe.
3. Every tool call and recommendation is inspectable.
4. The public portfolio demo works without requiring a Strava login.
5. Serverless, scale-to-zero services are the default until usage justifies
   continuously running infrastructure.
6. All AWS resources are declared in Terraform and deployed through CI/CD.

## Python environments and packages

Python versions, virtual environments, dependency resolution, and lock files are
managed exclusively with [`uv`](https://docs.astral.sh/uv/). Do not use direct
`pip` installs, Poetry, Conda, or committed virtual environments.

```bash
uv python install
uv sync --all-groups
uv run python --version
```

Add packages through `uv` so `pyproject.toml` and `uv.lock` remain authoritative:

```bash
uv add pydantic
uv add --group dev pytest
```

The foundation phase uses one root environment. Services may become explicit `uv`
workspace packages when independent deployment boundaries make that worthwhile.
