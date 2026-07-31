---
id: W09
type: work
title: USDC carry leg — uncorrelated borrow, eMode constraint, second template
phase: P3
status: achieved
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
  - README.md
  - package.json
  - package-lock.json
  - vitest.config.mjs
  - eslint.config.mjs
  - roadmap/work/W09-usdc-carry-leg.md
deliverables:
  - README.md
  - src/lib/strategy/templates.ts
  - src/core/risk.ts
  - src/core/health-factor.ts
  - src/core/plan.ts
  - src/core/borrow-limit.ts
  - docs/protocol-matrix.md
evidence_receipts:
  - roadmap/evidence/E-W09-usdc-carry-leg.md
invalidated_by:
  - SPEC.md
  - src/core/**
review_when: event:invalidated-by-change
updated: 2026-07-31
evidence_fingerprint: sha256:5c9e63060295d85bfd214aa93e1b6e5e7a3c689e6cd9265c30f2ce4ebace0c8f
---

# W09 — USDC carry leg

**Why this advances the vision:** the correlated loop demonstrates capital efficiency; the
USDC carry demonstrates the risk engine. Supply weETH, borrow USDC — no eMode, LTV 7750 /
LT 8000 bps (the non-eMode weETH regime, read from the pinned snapshot) — beside the loop
resting at HF 2.3, a carry sits in the amber band with a liquidation ratio that means
something. Two archetypes, one honest machine. Owner-ratified sequence 2026-07-28: after W08.
Charter revised 2026-07-30 per the sentinel treatment
(`C:\Users\kasel\AppData\Local\Temp\w05\w09-usdc-treatment.md`, verified against
aave-dao/aave-v3-origin @ fd1fbd9); the treatment binds this item the way rev 3.2 bound P3.

## Objective

0. **README truth first (owner-ratified fast item, first commit).** Un-comment the demo GIF
   embed and point it at `docs/demo.gif` (the committed 41s capture; the referenced
   `docs/media/` path never existed), and correct the merge-gate table: five required checks,
   adding the `e2e-fork` row (the browser-driven execution arc against a per-session pinned
   fork). Nothing else in the README moves — the full refresh is P4.
1. USDC reserve reads on the recorded-reads path: enrol USDC in `ChainSnapshot.reserves` and
   the pinned read set (the rate model is the existing Aave math over a different reserve).
   Three blocking six-decimal generalizations named by the treatment: `valueInBase` takes the
   reserve's `assetUnit` (the 18-decimal refusal currently makes carry HF unknown), debt base
   conversion via the ported `mulDivCeil` (GenericLogic-exact), and `liquidationRatioWad`
   unit-normalized (currently decimals-broken by 1e12 for weETH/USDC) with an
   equal-unit-reduction property test.
2. Borrow-leg support for a non-category asset. The compiler refusal for an in-eMode wallet
   already lands in `plan.ts`; W09 extends the reserve set without USDC-special-casing any
   branch. **Owner-ratified rulings (2026-07-30):** a mixed document (loop + carry) plans at
   the reserve regime with the regime stated as a rendered fact; `setUserEMode(0)` mid-plan is
   banned (case analysis: impossible above LT, an LTV-bypass in the (7750, 8000] window,
   pointless below LTV). The refusal is a designed state, never a revert discovered on the fork.
3. Oracle honesty: the USDC feed is "Capped USDC / USD" and is NOT $1 (read ~$0.9997 at the
   treatment's reality check). No $1 assumption anywhere; the risk labels state which way a
   depeg cuts (USDC downside RAISES carry HF).
4. Attribution: the existing Transfer-event mechanism for the USDC leg with exact equality on
   the fork; assert that no plan contains a USDC approve; carry template added beside the
   flagship with its owner-ratified default allocation of 6000 bps (the amber band, ratified
   2026-07-30); fork proof of the carry plan end to end; risk/HF assertions at the non-eMode
   LTV.

## Acceptance

- README shows the demo GIF and the five-check merge-gate table on GitHub.
- The carry template composes, simulates, and executes on the fork with every W07/W08
  invariant (attribution whitelist, tolerance, zero-after-consume) holding for the USDC leg.
- The eMode-category constraint is compiler-enforced, unit-proven, and the raw revert
  (`NotBorrowableInEMode`) is fork-proven by hand-constructed calldata — the product path
  refuses before calldata exists, by design, so the drill constructs its own.
- The two-template risk contrast renders honestly (amber band, liquidation ratio at the
  non-eMode regime) with all figures provenanced and no $1 oracle assumption.
- Codex final approval per D-007/D-011 (money-path; hard gate).

## Canonical commands

```text
npm run typecheck && npm run lint && npm run check:lint-boundaries
npx vitest run --coverage
npm run test:fork
```

## Non-goals

- Swap block / aggregator (P5). Looping USDC (requires swap).
- Any new protocol beyond the existing Aave v3 integration.
- The full README refresh, deploy, and OG/meta (P4).

## Handoff

- next: first commit is the README truth fix; then the reserve enrolment with the three
  six-decimal generalizations, fork-validated, before any template work.
- read_first: the sentinel treatment (path above), `src/core/rates.ts` (the reserve math to
  instantiate), `src/core/plan.ts` (the landed eMode refusal), `src/core/borrow-limit.ts`
  (the protocol rounding chain the USDC leg inherits at assetUnit 1e6).
- hazards: the eMode-category constraint is the correctness core; the six-decimal traps are
  blocking (assetUnit, mulDivCeil debt conversion, liquidationRatioWad units); the oracle is
  capped, not $1 — a $1 assumption anywhere is a blocking finding.
