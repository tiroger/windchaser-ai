"""A Model Context Protocol server over stdio, in the standard library alone.

The official SDK would do this too. It is not used because of how this gets run:
a person pastes a command into an MCP client's configuration, and
`python3 .../server.py` keeps working when a virtual environment does not exist,
has not been activated, or has moved. The protocol surface needed here is three
methods and a handshake.

Transport is newline-delimited JSON-RPC 2.0 on stdin and stdout. Nothing may be
written to stdout that is not a protocol message, so every diagnostic goes to
stderr -- a stray print is the classic way to make an MCP server look broken.
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import Any, Callable

from . import data, tools

PROTOCOL_VERSION = "2024-11-05"
SERVER = {"name": "windchaser", "version": "1.0.0"}


def _segment_arg(description: str) -> dict:
    return {"type": "string", "description": description}


TOOLS: list[dict] = [
    {
        "name": "list_segments",
        "description": (
            "List the segments the model knows about, with their length, gradient, "
            "your record, and whether power is fitted from your own attempts on that "
            "segment or comes from the rider-level model. Start here when unsure what "
            "a segment is called."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "search": {
                    "type": "string",
                    "description": "Optional name fragment to filter by.",
                },
                "calibrated_only": {
                    "type": "boolean",
                    "description": "Only segments with power fitted from their own attempts.",
                },
            },
        },
    },
    {
        "name": "predict_segment_time",
        "description": (
            "Predict a time for one segment at one hour, with the power used, the wind "
            "along the road, how much that wind is worth against still air, and the "
            "chance of beating your record."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "segment": _segment_arg("Segment name, a fragment of it, or its id."),
                "when": {
                    "type": "string",
                    "description": (
                        "Local hour as YYYY-MM-DDTHH, or a YYYY-MM-DD for that day's "
                        "first hour. Omit for the next hour."
                    ),
                },
            },
            "required": ["segment"],
        },
    },
    {
        "name": "find_best_window",
        "description": (
            "Rank the coming hours for one segment and report the best. Use this for "
            "'when should I ride X'."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "segment": _segment_arg("Segment name, a fragment of it, or its id."),
                "hours_ahead": {
                    "type": "integer",
                    "description": "How far ahead to look, up to 168. Defaults to all of it.",
                },
            },
            "required": ["segment"],
        },
    },
    {
        "name": "compare_segments",
        "description": (
            "Put several segments side by side at the same hour, ranked by the chance "
            "of a personal best. Use this for 'which should I ride'."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "segments": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Two or more segment names or fragments.",
                },
                "when": {
                    "type": "string",
                    "description": "Local hour as YYYY-MM-DDTHH. Omit for the next hour.",
                },
            },
            "required": ["segments"],
        },
    },
    {
        "name": "explain_prediction",
        "description": (
            "Show the arithmetic behind a prediction: the power and its source, the "
            "fitted mass and frontal area, air density, and the segment solved in "
            "tenths with the gradient, wind and speed of each. Use this to check "
            "whether a surprising answer is right."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "segment": _segment_arg("Segment name, a fragment of it, or its id."),
                "when": {
                    "type": "string",
                    "description": "Local hour as YYYY-MM-DDTHH. Omit for the next hour.",
                },
            },
            "required": ["segment"],
        },
    },
    {
        "name": "refresh_data",
        "description": (
            "Re-read the calibration and segment list from S3. The worker rebuilds "
            "them daily; this picks up a rebuild without restarting the server."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _refresh() -> str:
    data.load(refresh=True)
    known = data.segments()
    fitted = sum(1 for s in known.values() if s.get("calibrated_power_w"))
    return (
        f"Reloaded: {len(known)} segments, {fitted} with power fitted from their own "
        f"attempts, {len(known) - fitted} relying on the rider model."
    )


HANDLERS: dict[str, Callable[..., str]] = {
    "list_segments": tools.list_segments,
    "predict_segment_time": tools.predict_segment_time,
    "find_best_window": tools.find_best_window,
    "compare_segments": tools.compare_segments,
    "explain_prediction": tools.explain_prediction,
    "refresh_data": _refresh,
}


def _call(name: str, arguments: dict) -> dict:
    handler = HANDLERS.get(name)
    if handler is None:
        return {
            "content": [{"type": "text", "text": f"No such tool: {name}"}],
            "isError": True,
        }
    try:
        return {"content": [{"type": "text", "text": handler(**arguments)}]}
    except Exception as exc:  # noqa: BLE001
        # Reported as tool output rather than a protocol error, so the caller can
        # read what went wrong and try something else instead of the whole
        # conversation failing.
        traceback.print_exc(file=sys.stderr)
        return {
            "content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}],
            "isError": True,
        }


def handle(message: dict) -> dict | None:
    """One request in, one response out. None means the message needs no reply."""
    method = message.get("method")
    request_id = message.get("id")

    # Notifications carry no id and must never be answered.
    if request_id is None:
        return None

    if method == "initialize":
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": SERVER,
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        params = message.get("params") or {}
        return _call(params.get("name", ""), params.get("arguments") or {})

    raise LookupError(method or "(no method)")


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue

        request_id = message.get("id")
        try:
            result = handle(message)
        except LookupError as exc:
            reply: dict[str, Any] = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"Method not found: {exc}"},
            }
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            reply = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32603, "message": str(exc)},
            }
        else:
            if result is None:
                continue
            reply = {"jsonrpc": "2.0", "id": request_id, "result": result}

        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
