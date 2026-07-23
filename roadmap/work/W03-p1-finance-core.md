---
id: W03
type: work
title: P1 finance core — 13-step plan green on a pinned fork, headless
phase: P1
status: active
evidence_target: thirteen-step-plan-green-on-pinned-fork-in-ci
priority: 1
depends_on: [W04]
blocked_by: []
informs: [H0]
allowed_paths:
  - src/**
  - tests/**
  - .github/**
  - docs/**
  - spikes/**
  - package.json
  - package-lock.json
  - vitest.config.ts
  - vitest.fork.config.ts
  - tsconfig.json
  - eslint.config.mjs
  - roadmap/work/W03-p1-finance-core.md
deliverables:
  - src/core/provenance.ts
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
  - vitest.fork.config.ts
  - package.json
  - .github/workflows/ci.yml
evidence_receipts: []
invalidated_by:
  - SPEC.md
  - TRANSPLANT.md
  - docs/protocol-matrix.md
  - docs/protocol-matrix-reads.json
  - scripts/**
  - src/core/**
  - src/server/**
  - tests/**
  - vitest.config.ts
  - vitest.fork.config.ts
  - eslint.config.mjs
  - package.json
review_when: phase:P1:exit
updated: 2026-07-23
---

# W03 — P1 finance core on a fork, headless

**Why this advances the vision:** H0's central claim is provable money-math. P1 builds the
entire finance model and proves it against real protocol state *before* any canvas exists —
inverting the prototype's polish-first failure. Disproof: the 13-step flagship plan failing on
the pinned fork, an HF assertion diverging from Aave's accounting beyond the named bounds, or
any pre-existing share/amount being consumed.

## Objective

Implement SPEC §4's `core/` (provenance, rates, health-factor, allocation, graph, plan, errors,
format — pure, no I/O) and `server/chain/` (block-pinned `ChainSnapshot` reads), then prove the
SPEC §2 13-step flagship plan end-to-end on the pinned anvil fork in CI. No UI beyond a debug
harness. All protocol constants come from `docs/protocol-matrix.md` (backed by the committed
reads log) — never from memory.

**P1 execution scope is the EtherFi flagship only.** Lido blocks remain schema-representable,
but `core/plan.ts` returns an explicit typed `UnsupportedInPhase` error for them; no Lido
execution facts exist in the matrix yet (its §8 note).

## The pinned fixture (single source of fork determinism)

- **Fork block:** `25,592,678`, hash
  `0x7f1f53176578a6df42c94948c10623f002cca61398208c888edce99eaedbf0de`,
  timestamp 2026-07-23T03:14:11Z — the same block the committed matrix reads were generated at
  (`docs/protocol-matrix-reads.json` meta).
- **Anvil:** v1.7.1 (pinned; CI installs via foundry-toolchain pinned to the same version).
- All fork tests, matrix values, and plan fixtures reference this block. Re-pinning the block
  requires regenerating the matrix (`node scripts/protocol-reads.mjs`) in the same commit.

## Amount provenance (complete, per boundary review)

Every `TransactionStep` amount is exactly one of:

1. `literal` — the Input step only.
2. `step-output(producerStepId)` — attributed by the most precise signal: eETH via **share
   delta** or the producer's return value (deposit returns shares minted; floor-rounded per the
   matrix §7 semantics); WETH `withdraw` via its argument; ERC-20 mints/transfers via the
   producer's `Transfer` event value.
3. `derived(expression)` — for amounts computed from snapshot values, currently only the
   **borrow amount**: with `b_bps` = the borrow block's allocation (basis points of collateral
   value at open), all math in bigint over the block-pinned snapshot:
   `collateralBase = floor(suppliedWeETHWei × priceWeETHBase / 10^18)`;
   `borrowBase = floor(collateralBase × b_bps / 10^4)`;
   `borrowWei = floor(borrowBase × 10^18 / priceWETHBase)`.
   **Floor at every division** (conservative: rounds debt down). The expression, its inputs
   (each `Provenanced`), and rounding direction are recorded on the step.

## No-sweep invariants (share-based, integer bounds)

The fork suite seeds pre-existing balances (eETH, weETH, WETH) on the strategy wallet and
induces a rebase between steps via this exact, fully-specified mutation contract:
1. locate the packed accounting word empirically — `getTotalPooledEther()` is the sum of
   two packed `uint128` fields (`totalValueOutOfLp` + `totalValueInLp`, per the matrix §7
   source); scan the LiquidityPool proxy's first 256 slots at the fork block for the unique
   word where `uint128(word) + uint128(word >> 128) == getTotalPooledEther()` (excluding
   trivial zero words); assert exactly one match — on zero or multiple matches the test
   FAILS with the scan dump recorded (fallback path, only if that failure occurs: perform
   the rebase by impersonating the LP's authorized rebase caller instead, asserting the
   same post-conditions);
2. compute `delta = floor(getTotalPooledEther() / 100)` (+1.0000%); add `delta` to the
   low-half field, preserving the high half bit-exactly:
   `newWord = word + delta`, asserting the low half does not overflow into the high half;
3. `anvil_setStorageAt(slot, newWord)`; assert `getTotalPooledEther()` returns exactly
   `oldTotal + delta`, assert slots `slot-1` and `slot+1` are byte-identical to their
   pre-mutation values, and assert `eETH.totalShares()` is unchanged;
4. re-read `LP.amountForShare(1e18)` and assert it equals
   `floor(1e18 * (oldTotal + delta) / totalShares)`; all subsequent expected-value math uses
   the re-read rate. The recorded slot id and pre/post words go into the test output.
Invariants:

- Pre-existing **eETH shares** (`eETH.shares(wallet)` attributable to the seed): exact integer
  equality before/after — a rebase changes `balanceOf`, never seeded shares.
- Pre-existing **weETH and WETH token amounts**: exact equality (non-rebasing).
- Strategy-consumed amounts are attributed per §Amount-provenance; residual dust bounds are
  **named constants**: `EETH_DUST_SHARES_MAX = 1n` per wrap round-trip (floor mulDiv loses at most 1 integer
  share per conversion at rate > 1; the flagship has two wraps, so the aggregate bound is `2n`), `WETH_RESIDUAL_MAX = 0n`,
  `WEETH_RESIDUAL_MAX = 0n`. Exceeding any bound fails the suite.

## Acceptance

- **Fork gate:** `npm run test:fork` executes all 13 enumerated SPEC §2 steps against the
  pinned fixture **in CI**, asserting after every risk-changing step (supply, borrow, e-mode
  set, resupply) that `core/health-factor.ts` agrees with `Pool.getUserAccountData()`'s
  **WAD-scaled (1e18)** healthFactor within **1 part in 10^8 relative** — HF comparisons
  apply only while debt exists; before any debt, both sides must equal the no-debt sentinel
  `type(uint256).max` exactly. The final-state assertion list below must pass.
- **Final-state assertions (each exact or with the named bound):** user e-mode category == 1;
  weETH `usageAsCollateralEnabledOnUser` == true; **scaled** balances are the primary, index-independent assertions:
  `aToken(weETH).scaledBalanceOf(wallet)` equals the sum of per-supply scaled amounts (each
  computed from the attributed supplied amount and that supply's `nextLiquidityIndex` with
  aToken rounding, <=1 wei per supply, bound **2 wei** scaled); WETH
  `variableDebt.scaledBalanceOf(wallet)` equals the borrow's scaled amount within **1 wei**
  scaled; display-level balances are then recomputed from the final block's indices and
  asserted against on-chain `balanceOf` within **1 wei**; minimum-HF and final-HF each within the HF
  bound above; residuals: wallet weETH == seed exactly, WETH == seed exactly, eETH shares
  within the aggregate `2n` share bound of seed+attributed, native ETH: `final == initial − inputLiteral − gasActuallyPaid` (the
  borrow→unwrap→restake leg nets to zero by construction); post-action `liquidityRate`/`variableBorrowRate` from `getReserveData` == the
  §5.1 predicted rates within **1e-6 relative** (same strategy params, same formula).
- **No-sweep proof:** the invariants above, including the induced rebase.
- **Unit suite (behavioral, enumerated):** rates (RAY conversions, trailing-APR derivation,
  post-action rate recompute against the matrix strategy params, §5.2 net-APY fixtures), HF
  (min/final, e-mode cat-1 thresholds from the matrix, unknown state, liquidation-ratio
  algebra including the capped-oracle behavior recorded in matrix §5), allocation + graph
  structural validation (property tests: allocation conservation, HF≈1 rounding), plan
  snapshots for the 13-step fixture (to-address, selector, decoded args, amount-provenance
  kind per step), errors (v3.7 custom errors + legacy numeric fallback), format. **Coverage
  is configured, not asserted:** vitest v8 coverage with thresholds lines ≥95% / branches
  ≥90% on `src/core/`; `--passWithNoTests` is removed from the test script in this item.
- **Malicious-graph suite:** schema-valid-but-structurally-invalid graphs and the
  attacker-address payload are rejected by `core/graph.ts` before any plan is built (§5.6).
- **Validation matrix:** plan validation implements the recorded constraint set of matrix §4
  (active/frozen/paused, borrowing-enabled, supply+borrow caps via the **exact v3.7 formulas recorded in matrix §4** (scaled supply +
  accruedToTreasury indexed by nextLiquidityIndex; scaled debt by nextVariableBorrowIndex),
  available virtual liquidity, e-mode membership + isolated-category flag + LTV-zero bitmap,
  user collateral-enable) and
  rejects violating plans naming the offending block; cap boundary tested at the fixture's
  real weETH headroom.
- **No silent fallbacks:** numeric-literal `??` lint ban active in `core/`; `Provenanced<T>`
  (src/core/provenance.ts) carries every chain-derived value out of `server/chain/`.
- **Senior review (D-004):** Codex reviews `core/` before the phase-exit receipt; verdict and
  disposition recorded in the receipt.

## Fork-test wiring contract

- `package.json`: `"test:fork": "vitest run --config vitest.fork.config.ts"`.
- `vitest.fork.config.ts`: include `tests/fork/**/*.test.ts`; `passWithNoTests: false` (zero
  tests = fail); test/hook timeouts ≥ 120s; a global setup that spawns anvil
  (`ANVIL_PATH` env, default `anvil`) with
  `--fork-url $FORK_RPC_URL --fork-block-number 25592678 --host 127.0.0.1`, polls readiness,
  and tears the process down (kill + wait) on completion or failure.
- CI: `foundry-toolchain` action pinned to anvil v1.7.1; **`FORK_RPC_URL` is a required
  repository secret and must be archive-capable** — the pinned block has aged out of public
  nodes' recent-state windows (verified), so no public fallback exists.

## Non-goals

- No canvas, no components, no pages beyond a minimal debug harness.
- No Lido plan-building (explicit typed error; facts absent from the matrix by design).
- No sandbox session service (P3a) — the fork here is CI tooling, not the product sandbox.
- No SSE/live prices, no wallet connection.

## Canonical commands

```text
npm test                    # vitest unit suite incl. plan snapshots + coverage thresholds
npm run test:fork           # anvil fork suite at pinned block 25592678, also in CI
npm run build && npm run typecheck && npm run lint
python roadmap/tools/doctor.py
```

## Evidence

No attained evidence yet. Record fork-suite CI run IDs, the pinned fixture identity, and the
D-004 review outcome in the receipt; stamp per RULES.md.

## Handoff

- next: activates only after the W04 re-review confirms blockers cleared; activation flips
  P0→Done / P1→In progress in the same transition.
- read_first: SPEC §2 (13 steps, e-mode policy), §4, §5, §8; docs/protocol-matrix.md
  (including §3 OPEN item on v3.7 e-mode semantics — resolve before setUserEMode logic lands,
  and §7 deposit semantics); TRANSPLANT.md P2 rows (rpc.ts, rate-limiter, etherfi-contracts,
  liquidation.ts as rebuild-reference for HF algebra).
- hazards: weETH supply-cap headroom (~43k at the fixture block) is real but thin — cap
  validation is tested at that boundary; the fixture block guarantees determinism, mainnet
  does not. eETH moves by shares — use the share-based invariants, never balanceOf equality.
  v3.7 "Liquid eMode" membership is per-reserve-index bitmaps — use the matrix decode.
