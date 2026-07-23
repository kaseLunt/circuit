---
id: W03
type: work
title: P1 finance core — 13-step plan green on a pinned fork, headless
phase: P1
status: candidate
evidence_target: thirteen-step-plan-green-on-pinned-fork-in-ci
priority: 1
depends_on: [W01]
blocked_by: []
informs: [H0]
allowed_paths:
  - src/**
  - .github/**
  - docs/**
  - spikes/**
  - package.json
  - package-lock.json
  - vitest.config.ts
  - tsconfig.json
  - eslint.config.mjs
  - roadmap/work/W03-p1-finance-core.md
deliverables:
  - src/core/rates.ts
  - src/core/health-factor.ts
  - src/core/allocation.ts
  - src/core/graph.ts
  - src/core/plan.ts
  - src/core/errors.ts
  - src/core/format.ts
  - src/server/chain/snapshot.ts
  - src/core/plan.test.ts
  - tests/fork/flagship-plan.test.ts
  - .github/workflows/ci.yml
evidence_receipts: []
invalidated_by:
  - SPEC.md
  - TRANSPLANT.md
  - docs/protocol-matrix.md
  - src/core/**
  - src/server/**
review_when: phase:P1:exit
updated: 2026-07-23
---

# W03 — P1 finance core on a fork, headless

**Why this advances the vision:** H0's central claim is provable money-math. P1 builds the
entire finance model and proves it against real protocol state *before* any canvas exists —
inverting the predecessor's polish-first failure. Disproof: the 13-step flagship plan failing on
the pinned fork, an HF assertion diverging from Aave's own accounting, or any pre-existing
balance being swept.

## Objective

Implement SPEC §4's `core/` (rates, health-factor, allocation, graph, plan, errors, format —
pure, no I/O) and `server/chain/` (block-pinned `ChainSnapshot` reads), then prove the SPEC §2
13-step flagship plan end-to-end on a pinned anvil mainnet fork in CI. No UI beyond a debug
harness. All protocol constants come from `docs/protocol-matrix.md` (recorded reads) — never
from memory.

## Acceptance

- **Fork gate (the headline):** `tests/fork/flagship-plan.test.ts` executes all 13 enumerated
  steps against a pinned anvil fork **in CI**, asserting after every risk-changing step that
  `core/health-factor.ts` matches `Pool.getUserAccountData().healthFactor` (within documented
  rounding), and final position state matches the plan's prediction.
- **No-sweep proof:** the fork suite seeds pre-existing eETH/weETH/WETH balances **and induces a
  rebase between steps**; the plan provably touches none of them (SPEC §5.5 step-output
  attribution).
- **Unit suite:** 100% of `core/` — rates math (RAY conversions, trailing-APR derivation,
  post-action rate recompute, the §5.2 net-APY equation with fixtures), HF (min/final, e-mode
  category 1 thresholds, unknown state, liquidation-ratio algebra), allocation + graph
  structural validation (property tests for allocation conservation and HF≈1 rounding), plan
  snapshots for the 13-step fixture (to-address, selector, decoded args, amount-provenance per
  step), errors table (v3.6 custom errors + legacy fallback), format.
- **Malicious-graph suite:** schema-valid-but-structurally-invalid graphs and the
  attacker-address payload are rejected by `core/graph.ts` before any plan is built (§5.6).
- **Cap validation:** plan validation reads supply-cap headroom (weETH is ~96% full on mainnet)
  and rejects over-cap plans with the offending block identified (§5.7).
- **No silent fallbacks:** the numeric-literal `??` lint ban is active in `core/`; `Provenanced<T>`
  types carry every chain-derived value out of `server/chain/`.
- **Senior review (D-004):** Codex reviews `core/` before the phase-exit receipt; verdict and
  disposition recorded in the receipt.

## Non-goals

- No canvas, no components, no pages beyond a minimal debug harness.
- No sandbox session service (P3a) — the fork here is CI tooling, not the product sandbox.
- No SSE/live prices, no wallet connection.

## Canonical commands

```text
npm test                    # vitest unit suite incl. plan snapshots
npm run test:fork           # anvil fork suite (pinned block), also in CI
npm run build && npm run typecheck && npm run lint
python roadmap/tools/doctor.py
```

## Evidence

No attained evidence yet. Record fork-suite CI run IDs, the pinned block, and the D-004 review
outcome in the receipt; stamp per RULES.md.

## Handoff

- next: activates only after the P0→P1 boundary review (D-004) passes and its findings are
  dispositioned; activation flips P0→Done / P1→In progress in the same transition.
- read_first: SPEC §2 (13 enumerated steps, e-mode policy), §4 (layout + purity), §5 (all eight
  finance rules), §8 (fork suite requirements); docs/protocol-matrix.md; TRANSPLANT.md P2 rows
  (rpc.ts, rate-limiter, etherfi-contracts, liquidation.ts as rebuild-reference for HF algebra).
- hazards: weETH supply cap headroom (~43k) can shrink to zero on mainnet — the pinned fork
  block must be chosen with headroom, and cap validation tested at the boundary. eETH transfers
  move balances by shares — every equality assertion needs the documented rounding tolerance.
  Aave v3.6 "Liquid eMode" bitmaps: category membership is per-reserve-index, verify against the
  matrix's decode, not assumptions.
