# ADR-0004: Merge my-strava into WindChaser as its Training section

## Status

Accepted. Supersedes [ADR-0001](0001-new-repository.md).

## Context

ADR-0001 kept `my-strava` at arm's length because it was a tightly coupled
Streamlit/Pandas application with local file persistence and old dependencies.
That no longer describes it: it was rebuilt on this project's own stack (Next.js
15 on Amplify, a Python worker behind SQS, S3 JSON, Terraform delivered through
GitHub Actions with OIDC) and modelled on this repository's conventions.

Both applications serve one rider through one Strava API application, and that
is where running them separately breaks down:

- Strava allows one webhook subscription per application. WindChaser holds it.
- Both would hold the same refresh token. When Strava rotates it, whichever
  project did not perform the refresh is locked out.
- Both workers would fetch the same activities against one shared rate limit.
- Two Amplify apps, buckets, budgets and alarm sets cost and alert twice.

## Decision

Bring my-strava into this repository as WindChaser's **Training** section, one
application serving both purposes.

- **Web:** Training lives under `/training/*` beside the wind view at `/`, with
  a shared masthead switching between them. It uses this project's design
  tokens, fonts and light/dark themes.
- **Ingestion:** WindChaser's webhook endpoint stays the single Strava callback
  and forwards each activity event to a second worker, `training_sync`, on its
  own FIFO queue. The two workers write disjoint S3 keys, so neither can
  overwrite the other; each keeps its own serialization.
- **Credentials:** both workers use the existing `windchaser/{env}/strava`
  secret, re-reading it before writing a rotated refresh token, so the token
  cannot diverge. Owner-mode values live in a separate `windchaser/{env}/web`
  secret.
- **Rate limit:** non-urgent Training work (detail-stream backfill, saved-route
  profiles) is subject to the same 80%-of-daily-quota gate as WindChaser's own
  discretionary calls.
- The my-strava repository is archived and its AWS stack removed once Training
  is live here.

## Alternatives considered

- **A second Strava application for my-strava**, owned by another Strava
  account. Clean separation, but two products, two deployments and two bills
  for one rider, and an account kept only to own an app.
- **Share the application and poll** instead of using the webhook. Avoids the
  subscription limit but leaves both projects rotating one token, and makes new
  rides appear tens of minutes late.
- **Forward this project's webhook to a separate my-strava deployment.** Keeps
  the duplicated infrastructure, and couples two deployments by a cross-project
  queue grant.

## Consequences

- One sign-in to Strava, one webhook, one token, one budget and one set of alarms.
- The web application gains its first write path from the browser: an owner
  mode, behind a passphrase and a signed HTTP-only cookie, that edits goals,
  athlete settings and the maintenance log.
- Training's heavier Strava use shares this application's rate limit; the
  discretionary gate and smaller backfill batches keep WindChaser's calls first.
- Historical activity data is rebuilt from Strava by the worker rather than
  imported, so no personal data passes through this public repository.
- PROJECT_PLAN phase 5's one-time `my-strava` import adapter is no longer needed.
