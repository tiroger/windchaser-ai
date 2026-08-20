# ADR-0003: Terraform and GitHub Actions delivery

## Status

Accepted

## Context

The project must demonstrate reproducible infrastructure and production-style
delivery while avoiding long-lived cloud credentials.

## Decision

Declare all AWS resources with Terraform. Use GitHub Actions for validation,
planning, artifact builds, and environment promotion. Authenticate with GitHub OIDC
and short-lived, environment-scoped AWS roles.

## Consequences

- Infrastructure changes are reviewable and reproducible.
- Bootstrap and provider-coverage edge cases require explicit handling.
- CI/CD permissions become part of the security architecture.
- Manual console drift is detected and corrected through code.

