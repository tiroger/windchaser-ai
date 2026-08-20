# ADR-0001: New repository and selective migration

## Status

Accepted

## Context

The existing `my-strava` project contains valuable cycling domain knowledge and
historical data but uses a tightly coupled Streamlit/Pandas architecture, repeated
OAuth logic, local file persistence, old dependencies, and request patterns that
are unsuitable for a public serverless application.

## Decision

Build WindChaser in a new repository. Treat `my-strava` as a read-only reference and
source for an explicit one-time migration adapter. Port only tested domain behavior
and sanitized data.

## Consequences

- No compatibility burden with the legacy runtime.
- The new application can use React, typed services, MCP, and Terraform cleanly.
- Useful calculations require deliberate extraction and verification.
- The original application remains available as a historical portfolio artifact.

