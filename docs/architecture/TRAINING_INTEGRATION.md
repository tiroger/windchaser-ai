# Training integration

How the Training section (formerly the `my-strava` project, see
[ADR-0004](../decisions/0004-merge-my-strava.md)) fits into WindChaser. The
behaviour, data shapes and tests originate in
[tiroger/my-strava](https://github.com/tiroger/my-strava) at commit `d5e1fb3`.

## Flow

```text
Strava ─► POST /api/strava/webhook ─┬─► windchaser-{env}-strava-events (standard) ─► strava_worker
                                    │     efforts.json, calibration.json
                                    └─► windchaser-{env}-training-events.fifo ─► training_sync
                                          activities, streams, gear, saved routes
EventBridge ─► training-events.fifo: daily "scheduled-reconciliation" (also
               refreshes gear and saved routes), hourly "streams-backfill"
```

- Every message on the training queue uses message group `strava-events`, so
  training writes are applied one at a time. `strava_worker` keeps its reserved
  concurrency of one. The two workers never write the same S3 key.
- The webhook forwards only `object_type == "activity"` events whose `owner_id`
  equals `STRAVA_ATHLETE_ID` to the training queue, as the raw event JSON
  (`object_type`, `aspect_type`, `object_id`, `owner_id`, `subscription_id`,
  `event_time`). Its behaviour toward Strava and the existing queue is unchanged.

## Credentials

| Secret | Read by | Keys |
|---|---|---|
| `windchaser/{env}/strava` | web, `strava_worker`, `training_sync` | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`, `STRAVA_VERIFY_TOKEN` |
| `windchaser/{env}/web` | web only | `admin_passphrase` (≥16 chars), `admin_session_secret` (≥32 chars) |

`training_sync` keeps access tokens in memory only. When Strava returns a new
refresh token, it re-reads the secret and writes back the full JSON with only
`STRAVA_REFRESH_TOKEN` replaced, so other keys and the other worker's view stay
intact.

## S3 objects (bucket `APP_DATA_BUCKET`)

| Key | Written by | Read by | Shape |
|---|---|---|---|
| `activities.json` | training_sync | web | Array of activities: Strava summary fields; distance in miles, moving_time in hours, elevation in feet, speed in mph; `map.summary_polyline` |
| `bikes.json` | training_sync | web | Array of `{id, name, brand, model, distance (mi), retired, kind: bike\|shoe}` |
| `streams/{id}.json` | training_sync | web | `{id, start_date_local, sport_type, samples{time, distance, altitude, watts, heartrate, cadence, velocity, latlng}, summary{…}}` |
| `streams-index.json` | training_sync | web | `{id: {date, sport_type, has_streams, power_bests, normalized_power, …}}` |
| `saved-routes.json` | training_sync | web | Array of saved routes with `profile_updated_at` |
| `saved-routes/{id}.json` | training_sync | web | `{id, updated_at, distance[], altitude[], latlng[]}` |
| `sync-state.json` | training_sync | training_sync | `{last_sync_epoch, updated_at}` |
| `maintenance.json` | web (owner) | web | Array of maintenance records |
| `settings.json` | web (owner) | web | `{goals, athlete}` |

The exact shapes are those produced by `services/training_sync` and parsed by
`apps/web/lib/training/data.ts`; the tests on both sides are the contract.

## Web runtime environment

Added to Terraform's `runtime_environment` and to `amplify.yml`'s allowlist:
`ACTIVITIES_S3_KEY`, `BIKES_S3_KEY`, `STREAMS_S3_PREFIX`, `STREAMS_INDEX_S3_KEY`,
`SAVED_ROUTES_S3_KEY`, `SAVED_ROUTES_S3_PREFIX`, `MAINTENANCE_S3_KEY`,
`SETTINGS_S3_KEY`, `WEB_SECRET_ARN`, `TRAINING_EVENTS_QUEUE_URL`,
`STRAVA_ATHLETE_ID`.

## Web routes

Pages live under `/training` (overview, `activities`, `activities/[id]`,
`routes`, `saved-routes`, `heatmap`, `performance`, `garage`, `year`), with
the sport filter in `?sport=`. Their APIs live under `/api/training/*`
(`activities/[id]`, `routes/[id]`, `heatmap`, `performance`, `saved-routes`,
`saved-routes/[id]`, `settings`, `maintenance`, `admin/session`,
`data-version`). Owner mode is an HTTP-only, `SameSite=Strict` cookie named
`windchaser-owner`, signed with `admin_session_secret` and valid for 8 hours.
State-changing requests also require `Sec-Fetch-Site: same-origin`.

For local development without a bucket, the web app reads a my-strava snapshot
from `TRAINING_LOCAL_DATA_DIR` (`processed_data.csv`, `bike_data.csv`, and
optionally `streams-index.json`, `streams/`, `saved-routes.json`,
`saved-routes/`). A production build refuses this unless
`ALLOW_LOCAL_SNAPSHOT=true`. Neither variable is set in a deployed environment.

## Privacy

The repository is public. No personal data is committed; history is rebuilt
from Strava. Any response carrying coordinates hides everything within 500 m
of a route's start and end, and the worker never stores "Only You" activities.
