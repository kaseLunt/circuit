---
id: D-005
type: decision
title: Receipt currency checks apply only to achieved-referenced receipts
status: proposed
date: 2026-07-23
supersedes: []
updated: 2026-07-23
---

# D-005 — Evidence-receipt currency is an attainment claim

## Context

The bundled validator swept every `type: evidence` file with full fingerprint *currency* checks
(current snapshot must equal the tested commit). Combined with receipt immutability and the
no-delete rule, this froze any work item's `invalidated_by`/deliverable paths forever — W04's
legitimate remediation of W01's inputs could not be committed at all. SYSTEM.md's own model
says input changes "invalidate attainment until verification is rerun" and immutable records
are "append-only or superseded" — history, not standing claims.

## Decision

`roadmap/tools/doctor.py` scopes currency checks (`current == tested` for contract and input
fingerprints) to receipts **referenced by achieved work** — where they are the attainment claim
and correctly block silent drift. The all-files evidence sweep still validates structure,
work-binding, status, timestamps, ancestry, and recorded-vs-tested fingerprint integrity; it no
longer asserts currency for unreferenced or superseded receipts.

Consequence for W01: its invalidated receipt remains as unreferenced history; W01 sits
`superseded` until W04's close re-runs the full suite and re-achieves it with a fresh receipt.

## Ratification

Proposed by the integrator; operates via an owner-acknowledged enforcement commit. Owner
acceptance pending. Note: this is a local patch to installer-owned tooling — a future
control-plane upgrade will flag the drift and must be reconciled against this decision.
