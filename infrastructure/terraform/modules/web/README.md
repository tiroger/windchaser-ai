# web

Amplify hosting for the Next.js application, the Strava secret it reads at
runtime, and the compute role that lets it read that secret and nothing else.

## Why Amplify, and why Next.js 15

Amplify Hosting compute supports Next.js 12 through 15. The application is
pinned to 15 for that reason. Any future Next upgrade is gated on Amplify's
supported version matrix, not on what npm offers.

`platform = "WEB_COMPUTE"` is what runs server-side rendering and API routes.
The static platform would drop them, and with them the Strava credentials that
must never reach the browser.

Streaming responses are not supported by Amplify. That does not matter yet; it
will when the copilot in phase 4 wants to stream.

## Two manual steps, and why they exist

### 1. Connect the repository

Terraform creates the Amplify app but cannot complete a GitHub App connection:
that authorization has no Terraform representation. Once, in the console:

  Amplify → windchaser-dev → Hosting → connect the repository → GitHub App →
  authorize → pick tiroger/windchaser-ai, branch main

Supplying `github_access_token` instead connects it with a personal access
token, which Terraform can express but which is a long-lived credential with
repository read access. The GitHub App is the better default; the token exists
for anyone who would rather not click.

This is the documented exception required by
`docs/architecture/TERRAFORM_AND_CICD.md`: infrastructure created outside
Terraform is recorded rather than left implicit.

### 2. Populate the secret

Terraform creates the secret and never its value, per section 11 of the project
plan. Write it once:

```bash
aws secretsmanager put-secret-value \
  --secret-id windchaser/dev/strava \
  --secret-string '{
    "STRAVA_CLIENT_ID":"...",
    "STRAVA_CLIENT_SECRET":"...",
    "STRAVA_REFRESH_TOKEN":"..."
  }'
```

Rotating it later touches nothing here. The app caches the value for the life
of the container, so a rotation takes effect on the next cold start.

### 3. Populate the owner-mode secret

The Training section's owner mode (ADR-0004) reads a second secret, which only
the web runtime can read; neither Strava worker can. Write it once:

```bash
aws secretsmanager put-secret-value \
  --secret-id windchaser/dev/web \
  --secret-string '{
    "admin_passphrase":"... at least 16 characters ...",
    "admin_session_secret":"... at least 32 characters ..."
  }'
```

The Strava secret also carries `STRAVA_VERIFY_TOKEN` for the webhook. Both
workers may rewrite that document when Strava rotates the refresh token, and
each replaces only `STRAVA_REFRESH_TOKEN`, so keys added by hand survive.

## What the app reads at runtime

| Variable | Purpose |
|---|---|
| `STRAVA_SECRET_ARN` | Where to fetch credentials. Not itself secret; reading it requires the compute role |
| `AWS_REGION_NAME` | Region for the Secrets Manager client |
| `AMPLIFY_MONOREPO_APP_ROOT` | Which application in the monorepo to build |
| `AMPLIFY_DIFF_DEPLOY` | Off. Diff deploys decide by changed path and get it wrong for an app depending on files above its own root |
| `LIVE_AI_ENABLED` | Off until the briefing is wired to Bedrock, so a misconfiguration cannot quietly start spending on inference |
| `ACTIVITIES_S3_KEY`, `BIKES_S3_KEY`, `STREAMS_S3_PREFIX`, `STREAMS_INDEX_S3_KEY`, `SAVED_ROUTES_S3_KEY`, `SAVED_ROUTES_S3_PREFIX` | Training objects written by `training_sync`; read only |
| `MAINTENANCE_S3_KEY`, `SETTINGS_S3_KEY` | The two objects the runtime may write, on the owner's behalf |
| `WEB_SECRET_ARN` | Owner-mode secret |
| `TRAINING_EVENTS_QUEUE_URL`, `STRAVA_ATHLETE_ID` | Where the webhook forwards this rider's activity events; either unset skips forwarding |

Locally the same credentials come from `.env`; the environment wins over the
secret, so a local checkout keeps working unchanged.

## Cost

Amplify compute bills per request and per GB-hour, with a free tier that a
portfolio-scale app sits inside. The secret costs about forty cents a month,
which is why the three credentials share one secret rather than having three.
Build minutes are the variable most likely to surprise; `AMPLIFY_DIFF_DEPLOY`
being off means every push to the tracked branch builds.

Versions superseded more than 30 days ago are expired, keeping the newest ten
of each object. The bucket is versioned and the Training sync rewrites its
objects on every ride, so without the rule its size would track its history
rather than its data.
