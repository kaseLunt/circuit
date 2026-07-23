---
id: D-004
type: decision
title: Codex is the senior reviewer for load-bearing work
status: superseded
date: 2026-07-22
approved_by: Kase Lunt (owner)
supersedes: []
superseded_by: D-007
updated: 2026-07-23
---

# D-004 — Codex senior review

## Context

This project's spec quality came from independent adversarial review: a Codex pass caught
implementer-level defects (cyclic graph semantics, HF ambiguity, misdecoded errors) that
same-model review missed. The owner directs that this remain standing practice, not a one-off.

## Decision

Dispatch a Codex review (via the codex-reviewer agent, resuming the existing Codex session where
one exists so accumulated context is retained) for anything that warrants senior review. At
minimum, that means:

- SPEC.md changes beyond typo-level, before they are committed as the new contract;
- every `core/` money-math module before the phase-exit receipt that claims it correct;
- the §6 execution family (plan building, sandbox execution, recovery machines) before P3 closes;
- phase-boundary reviews (the outgoing phase's outputs, before the next phase builds on them);
- anything the integrator judges load-bearing or is uncertain about.

The review outcome (verdict + disposition of findings) is recorded in the relevant evidence
receipt or decision record. A Codex verdict is advisory input to the owner/integrator, not
authority — but skipping a warranted review requires stating why in the receipt.

## Consequences

- Review context accumulates in resumable Codex sessions; findings get verified, not re-argued.
- Phase receipts gain a "senior review" line; P0→P1 is the first application.
