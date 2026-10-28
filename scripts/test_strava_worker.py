#!/usr/bin/env python3
"""Exercise the Strava worker's logic without AWS or Strava.

Plain assertions and no test framework, matching how the physics parity check
in CI is written. What is covered is the part that can silently corrupt the
training history: which efforts are accepted, what happens when the same event
arrives twice, and whether an effort too recent for reanalysis is left alone
rather than defaulted to calm.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "packages" / "cycling-analytics"))
sys.path.insert(0, str(REPO))

from services.strava_worker import handler, strava, weather  # noqa: E402


def history() -> dict:
    return {
        "segments": {
            "1001": {
                "id": 1001,
                "name": "Tracked climb",
                "cell_id": "41.00,-73.90",
                "average_grade": 5.0,
                "points": [[41.0, -73.9], [41.01, -73.9]],
            }
        },
        "efforts": [],
    }


def effort(effort_id: int, segment_id: int, when: str) -> dict:
    return {
        "id": effort_id,
        "segment": {"id": segment_id},
        "start_date": when,
        "elapsed_time": 600,
        "moving_time": 590,
        "distance": 3000,
        "average_watts": 240,
        "device_watts": True,
    }


def with_activity(payload: dict):
    """Replace the Strava call with a fixture, restoring it afterwards."""
    original = handler.activity

    def fake(activity_id: int) -> dict:
        return payload

    handler.activity = fake
    return original


def run(name: str, fn) -> None:
    fn()
    print(f"  ok  {name}")


def test_only_tracked_segments_are_recorded() -> None:
    store = history()
    original = with_activity(
        {
            "segment_efforts": [
                effort(1, 1001, "2026-08-01T12:00:00Z"),
                # A segment nobody asked about; ingesting it would cost further
                # Strava reads for geometry against an already-tight quota.
                effort(2, 9999, "2026-08-01T12:00:00Z"),
            ]
        }
    )
    try:
        added = handler.apply_event(
            {"object_type": "activity", "object_id": 55, "aspect_type": "create"},
            store,
        )
    finally:
        handler.activity = original

    assert added == 1, f"expected one effort, got {added}"
    assert store["efforts"][0]["segment_id"] == 1001
    assert store["efforts"][0]["activity_id"] == 55
    assert store["efforts"][0]["weather"] is None, "weather must wait for the archive"


def test_redelivery_adds_nothing() -> None:
    store = history()
    payload = {"segment_efforts": [effort(1, 1001, "2026-08-01T12:00:00Z")]}
    event = {"object_type": "activity", "object_id": 55, "aspect_type": "create"}

    original = with_activity(payload)
    try:
        first = handler.apply_event(event, store)
        # SQS is at-least-once and Strava retries on its own. The same effort
        # arriving twice must not become two efforts, which would weight that
        # ride double in every fit.
        second = handler.apply_event(event, store)
    finally:
        handler.activity = original

    assert first == 1 and second == 0, f"{first}, {second}"
    assert len(store["efforts"]) == 1


def test_delete_removes_that_activity_only() -> None:
    store = history()
    store["efforts"] = [
        {"effort_id": 1, "activity_id": 55, "segment_id": 1001},
        {"effort_id": 2, "activity_id": 56, "segment_id": 1001},
    ]
    removed = handler.apply_event(
        {"object_type": "activity", "object_id": 55, "aspect_type": "delete"}, store
    )
    assert removed == 1, removed
    assert [e["effort_id"] for e in store["efforts"]] == [2]


def test_athlete_events_are_ignored() -> None:
    store = history()
    added = handler.apply_event(
        {"object_type": "athlete", "object_id": 7, "aspect_type": "update"}, store
    )
    assert added == 0


def test_recent_efforts_are_left_for_later() -> None:
    store = history()
    just_now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    long_ago = (
        datetime.now(timezone.utc) - timedelta(days=weather.ARCHIVE_LAG_DAYS + 30)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    store["efforts"] = [
        {"effort_id": 1, "start_date": just_now, "cell_id": "41.00,-73.90", "weather": None},
        {"effort_id": 2, "start_date": long_ago, "cell_id": "41.00,-73.90", "weather": None},
    ]

    calls: list[tuple] = []
    original = weather.fetch_cell_month

    def fake(lat, lon, year, month):
        calls.append((lat, lon, year, month))
        return {}

    weather.fetch_cell_month = fake
    try:
        handler.attach_weather(store)
    finally:
        weather.fetch_cell_month = original

    # Only the old effort may be looked up. Asking the archive about this
    # morning returns nothing useful and spends a request finding that out.
    assert len(calls) == 1, f"expected one cell-month lookup, got {calls}"
    assert store["efforts"][0]["weather"] is None


def test_unparseable_cell_id_does_not_stop_the_rest() -> None:
    store = history()
    long_ago = (
        datetime.now(timezone.utc) - timedelta(days=weather.ARCHIVE_LAG_DAYS + 30)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    store["efforts"] = [
        {"effort_id": 1, "start_date": long_ago, "cell_id": "nonsense", "weather": None},
        {"effort_id": 2, "start_date": long_ago, "cell_id": "41.00,-73.90", "weather": None},
    ]
    seen: list[tuple] = []
    original = weather.fetch_cell_month
    weather.fetch_cell_month = lambda *a: (seen.append(a), {})[1]
    try:
        handler.attach_weather(store)
    finally:
        weather.fetch_cell_month = original
    assert len(seen) == 1, seen


def test_the_trigger_decides_which_path_runs() -> None:
    seen: list[str] = []
    ingest, refresh = handler.ingest, handler.refresh
    handler.ingest = lambda e, c=None: seen.append("ingest")
    handler.refresh = lambda e=None, c=None: seen.append("refresh")
    try:
        handler.main({"Records": [{"eventSource": "aws:sqs", "body": "{}"}]})
        handler.main({"source": "aws.events"})
        # A queue message that is not from SQS is not an ingestion. Guessing
        # from the presence of Records alone would send a scheduled run down
        # the path that expects message bodies.
        handler.main({"Records": [{"eventSource": "aws:s3"}]})
    finally:
        handler.ingest, handler.refresh = ingest, refresh
    assert seen == ["ingest", "refresh", "refresh"], seen


def test_backfill_prefers_the_most_ridden_untracked_segment() -> None:
    store = history()
    bundle = {
        "segments": [
            # Already known; its history is in hand.
            {"id": 1001, "name": "Tracked climb", "effort_count_personal": 40},
            {"id": 2002, "name": "Ridden twice", "effort_count_personal": 2},
            {"id": 2003, "name": "Ridden often", "effort_count_personal": 25},
            # Never ridden: no history to fetch and no record to beat either.
            {"id": 2004, "name": "Never ridden", "effort_count_personal": 0},
        ]
    }
    pick = handler.backfill_candidate(store, bundle)
    assert pick and pick["id"] == 2003, pick


def test_backfill_stops_when_there_is_nothing_left() -> None:
    store = history()
    bundle = {"segments": [{"id": 1001, "name": "Tracked climb", "effort_count_personal": 9}]}
    assert handler.backfill_candidate(store, bundle) is None


def test_backfill_records_history_and_geometry() -> None:
    store = history()
    segment = {
        "id": 2003,
        "name": "New climb",
        "distance_m": 4000,
        "average_grade": 7.0,
        "pr_elapsed_time": 900,
        "cell_id": "41.10,-73.90",
        "points": [[41.1, -73.9], [41.11, -73.9], [41.12, -73.9]],
        "effort_count_personal": 3,
    }
    fetched = [
        {"id": 91, "start_date": "2026-08-01T12:00:00Z", "elapsed_time": 900,
         "moving_time": 890, "average_watts": 250, "device_watts": True,
         "activity": {"id": 77}},
        # No start date: unusable, and silently keeping it would put a record
        # with no timestamp into a training set joined to weather by the hour.
        {"id": 92, "elapsed_time": 910},
    ]
    all_efforts, profile = strava.all_efforts, strava.altitude_profile
    strava.all_efforts = lambda sid, **kw: fetched
    strava.altitude_profile = lambda sid: {"distance_m": [0, 4000], "altitude_m": [10, 290]}
    try:
        added = handler.backfill_segment(store, segment)
    finally:
        strava.all_efforts, strava.altitude_profile = all_efforts, profile

    assert added == 1, added
    assert "2003" in store["segments"]
    assert store["segments"]["2003"]["elevation_profile"]["altitude_m"] == [10, 290]
    recorded = store["efforts"][0]
    assert recorded["segment_id"] == 2003 and recorded["activity_id"] == 77
    assert recorded["weather"] is None, "weather must wait for the archive"


def test_backfill_keeps_the_efforts_when_the_profile_fails() -> None:
    store = history()
    segment = {
        "id": 2005, "name": "Partial", "distance_m": 1000, "average_grade": 3.0,
        "pr_elapsed_time": 300, "cell_id": "41.10,-73.90",
        "points": [[41.1, -73.9], [41.11, -73.9]], "effort_count_personal": 2,
    }
    all_efforts, profile = strava.all_efforts, strava.altitude_profile

    def refuse(sid):
        raise strava.RateLimited("quota")

    strava.all_efforts = lambda sid, **kw: [
        {"id": 93, "start_date": "2026-08-01T12:00:00Z", "elapsed_time": 300,
         "moving_time": 300, "average_watts": 200, "device_watts": True}
    ]
    strava.altitude_profile = refuse
    try:
        added = handler.backfill_segment(store, segment)
    finally:
        strava.all_efforts, strava.altitude_profile = all_efforts, profile

    # The efforts cost the calls and are already in hand. A segment with history
    # and an average gradient beats one with neither.
    assert added == 1
    assert store["segments"]["2005"]["elevation_profile"] is None


def test_quota_accounting_gates_optional_work() -> None:
    original = strava._quota
    try:
        strava._quota = None
        assert strava.discretionary_allowed(), "unknown quota must not block"
        strava._quota = {"short_used": 2, "short_limit": 100,
                         "daily_used": 500, "daily_limit": 1000}
        assert strava.discretionary_allowed(), "half spent is fine"
        strava._quota = {"short_used": 2, "short_limit": 100,
                         "daily_used": 850, "daily_limit": 1000}
        # Backfilling a segment nobody asked for today must never be the call
        # that leaves the app unable to refresh the ones they did.
        assert not strava.discretionary_allowed(), "past the ceiling it must stand down"
    finally:
        strava._quota = original


def test_profiles_are_fetched_for_segments_never_ridden() -> None:
    store = history()
    bundle = {
        "segments": [
            {"id": 3001, "name": "Ridden often", "effort_count_personal": 40,
             "points": [[41.0, -73.9], [41.01, -73.9]], "average_grade": 5.0},
            # Never ridden by this athlete. Strava still has its elevation, and
            # a real gradient improves the prediction whether or not there is a
            # record to compare it against.
            {"id": 3002, "name": "Never ridden", "effort_count_personal": 0,
             "points": [[41.2, -73.9], [41.21, -73.9]], "average_grade": 9.0},
        ]
    }
    asked: list[int] = []
    original = strava.altitude_profile

    def fake(sid):
        asked.append(sid)
        return {"distance_m": [0, 1000], "altitude_m": [10, 60]}

    strava.altitude_profile = fake
    try:
        added = handler.backfill_profiles(store, bundle, limit=10)
    finally:
        strava.altitude_profile = original

    assert added == 2, added
    # Ridden segments first: those have a record, so a better gradient changes
    # an answer rather than only a picture.
    assert asked == [3001, 3002], asked
    assert store["segments"]["3002"]["elevation_profile"]["altitude_m"] == [10, 60]


def test_profiles_are_not_refetched() -> None:
    store = history()
    store["segments"]["1001"]["elevation_profile"] = {"distance_m": [0, 1], "altitude_m": [0, 1]}
    bundle = {"segments": [{"id": 1001, "name": "Tracked climb", "effort_count_personal": 40}]}
    original = strava.altitude_profile
    strava.altitude_profile = lambda sid: (_ for _ in ()).throw(AssertionError("refetched"))
    try:
        assert handler.backfill_profiles(store, bundle, limit=10) == 0
    finally:
        strava.altitude_profile = original


def test_profiles_stop_at_the_quota_ceiling() -> None:
    store = history()
    bundle = {"segments": [
        {"id": 4000 + i, "name": f"S{i}", "effort_count_personal": i,
         "points": [[41.0, -73.9], [41.01, -73.9]], "average_grade": 4.0}
        for i in range(6)
    ]}
    original_q, original_p = strava._quota, strava.altitude_profile
    strava._quota = {"short_used": 2, "short_limit": 100,
                     "daily_used": 900, "daily_limit": 1000}
    strava.altitude_profile = lambda sid: {"distance_m": [0, 1], "altitude_m": [0, 1]}
    try:
        added = handler.backfill_profiles(store, bundle, limit=10)
    finally:
        strava._quota, strava.altitude_profile = original_q, original_p
    assert added == 0, "past the ceiling, nothing discretionary may run"


def test_token_refresh_reads_the_shared_secret_fresh() -> None:
    """The training worker shares the refresh token and may have rotated it."""
    import json

    class Secrets:
        def __init__(self) -> None:
            self.value = {"STRAVA_CLIENT_ID": "1", "STRAVA_CLIENT_SECRET": "s", "STRAVA_REFRESH_TOKEN": "old", "STRAVA_VERIFY_TOKEN": "v"}
            self.writes: list[dict] = []

        def get_secret_value(self, SecretId: str) -> dict:
            return {"SecretString": json.dumps(self.value)}

        def put_secret_value(self, SecretId: str, SecretString: str) -> None:
            self.value = json.loads(SecretString)
            self.writes.append(self.value)

    secrets = Secrets()
    sent: list[str] = []
    import os

    saved = (strava._secrets, strava._credentials, strava._token, strava._http)
    saved_arn = os.environ.get("STRAVA_SECRET_ARN")
    try:
        os.environ["STRAVA_SECRET_ARN"] = "arn:test"
        strava._secrets, strava._credentials, strava._token = secrets, None, None
        strava.credentials()
        # Another worker rotates the token after this container cached the secret.
        secrets.value = {**secrets.value, "STRAVA_REFRESH_TOKEN": "rotated-elsewhere"}

        def fake_http(url: str, *, data: dict | None = None, token: str | None = None) -> dict:
            sent.append((data or {}).get("refresh_token", ""))
            return {"access_token": "a", "expires_at": 9_999_999_999, "refresh_token": "newest"}

        strava._http = fake_http
        assert strava.access_token() == "a"
        assert sent == ["rotated-elsewhere"], sent
        assert secrets.writes[-1]["STRAVA_REFRESH_TOKEN"] == "newest"
        assert secrets.writes[-1]["STRAVA_VERIFY_TOKEN"] == "v"
    finally:
        strava._secrets, strava._credentials, strava._token, strava._http = saved
        if saved_arn is None:
            os.environ.pop("STRAVA_SECRET_ARN", None)
        else:
            os.environ["STRAVA_SECRET_ARN"] = saved_arn


def test_ingest_unwraps_the_webhook_envelope() -> None:
    import json

    store = history()
    saved: list[dict] = []
    load, save = handler.store.load, handler.store.save
    handler.store.load = lambda key: store
    handler.store.save = lambda key, payload: saved.append(payload)
    original = with_activity({"segment_efforts": [effort(1, 1001, "2026-10-01T12:00:00Z")]})
    try:
        # Exactly what the webhook route enqueues. Reading the envelope as the
        # event dropped every ride from August to October without a log line.
        body = {
            "received_at": "2026-10-01T13:00:00Z",
            "event": {"object_type": "activity", "object_id": 55, "aspect_type": "create"},
        }
        result = handler.ingest({"Records": [{"body": json.dumps(body)}]})
    finally:
        handler.activity = original
        handler.store.load, handler.store.save = load, save

    assert result["efforts_changed"] == 1, result
    assert saved and saved[-1]["efforts"][0]["activity_id"] == 55


def test_ingest_skips_messages_that_are_not_events() -> None:
    import json

    store = history()
    load, save = handler.store.load, handler.store.save
    handler.store.load = lambda key: store
    handler.store.save = lambda key, payload: None
    try:
        result = handler.ingest({"Records": [{"body": json.dumps({"received_at": "x"})}]})
    finally:
        handler.store.load, handler.store.save = load, save
    assert result["efforts_changed"] == 0, result


def test_resync_recovers_missed_efforts_oldest_segment_first() -> None:
    store = history()
    store["segments"]["1002"] = {
        "id": 1002, "name": "Synced recently", "cell_id": "41.00,-73.90",
        "efforts_synced_at": "2026-10-27T00:00:00Z",
    }
    # Held from the offline history, which recorded no activity.
    store["efforts"] = [{"effort_id": 1, "segment_id": 1001, "activity_id": None}]
    fetched = {
        1001: [
            {"id": 1, "start_date": "2025-06-01T12:00:00Z", "elapsed_time": 600, "activity": {"id": 70}},
            {"id": 2, "start_date": "2026-10-17T12:00:00Z", "elapsed_time": 590, "activity": {"id": 71}},
        ],
    }
    asked: list[int] = []

    def fake(segment_id: int, **kw) -> list[dict]:
        asked.append(segment_id)
        return fetched.get(segment_id, [])

    all_efforts = strava.all_efforts
    strava.all_efforts = fake
    try:
        synced, added = handler.resync_segments(store, limit=1)
    finally:
        strava.all_efforts = all_efforts

    assert asked == [1001], f"never-synced segment first, one per limit: {asked}"
    assert (synced, added) == (1, 1), (synced, added)
    assert store["efforts"][0]["activity_id"] == 70, "held effort gains its activity"
    assert store["efforts"][1]["activity_id"] == 71 and store["efforts"][1]["weather"] is None
    assert store["segments"]["1001"]["efforts_synced_at"], "progress is recorded"


def test_resync_progress_is_saved_even_when_nothing_is_new() -> None:
    store = history()
    saved: list[dict] = []
    load, save, save_cal = handler.store.load, handler.store.save, handler.store.save_calibration
    all_efforts, profile = strava.all_efforts, strava.altitude_profile
    handler.store.load = lambda key: store if key == handler.EFFORTS_KEY else {"segments": []}
    handler.store.save = lambda key, payload: saved.append(payload)
    handler.store.save_calibration = lambda key, payload: None
    strava.all_efforts = lambda sid, **kw: []
    strava.altitude_profile = lambda sid: None
    attach, build = handler.attach_weather, handler.build_calibration
    handler.attach_weather = lambda payload: 0
    handler.build_calibration = lambda payload: {"segments": {}, "rider": {}}
    try:
        result = handler.refresh()
    finally:
        handler.store.load, handler.store.save, handler.store.save_calibration = load, save, save_cal
        strava.all_efforts, strava.altitude_profile = all_efforts, profile
        handler.attach_weather, handler.build_calibration = attach, build

    assert result["segments_resynced"] == 1, result
    assert saved and saved[-1]["segments"]["1001"].get("efforts_synced_at"), "otherwise it re-reads the same segments forever"


def main() -> None:
    print("Strava worker")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            run(name[5:].replace("_", " "), fn)
    print("  all passed")


if __name__ == "__main__":
    main()
