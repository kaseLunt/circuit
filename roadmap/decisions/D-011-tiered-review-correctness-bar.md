---
id: D-011
type: decision
title: Tiered review — the gate targets correctness under realistic conditions
status: accepted
date: 2026-07-27
approved_by: Kase Lunt (owner)
supersedes: []
updated: 2026-07-27
---

# D-011 — tiered review, correctness bar

## Context

D-007 stands: complex work requires an explicit Codex APPROVAL before it is done. This
decision scopes WHICH work carries that gate and WHAT question the gate answers. The owner
reviewed the finding ledger across the eleven verdicts of the attribution and session-service
surfaces (2026-07-27): roughly half of all findings were correctness or availability defects
reachable in ordinary use, concentrated in money-path and session-lifecycle code; the other
half were hostile-input hardening that no ordinary use can trigger, concentrated in late
rounds with diminishing returns.

## Ruling

1. **The bar is correctness, not adversarial invulnerability.** The gate's question is: does
   this produce correct numbers and preserve state under realistic conditions — network
   flakes, transport ambiguity, reloads, retries, races from normal concurrent use, provider
   throttling? Findings of that class are blocking. Hostile-actor scenarios — forged objects
   from a malicious caller, deliberate manipulation of process internals, attacker-controlled
   clocks — are NOT blocking: they are recorded, fixed when the fix is cheap, and never hold
   a landing. Review dispatches state this severity model explicitly.

2. **Hard gate (full loop to APPROVAL)**: core/ and all money-math, attribution and amount
   handling, calldata construction, session lifecycle and recovery, protocol-integration
   correctness, phase exits.

3. **Advisory tier (one Codex round, integrator triages, no loop)**: UI surfaces, wallet
   glue, e2e specs, visual work. Taste desk + tests + CI carry these; a finding escalates to
   the hard gate only if the integrator judges it money-touching.

4. **Exempt** (restating D-007's exemption): docs, formatting, dep bumps, and test-only
   changes that do not alter complex behavior. CI remains the proof for test-infrastructure
   changes.

## Mechanics

Hard-gate receipts cite the APPROVAL verdict as before. Advisory-tier work cites its single
review thread and the triage disposition in the PR body.
