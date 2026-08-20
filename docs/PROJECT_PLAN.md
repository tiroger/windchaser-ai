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

- Light and dark are both designed, not inverted, and follow the reader's system
  preference unless they choose otherwise. The basemap swaps with the theme.
- Three accent roles, each meaning one thing: warm orange for the rider and
  their effort, green for an open window, blue for wind and weather.
- Data colours are validated per theme for OKLCH lightness band, chroma
  floor, colour-vision separation, and contrast against that theme's surface.
  `scripts/validate_palette.js` in the dataviz skill is the check of record.
- One typeface superfamily, Geist and Geist Mono, so measured values and the
  labels beside them read as one system. Every number is tabular.
- Depth from layered surfaces and restrained shadow rather than a hairline
  border on every element.
- Map-first layouts.
- Restrained animation conveying wind direction, forecast progression, and tool
  execution. The wind field is advected by the real forecast vector, so the
  motion carries information rather than decorating.
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
SegmentCellMap
ForecastCell
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
PK SEGMENT#<segment_id>       SK CELLMAP#<geometry_version>
PK CELL#<geohash>             SK FORECAST#<issued_at>#<valid_at>
PK USER#<user_id>             SK OPPORTUNITY#<timestamp>#<id>
PK OPPORTUNITY#<id>           SK NOTIFICATION#<id>
```

Forecast data is keyed by provider grid cell, never by segment. Two segments a few
hundred metres apart resolve to the same cell and share one cached provider
response, as do the same segments across different users. Storing a forecast copy
per segment would multiply provider calls by segment count and invalidate the
caching policy in `docs/architecture/COST_STRATEGY.md`.

`SegmentCellMap` records which cells the segment's sections resolve to, versioned
by geometry so a re-decoded polyline does not silently reuse a stale mapping. The
opportunity evidence snapshot records the cell identifiers and issuance times
actually used, so a past decision can be replayed exactly.

Large or replayable objects belong in S3:

- raw and normalized Strava payloads;
- segment polylines and derived section data;
- sanitized historical imports;
- evaluation datasets and run artifacts;
- large execution traces;
- generated public demo fixtures.

### Retention

- Raw webhook bodies: 14-30 days.
- Forecast cells: 7-14 days by DynamoDB TTL. They are a cache, and the values that
  mattered are already copied into the opportunity evidence snapshot.
- Forecast-versus-actual pairs used for calibration: retained in compacted form in
  S3, independent of the cell TTL.
- Detailed agent traces: 14-30 days in production; sanitized exemplars retained.
- Opportunity evidence: retained with compact normalized fields.
- S3 lifecycle transitions/deletion configured in Terraform.

## 9. Opportunity algorithm

### Organizing rule

Inputs fall into two categories and are never mixed:

1. Anything that changes the predicted **time** enters the physics model: wind
   resolved per section, air density, gradient, and available rider power.
2. Anything that changes whether the rider **wants to go**, without materially
   changing the time, stays a score modifier: precipitation, gust handling risk,
   daylight, and quiet hours.

Forecast uncertainty belongs to neither. It widens the predicted time interval,
which lowers the probability of beating the target, which lowers the score by
construction. Uncertainty is never added to the score as its own term, because a
confident mediocre window must not outrank an uncertain excellent one.

### Section geometry

Decode the segment polyline and resample it into sections short enough that
bearing and gradient are approximately constant within each one. Target 50-100 m
sections, subdividing further where curvature is high.

Each section carries distance, bearing, gradient, elevation, and an optional
exposure factor. Weather is attached per section from the nearest cached forecast
grid cell rather than requested per section.

### Wind component

Weather direction is commonly reported as the direction wind comes from. Convert
it to a travel direction before comparing it with road bearing.

For section `i`:

```text
wind_to_i = (wind_from_i + 180) mod 360
tailwind_i = wind_speed_i * cos(wind_to_i - road_bearing_i)
crosswind_i = abs(wind_speed_i * sin(wind_to_i - road_bearing_i))
headwind_i = -tailwind_i
```

Apply exposure to reduce the effective wind on sheltered sections:

```text
tailwind_i = tailwind_i * exposure_i
crosswind_i = crosswind_i * exposure_i
```

### Section speed

Solve a constant-power model for ground speed on each section:

```text
v_air_i     = v_i + headwind_i
drag_i      = 0.5 * rho * CdA * v_air_i * abs(v_air_i)
rolling_i   = Crr * m * g * cos(atan(grade_i))
gravity_i   = m * g * sin(atan(grade_i))
power_i(v_i) = v_i * (drag_i + rolling_i + gravity_i) / drivetrain_efficiency
```

Find `v_i` such that `power_i(v_i) = power_available`. The left side is monotonic
in `v_i`, so bisection converges reliably and needs no closed-form cubic solution.

Two details that unit tests must pin:

- `v_air * abs(v_air)` preserves sign, so a tailwind stronger than ground speed
  correctly becomes a forward push rather than a drag penalty.
- Air density is a function of temperature, pressure, and humidity. Temperature
  therefore enters the time model here, not as an additive score term.

Rider readiness enters the same way, as an adjustment to `power_available`
derived from recent training load. Fatigue is a power input, not a score penalty.

### Segment time estimate

```text
t_i = d_i / v_i
predicted_time = sum(t_i)
```

Aggregate in time, never in wind. Drag is quadratic in air speed, so a headwind
costs more time than an equal tailwind returns. A distance-weighted mean tailwind
collapses that asymmetry and is approximately zero for any out-and-back or loop
regardless of wind speed, which is exactly the case route-aware analysis exists to
handle.

Reference values for 10 km, flat, 250 W, 80 kg, CdA 0.32, Crr 0.005, air density
1.225 kg/m3, and drivetrain efficiency 1.0:

| Window | Mean tailwind | Modelled time | vs calm |
|---|---|---|---|
| Calm | 0.0 m/s | 16.29 min | — |
| 8 m/s, out-and-back | 0.0 m/s | 19.29 min | +18.4% |
| 12 m/s, out-and-back | 0.0 m/s | 23.31 min | +43.1% |
| 8 m/s, four-sided loop | 0.0 m/s | 17.79 min | +9.2% |
| 8 m/s, point-to-point tailwind | +8.0 m/s | 10.55 min | -35.2% |

The first four rows are indistinguishable under mean-tailwind aggregation and
differ by up to seven minutes in reality. They are committed as golden fixtures.

### Reported wind summary

A single scalar remains useful for SMS copy and dashboard labels:

```text
effective_tailwind = sum(tailwind_i * d_i) / sum(d_i)
```

This value is presentational only. It must not be an input to prediction,
scoring, or alert eligibility, and the contract marks it as such.

### Hard gates

Gates are evaluated before scoring. Any failure rejects the window and records
the failing gate in the evidence snapshot.

- Sustained wind or gust above the handling threshold.
- Lightning probability above threshold.
- Forecast coverage below the minimum fraction of sections with valid data.
- Forecast age beyond the maximum staleness allowed for the window.
- Window falling inside rider quiet hours or outside required daylight.
- Provider-reported ice or standing water where available.

### Opportunity score

The prediction produces a time distribution, not a point estimate. Score from
that distribution and the rider's target:

```text
p_beat = P(predicted_time < target_time)
margin = clamp((target_time - median_time) / (target_time * margin_scale), 0, 1)

score = w_beat    * p_beat
      + w_margin  * margin
      - w_precip  * precipitation_penalty
      - w_gust    * gust_penalty
      - w_comfort * comfort_penalty

score = clamp(score, 0, 1)
```

| Term | Meaning | Range | Starting weight |
|---|---|---|---|
| `p_beat` | Probability of beating the target | 0-1 | 0.70 |
| `margin` | How far under target the median falls | 0-1 | 0.30 |
| `precipitation_penalty` | Rain or snow intensity | 0-1 | 0.25 |
| `gust_penalty` | Gust spread above sustained wind | 0-1 | 0.20 |
| `comfort_penalty` | Heat, cold, or low visibility | 0-1 | 0.15 |

Benefit weights sum to 1.0. Penalties are subtractive and the result is clamped,
so the score stays comparable across riders and segments. Weights are versioned
configuration, not constants in code, and the active version is written into
every evidence snapshot so past decisions remain explicable.

Alert eligibility is a threshold on `p_beat`, not on `score`. The score orders the
dashboard; the probability authorizes an SMS. Keeping these separate means tuning
presentation never silently changes who gets texted.

### Uncertainty

Interval width comes from forecast spread, model residual variance, and effort
variance for the rider on that segment. Widening the interval reduces `p_beat`
automatically, which is the only channel through which confidence affects
outcomes.

Where multiple forecast issuances cover the same window, disagreement between
them is a direct uncertainty signal and is preferred over a provider-reported
confidence value.

### Prediction evolution

1. Baseline physics model calibrated against historical efforts to fit per-rider
   `CdA`, `Crr`, and sustainable power.
2. Regularized regression on the physics model residual with time-aware
   cross-validation.
3. Quantile regression for predicted time intervals.
4. Per-rider calibration only after sufficient data exists.
5. Optional SageMaker training only if the dataset and portfolio value justify the
   cost; local/CI training and Lambda inference are preferred initially.

Learned stages predict the residual rather than replacing the physics model, so
the system degrades to a defensible estimate when a rider has little history.

### Metrics

Prediction quality is measured by backtesting against historical efforts, where
sample sizes are adequate:

- Mean absolute error against actual elapsed time.
- Prediction interval coverage against nominal level.
- Calibration error of `p_beat` in probability bins.
- Improvement over a naive still-air baseline.

Alert quality is measured operationally. With a single rider these are counters
and review items, not statistics, and must not be reported as rates until the
sample supports it:

- Alerts sent, attempted, and converted to a target-beating effort.
- Alerts suppressed by each gate, cooldown, and quiet-hours rule.
- Windows where the forecast materially changed after the alert was sent.

### Required tests

- Cardinal directions and wraparound at 0/360 degrees.
- Meteorological direction convention, verified against a known-good case.
- Curved routes, out-and-back routes, and closed loops.
- Tailwind exceeding ground speed.
- Zero-length and single-point sections, and missing forecast points.
- Unit consistency across m/s, km/h, and mph at every boundary.
- Gradient sign on climbs and descents.
- The golden fixture table above, asserted end to end.
- Gate precedence, ensuring a failing gate rejects before scoring runs.
- Score monotonicity: increasing `p_beat` with all else fixed must not lower the
  score.

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

- Unit tests for quiet hours, deduplication, cooldown, and message segmentation.
- The geometry, wind, speed, gate, and scoring cases enumerated in section 9 under
  "Required tests", including the golden fixture table. Section 9 owns that list;
  it is not restated here so the two cannot drift apart.
- Contract tests for Strava, weather, MCP, events, and API schemas.
- Integration tests using recorded/sanitized provider responses.
- Terraform formatting, validation, linting, security scanning, and plan checks.
- Playwright tests for public demo, OAuth boundaries using mocks, dashboard, SMS
  preview, and mobile deep links.

### Prediction evaluation

Section 9 defines the metrics and draws the line between backtested prediction
quality and operational alert counters. This section defines how they are run.

- A backtest harness replays stored forecast-versus-actual pairs against a named
  model version and emits the section 9 prediction metrics.
- Cross-validation is time-aware. Splits never let a later effort inform an
  earlier prediction, because a rider's fitness trends over a season.
- Every run records the model version, weight configuration version, and dataset
  hash, so a reported number can be traced to what produced it.
- CI runs the backtest on the committed fixture dataset and fails on regression
  against a recorded baseline. Full-history runs are manual.
- A naive still-air prediction is retained as the control. A learned model that
  does not beat it is not shipped.
- Operational alert counters are reviewed, not gated. With a single rider the
  sample cannot support a false-alert rate, and treating it as one would tune the
  system on noise.

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
