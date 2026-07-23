---
id: D-007
type: decision
title: Complex work requires Codex final approval as a hard gate
status: accepted
date: 2026-07-23
approved_by: Kase Lunt (owner)
supersedes: [D-004]
updated: 2026-07-23
---

# D-007 — Codex final approval for complex work

## Context

Supersedes D-004, which made Codex a senior *reviewer* whose verdict was advisory. In practice
the Codex loop caught defects that would otherwise have shipped — all-wrong error selectors,
tautological tests, and a genuine health-factor wrong-number the integrator introduced by
overriding the reviewer. The owner directs that for complex work this is no longer advisory: it
is a required final-approval gate.

## Decision

**Complex work must always receive a final APPROVAL verdict from Codex before it can be marked
`achieved` or before its phase may exit.** The gate is hard, not advisory:

- A complex work item's evidence receipt MUST cite a Codex verdict that is an explicit approval
  ("sound to proceed" / "may close" / equivalent), at the reviewed commit.
- If Codex withholds approval (blocking or unresolved findings), the work is **not done** — fix
  and re-review until approval, resuming the same Codex session for context.
- Owner override is the only exception and must be recorded explicitly in the receipt with the
  owner's rationale; the integrator may not self-exempt.

**Complex work** (non-exhaustive; the integrator errs toward inclusion): any `core/` or
money-math module; calldata / transaction-building / execution; security-bearing surfaces
(auth, provenance, share-URL handling); protocol-integration correctness; phase-boundary
transitions; architecture-bearing changes; and anything the integrator judges load-bearing or
is uncertain about. Trivial/mechanical work (docs, formatting, dependency bumps, test-only
tweaks) does not require the gate — but if a mechanical change touches complex code's behavior,
it is complex.

Dispatch via the codex-reviewer agent, resuming the standing Codex session so accumulated
context is retained; record verdict + finding disposition in the receipt.

## Consequences

- "Reviewed" is replaced by "approved": a complex receipt without a recorded Codex approval (or
  an explicit owner override) is invalid and doctor/should treat it as incomplete evidence.
- The P1 finance core (W03) is the first item to close under this gate: `core/` is approved;
  `plan.ts` and the fork suite must obtain Codex approval before the P1-exit receipt.
- Review context accumulates in the resumable Codex session; findings are verified, not
  re-argued.
