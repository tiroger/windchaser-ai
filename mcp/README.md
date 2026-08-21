# WindChaser MCP server

Ask the prediction model questions in conversation, instead of scrubbing the
web interface for them.

Everything it answers comes from the same engine the application runs and the
same calibration the worker rebuilds daily. It does not re-implement the
physics, because a second implementation is a second set of answers.

## Wiring it up

The command is a plain path to a file. There is no virtual environment to
activate and nothing to install: the server uses the standard library only, and
imports the analytics package from this repository.

```json
{
  "mcpServers": {
    "windchaser": {
      "command": "python3",
      "args": ["/absolute/path/to/windchaser-ai/mcp/server.py"],
      "env": {
        "WINDCHASER_BUCKET": "windchaser-dev-data-755319535705",
        "AWS_PROFILE": "personal-admin"
      }
    }
  }
}
```

`WINDCHASER_BUCKET` is optional. With it, the server refreshes the calibration
from S3 through the AWS CLI, so a rebuild reaches your questions without a
redeploy. Without it, the working copy under `apps/web/fixtures` is used, which
is fine and simply as current as the last time you built it.

## What it will not do

It never calls Strava. Their read allowance is a thousand a day and the
application needs it; a question asked here should never be the reason a segment
list falls back to saved data. Segment geometry and calibration come from S3 or
disk, and the forecast comes from Open-Meteo, which has no such limit.

## Tools

| tool | question it answers |
| --- | --- |
| `list_segments` | what does the model know about, and how well |
| `predict_segment_time` | what would I do on this, at this hour |
| `find_best_window` | when this week should I ride it |
| `compare_segments` | which of these is the better bet right now |
| `explain_prediction` | why does it say that |
| `refresh_data` | pick up the worker's latest rebuild |

## Reading the answers

Two marks appear beside a segment in the tables:

- `~` power came from the rider-level model rather than that segment's own
  attempts. Backtested at 82s mean error against 52s for a segment with its own
  fit, so treat the number as a good estimate rather than a measurement.
- `!` the comparison is against a Strava *elapsed* record, which may be years
  old or include stops. A hundred percent chance of beating one of these means
  the record is soft, not that the ride is easy.

Both marks are worth taking seriously. Most of what the app shows is still
awaiting effort history, and the worker collects one segment a day.

## Things worth asking

- "Which of my segments has the best shot at a PB this weekend?"
- "When should I ride Hawk Hill this week, and how much is the wind worth?"
- "Why does it think I'd do 18:31 on Montebello to School?"
- "Which of my segments is most sensitive to wind direction?"
