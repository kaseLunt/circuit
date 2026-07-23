---
id: D-003
type: decision
title: Push-event scope review reports without failing (solo serial-writer posture)
status: proposed
date: 2026-07-22
supersedes: []
updated: 2026-07-22
---

# D-003 — Push-event scope review is report-only

## Context

The control-plane workflow's push-replay job requires a pull-request number to attribute owner
approvals. This repository currently uses a direct-push serial-writer flow (D-001/D-002), so
every push containing an owner-reviewed governance transition fails that advisory job — a
permanent red X that carries no information beyond "this was not a PR".

## Decision

Mark the push-replay step `continue-on-error: true`. Its output remains in the logs; the job is
already labeled advisory, and local gates (pre-commit doctor + scope-gate) remain the operative
feedback. PR-event scope review is unchanged and still fails on violations.

## Upgrade path (before the repo goes public)

Adopt PR-based integration with branch protection and the required-workflow trusted audit; then
revert this step to failing. Tracked as a P4 launch item.

## Ratification

Proposed by the integrator during P0; owner acceptance pending.
