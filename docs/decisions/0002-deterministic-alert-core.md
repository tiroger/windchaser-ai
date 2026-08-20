# ADR-0002: Deterministic alert core with optional generative explanation

## Status

Accepted

## Context

Wind alignment, target-time comparison, alert eligibility, consent, and deduplication
must be reproducible. Making them dependent on an LLM would increase cost,
variability, and failure risk.

## Decision

Calculate and authorize alerts with deterministic services. Bedrock generates a
grounded explanation from the stored evidence and powers interactive questions. A
deterministic template is the fallback alert text.

## Consequences

- Alerts continue during Bedrock or AgentCore outages.
- Numerical behavior can be unit-tested and replayed.
- AI adds value without becoming an uncontrolled authority.
- Separate evaluation suites are required for prediction and language behavior.

