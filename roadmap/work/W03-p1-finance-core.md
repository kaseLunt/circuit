---
id: W03
type: work
title: P1 finance core — 13-step plan green on a pinned fork, headless
phase: P1
status: achieved
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
  - scripts/**
  - package.json
  - package-lock.json
  - vitest.config.mjs
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
  - docs/address-roots.json
  - src/core/plan.test.ts
  - tests/fork/flagship-plan.test.ts
  - vitest.fork.config.ts
  - package.json
  - .github/workflows/ci.yml
evidence_receipts:
  - roadmap/evidence/E-W03-p1-finance-core-r3.md
invalidated_by:
  - SPEC.md
  - TRANSPLANT.md
  - docs/protocol-matrix.md
  - docs/protocol-matrix-reads.json
  - docs/address-roots.json
  - scripts/**
  - src/core/**
  - src/server/**
  - tests/**
  - vitest.config.mjs
  - vitest.fork.config.ts
  - eslint.config.mjs
  - package.json
review_when: event:invalidated-by-change
updated: 2026-07-25
evidence_fingerprint: sha256:70f739b90f8f5161f48cbd280de7af5e1ee385b46ed5a48c18db84634f3e5184
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
- **Address provenance is a verification input, not a doc.** `docs/address-roots.json` holds the
  only four addresses that are not on-chain reads, pinned to a hashed upstream artifact. It is
  listed in both `deliverables` and `invalidated_by` **deliberately**: `doctor.py` fingerprints
  exactly those lists plus receipts, so if this file were omitted, editing the upstream commit,
  the sha256, or a root address would leave an existing receipt mechanically "current" while the
  fixture's identity authority had silently changed. Re-run
  `node scripts/protocol-reads.mjs --verify-roots` whenever it changes.
- **Codex final approval (D-007, supersedes D-004):** an explicit Codex APPROVAL verdict is a
  hard gate before this item may be marked `achieved` or P1 may exit; verdict and
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
  nodes' recent-state windows (verified), so no public fallback exists. The secret exists
  (`gh secret list`: set 2026-07-23T05:16:10Z) and is write-only, so it cannot serve a local run.
- Local fork runs (2026-07-24): anvil is **not** installed system-wide and Foundry has no
  supported Windows `foundryup`. The pinned binary is kept out of the repo and off `PATH` at
  `C:/Users/kasel/tools/foundry-v1.7.1/anvil.exe` (release asset
  `foundry_v1.7.1_win32_amd64.zip`, sha256 `6d41121b4bbb809845821c903619cfee75ed364f2bdc58a6787c9b0454114537`
  verified against the published checksum; reports `anvil Version: 1.7.1`, commit
  `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`). Point the suite at it with `ANVIL_PATH`.
  A missing `FORK_RPC_URL` or absent anvil fails the suite closed; note that vitest runs
  `globalSetup` **before** collection, so either failure surfaces as a misleading
  "No test files found" alongside the real error.
- **Provider rate limits were a real failure mode, now mitigated at the root.** anvil assumes
  330 compute units/second (Alchemy's paid tier) and bursts past a free-tier endpoint, which
  answers `429`; anvil retries, gives up, and the suite dies with `Max retries exceeded` inside
  `captureFootprint`, reporting every test **skipped**. The global setup now passes
  `--compute-units-per-second` (`ANVIL_CUPS`, default `100`) so anvil self-throttles. Verified
  2026-07-25: 9/9 green with no cooldown in a window where unthrottled runs were failing, at the
  cost of runtime (~72s → ~129s). Raise `ANVIL_CUPS` when pointing at a higher-budget endpoint.
- **Diagnosing a fork-job failure:** `N skipped` + **zero** assertion failures + all setup steps
  green is the rate-limit signature, not a money-math regression — check that before reading
  logs. Note the two consumers are **not independent**: heavy local runs can exhaust the same
  quota the CI job needs, so a local debugging spree can cause a CI failure (observed
  2026-07-25). A dedicated CI endpoint would decouple them.

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
D-007 Codex approval verdict in the receipt; stamp per RULES.md.

## Handoff

- next: the D-007 Codex review of the full W03 surface, then push for the CI fork run, then
  stamp the receipt citing run IDs + fixture identity + the review verdict. `FORK_RPC_URL` is
  already a repository secret (`gh secret list`: set 2026-07-23T05:16:10Z) and is write-only —
  CI injects it; it cannot be read back for a local run. For a **local** fork run, build the URL
  from the old repo's key without writing it to disk (the suite reads `process.env` directly and
  neither node nor vitest auto-loads a `.env`):
  `export FORK_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/$(grep '^ALCHEMY_API_KEY=' /c/Users/kasel/source/repos/defi-portfolio-tracker/.env | cut -d'"' -f2)"`.
  Never commit the URL (post-incident policy).
  Done since the last handoff: getReserveDeficit reads added and the log regenerated (purely
  additive — every prior read byte-identical), deficit rows recorded in matrix §4, §9 item 3
  resolved, and both reserves' liquidityRate now reproduce exactly in rates.test.ts.
- read_first: SPEC §2 (13 steps, e-mode policy), §4, §5, §8; docs/protocol-matrix.md §4
  (source-verified v3.7 rounding/accrual semantics + cap formulas) and §7 deposit semantics;
  src/core/plan.ts module header; tests/fork/flagship-plan.test.ts header.
- hazards: weETH supply-cap headroom (~43k at the fixture block) is real but thin — cap
  validation is tested at that boundary; the fixture block guarantees determinism, mainnet
  does not. eETH moves by shares — use the share-based invariants, never balanceOf equality.
  v3.7 "Liquid eMode" membership is per-reserve-index bitmaps — use the matrix decode.
  Fork-execution traps (all encoded in the suite): anvil's public-key dev accounts carry
  EIP-7702 delegations on mainnet whose fallbacks OOG WETH9's 2300-gas ETH push — use a
  fresh code-free EOA; gas estimation understates Aave txs (accrual SSTOREs become value
  writes in the mined block) — send explicit limits; a reused external anvil MUST anvil_reset
  per run or state pollution masquerades as bugs. v3.7 feeds reserve.deficit into liquidity
  rates (WETH deficit ≈ 52.96k at the pin, confirmed by live read + rate inversion).
