"""The effort history, held as one object in S3.

One object rather than one per effort, because every consumer of this data reads
all of it: the calibration is fitted across the whole history at once. Splitting
it would turn one read into hundreds for no benefit.

That makes writes read-modify-write, which is safe here only because the worker
runs with a reserved concurrency of one. That limit is load-bearing, not tuning.
"""

from __future__ import annotations

import json
import os

# Imported on first use rather than at module scope. The Lambda runtime provides
# boto3, but the tests do not, and a module that cannot be imported without its
# cloud dependencies cannot have its logic tested at all.
_s3 = None


def _client():
    global _s3
    if _s3 is None:
        import boto3

        _s3 = boto3.client("s3")
    return _s3

EMPTY: dict = {
    "generated_at": None,
    "source": "strava webhook + open-meteo ERA5 archive",
    "segments": {},
    "efforts": [],
}


def _bucket() -> str:
    bucket = os.environ.get("APP_DATA_BUCKET")
    if not bucket:
        raise RuntimeError("APP_DATA_BUCKET is not set")
    return bucket


def load(key: str) -> dict:
    try:
        body = _client().get_object(Bucket=_bucket(), Key=key)["Body"].read()
    except Exception as exc:  # noqa: BLE001 - narrowed immediately below
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404"):
            # A first run before any history has been uploaded. Starting empty
            # is correct; the offline scripts seed the real history.
            return json.loads(json.dumps(EMPTY))
        raise
    return json.loads(body.decode())


def save(key: str, payload: dict) -> None:
    _client().put_object(
        Bucket=_bucket(),
        Key=key,
        Body=json.dumps(payload).encode(),
        ContentType="application/json",
    )


def save_calibration(key: str, bundle: dict) -> None:
    save(key, bundle)
