#!/usr/bin/env python3
"""Exercise the Training sync worker without AWS or Strava.

unittest rather than the plain assertions of test_strava_worker.py, because
these tests arrived with the worker from my-strava (ADR-0004) and keeping them
as written is the best evidence the port changed nothing it did not mean to.
The tests added here cover what the port did change: credentials shared with
strava_worker, the 80% discretionary gate on the shared read allowance, the
message shapes the WindChaser webhook produces, and gear on a token that may
lack profile:read_all.

Strava and S3 are replaced by patching the handler's own seams (_strava_get,
_read_json, _write_json, _delete_object, _credentials), so no network and no
boto3 are needed: the handler imports boto3 only when it first talks to AWS.
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
import unittest
import urllib.error
from contextlib import redirect_stdout
from datetime import datetime, timezone
from email.message import Message
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "services"))

from training_sync import handler  # noqa: E402
from training_sync import streams as stream_math  # noqa: E402
from training_sync.handler import _to_processed  # noqa: E402


def _reset_module_state() -> None:
    """Module-level state survives between Lambda invocations, and so between tests."""
    handler._quota = None
    handler._throttled = False
    handler._token = None
    handler._gear_scope_reported = False


class WorkerTestCase(unittest.TestCase):
    def setUp(self):
        _reset_module_state()
        self.addCleanup(_reset_module_state)


def _set_quota(daily_used, daily_limit=1000):
    handler._quota = {
        "short_used": 1,
        "short_limit": 100,
        "daily_used": daily_used,
        "daily_limit": daily_limit,
        "day": datetime.now(timezone.utc).date().isoformat(),
    }


# --------------------------------------------------------- ported: shapes --


class NormalizeActivityTests(WorkerTestCase):
    def test_normalizes_units_and_local_date(self):
        activity = _to_processed(
            {
                "id": 123,
                "name": "Morning ride",
                "type": "Ride",
                "start_date_local": "2025-03-04T06:30:00",
                "distance": 16093.44,
                "moving_time": 3600,
                "elapsed_time": 3900,
                "total_elevation_gain": 304.8,
                "average_speed": 5,
                "max_speed": 10,
                "map": {"summary_polyline": "encoded"},
            }
        )

        self.assertEqual(activity["id"], "123")
        self.assertEqual(activity["distance"], 10.0)
        self.assertEqual(activity["moving_time"], 1.0)
        self.assertEqual(activity["elapsed_time"], 1.1)
        self.assertEqual(activity["total_elevation_gain"], 1000.0)
        self.assertEqual(activity["average_speed"], 11.2)
        self.assertEqual(activity["year"], 2025)
        self.assertEqual(activity["map"]["summary_polyline"], "encoded")

    def test_normalizes_utc_activity_date(self):
        activity = _to_processed(
            {
                "id": 456,
                "start_date": datetime(2024, 12, 31, tzinfo=timezone.utc).isoformat(),
            }
        )
        self.assertEqual(activity["year"], 2024)


# ------------------------------------------------------------ credentials --


class FakeSecrets:
    """Secrets Manager holding the shared windchaser/{env}/strava document."""

    def __init__(self, *versions):
        # Each read returns the next version, then the last one forever, so a
        # test can change the secret between the worker's two reads.
        self.versions = [dict(v) for v in versions]
        self.reads = 0
        self.written = []

    def get_secret_value(self, **_kwargs):
        version = self.versions[min(self.reads, len(self.versions) - 1)]
        self.reads += 1
        return {"SecretString": json.dumps(version)}

    def put_secret_value(self, **kwargs):
        self.written.append(json.loads(kwargs["SecretString"]))


SHARED_SECRET = {
    "STRAVA_CLIENT_ID": "client",
    "STRAVA_CLIENT_SECRET": "secret",
    "STRAVA_REFRESH_TOKEN": "old-refresh-token",
    "STRAVA_VERIFY_TOKEN": "verify",
}


class StravaRequestTests(WorkerTestCase):
    def test_api_request_uses_bearer_token(self):
        with patch.object(handler, "_request_json", return_value={"ok": True}) as request_json:
            response = handler._strava_get("/athlete", "access-token")

        self.assertEqual(response, {"ok": True})
        request = request_json.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer access-token")
        self.assertEqual(request.get_header("User-agent"), handler.USER_AGENT)


class CredentialTests(WorkerTestCase):
    def _credentials(self, secrets, oauth_response):
        with (
            patch.object(handler, "_secrets", secrets),
            patch.dict(os.environ, {"STRAVA_SECRET_ARN": "secret-arn"}),
            patch.object(handler, "_request_json", return_value=oauth_response) as request_json,
        ):
            return handler._credentials(), request_json

    def test_refresh_uses_the_shared_secret_keys(self):
        secrets = FakeSecrets(SHARED_SECRET)
        token, request_json = self._credentials(
            secrets,
            {"access_token": "access", "refresh_token": "old-refresh-token", "expires_at": 2_000_000_000},
        )
        self.assertEqual(token, "access")
        body = request_json.call_args.args[0].data.decode()
        self.assertIn("client_id=client", body)
        self.assertIn("refresh_token=old-refresh-token", body)
        # Same refresh token back: nothing to persist, and the access token is
        # never written to a secret other readers share.
        self.assertEqual(secrets.written, [])

    def test_valid_in_memory_token_skips_secret_and_oauth(self):
        handler._token = ("cached-token", time.time() + 3600)
        secrets = FakeSecrets(SHARED_SECRET)
        token, request_json = self._credentials(secrets, {})
        self.assertEqual(token, "cached-token")
        request_json.assert_not_called()
        self.assertEqual(secrets.reads, 0)

    def test_expiring_token_is_refreshed_from_a_fresh_read(self):
        handler._token = ("stale", time.time() + 30)
        # The other worker rotated the refresh token since this container last
        # looked; the refresh must use the current one, not a cached copy.
        secrets = FakeSecrets({**SHARED_SECRET, "STRAVA_REFRESH_TOKEN": "rotated-elsewhere"})
        token, request_json = self._credentials(
            secrets,
            {"access_token": "fresh", "refresh_token": "rotated-elsewhere", "expires_at": 2_000_000_000},
        )
        self.assertEqual(token, "fresh")
        self.assertIn("refresh_token=rotated-elsewhere", request_json.call_args.args[0].data.decode())
        self.assertEqual(handler._token, ("fresh", 2_000_000_000.0))

    def test_rotation_rereads_and_replaces_only_the_refresh_token(self):
        # The verify token changes between the read that fed the OAuth call and
        # the write: the write must keep the newer value.
        secrets = FakeSecrets(SHARED_SECRET, {**SHARED_SECRET, "STRAVA_VERIFY_TOKEN": "changed"})
        with redirect_stdout(io.StringIO()):
            token, _ = self._credentials(
                secrets,
                {"access_token": "new-access", "refresh_token": "new-refresh", "expires_at": 2_000_000_000},
            )
        self.assertEqual(token, "new-access")
        self.assertEqual(secrets.reads, 2)
        self.assertEqual(secrets.written, [{
            **SHARED_SECRET,
            "STRAVA_VERIFY_TOKEN": "changed",
            "STRAVA_REFRESH_TOKEN": "new-refresh",
        }])
        self.assertNotIn("access_token", secrets.written[0])
        self.assertNotIn("expires_at", secrets.written[0])

    def test_rotation_never_logs_the_token(self):
        secrets = FakeSecrets(SHARED_SECRET)
        output = io.StringIO()
        with redirect_stdout(output):
            self._credentials(
                secrets,
                {"access_token": "new-access", "refresh_token": "new-refresh", "expires_at": 2_000_000_000},
            )
        self.assertNotIn("new-refresh", output.getvalue())
        self.assertNotIn("new-access", output.getvalue())

    def test_missing_keys_fail_before_calling_strava(self):
        secrets = FakeSecrets({"STRAVA_CLIENT_ID": "client"})
        with self.assertRaises(RuntimeError) as raised:
            self._credentials(secrets, {})
        self.assertIn("STRAVA_REFRESH_TOKEN", str(raised.exception))


# ------------------------------------------------------------- rate limit --


def _headers(usage, limit):
    message = Message()
    message["x-readratelimit-usage"] = usage
    message["x-readratelimit-limit"] = limit
    return message


class RateLimitTests(WorkerTestCase):
    def test_quota_is_read_from_strava_headers(self):
        handler._record_quota(_headers("10,790", "100,1000"))
        self.assertEqual(handler.quota()["daily_used"], 790)
        self.assertTrue(handler._discretionary_allowed())
        handler._record_quota(_headers("10,800", "100,1000"))
        self.assertFalse(handler._discretionary_allowed())

    def test_unparseable_or_absent_headers_leave_work_allowed(self):
        handler._record_quota(Message())
        handler._record_quota(_headers("x,y", "100,1000"))
        handler._record_quota(None)
        self.assertIsNone(handler.quota())
        self.assertTrue(handler._discretionary_allowed())

    def test_yesterdays_quota_does_not_hold_back_today(self):
        _set_quota(990)
        handler._quota["day"] = "2000-01-01"
        self.assertTrue(handler._discretionary_allowed())

    def test_a_429_records_usage_and_stops_optional_work(self):
        refusal = urllib.error.HTTPError(
            "https://www.strava.com/api/v3/athlete", 429, "Too Many Requests",
            _headers("100,500", "100,1000"), io.BytesIO(b"Rate Limit Exceeded"),
        )
        with patch.object(handler.urllib.request, "urlopen", side_effect=refusal):
            with self.assertRaises(handler.StravaHTTPError) as raised:
                handler._strava_get("/athlete", "token")
        self.assertEqual(raised.exception.status, 429)
        self.assertEqual(handler.quota()["daily_used"], 500)
        # Only half the daily allowance, but the 15-minute window is spent.
        self.assertFalse(handler._discretionary_allowed())


# --------------------------------------------------------------- messages --


class MessageTests(WorkerTestCase):
    def _parse(self, body):
        return handler._records_from_sqs({"body": json.dumps(body)})

    def test_schedule_sources(self):
        self.assertEqual(self._parse({"source": "scheduled-reconciliation"}), {"source": "reconcile"})
        self.assertEqual(self._parse({"source": "reconcile"}), {"source": "reconcile"})
        self.assertEqual(self._parse({"source": "streams-backfill"}), {"source": "streams-backfill"})
        self.assertEqual(self._parse({"source": "routes-sync"}), {"source": "routes-sync"})

    def test_raw_webhook_event_passes_through(self):
        event = {"object_type": "activity", "aspect_type": "create", "object_id": 1, "owner_id": 42}
        self.assertEqual(self._parse(event), event)

    def test_windchaser_envelope_is_unwrapped(self):
        event = {"object_type": "activity", "aspect_type": "update", "object_id": 1, "owner_id": 42}
        self.assertEqual(self._parse({"received_at": "2026-10-27T00:00:00Z", "event": event}), event)

    def test_unparseable_message_is_dropped_not_retried(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(handler._records_from_sqs({"body": "not json"}), {})
            self.assertEqual(handler._records_from_sqs({}), {})


# ----------------------------------------------------------------- events --


def _strava_activity(activity_id, athlete_id=42, **overrides):
    return {
        "id": activity_id,
        "athlete": {"id": athlete_id},
        "name": "Ride",
        "type": "Ride",
        "start_date_local": "2025-03-04T06:30:00Z",
        "distance": 1609.344,
        "visibility": "everyone",
        "segment_efforts": [{"id": 1}],
        "map": {"summary_polyline": "abc", "polyline": "full-resolution"},
        **overrides,
    }


class ProcessEventTests(WorkerTestCase):
    def setUp(self):
        super().setUp()
        patcher = patch.dict(os.environ, {"STRAVA_ATHLETE_ID": "42"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.existing = [{"id": "1", "name": "Existing"}]

    def _event(self, aspect_type, object_id=1, owner_id=42):
        return {
            "object_type": "activity",
            "aspect_type": aspect_type,
            "object_id": object_id,
            "owner_id": owner_id,
        }

    def test_delete_requires_strava_to_confirm_the_activity_is_gone(self):
        with patch.object(handler, "_strava_get", return_value=_strava_activity(1)):
            result = handler._process_event(self._event("delete"), "token", self.existing)
        self.assertEqual([activity["id"] for activity in result], ["1"])

        missing = handler.StravaHTTPError(404, "Record Not Found")
        with patch.object(handler, "_strava_get", side_effect=missing):
            result = handler._process_event(self._event("delete"), "token", self.existing)
        self.assertEqual(result, [])

    def test_ignores_activities_owned_by_another_athlete(self):
        with patch.object(handler, "_strava_get", return_value=_strava_activity(2, athlete_id=7)):
            result = handler._process_event(self._event("create", object_id=2), "token", self.existing)
        self.assertEqual(result, self.existing)

    def test_ignores_events_for_another_owner_without_calling_strava(self):
        with patch.object(handler, "_strava_get") as strava_get:
            result = handler._process_event(self._event("delete", owner_id=7), "token", self.existing)
        self.assertEqual(result, self.existing)
        strava_get.assert_not_called()

    def test_private_activity_is_removed(self):
        private = _strava_activity(1, visibility="only_me")
        with patch.object(handler, "_strava_get", return_value=private):
            result = handler._process_event(self._event("update"), "token", self.existing)
        self.assertEqual(result, [])

    def test_stores_only_dashboard_fields(self):
        with patch.object(handler, "_strava_get", return_value=_strava_activity(3)):
            result = handler._process_event(self._event("create", object_id=3), "token", [])
        record = result[0]
        self.assertNotIn("segment_efforts", record)
        self.assertNotIn("athlete", record)
        self.assertEqual(record["map"], {"summary_polyline": "abc"})
        self.assertEqual(record["distance"], 1.0)

    def test_other_errors_are_retried(self):
        with patch.object(handler, "_strava_get", side_effect=handler.StravaHTTPError(429, "")):
            with self.assertRaises(handler.StravaHTTPError):
                handler._process_event(self._event("update"), "token", self.existing)

    def test_unconfigured_athlete_fails_rather_than_storing_anyone(self):
        with patch.dict(os.environ, {"STRAVA_ATHLETE_ID": ""}):
            with self.assertRaises(RuntimeError):
                handler._process_event(self._event("create"), "token", [])


class ReconcileTests(WorkerTestCase):
    def test_upserts_public_and_drops_private_activities(self):
        stored = [{"id": "1", "name": "Old"}, {"id": "2", "name": "Now private"}]
        pages = [[_strava_activity(1, name="Renamed"), _strava_activity(2, private=True)]]
        with (
            patch.object(handler, "_read_json", return_value={}),
            patch.object(handler, "_strava_get", side_effect=pages),
        ):
            result = handler._reconcile("token", stored)
        self.assertEqual([(a["id"], a["name"]) for a in result], [("1", "Renamed")])


class StreamMathTests(WorkerTestCase):
    def test_one_hz_fills_short_gaps_and_drops_pauses(self):
        series = stream_math.one_hz(
            [0, 1, 2, 5, 12, 13],
            {"watts": [100, 110, 120, 130, 140, 150]},
        )
        # 2 -> 5 is a 3 s dropout, filled; 5 -> 12 is a pause, removed.
        self.assertEqual(series["watts"], [100, 110, 120, 120, 120, 130, 140, 150])

    def test_power_bests_use_full_windows_only(self):
        bests = stream_math.power_bests([0, 0, 100, 200, 300, 0])
        self.assertEqual(bests, {"1": 300, "5": 120})

    def test_normalized_power(self):
        self.assertEqual(stream_math.normalized_power([200] * 120), 200.0)
        self.assertIsNone(stream_math.normalized_power([200] * 29))
        watts = [100] * 30 + [300] * 30
        rolling = [sum(watts[end - 30:end]) / 30 for end in range(30, 61)]
        expected = round((sum(value ** 4 for value in rolling) / len(rolling)) ** 0.25, 1)
        self.assertEqual(stream_math.normalized_power(watts), expected)

    def test_summary_halves_and_moving_time(self):
        summary = stream_math.summarize({
            "time": list(range(10)),
            "watts": [100] * 5 + [200] * 5,
            "heartrate": [120] * 5 + [150] * 5,
        })
        self.assertEqual(summary["moving_seconds"], 10)
        self.assertEqual(summary["first_half"], {"watts": 100.0, "heartrate": 120.0})
        self.assertEqual(summary["second_half"], {"watts": 200.0, "heartrate": 150.0})
        self.assertEqual(summary["average_watts"], 150)
        self.assertEqual(summary["max_heartrate"], 150)

    def test_samples_downsample_and_convert(self):
        long = stream_math.samples({"time": list(range(5000)), "distance": [1609.344] * 5000})
        self.assertLessEqual(len(long["time"]), 1200)
        self.assertEqual(long["time"][0], 0)
        self.assertEqual(long["time"][-1], 4999)
        self.assertEqual(long["distance"][0], 1.0)
        short = stream_math.samples({"time": list(range(100)), "watts": [1.6] * 100})
        self.assertEqual(len(short["time"]), 100)
        self.assertEqual(short["watts"][0], 2)
        self.assertNotIn("heartrate", short)

    def test_samples_keep_aligned_coordinates(self):
        track = stream_math.samples(
            {"time": list(range(3000)), "latlng": [[37.1234567, -122.7654321]] * 3000}
        )
        self.assertEqual(len(track["latlng"]), len(track["time"]))
        self.assertEqual(track["latlng"][0], [37.12346, -122.76543])
        self.assertIn("latlng", stream_math.STREAM_KEYS)


class FakeStore:
    """In-memory stand-in for the data bucket."""

    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.deleted = []

    def read(self, key, default):
        return json.loads(json.dumps(self.objects.get(key, default)))

    def write(self, key, value):
        self.objects[key] = value

    def delete(self, key):
        self.deleted.append(key)
        self.objects.pop(key, None)

    def patches(self):
        return (
            patch.object(handler, "_read_json", side_effect=self.read),
            patch.object(handler, "_write_json", side_effect=self.write),
            patch.object(handler, "_delete_object", side_effect=self.delete),
            patch.object(handler, "_credentials", return_value="token"),
        )


# ------------------------------------------------------------------- gear --


class GearDiscoveryTests(WorkerTestCase):
    def test_unknown_gear_is_looked_up_once_and_typed_by_prefix(self):
        store = FakeStore({"bikes.json": [
            {"id": "b1", "name": "Known", "brand": "Giant", "model": "TCR", "distance": 10.0, "retired": False, "kind": "bike"},
            {"id": "b4", "name": "Legacy", "brand": "", "model": "", "distance": 5.0, "retired": False},
        ]})
        gear = {
            "/gear/b2": {"id": "b2", "nickname": "New bike", "brand_name": "Storck", "model_name": "Scenero", "distance": 1609.344, "retired": False},
            "/gear/g3": {"id": "g3", "name": "Shoes", "distance": 0, "retired": True},
            "/gear/b4": {"id": "b4", "name": "Legacy", "brand_name": "Cannondale", "model_name": "CAAD10", "distance": 8046.72, "retired": True},
        }
        activities = [{"id": "1", "gear_id": "b1"}, {"id": "2", "gear_id": "b2"}, {"id": "3", "gear_id": "g3"}, {"id": "4", "gear_id": "b4"}]
        read, write, delete, _ = store.patches()
        with read, write, delete, patch.object(handler, "_strava_get", side_effect=lambda path, *_: gear[path]) as strava_get:
            handler._sync_gear("token", activities, refresh_athlete=False)

        self.assertEqual(sorted(call.args[0] for call in strava_get.call_args_list), ["/gear/b2", "/gear/b4", "/gear/g3"])
        saved = {item["id"]: item for item in store.objects["bikes.json"]}
        self.assertEqual(saved["b2"]["kind"], "bike")
        self.assertEqual(saved["b2"]["distance"], 1.0)
        self.assertEqual(saved["g3"]["kind"], "shoe")
        self.assertTrue(saved["g3"]["retired"])
        self.assertTrue(saved["b4"]["retired"])
        self.assertEqual(saved["b4"]["brand"], "Cannondale")
        self.assertEqual(saved["b1"]["brand"], "Giant")

    def test_reconcile_refreshes_listed_gear_without_losing_details(self):
        store = FakeStore({"bikes.json": [
            {"id": "b1", "name": "Known", "brand": "Giant", "model": "TCR", "distance": 10.0, "retired": False, "kind": "bike"},
            {"id": "b9", "name": "Sold", "brand": "Marin", "model": "", "distance": 3.0, "retired": True, "kind": "bike"},
        ]})
        athlete = {"bikes": [{"id": "b1", "name": "Known", "distance": 32186.88}], "shoes": []}
        read, write, delete, _ = store.patches()
        with read, write, delete, patch.object(handler, "_strava_get", return_value=athlete) as strava_get:
            handler._sync_gear("token", [], refresh_athlete=True)

        strava_get.assert_called_once()
        saved = {item["id"]: item for item in store.objects["bikes.json"]}
        self.assertEqual(saved["b1"]["distance"], 20.0)
        self.assertEqual(saved["b1"]["brand"], "Giant")
        self.assertIn("b9", saved)

    def test_athlete_without_gear_lists_is_reported_once_and_tolerated(self):
        store = FakeStore()
        read, write, delete, _ = store.patches()
        output = io.StringIO()
        with read, write, delete, redirect_stdout(output), \
                patch.object(handler, "_strava_get", return_value={"id": 42, "firstname": "R"}):
            handler._sync_gear("token", [], refresh_athlete=True)
            handler._sync_gear("token", [], refresh_athlete=True)
        self.assertEqual(output.getvalue().count("profile:read_all"), 1)
        self.assertNotIn("bikes.json", store.objects)

    def test_gear_refused_for_scope_is_reported_once_and_stops_lookups(self):
        store = FakeStore()
        read, write, delete, _ = store.patches()
        refused = handler.StravaHTTPError(401, "Authorization Error")
        output = io.StringIO()
        activities = [{"id": "1", "gear_id": "b1"}, {"id": "2", "gear_id": "b2"}]
        with read, write, delete, redirect_stdout(output), \
                patch.object(handler, "_strava_get", side_effect=refused) as strava_get:
            self.assertFalse(handler._sync_gear("token", activities, refresh_athlete=False))
            handler._sync_gear("token", activities, refresh_athlete=False)
        # One refused call per run, not one per piece of gear.
        self.assertEqual(strava_get.call_count, 2)
        self.assertEqual(output.getvalue().count("profile:read_all"), 1)

    def test_gear_errors_never_raise(self):
        store = FakeStore()
        for failure in (handler.StravaHTTPError(429, ""), handler.StravaHTTPError(500, ""), RuntimeError("down")):
            read, write, delete, _ = store.patches()
            with read, write, delete, redirect_stdout(io.StringIO()), \
                    patch.object(handler, "_strava_get", side_effect=failure):
                self.assertFalse(handler._sync_gear("token", [{"id": "1", "gear_id": "b1"}], refresh_athlete=True))

    def test_only_the_current_events_gear_is_fetched_past_the_ceiling(self):
        _set_quota(950)
        store = FakeStore()
        read, write, delete, _ = store.patches()
        activities = [{"id": "1", "gear_id": "b1"}, {"id": "2", "gear_id": "b2"}, {"id": "3", "gear_id": "g3"}]
        with read, write, delete, redirect_stdout(io.StringIO()), \
                patch.object(handler, "_strava_get", side_effect=lambda path, *_: {"id": path.rsplit("/", 1)[1]}) as strava_get:
            handler._sync_gear("token", activities, refresh_athlete=False, needed={"b2"})
        self.assertEqual([call.args[0] for call in strava_get.call_args_list], ["/gear/b2"])
        self.assertEqual([gear["id"] for gear in store.objects["bikes.json"]], ["b2"])


def _stored(activity_id, date):
    return {"id": activity_id, "start_date_local": date, "sport_type": "Ride", "gear_id": None}


def _webhook(object_id, aspect_type="create", owner_id=42):
    return {"object_type": "activity", "aspect_type": aspect_type, "object_id": object_id, "owner_id": owner_id}


def _sqs(*bodies):
    return {"Records": [{"eventSource": "aws:sqs", "body": json.dumps(body)} for body in bodies]}


# ---------------------------------------------------------------- streams --


class StreamsSyncTests(WorkerTestCase):
    def setUp(self):
        super().setUp()
        patcher = patch.dict(os.environ, {"STRAVA_ATHLETE_ID": "42", "STREAMS_BACKFILL_LIMIT": "2"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self, store, event, strava_get):
        read, write, delete, credentials = store.patches()
        with read, write, delete, credentials, redirect_stdout(io.StringIO()), \
                patch.object(handler, "_strava_get", side_effect=strava_get):
            return handler.main(event, None)

    def test_backfill_fetches_newest_missing_up_to_the_limit(self):
        store = FakeStore({
            "activities.json": [_stored(str(i), f"2025-01-0{i}T08:00:00Z") for i in range(1, 6)],
            "streams-index.json": {"5": {"has_streams": True}},
        })
        fetched = []

        def strava_get(path, *_):
            fetched.append(path)
            return {"time": {"data": [0, 1, 2]}, "watts": {"data": [100, 200, 300]}}

        result = self._run(store, {"source": "streams-backfill"}, strava_get)
        self.assertEqual(fetched, ["/activities/4/streams", "/activities/3/streams"])
        self.assertEqual(result["streams_fetched"], 2)
        self.assertEqual(set(store.objects["streams-index.json"]), {"3", "4", "5"})
        self.assertEqual(store.objects["streams/4.json"]["summary"]["power_bests"], {"1": 300})

    def test_backfill_stops_at_the_rate_limit_and_keeps_progress(self):
        store = FakeStore({"activities.json": [_stored(str(i), f"2025-01-0{i}T08:00:00Z") for i in range(1, 4)]})
        calls = []

        def strava_get(path, *_):
            calls.append(path)
            if len(calls) > 1:
                raise handler.StravaHTTPError(429, "Rate Limit Exceeded")
            return {"time": {"data": [0, 1]}}

        result = self._run(store, {"source": "streams-backfill"}, strava_get)
        self.assertTrue(result["ok"])
        self.assertEqual(list(store.objects["streams-index.json"]), ["3"])

    def test_activity_without_streams_is_indexed_as_such(self):
        missing = handler.StravaHTTPError(404, "Record Not Found")
        with patch.object(handler, "_strava_get", side_effect=missing), patch.object(handler, "_write_json") as write:
            entry = handler._fetch_streams(_stored("7", "2025-01-01T08:00:00Z"), "token")
        self.assertFalse(entry["has_streams"])
        self.assertEqual(entry["power_bests"], {})
        write.assert_not_called()

    def test_confirmed_delete_removes_streams_and_index_entry(self):
        store = FakeStore({
            "activities.json": [_stored("1", "2025-01-01T08:00:00Z")],
            "streams-index.json": {"1": {"has_streams": True}},
            "streams/1.json": {"id": "1"},
        })
        self._run(store, _webhook(1, "delete"), lambda *_: (_ for _ in ()).throw(handler.StravaHTTPError(404, "")))
        self.assertEqual(store.deleted, ["streams/1.json"])
        self.assertEqual(store.objects["streams-index.json"], {})

    def test_private_activity_never_has_streams_fetched(self):
        store = FakeStore({"activities.json": []})
        paths = []

        def strava_get(path, *_):
            paths.append(path)
            return _strava_activity(8, visibility="only_me")

        self._run(store, _webhook(8), strava_get)
        self.assertEqual(paths, ["/activities/8"])
        self.assertNotIn("streams/8.json", store.objects)

    def test_new_webhook_activity_gets_streams_and_unknown_gear(self):
        store = FakeStore({"activities.json": []})
        responses = {
            "/activities/9": _strava_activity(9, gear_id="b77"),
            "/gear/b77": {"id": "b77", "nickname": "Brand new", "distance": 0},
            "/activities/9/streams": {"time": {"data": [0, 1, 2]}, "heartrate": {"data": [90, 95, 100]}},
        }
        self._run(store, _webhook(9), lambda path, *_: responses[path])
        self.assertEqual(store.objects["bikes.json"][0]["name"], "Brand new")
        self.assertTrue(store.objects["streams-index.json"]["9"]["has_streams"])
        self.assertEqual(store.objects["streams/9.json"]["samples"]["heartrate"], [90, 95, 100])

    # -- added with the port --

    def test_default_backfill_batch_is_25(self):
        with patch.dict(os.environ):
            os.environ.pop("STREAMS_BACKFILL_LIMIT")
            store = FakeStore({"activities.json": [
                _stored(str(i), f"2025-01-01T08:{i:02d}:00Z") for i in range(40)
            ]})
            result = self._run(store, {"source": "streams-backfill"}, lambda *_: {"time": {"data": [0, 1]}})
        self.assertEqual(result["streams_fetched"], 25)

    def test_backfill_stands_down_at_the_quota_ceiling(self):
        _set_quota(800)
        store = FakeStore({"activities.json": [_stored("1", "2025-01-01T08:00:00Z")]})
        result = self._run(store, {"source": "streams-backfill"}, AssertionError("spent quota"))
        self.assertEqual(result["streams_fetched"], 0)
        self.assertNotIn("streams-index.json", store.objects)

    def test_backfill_stops_when_usage_crosses_the_ceiling_mid_run(self):
        store = FakeStore({"activities.json": [_stored(str(i), f"2025-01-0{i}T08:00:00Z") for i in range(1, 6)]})
        calls = []

        def strava_get(path, *_):
            calls.append(path)
            _set_quota(790 + 10 * len(calls))
            return {"time": {"data": [0, 1]}}

        with patch.dict(os.environ, {"STREAMS_BACKFILL_LIMIT": "10"}):
            result = self._run(store, {"source": "streams-backfill"}, strava_get)
        # 800 after the first call, so the second never goes out.
        self.assertEqual(result["streams_fetched"], 1)
        self.assertEqual(calls, ["/activities/5/streams"])

    def test_webhook_event_and_its_streams_run_past_the_ceiling(self):
        _set_quota(990)
        store = FakeStore({"activities.json": [_stored("1", "2025-01-01T08:00:00Z")]})
        responses = {
            "/activities/9": _strava_activity(9),
            "/activities/9/streams": {"time": {"data": [0, 1, 2]}},
        }
        result = self._run(store, _webhook(9), lambda path, *_: responses[path])
        self.assertEqual(result["streams_fetched"], 1)
        self.assertEqual({a["id"] for a in store.objects["activities.json"]}, {"1", "9"})
        # Activity 1 lacks streams too, but filling it in is the backfill's job.
        self.assertEqual(set(store.objects["streams-index.json"]), {"9"})

    def test_reconcile_lists_past_the_ceiling_and_fetches_only_the_newest_streams(self):
        _set_quota(990)
        store = FakeStore({"activities.json": []})
        listed = [_strava_activity(i, start_date_local=f"2025-01-0{i}T08:00:00Z") for i in range(1, 7)]
        paths = []

        def strava_get(path, _token, query=None):
            paths.append(path)
            if path == "/athlete/activities":
                return listed
            if path.endswith("/streams") and path.startswith("/activities/"):
                return {"time": {"data": [0, 1]}}
            if path == "/athlete":
                return {"bikes": [], "shoes": []}
            if path == "/athletes/42/routes":
                return [_route("5", "2025-01-01T00:00:00Z")]
            raise AssertionError(f"unexpected call {path}")

        result = self._run(store, _sqs({"source": "scheduled-reconciliation"}), strava_get)
        self.assertEqual(len(store.objects["activities.json"]), 6)
        self.assertEqual(
            [path for path in paths if path.endswith("/streams")],
            ["/activities/6/streams", "/activities/5/streams", "/activities/4/streams"],
        )
        self.assertEqual(result["streams_fetched"], handler.RECONCILE_STREAMS_ALWAYS)
        # The route listing still runs, so a deleted route still disappears;
        # its profile waits for quota.
        self.assertEqual(result["route_profiles_fetched"], 0)
        self.assertIn("/athletes/42/routes", paths)
        self.assertIsNone(store.objects["saved-routes.json"][0]["profile_updated_at"])
        self.assertIn("last_sync_epoch", store.objects["sync-state.json"])

    def test_a_429_on_streams_stops_the_route_profiles_too(self):
        store = FakeStore({"activities.json": [_stored("1", "2025-01-01T08:00:00Z")]})

        def strava_get(path, _token, query=None):
            if path == "/activities/1/streams":
                handler._throttled = True  # what _request_json does on a 429
                raise handler.StravaHTTPError(429, "")
            if path == "/athletes/42/routes":
                return [_route("5", "2025-01-01T00:00:00Z")]
            raise AssertionError(f"unexpected call {path}")

        result = self._run(store, _sqs({"source": "streams-backfill"}, {"source": "routes-sync"}), strava_get)
        self.assertTrue(result["ok"])
        self.assertEqual(result["route_profiles_fetched"], 0)

    def test_a_previous_invocations_429_does_not_carry_over(self):
        handler._throttled = True
        store = FakeStore({"activities.json": [_stored("1", "2025-01-01T08:00:00Z")]})
        result = self._run(store, {"source": "streams-backfill"}, lambda *_: {"time": {"data": [0, 1]}})
        self.assertEqual(result["streams_fetched"], 1)

    def test_enveloped_event_is_applied(self):
        store = FakeStore({"activities.json": []})
        responses = {
            "/activities/9": _strava_activity(9),
            "/activities/9/streams": {"time": {"data": [0, 1]}},
        }
        envelope = {"received_at": "2026-10-27T00:00:00Z", "event": _webhook(9)}
        self._run(store, _sqs(envelope), lambda path, *_: responses[path])
        self.assertEqual([a["id"] for a in store.objects["activities.json"]], ["9"])

    def test_gear_refusal_does_not_fail_the_event(self):
        store = FakeStore({"activities.json": []})

        def strava_get(path, *_):
            if path == "/activities/9":
                return _strava_activity(9, gear_id="b77")
            if path == "/gear/b77":
                raise handler.StravaHTTPError(403, "Forbidden")
            return {"time": {"data": [0, 1]}}

        result = self._run(store, _sqs(_webhook(9)), strava_get)
        self.assertTrue(result["ok"])
        self.assertEqual([a["id"] for a in store.objects["activities.json"]], ["9"])
        self.assertNotIn("bikes.json", store.objects)
        self.assertTrue(store.objects["streams-index.json"]["9"]["has_streams"])

    def test_unparseable_message_is_acknowledged(self):
        store = FakeStore({"activities.json": []})
        read, write, delete, credentials = store.patches()
        with read, write, delete, credentials, redirect_stdout(io.StringIO()), \
                patch.object(handler, "_strava_get", side_effect=AssertionError("no calls")):
            result = handler.main({"Records": [{"eventSource": "aws:sqs", "body": "{"}]}, None)
        self.assertTrue(result["ok"])
        self.assertEqual(store.objects, {"activities.json": []})


# ----------------------------------------------------------- saved routes --


def _route(route_id, updated_at, **overrides):
    return {
        "id": int(route_id),
        "id_str": route_id,
        "name": f"Route {route_id}",
        "description": None,
        "type": 1,
        "sub_type": 1,
        "distance": 1609.344,
        "elevation_gain": 304.8,
        "estimated_moving_time": 3600,
        "starred": False,
        "private": False,
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": updated_at,
        "map": {"summary_polyline": "abc"},
        **overrides,
    }


def _route_streams(points=3):
    return [
        {"type": "latlng", "data": [[37.8 + i * 0.001, -122.4] for i in range(points)]},
        {"type": "distance", "data": [i * 100.0 for i in range(points)]},
        {"type": "altitude", "data": [10.0 + i for i in range(points)]},
    ]


class SavedRoutesTests(WorkerTestCase):
    def setUp(self):
        super().setUp()
        patcher = patch.dict(os.environ, {"STRAVA_ATHLETE_ID": "42", "SAVED_ROUTES_PROFILE_LIMIT": "2"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _sync(self, store, responses):
        calls = []

        def strava_get(path, _token, query=None):
            calls.append((path, (query or {}).get("page")))
            response = responses[(path, (query or {}).get("page"))] if (path, (query or {}).get("page")) in responses else responses[path]
            if isinstance(response, Exception):
                raise response
            return response

        read, write, delete, _ = store.patches()
        with read, write, delete, redirect_stdout(io.StringIO()), \
                patch.object(handler, "_strava_get", side_effect=strava_get):
            fetched = handler._sync_saved_routes("token", deadline=float("inf"))
        return fetched, calls

    def test_lists_every_page_and_skips_private_routes(self):
        full_page = [_route(str(1000 + i), "2025-01-01T00:00:00Z") for i in range(100)]
        store = FakeStore({"saved-routes.json": [
            {"id": str(1000 + i), "updated_at": "2025-01-01T00:00:00Z", "profile_updated_at": "2025-01-01T00:00:00Z"}
            for i in range(100)
        ]})
        responses = {
            ("/athletes/42/routes", 1): full_page,
            ("/athletes/42/routes", 2): [_route("7", "2025-01-01T00:00:00Z", private=True)],
        }
        fetched, calls = self._sync(store, responses)
        self.assertEqual([call for call in calls if "routes" in call[0] and "streams" not in call[0]],
                         [("/athletes/42/routes", 1), ("/athletes/42/routes", 2)])
        self.assertEqual(fetched, 0)
        ids = {route["id"] for route in store.objects["saved-routes.json"]}
        self.assertEqual(len(ids), 100)
        self.assertNotIn("7", ids)

    def test_converts_units_and_types(self):
        route = handler.saved_routes.summary(
            _route("9", "2025-02-01T00:00:00Z", type=2, sub_type=4, starred=True, map={}), None
        )
        self.assertEqual(route["id"], "9")
        self.assertEqual(route["type"], "run")
        self.assertEqual(route["sub_type"], "trail")
        self.assertEqual(route["distance"], 1.0)
        self.assertEqual(route["elevation_gain"], 1000)
        self.assertEqual(route["description"], "")
        self.assertIsNone(route["polyline"])
        self.assertTrue(route["starred"])
        self.assertEqual(handler.saved_routes.summary(_route("9", "x", type=3, sub_type=9), None)["type"], "other")

    def test_fetches_profiles_only_for_new_or_edited_routes(self):
        store = FakeStore({"saved-routes.json": [
            {"id": "1", "updated_at": "2025-01-01T00:00:00Z", "profile_updated_at": "2025-01-01T00:00:00Z"},
            {"id": "2", "updated_at": "2025-01-01T00:00:00Z", "profile_updated_at": "2025-01-01T00:00:00Z"},
        ]})
        responses = {
            ("/athletes/42/routes", 1): [
                _route("1", "2025-01-01T00:00:00Z"),
                _route("2", "2025-03-01T00:00:00Z"),
                _route("3", "2025-02-01T00:00:00Z"),
            ],
            "/routes/2/streams": _route_streams(),
            "/routes/3/streams": _route_streams(),
        }
        fetched, calls = self._sync(store, responses)
        self.assertEqual(fetched, 2)
        self.assertEqual([path for path, _ in calls if path.endswith("/streams")], ["/routes/2/streams", "/routes/3/streams"])
        profile = store.objects["saved-routes/3.json"]
        self.assertEqual(profile["distance"], [0.0, 0.062, 0.124])
        self.assertEqual(profile["altitude"], [32.8, 36.1, 39.4])
        self.assertEqual(profile["latlng"][0], [37.8, -122.4])
        saved = {route["id"]: route for route in store.objects["saved-routes.json"]}
        self.assertEqual(saved["2"]["profile_updated_at"], "2025-03-01T00:00:00Z")
        self.assertEqual([route["id"] for route in store.objects["saved-routes.json"]], ["2", "3", "1"])

    def test_stops_at_the_limit_and_the_rate_limit_keeping_progress(self):
        store = FakeStore()
        responses = {
            ("/athletes/42/routes", 1): [_route(str(i), f"2025-0{i}-01T00:00:00Z") for i in range(1, 5)],
            "/routes/4/streams": _route_streams(),
            "/routes/3/streams": handler.StravaHTTPError(429, "Rate Limit Exceeded"),
        }
        fetched, calls = self._sync(store, responses)
        self.assertEqual(fetched, 1)
        self.assertEqual([path for path, _ in calls if path.endswith("/streams")], ["/routes/4/streams", "/routes/3/streams"])
        saved = {route["id"]: route for route in store.objects["saved-routes.json"]}
        self.assertEqual(saved["4"]["profile_updated_at"], "2025-04-01T00:00:00Z")
        self.assertIsNone(saved["3"]["profile_updated_at"])

        store = FakeStore()
        responses = {
            ("/athletes/42/routes", 1): [_route(str(i), f"2025-0{i}-01T00:00:00Z") for i in range(1, 5)],
            **{f"/routes/{i}/streams": _route_streams() for i in range(1, 5)},
        }
        fetched, _ = self._sync(store, responses)
        self.assertEqual(fetched, 2)

    def test_removes_profiles_of_deleted_or_private_routes(self):
        store = FakeStore({
            "saved-routes.json": [
                {"id": "1", "updated_at": "a", "profile_updated_at": "a"},
                {"id": "2", "updated_at": "a", "profile_updated_at": "a"},
                {"id": "3", "updated_at": "a", "profile_updated_at": None},
            ],
            "saved-routes/1.json": {"id": "1"},
            "saved-routes/2.json": {"id": "2"},
        })
        responses = {("/athletes/42/routes", 1): [_route("1", "a"), _route("2", "a", private=True)]}
        self._sync(store, responses)
        self.assertEqual(store.deleted, ["saved-routes/2.json"])
        self.assertEqual([route["id"] for route in store.objects["saved-routes.json"]], ["1"])

    def test_profile_downsampling_keeps_both_ends(self):
        profile = handler.saved_routes.profile(_route("5", "a"), _route_streams(4500))
        self.assertLessEqual(len(profile["distance"]), 2000)
        self.assertEqual(profile["distance"][0], 0.0)
        self.assertEqual(profile["distance"][-1], round(4499 * 100 * 0.000621371, 3))
        self.assertEqual(len(profile["latlng"]), len(profile["altitude"]))

    def test_routes_sync_message_triggers_a_sync(self):
        record = {"body": json.dumps({"source": "routes-sync"})}
        self.assertEqual(handler._records_from_sqs(record), {"source": "routes-sync"})
        store = FakeStore({"activities.json": []})
        read, write, delete, credentials = store.patches()
        with read, write, delete, credentials, \
                patch.object(handler, "_strava_get", return_value=[]), \
                patch.object(handler, "_sync_gear"), \
                patch.object(handler, "_sync_saved_routes", return_value=0) as sync:
            handler.main({"Records": [record]}, None)
        sync.assert_called_once()

    # -- added with the port --

    def test_profiles_wait_for_quota_but_removals_do_not(self):
        _set_quota(850)
        store = FakeStore({
            "saved-routes.json": [{"id": "1", "updated_at": "a", "profile_updated_at": "a"}],
            "saved-routes/1.json": {"id": "1"},
        })
        responses = {
            ("/athletes/42/routes", 1): [_route("2", "2025-01-01T00:00:00Z")],
            "/routes/2/streams": AssertionError("profile fetched past the ceiling"),
        }
        fetched, calls = self._sync(store, responses)
        self.assertEqual(fetched, 0)
        self.assertEqual(store.deleted, ["saved-routes/1.json"])
        self.assertEqual([route["id"] for route in store.objects["saved-routes.json"]], ["2"])
        self.assertFalse(any(path.endswith("/streams") for path, _ in calls))


if __name__ == "__main__":
    unittest.main(verbosity=1)
