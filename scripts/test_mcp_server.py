#!/usr/bin/env python3
"""Speak the protocol to the MCP server and check what comes back.

Runs the server as a subprocess over stdio, exactly as a client would, because
the failures worth catching are protocol-shaped: replying to a notification,
writing something to stdout that is not a message, or letting an exception in a
tool take down the connection instead of being reported as tool output.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "mcp" / "server.py"

# The real artefacts hold personal training data and are not in the repository,
# so the tests bring their own. Nothing below asks a question that needs a
# forecast, which keeps them off the network and deterministic.
SYNTHETIC_SEGMENT = {
    "id": 11,
    "name": "Test Hill",
    "source": "starred",
    "distance_m": 2000.0,
    "average_grade": 5.0,
    "maximum_grade": 9.0,
    "elevation_high": 200.0,
    "elevation_low": 100.0,
    "total_elevation_gain": 100.0,
    "climb_category": 1,
    "city": "Nowhere",
    "state": None,
    "effort_count": 10,
    "athlete_count": 5,
    "star_count": 1,
    "pr_elapsed_time": 600,
    "pr_date": None,
    "effort_count_personal": 4,
    "points": [[41.0 + i * 0.001, -73.9] for i in range(12)],
    "region_id": "r0",
    "cell_id": "41.00,-73.90",
}


def fixtures() -> str:
    """A minimal artefact pair, written somewhere the server can be pointed at."""
    directory = Path(tempfile.mkdtemp(prefix="windchaser-mcp-"))
    (directory / "calibration.json").write_text(json.dumps({
        "generated_at": "2026-08-21T00:00:00Z",
        "segments": {
            "11": {
                "segment_id": 11,
                "name": "Test Hill",
                "power_w": 220.0,
                "attempt_count": 9,
                "best_moving_time_s": 590,
                "pr_elapsed_time_s": 600,
                "elevation_profile": {
                    "distance_m": [0, 1000, 2000],
                    "altitude_m": [100, 150, 200],
                },
            }
        },
        "rider": {
            "cp_w": 132.0, "w_prime_j": 11000.0, "grade_w": 1250.0,
            "grade_min": -0.002, "grade_max": 0.059,
            "mass_kg": 75.9, "cda": 0.259, "attempt_count": 141,
        },
    }))
    (directory / "opportunities.json").write_text(json.dumps({
        "generated_at": "2026-08-21T00:00:00Z",
        "segments": [SYNTHETIC_SEGMENT],
        "forecast_cells": {},
    }))
    return str(directory)


FIXTURE_DIR = fixtures()


class Client:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={**os.environ, "WINDCHASER_FIXTURES": FIXTURE_DIR,
                 "WINDCHASER_BUCKET": ""},
        )

    def send(self, message: dict) -> None:
        assert self.proc.stdin
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def read(self, timeout: float = 60.0) -> dict:
        assert self.proc.stdout
        line = self.proc.stdout.readline()
        if not line:
            raise AssertionError("server closed the connection")
        return json.loads(line)

    def call(self, name: str, arguments: dict, request_id: int = 99) -> dict:
        self.send({
            "jsonrpc": "2.0", "id": request_id, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        })
        return self.read()

    def close(self) -> str:
        assert self.proc.stdin and self.proc.stderr
        self.proc.stdin.close()
        self.proc.wait(timeout=30)
        return self.proc.stderr.read()


def run(name: str, fn) -> None:
    fn()
    print(f"  ok  {name}")


def test_handshake_and_catalogue() -> None:
    c = Client()
    try:
        c.send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {}}})
        result = c.read()["result"]
        assert result["protocolVersion"] == "2024-11-05", result
        assert result["serverInfo"]["name"] == "windchaser", result

        c.send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools = c.read()["result"]["tools"]
        names = {t["name"] for t in tools}
        assert {"predict_segment_time", "compare_segments", "explain_prediction"} <= names, names
        # Every tool needs a schema, or a client cannot call it.
        for tool in tools:
            assert tool["inputSchema"]["type"] == "object", tool["name"]
            assert tool["description"], tool["name"]
    finally:
        c.close()


def test_a_notification_is_never_answered() -> None:
    c = Client()
    try:
        # If the server replies to this, the reply is read as the answer to the
        # next request and every subsequent response is off by one.
        c.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        c.send({"jsonrpc": "2.0", "id": 7, "method": "ping"})
        reply = c.read()
        assert reply["id"] == 7, f"expected the ping's reply, got {reply}"
    finally:
        c.close()


def test_a_failing_tool_reports_rather_than_dies() -> None:
    c = Client()
    try:
        reply = c.call("predict_segment_time", {"segment": "no such segment here"})
        assert "content" in reply["result"], reply
        assert "No segment matching" in reply["result"]["content"][0]["text"]
        # The connection must still work afterwards.
        reply = c.call("list_segments", {"search": "Test"}, request_id=100)
        assert reply["id"] == 100
        assert "Test Hill" in reply["result"]["content"][0]["text"]
    finally:
        c.close()


def test_unknown_tool_and_unknown_method_differ() -> None:
    c = Client()
    try:
        # An unknown tool is the model's mistake: report it as tool output so it
        # can pick another one.
        reply = c.call("not_a_tool", {})
        assert reply["result"]["isError"] is True, reply
        # An unknown method is the client's mistake, and belongs in the
        # protocol's own error channel.
        c.send({"jsonrpc": "2.0", "id": 8, "method": "no/such/method"})
        reply = c.read()
        assert reply["error"]["code"] == -32601, reply
    finally:
        c.close()


def test_nothing_but_protocol_reaches_stdout() -> None:
    c = Client()
    try:
        c.call("list_segments", {})
        # A tool that fails, since a real prediction would need the forecast.
        c.call("predict_segment_time", {"segment": "nothing called this"})
        c.send({"jsonrpc": "2.0", "id": 9, "method": "ping"})
        # A stray print would have been consumed as one of the replies above and
        # this read would fail or return the wrong id.
        assert c.read()["id"] == 9
    finally:
        c.close()


def main() -> None:
    print("MCP server")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            run(name[5:].replace("_", " "), fn)
    print("  all passed")


if __name__ == "__main__":
    main()
