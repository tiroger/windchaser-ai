"""The Training section's Strava sync: activities, streams, gear and saved routes.

Ported from my-strava (ADR-0004). Runs beside strava_worker, never instead of it:
the two consume separate queues and write disjoint S3 keys, and the contract
between them and the web application is docs/architecture/TRAINING_INTEGRATION.md.
"""
