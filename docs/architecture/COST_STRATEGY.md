# AWS Cost Strategy

## Objective

Operate a fully featured owner/portfolio deployment at the lowest practical cost
without creating an architecture that must be discarded for moderate growth.
Actual AWS and carrier prices vary by region, model, and destination, so Terraform
budgets and measured usage—not a static estimate—are the source of truth.

## Cost principles

1. Avoid always-on compute and databases.
2. Precompute user-visible results rather than fan out during page requests.
3. Do not invoke paid AI for anonymous page views.
4. Batch, cache, and deduplicate third-party calls.
5. Retain only operationally useful logs and detailed payloads.
6. Put a budget, alarm, quota, or kill switch around every variable-cost subsystem.

## Cost profile by component

| Component | Expected portfolio behavior | Control |
|---|---|---|
| Amplify Hosting | Small static/SSR site and assets | Cache assets, prerender public pages, limit build frequency |
| API Gateway | Low request volume | HTTP API, authenticated endpoints, throttling |
| Lambda | Short bursty jobs | Right-size memory, arm64 where supported, bounded timeouts |
| Step Functions | A few forecast sweeps/day | Batch segments per execution; compare Standard and Express from measurements |
| DynamoDB | Small on-demand workload | Single-table design, TTL, avoid scans, on-demand mode |
| S3 | Small fixtures and payload archive | Compression and lifecycle expiration |
| Secrets Manager | Small fixed per-secret cost | Consolidate only where security boundaries permit; use Parameter Store for non-secrets |
| CloudWatch | Can become unexpectedly material | Structured concise logs, short retention, metric filters sparingly, trace sampling |
| Bedrock | Variable per token | Small evaluated model, concise context, caching, no anonymous live inference |
| AgentCore | Variable runtime/session use | Authenticated/explicit use, short sessions, replay demo, optional dev disable switch |
| SMS | Per message part and number fees | Short messages, dedupe, cooldown, hard spend limit |
| NAT Gateway | High fixed cost for a portfolio | Avoid private subnets/NAT initially; use service-native encryption and IAM |
| WAF | Recurring/request costs | Add when threat/traffic profile warrants; use API throttling and auth first |

## Forecast scheduling policy

Instead of checking every segment every hour:

1. Run two or three broad seven-day sweeps per day.
2. Cache forecasts by provider grid cell and forecast issuance time.
3. Reuse cells across nearby segments and users.
4. When a window crosses a watch threshold, schedule focused refreshes as it nears.
5. Stop refreshing expired, snoozed, or low-confidence opportunities.
6. Enforce a per-user and global provider-call budget.

## Bedrock policy

- Opportunity calculation and notification eligibility never require Bedrock.
- Rejected windows receive no generated explanation.
- Use deterministic templates when generation is unavailable or over budget.
- Generate one explanation per material forecast version, not per page view.
- Cache explanations with their evidence hash.
- Route simple summarization to a smaller model; use a larger model only for
  complex interactive questions when evaluations show a benefit.
- Cap input context, output tokens, tool iterations, and agent wall time.
- Expose a `LIVE_AI_ENABLED` operational switch.

## Public portfolio demo

The default demo is built from sanitized fixtures and recorded tool traces. A
reviewer can understand the entire workflow without consuming Strava, weather,
AgentCore, Bedrock, or SMS resources. An explicit “Run live AI demo” action can be
rate-limited, authenticated with a lightweight demo token, or disabled when a
monthly threshold is reached.

## SMS controls

- Transactional message type.
- Send only after verified consent.
- Keep content compact and use a deep link for detail.
- Idempotency key: user + segment + opportunity window + forecast material version.
- Per-user cooldown and daily maximum.
- Global daily maximum and account spending quota.
- Test mode restricts destinations to an allowlist.

## Observability controls

- Dev log retention: 7-14 days.
- Production application logs: 14-30 days initially.
- Sample successful traces; retain all error traces within a cap.
- Store large replay artifacts in compressed S3 objects rather than CloudWatch.
- Avoid high-cardinality CloudWatch metric dimensions.
- Dashboard only decision-relevant metrics.

## Terraform-enforced guardrails

- AWS Budget alerts at staged actual and forecast thresholds.
- Cost Anomaly Detection monitor/subscription.
- Lambda reserved concurrency on expensive or externally connected workers.
- API Gateway throttles.
- SQS maximum receive count and retention.
- DynamoDB TTL.
- S3 lifecycle expiration.
- Log-group retention.
- Bedrock and SMS runtime kill-switch parameters.
- Required cost-allocation tags.

## Initial budget targets

Set targets after confirming region and SMS origination requirements. Recommended
starting guardrails for an owner-only environment:

```text
dev warning threshold       low double-digit USD/month
prod warning threshold      low double-digit USD/month
forecast anomaly            >2x trailing daily average
Bedrock request ceiling     explicit daily count/token budget
SMS ceiling                 explicit daily send count and AWS spending quota
```

Avoid claiming an exact monthly total until Terraform plans, selected Bedrock model,
weather provider, domain, SMS number/registration, and real traffic are known. Add a
monthly cost review to the release checklist.

## When to add more expensive infrastructure

- Add WAF when the public endpoint attracts meaningful traffic or abuse.
- Add provisioned DynamoDB only when measured steady demand is cheaper.
- Add private networking/NAT only for a documented security or connectivity need;
  prefer VPC endpoints where viable.
- Add SageMaker hosted inference only when a learned model cannot run economically
  in Lambda or batch.
- Add OpenSearch/managed vector infrastructure only when the knowledge corpus and
  retrieval quality justify it.

