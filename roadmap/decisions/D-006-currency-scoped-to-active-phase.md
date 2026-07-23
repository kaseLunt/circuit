---
id: D-006
type: decision
title: Receipt currency is an active-phase guarantee; completed phases are historical
status: proposed
date: 2026-07-23
supersedes: []
updated: 2026-07-23
---

# D-006 — Receipt currency applies within the active phase only

## Context

D-005 scoped fingerprint *currency* checks (current snapshot == tested commit) to receipts
referenced by achieved work. That correctly blocks stale green claims within a phase, but it
over-fires across phases: P1 legitimately evolves shared files (`package.json`, configs) that
appear in completed P0 items' `invalidated_by`. Under D-005 alone, adding a test dependency in
P1 retroactively invalidated W01's P0 attainment — a completed phase cannot stay closed while
the next phase builds on it. SYSTEM.md frames achieved attainment as an immutable record valid
as of its tested commit; a moving-HEAD currency check contradicts that once the phase is done.

## Decision

`doctor.py` applies the currency check to an achieved work item **only when its `phase` equals
`STATUS.active_phase`**. While a phase is active, its achieved items must still match HEAD
(catches intra-phase staleness). Once `active_phase` moves on, the item is historical: its
receipt remains valid as of its immutable `tested_commit`, and shared-input evolution by later
phases does not unachieve it. The recorded-vs-tested integrity check is unconditional in all
cases; only the current-vs-tested comparison is phase-scoped.

Reopening a completed phase's item (e.g. a real regression in P0 scaffolding) is an explicit
transition: set it back to active and re-verify — not a silent consequence of an unrelated edit.

## Ratification

Proposed by the integrator during P1 bootstrap; operates via an owner-acknowledged enforcement
commit. Owner acceptance pending. Refines D-005; a future control-plane upgrade must reconcile
both against upstream tooling.
