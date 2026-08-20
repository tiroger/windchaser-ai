# WindChaser AI: Comprehensive Project Plan

## 1. Executive summary

WindChaser AI is a mobile-first React web application that identifies favorable
weather windows for attempting a personal best or a configured KOM/QOM target on
cycling segments. It connects to Strava with OAuth, stores the rider's selected
segments and historical efforts, evaluates forecast wind along each segment's
actual geometry, ranks opportunities, and sends an SMS when a configured threshold
is met.

An Amazon Bedrock agent provides grounded explanations and conversational planning.
The agent discovers domain capabilities through MCP servers aggregated by Amazon
Bedrock AgentCore Gateway. The operational alert path remains deterministic and
does not require an LLM to run successfully.

The project is optimized for a low-traffic portfolio deployment: managed,
serverless, scale-to-zero components; aggressive caching; scheduled batch work;
short data retention; AWS Budgets and alarms; and an offline public demo that does
not make paid inference or third-party API calls on every visit.

## 2. Goals

### Product goals

1. Connect a rider's Strava account securely.
2. Import and monitor starred or explicitly selected cycling segments.
3. Find favorable PB/KOM attempt windows over the next seven days.
4. Calculate wind assistance over curved segment geometry rather than using a
   single start-to-finish bearing.
5. Estimate a time range and probability of beating a personal or configured
   target time.
6. Send a useful, concise SMS with a deep link to the opportunity page.
7. Analyze the resulting Strava activity and report whether the target was met.
8. Let the rider ask natural-language questions about segments, conditions, and
   readiness.

### Portfolio goals

1. Demonstrate production-oriented AI engineering rather than a thin LLM wrapper.
2. Show MCP tool discovery, structured tool calls, authentication, and governance.
3. Show deterministic numerical systems operating alongside generative AI.
4. Demonstrate AWS serverless/event-driven design, security, observability, and
   cost management.
5. Provide measurable agent and prediction evaluations.
6. Deploy all AWS infrastructure with Terraform and all application changes through
   GitHub Actions.
7. Offer a polished, instantly accessible public demo using sanitized fixtures.

## 3. Non-goals for the first release

- Scraping Strava leaderboards or bypassing Strava API/licensing restrictions.
- Live turn-by-turn navigation.
- Medical, injury, or definitive safety advice.
- Training a large bespoke model.
- Supporting every weather provider or every country at launch.
- Native iOS or Android applications.
- Sending marketing SMS messages.
- High-scale multi-tenant SaaS billing.

## 4. Target users and primary journeys

### Rider

1. Signs in and connects Strava.
2. Selects starred segments to monitor.
3. Configures PB/KOM targets, thresholds, quiet hours, and phone number.
4. Sees ranked opportunities on the dashboard.
5. Receives an SMS and opens a mobile opportunity page.
6. Attempts the segment.
7. Receives a post-ride result after the Strava webhook is processed.

### Portfolio reviewer

1. Opens the public landing page with no login.
2. Explores a seeded, sanitized segment and forecast.
3. Watches the wind overlay and opportunity score change over time.
4. Opens the AI trace to inspect MCP tool calls and evidence.
5. Reviews architecture, evaluation, latency, reliability, and cost metrics.

## 5. Functional scope

### Authentication and profile

- Cognito sign-in for the application.
- Strava OAuth connection with encrypted refresh-token storage.
- Explicit scopes and account disconnect/deletion flows.
- Verified phone number, SMS consent timestamp, opt-out status, timezone, quiet
  hours, and notification thresholds.

### Strava integration

- OAuth authorization and refresh.
- Starred segment synchronization.
- Segment detail and geometry retrieval.
- Athlete-specific PR statistics where permitted.
- Activity and segment-effort ingestion where permitted.
- Webhook endpoint that acknowledges within Strava's required response window and
  queues asynchronous processing.
- Request caching, rate-limit accounting, and backoff.
- Data deletion when authorization is revoked.

### Weather and wind intelligence

- Hourly forecast retrieval for sampled points along a segment.
- Normalize wind direction, speed, gusts, temperature, precipitation, and forecast
  timestamp into provider-neutral contracts.
- Decode segment polylines and sample them into directional sections.
- Calculate bearing and tailwind/crosswind/headwind components per section.
- Distance-weight and optionally grade/exposure-weight the components.
- Attach forecast provenance and confidence.
- Avoid duplicate provider requests by grouping nearby segment points and caching
  forecast cells.

### Opportunity engine

- Rule-based MVP score with transparent factors and hard safety gates.
- PB time-range estimate from historical effort, effective wind, temperature,
  readiness, and uncertainty.
- Configured KOM/QOM target times without leaderboard scraping.
- Per-user thresholds and quiet hours.
- Deduplication, cooldown, cancellation, and material-change policies.
- Store the complete evidence snapshot used for each score.

### SMS notifications

- Transactional SMS through AWS End User Messaging SMS.
- SQS queue and dead-letter queue.
- Idempotent sends and delivery-state tracking.
- Concise messages designed to remain within as few SMS parts as possible.
- Deep link to a signed-in mobile opportunity page.
- STOP/opt-out behavior and suppression list.
- Test mode that only sends to verified owner numbers.

### AI copilot

- Natural-language questions about upcoming opportunities and historical efforts.
- Bedrock model through AgentCore Runtime.
- Structured MCP tools through AgentCore Gateway.
- Grounded responses referencing tool outputs.
- Read-only tools by default; confirmation for notification or preference mutations.
- Streaming response and visible tool trace in the web interface.
- Guardrails for unsafe, medical, and overconfident advice.

### Portfolio experience

- Public fixture-based demo that incurs no Strava or Bedrock request by default.
- Interactive segment map with wind arrows and colored route sections.
- Opportunity timeline and score factor breakdown.
- Sanitized example agent trace.
- Architecture, evaluation, reliability, and cost pages.

## 6. User experience and design system

### Visual direction

- Dark charcoal base, warm orange primary accent, electric green opportunity
  accent, and blue wind/weather layers.
- Map-first layouts and editorial typography.
- Restrained animation conveying wind direction, forecast progression, and tool
  execution.
- Mobile-first opportunity pages because most authenticated visits originate from
  SMS deep links.
- WCAG 2.2 AA color contrast, keyboard navigation, reduced-motion support, and
  screen-reader labels.

### Primary routes

```text
/                         Public portfolio landing page
/demo                     Fixture-based interactive demo
/dashboard                Authenticated opportunity dashboard
/segments                 Monitored segment management
/segments/:id             Segment history and forecast
/opportunities/:id        Mobile-first alert destination
/copilot                  AI cycling copilot
/settings/strava          Strava connection and data controls
/settings/alerts          Phone, thresholds, and quiet hours
/engineering              Architecture and evaluation showcase
```

### Core components

```text
OpportunityCard            SegmentMap
WindVectorLayer            ForecastTimeline
ProbabilityGauge           TargetTimeComparison
ScoreFactorBreakdown       RiderReadiness
SmsPreview                 AgentChat
ToolCallTrace              ArchitectureViewer
EvaluationSummary          CostSummary
```

## 7. Technology choices

### Web

- Next.js 15, React, and TypeScript.
- Tailwind CSS and accessible headless UI primitives.
- MapLibre GL by default to avoid mandatory per-map Mapbox costs; a Mapbox provider
  remains possible behind an adapter.
- Recharts for common charts; custom canvas/WebGL for dense wind overlays if needed.
- TanStack Query for client-side server state.
- Zod schemas generated or synchronized from shared API contracts.
- Vitest, Testing Library, Mock Service Worker, and Playwright.

### Backend and analytics

- Python 3.12.
- FastAPI for local/API service interfaces when a web framework is needed.
- Pydantic v2 contracts.
- `httpx` with certificate verification, deadlines, retries, and connection pooling.
- `uv` for reproducible Python dependencies.
- `uv` exclusively manages Python installation, virtual environments, dependency
  groups, workspace packages, and lock files; direct `pip`, Poetry, and Conda
  workflows are not supported.
- Lightweight Lambda handlers for scheduled/event-driven work.
- Containerized AgentCore workloads only where AgentCore requires them.

### AI and MCP

- Amazon Bedrock foundation model selected by an evaluated quality/cost policy.
- Strands Agents with Bedrock AgentCore Runtime.
- AgentCore Gateway as the governed MCP endpoint.
- Python MCP SDK/FastMCP for custom servers.
- Bedrock Guardrails and explicit application-layer policies.
- Prompt, tool schema, and evaluation dataset versioning.

### Infrastructure

- Terraform 1.8+ with AWS provider 5+; exact versions pinned in lock files.
- Separate `dev` and `prod` roots with shared modules.
- Remote state in S3 with locking and encryption.
- GitHub Actions OIDC federation; no long-lived AWS keys in GitHub.
- AWS provider default tags for application, environment, owner, cost center, and
  managed-by metadata.

## 8. Data model

Use a small number of DynamoDB tables with explicit access patterns. Start with a
single application table unless metrics prove separate tables are advantageous.

### Core entities

```text
User
StravaConnection
RiderProfile
AlertPreference
Segment
UserSegment
SegmentEffort
ForecastSnapshot
Opportunity
Notification
AgentTraceMetadata
WebhookEvent
```

### Example keys

```text
PK USER#<user_id>             SK PROFILE
PK USER#<user_id>             SK STRAVA
PK USER#<user_id>             SK SEGMENT#<segment_id>
PK SEGMENT#<segment_id>       SK METADATA
PK SEGMENT#<segment_id>       SK FORECAST#<timestamp>
PK USER#<user_id>             SK OPPORTUNITY#<timestamp>#<id>
PK OPPORTUNITY#<id>           SK NOTIFICATION#<id>
```

Large or replayable objects belong in S3:

- raw and normalized Strava payloads;
- segment polylines and derived section data;
- sanitized historical imports;
- evaluation datasets and run artifacts;
- large execution traces;
- generated public demo fixtures.

### Retention

- Raw webhook bodies: 14-30 days.
- Forecast snapshots: 30-90 days, aggregated before expiration.
- Detailed agent traces: 14-30 days in production; sanitized exemplars retained.
- Opportunity evidence: retained with compact normalized fields.
- S3 lifecycle transitions/deletion configured in Terraform.

## 9. Opportunity algorithm

### Wind component

Weather direction is commonly reported as the direction wind comes from. Convert it
to a travel direction before comparing it with road bearing.

For section `i`:

```text
wind_to_i = (wind_from_i + 180) mod 360
tailwind_i = wind_speed_i * cos(wind_to_i - road_bearing_i)
crosswind_i = abs(wind_speed_i * sin(wind_to_i - road_bearing_i))
```

Aggregate using section distance and optional exposure/grade weights:

```text
effective_tailwind = sum(tailwind_i * weight_i) / sum(weight_i)
```

Tests must cover cardinal directions, wraparound at 0/360 degrees, curved routes,
missing points, units, and meteorological direction conventions.

### MVP opportunity score

Use transparent normalized components:

```text
score =
    wind_benefit
  + temperature_benefit
  + readiness_benefit
  + forecast_confidence
  - precipitation_penalty
  - gust_penalty
  - fatigue_penalty
  - uncertainty_penalty
```

Hard gates can reject a window before scoring, for example excessive gusts,
lightning risk, or insufficient forecast coverage.

### Prediction evolution

1. Baseline heuristic calibrated on historical efforts.
2. Regularized regression with time-aware cross-validation.
3. Quantile regression for predicted time intervals.
4. Per-rider calibration only after sufficient data exists.
5. Optional SageMaker training only if the dataset and portfolio value justify the
   cost; local/CI training and Lambda inference are preferred initially.

Metrics include MAE, interval coverage, calibration error, false-alert rate, PB
precision, and opportunity recall.

## 10. MCP design

### Strava MCP

```text
list_starred_segments
get_segment
get_personal_best
list_segment_efforts
get_recent_rides
```

### Weather MCP

```text
get_hourly_forecast
get_route_weather
find_favorable_weather_windows
```

### Opportunity MCP

```text
calculate_wind_alignment
score_pb_opportunity
predict_segment_time
compare_opportunity_windows
```

### Notification MCP

```text
preview_pb_alert
send_pb_alert
get_alert_delivery_status
update_alert_preferences
```

### Tool contract requirements

- JSON input and output schemas.
- Units and coordinate conventions.
- Explicit error codes and retryability.
- Provenance, observed/forecast timestamps, and confidence.
- Behavioral annotations such as read-only, idempotent, or mutating.
- User and tenant scope enforced outside the model.
- Idempotency key required for notification sends.

## 11. Security and privacy

- Least-privilege IAM per function, workflow, and agent.
- GitHub OIDC roles restricted by repository, branch/environment, and workflow.
- Strava refresh tokens encrypted with KMS and never returned to the browser.
- Secrets Manager for provider credentials; Parameter Store for non-secret config.
- No secrets in Terraform variables, state outputs, logs, traces, or test fixtures.
- API Gateway throttling and AWS WAF only when public-risk or traffic justifies its
  recurring cost.
- Signed webhook verification flow and immediate asynchronous acknowledgement.
- Input validation at every network boundary.
- Treat Strava metadata, weather text, MCP resources, and retrieved documents as
  untrusted content.
- Explicit confirmation for mutable MCP calls in interactive sessions.
- Encrypt DynamoDB and S3; block public S3 access.
- CloudTrail and security-relevant alarms.
- User export and deletion path.
- Sanitize location data in the public demo and portfolio traces.

## 12. Reliability and observability

### Reliability patterns

- At-least-once event handling with idempotency records.
- SQS dead-letter queues for webhook, forecast, and notification processing.
- Exponential backoff and jitter for Strava/weather calls.
- Circuit breaker or temporary suppression after repeated provider failures.
- Conditional DynamoDB writes to prevent duplicate alerts.
- Forecast version attached to every opportunity and SMS.
- Agent failure never blocks deterministic alert generation.

### Telemetry

- JSON logs with correlation, user-hash, segment, opportunity, workflow, and trace
  IDs.
- CloudWatch embedded metrics for low-overhead custom metrics.
- X-Ray/OpenTelemetry traces across API, Step Functions, Lambda, MCP, and Bedrock.
- Dashboards for ingestion, forecast coverage, opportunities, SMS delivery,
  Bedrock calls, latency, failures, and estimated spend.
- Alarms for DLQ depth, error rate, missing scheduled executions, SMS failures,
  unexpected Bedrock volume, and budget thresholds.

## 13. Testing and evaluation strategy

### Conventional tests

- Unit tests for bearings, wind components, scoring, quiet hours, deduplication, and
  message segmentation.
- Contract tests for Strava, weather, MCP, events, and API schemas.
- Integration tests using recorded/sanitized provider responses.
- Terraform formatting, validation, linting, security scanning, and plan checks.
- Playwright tests for public demo, OAuth boundaries using mocks, dashboard, SMS
  preview, and mobile deep links.

### AI evaluations

- Correct tool selection.
- Correct and complete tool arguments.
- No invented numerical facts.
- Evidence coverage and citation fidelity.
- Safe handling of excessive gusts or missing weather.
- Appropriate confirmation before mutation.
- Response usefulness, concision, latency, and cost.
- Regression suite of at least 30 scenarios before production launch.

### Replay

Record sanitized MCP responses and deterministic inputs so agent runs can be
replayed without Strava, weather, SMS, or Bedrock network calls. CI uses replay by
default; paid end-to-end evaluation runs are manual or scheduled sparingly.

## 14. Cost-conscious design

The detailed strategy is in `docs/architecture/COST_STRATEGY.md`. Core decisions:

1. Static/public pages are generated or cached; the demo uses fixtures.
2. Lambda and managed serverless services replace idle containers.
3. DynamoDB on-demand avoids provisioned idle capacity.
4. Forecasts are batched by geography and cached across segments.
5. EventBridge schedules a few forecast sweeps per day, increasing only near a
   promising time window.
6. Bedrock is not invoked for rejected opportunities and public demo views.
7. The explanation uses a lower-cost model unless evaluation requires a larger one.
8. AgentCore is enabled only for authenticated copilot traffic and portfolio demos
   that explicitly request a live run.
9. SMS messages are concise and deduplicated.
10. Log retention, trace sampling, S3 lifecycle, budgets, and kill switches are
    configured from day one.

## 15. Terraform strategy

Everything in AWS is declared by Terraform, including:

- state/bootstrap resources;
- GitHub OIDC providers and deployment roles;
- Amplify application and branch configuration;
- Cognito resources;
- API Gateway, Lambda, layers, and permissions;
- EventBridge schedules and event rules;
- Step Functions state machines;
- SQS queues and DLQs;
- DynamoDB tables and indexes;
- S3 buckets and lifecycle rules;
- KMS keys, Secrets Manager placeholders, and IAM policies;
- Bedrock Guardrails, Knowledge Base resources where used, AgentCore resources when
  provider/API support is available, or explicit deployment adapters otherwise;
- SMS configuration and resource policies where Terraform provider coverage permits;
- CloudWatch dashboards, alarms, log groups, budgets, and cost-anomaly monitors;
- DNS and certificates when a domain is selected.

No production infrastructure is created manually without recording an exception
and importing it into Terraform.

## 16. CI/CD strategy

### Pull request

- Detect affected workspaces.
- Format, lint, type-check, and unit test TypeScript and Python.
- Validate OpenAPI/JSON schemas and compatibility.
- Run Terraform fmt, validate, TFLint, and Checkov/tfsec.
- Create a read-only Terraform plan for `dev`.
- Run web build and fixture-based Playwright smoke tests.
- Upload reports and plan artifacts without exposing secrets.

### Merge to `main`

- Build immutable web/function/container artifacts.
- Generate SBOM and vulnerability scan.
- Publish artifacts tagged with Git SHA.
- Apply Terraform to `dev` after environment approval rules.
- Run migrations/import steps designed to be idempotent.
- Execute deployed smoke and contract tests.

### Production

- Triggered by a signed version tag or manual promotion of an existing SHA.
- GitHub `production` environment approval required.
- Apply the exact reviewed Terraform plan or re-plan with drift detection.
- Deploy immutable artifacts already tested in `dev`.
- Run canary checks and rollback application configuration if necessary.

GitHub Actions authenticates to AWS through OIDC and short-lived role sessions. No
AWS access key is stored as a GitHub secret.

## 17. Delivery phases and acceptance criteria

### Phase 0: Foundation

- Monorepo tooling, formatting, tests, pre-commit hooks, and documentation.
- Root `uv` project, pinned Python version, committed lock file, and CI using
  `uv sync --locked`; introduce workspace members as Python services are created.
- Terraform bootstrap, dev environment, GitHub OIDC, budgets, and baseline alarms.
- Public fixture-based landing page deployed.

**Exit:** A pull request produces green checks and a Terraform plan; merge deploys a
static public demo to dev.

### Phase 1: Strava vertical slice

- Cognito and Strava OAuth for the owner account.
- Typed Strava client, encrypted token storage, starred segment sync.
- One monitored segment shown on the web map.

**Exit:** The owner connects Strava and sees a real starred segment without secrets
or private location data in logs.

### Phase 2: Wind opportunity engine

- Weather provider adapter and caching.
- Polyline sampling, wind-vector calculations, opportunity scoring.
- Seven-day dashboard and detailed evidence page.

**Exit:** Golden fixture calculations pass and at least one real segment produces a
reproducible forecast timeline.

### Phase 3: SMS closed loop

- AWS SMS test/registered origination setup.
- Alert queue, idempotency, quiet hours, delivery tracking, and deep links.
- Strava webhook post-ride analysis.

**Exit:** A qualifying opportunity texts the verified owner phone exactly once and a
subsequent ride produces a result notification.

### Phase 4: MCP and Bedrock

- Deploy Strava, weather, opportunity, and notification MCP tools.
- AgentCore Gateway and Runtime with a Strands agent.
- Streaming copilot and inspectable tool trace.
- Guardrails and initial agent evaluation suite.

**Exit:** The agent answers the golden scenarios with grounded values and passes
tool-selection, safety, and mutation-confirmation thresholds.

### Phase 5: Prediction and portfolio polish

- Historical import from `my-strava` through a one-time sanitized adapter.
- Baseline versus learned predictor evaluation.
- Engineering, evaluation, cost, and architecture pages.
- Accessibility, performance, SEO, and mobile polish.

**Exit:** Public demo is usable without login, mobile Lighthouse targets are met,
cost dashboard is populated, and the repository documents reproducible deployment.

## 18. Initial backlog

### P0

- Monorepo bootstrap and pinned toolchains.
- Architecture decision records.
- Terraform remote-state bootstrap.
- GitHub OIDC and CI validation.
- Public demo shell.
- Domain contracts for segment, forecast, opportunity, and notification.
- Wind-vector unit-test suite.

### P1

- Strava OAuth and client.
- DynamoDB access layer.
- Starred segment import.
- Weather adapter and cache.
- Opportunity dashboard.
- SMS test flow.

### P2

- Strava webhooks.
- AgentCore Gateway and MCP tools.
- Bedrock copilot.
- Evaluation dashboard.
- Historical data importer.

### P3

- Learned personalized prediction.
- Additional weather providers.
- Public multi-user onboarding.
- Richer notification channels.

## 19. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Strava API review or endpoint restrictions | Owner-only MVP, cache permitted data, avoid leaderboard dependency, provide fixture demo |
| Weather forecasts are spatially coarse | Display confidence, sample multiple points, validate against historical observations |
| Too many false alerts | Conservative thresholds, cooldowns, calibration metrics, user feedback |
| Unsafe recommendation | Deterministic gates, uncertainty, guardrails, no safety guarantees |
| SMS registration delays | Start with verified/test destination and in-app alerts; submit registration early |
| Bedrock/AgentCore cost or availability | Deterministic core, replay fixtures, opt-in live demo, model routing |
| Terraform provider lacks a new AWS feature | Use AWS Cloud Control/API deployment adapter only as a documented temporary bridge, then import/migrate when supported |
| Location privacy exposure | Redact home zones, sanitize demo fixtures, short trace retention |

## 20. Definition of done

A feature is complete when:

- behavior and failure modes are documented;
- contracts are versioned;
- tests cover the happy path and critical edge cases;
- least-privilege IAM is reviewed;
- logs and metrics avoid secrets/private location data;
- cost impact is understood;
- Terraform declares its infrastructure;
- CI validates it and CD promotes it;
- user-facing behavior is accessible and mobile-friendly;
- relevant evaluation or operational dashboards are updated.
