---
id: W09
type: work
title: USDC carry leg — uncorrelated borrow, eMode constraint, second template
phase: P3
status: candidate
evidence_target: usdc-carry-template-fork-proven-with-emode-constraint
priority: 2
depends_on: [W08]
blocked_by: []
informs: [H0]
allowed_paths:
  - src/**
  - tests/**
  - e2e/**
  - docs/**
  - scripts/**
  - package.json
  - package-lock.json
  - vitest.config.ts
  - roadmap/work/W09-usdc-carry-leg.md
deliverables:
  - src/lib/strategy/templates.ts
evidence_receipts: []
invalidated_by:
  - SPEC.md
  - src/core/**
review_when: event:invalidated-by-change
updated: 2026-07-28
---

# W09 — USDC carry leg

**Why this advances the vision:** the correlated loop demonstrates capital efficiency; the
USDC carry demonstrates the risk engine. Supply weETH, borrow USDC — no eMode, ~72% LTV, real
price risk — beside the loop resting at HF 2.3, a carry sits in the amber band with a
liquidation ratio that means something. Two archetypes, one honest machine.
Owner-ratified sequence 2026-07-28: after W08.

## Objective

1. USDC reserve reads on the recorded-reads path (rate model is the existing Aave math over a
   different reserve; oracle-priced risk already handles uncorrelated debt).
2. Borrow-leg support for a non-category asset: the plan compiler models the eMode-category
   constraint — while in ETH-correlated eMode a USDC borrow is refused or the eMode state is
   sequenced correctly; the refusal is a designed state, not a revert discovered on the fork.
3. Attribution: the existing Transfer-event mechanism for the USDC leg; carry template added
   beside the flagship; fork proof of the carry plan end to end; risk/HF assertions at the
   non-eMode LTV.

## Acceptance

- The carry template composes, simulates, and executes on the fork with every W07 invariant
  (attribution whitelist, tolerance, zero-after-consume) holding for the USDC leg.
- The eMode-category constraint is compiler-enforced and unit-plus-fork proven.
- The two-template risk contrast renders honestly (amber band, liquidation ratio) with all
  figures provenanced.
- Codex final approval per D-007/D-011 (money-path; hard gate).

## Canonical commands

```text
npm run typecheck && npm run lint && npx vitest run --coverage
npm run test:fork
```

## Non-goals

- Swap block / aggregator (P5). Looping USDC (requires swap).
- Any new protocol beyond the existing Aave v3 integration.

## Handoff

- next: activate after W08; first commit is the reads + rate model, fork-validated.
- read_first: `src/core/rates.ts` (the reserve math to instantiate), `src/core/plan.ts`
  (eMode sequencing), the W07 amendment paragraph for the split rationale.
- hazards: the eMode constraint is the correctness core of this item — a plan that borrows a
  non-category asset while in eMode 1 reverts on-chain; the compiler must refuse first.
