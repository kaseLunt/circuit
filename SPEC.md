# SPEC — Strategy Studio (working title)

> A node-based DeFi strategy composer: drag blocks, see honestly-simulated outcomes
> with live on-chain data, execute real multi-step transactions with production-grade
> wallet UX — every money-path unit- and fork-tested.

**Status:** v2.2 · 2026-07-22 — post-verification revision. Codex verification of
v2.1 scored 17/26 resolved, 9 partial, 0 unresolved and cleared P0; v2.2 applies
its 8 new findings and the minimal-edits-before-P1 list.
**Repo:** `defi-strategy-studio` (name resolved in P0, §12)
**Predecessor:** an earlier private prototype, used only as a parts bin via TRANSPLANT.md

**v2.2 changes (post-verification):** failure fixture made data-driven — eMode
LTV/LT are read, never scripted; the override drives borrow strictly above the
block-pinned LT for a deterministic HF revert; the re-simulation is the single
authoritative pass · amount resolution upgraded to **share/return-value
attribution** (rebase-proof; no gas double-count) · provenance type generalized to
**Observed / Derived / Entered / Configured** · net-APY equation published with
`b` defined · plan validation bound to the P0-recorded revision constraint set ·
sandbox **snapshot-identity contract** + executable P0 proof gate ·
existing-position predicate unified · finance reads split from tx-transport
observation · claims-downgrade rule attached to the live-mode cut. (v2.1 history
in git: `1ad2e8b`.)

---

## 1. Purpose & audience

This is a **portfolio project: a demonstration of web3 frontend / design-engineering
craft**. It is not a product chasing users. Every decision optimizes for one reader: a
senior engineer spending 3 minutes cold, then 20 minutes deep, judging the work on its
merits.

The standard that reader holds (in order):

1. **Correctness in the money-math** — can every number on screen be defended?
2. **Tests + CI** — is correctness enforced or asserted?
3. **Scope restraint** — did the author curate, or accrete?
4. **Transaction UX craft** — the scarce web3 frontend skill; almost nobody shows
   multi-step execution lifecycle done well.
5. **Taste** — restraint in motion/color; a11y as a floor, not a feature.

**The one-sentence story** (the README's first line):

> "I designed and built a node-based DeFi strategy composer — every number on
> screen carries its provenance (observed on chain, derived by tested math, or
> entered by the user), every money-path is unit- and fork-tested, and the
> execution UX is the part I'm proudest of."

### Anti-goals

- No feature breadth for its own sake. Ten features at 60% is the failure mode this
  spec exists to prevent.
- No fabricated numbers, ever (§7 policy).
- No decoration that doesn't encode information.
- **No self-referential meta-docs** — the repo speaks about the product and its
  engineering, never about its author's goals. Working docs that carry engineering
  content (CLAUDE.md as enforcement rules, decision records) are load-bearing and
  stay; in 2026 a disciplined agentic-workflow config is signal, not scaffolding.

---

## 2. Product definition

### Hero surface: the Composer

A React Flow canvas where the user assembles a DeFi strategy from typed blocks and
executes it.

**Protocol target (pinned):** **Aave v3 — Ethereum Core market.** Ethereum has
multiple Aave v3 instances (Core, Prime, EtherFi); all addresses come from the Aave
address book for Core, and `server/chain/` records the market + deployed protocol
revision at read time. Error decoding handles the deployed revision's **custom
errors** (v3.4+) *and* legacy `Error(string)` numeric codes (§6).

**Blocks (v1):**

| Block | Semantics |
|---|---|
| **Input** | ETH amount entering the strategy |
| **Stake** | EtherFi (ETH→eETH via LiquidityPool) · Lido (ETH→stETH) |
| **Wrap / Unwrap** | eETH⇄weETH · stETH⇄wstETH · **WETH⇄ETH** (native `deposit`/`withdraw`) — auto-inserted by the route optimizer where a lend step needs the wrapped form. **Scope note:** these are wrapper conversions only. LST/LRT→ETH *exits* (EtherFi withdrawal-request NFTs, Lido withdrawal queue) are explicitly unsupported in v1 — the UI must never imply a synchronous unstake path exists. |
| **Lend** | Aave v3 Core supply |
| **Borrow** | Aave v3 Core, **variable rate only** — `interestRateMode = 2` hardcoded; Aave v3.2 removed stable borrowing, so no rate-mode config exists anywhere in the schema or UI |

**Not in v1:** Swap block (P5, with the aggregator integration). Existing-position
import/merge (P5, see live-mode scope below).

**The flagship template — "Leveraged Restake Loop" — is a finite expanded DAG, not
a cycle.** The canvas renders the one closed iteration as explicit duplicated
nodes, so `core/plan.ts` receives an acyclic graph an ordinary topological sort can
order — no cycle-unrolling semantics exist anywhere:

```
Input(ETH) → Stake(eETH) → Wrap(weETH) → Supply(Aave) → Borrow(WETH)
  → Unwrap(WETH→ETH) → Stake₂(eETH) → Wrap₂(weETH) → Supply₂(Aave)
```

**Enumerated execution steps for this template** (the canonical fixture for plan
snapshots, Playwright step counts, and the §3 demo):

1. EtherFi LiquidityPool `deposit` (ETH→eETH)
2. eETH `approve` (weETH contract, bound to the attributed output of step 1)
3. weETH `wrap`
4. `setUserEMode` (ETH-correlated category) — emitted only when required (§5.4)
5. weETH `approve` (Aave Pool)
6. Aave `supply`
7. Aave `borrow` (WETH, variable)
8. WETH `withdraw` (→ ETH)
9. EtherFi `deposit` (ETH→eETH)
10. eETH `approve` → 11. `wrap` → 12. weETH `approve` → 13. Aave `supply`

**E-mode policy (v1):** the plan sets the ETH-correlated category for *new*
positions only. HF math uses the active category's collateral membership and
liquidation threshold — not a blanket "enhanced LT" (§5.4). **Live mode v1 refuses
wallets with any existing Aave Core footprint** — any debt *or any aToken balance,
collateral-enabled or not* (one predicate, referenced verbatim by §3 step 7) —
with a designed explanation state — merging a planned strategy into an existing
position, and eMode transitions on live positions, are P5 problems and pretending
otherwise would ship wrong risk numbers. Sandbox is unaffected (fresh account).

**Canvas features:**

- **Edges:** allocation-aware — click to edit percent/amount split; over-allocation
  detected and surfaced on the source block.
- **Live simulation panel:** projected net APY (§5.2 formula), position value, gas
  estimate — recomputed as the graph changes.
- **Risk on the canvas:** borrow blocks display **minimum HF during execution** and
  the **liquidation ratio** (§5.4, §7) live as allocation sliders move.
- **Execution:** two explicit modes (§6): **Sandbox** (forked-mainnet environment,
  clearly badged, available to any visitor) and **Live** (real wallet, real funds,
  gated by fresh simulation against real state).

### Supporting surfaces (deliberately thin)

- **Landing (P4):** one screen: what it is, a looping 20s demo capture, two CTAs
  (Try sandbox / View source). No fabricated stats. Ever.
- **Positions view: cut from v1.** Its only worthwhile form — import an existing
  Aave position into the composer — is P5, paired with the live-merge work above.

### Cut entirely (do not port, do not rebuild)

Analytics · alerts/notifications · EtherFi-branded page · historical reconstruction ·
SIWE auth · Postgres/Prisma · BullMQ workers · socket.io · Alchemy WS · server-side
strategy persistence · loyalty/points UI · multi-chain (v1 is Ethereum mainnet only).

---

## 3. The demo script (acceptance criteria)

This script must work, in order, on the deployed URL, **with no wallet connected**
(sandbox mode is the default experience). It is the Playwright smoke test — wallet
interactions driven by a **wagmi mock connector**; the true live path has a separate
manual checklist (§8). It is also the README GIF.

1. Land → "Try sandbox" → composer opens with the **Leveraged Restake Loop**
   template loaded (the expanded DAG above), Sandbox badge visible in the chrome.
2. Numbers are live: staking APR, supply APY, borrow APR each visibly sourced —
   tooltip cites method + block number + source-fetch timestamp (§5.1, §5.7). No
   number renders before its source resolves: in-node skeleton treatment (§7),
   never placeholder values.
3. Drag the borrow allocation 50% → 70%: **minimum-HF-during-execution** and the
   liquidation ratio update on the block in real time (client-side pure computation
   over a block-pinned read set, §5.4); crossing the warning threshold shifts the
   block to its warning state.
4. **The prevention-and-override beat:** drag borrow past the limit → the block
   rejects it *client-side, inline*, showing the math with **LTV/LT read from the
   active eMode configuration** — never scripted copy (the in-eMode and
   outside-eMode regimes differ; quoting the wrong one is a correctness bug).
   Simulate is gated. Click **"Simulate anyway"** (explicit override, kept for
   exactly this purpose) → the borrow step fails in simulation with a **decoded
   revert** in the step list. The fixture drives borrow **strictly above the
   block-pinned liquidation threshold with rounding headroom**, so the decoded
   error is deterministically the deployed revision's HF error (at exactly LT,
   HF=1 *passes* Aave's check and the LTV error fires instead). Drag back to
   70% → **Re-simulate** reruns the *entire* bundle from the base snapshot (§6 —
   failed simulations have no resumable prefix). **This is the single
   authoritative passing simulation — the demo never simulates twice.**
5. Review the authoritative run: per-step results stream into the step list
   (pending → success) for all 13 enumerated steps, gas per step, final summary
   (net APY, final HF, liquidation ratio).
6. Hit **Execute (Sandbox)**: the multi-step execution runs against the forked
   environment — all 13 steps, each with its lifecycle (pending → confirmed,
   explorer link where the provider offers one). The sandbox badge notes "no
   signatures in sandbox" (§6).
7. Connect a wallet (mock in CI) → mode switches to Live; **Execute stays gated**
   until a fresh simulation against the real balance passes, and live mode refuses
   wallets per the §2 footprint predicate. (Completed live execution is *not*
   an acceptance gate — no reviewer executes with a funded wallet.)
8. **Closing beat:** copy the share URL, open it in a private window → the graph
   rehydrates from the URL (validated, §5.6).

If any step shows a stale, fabricated, or unsourced number, the build fails review.

---

## 4. Architecture

```
Next.js 16 (App Router, RSC-first)
├── Client islands: composer canvas, wallet UI, tx execution
├── tRPC 11: rates, simulate, sandbox-session (keys stay server-side)
├── viem v2 + wagmi v3 (NO ethers)
├── zustand (composer store) + react-query (server state)
├── Tailwind 4 + ported token system (single design language, dark-only v1)
└── No database. No auth. localStorage + share-URL for strategies.
    (One narrow exception, only if the P0 spike demands it: a small KV store
     for the sandbox session registry — §6. Nothing else may use it.)
```

**Decisions and their reasons:**

| Decision | Reason |
|---|---|
| No Postgres/Prisma/SIWE | The v1 product needs no server-side user state. Deleting auth deletes the predecessor's worst security findings *by construction*. Wallet connection is identity where it matters (signing). An ADR + README paragraph frames the tRPC proxy, zod env validation, and caching as deliberate backend signal (§9). |
| Strategies persist to localStorage; share via URL-encoded graph | Zero-backend persistence; the share-URL is a demo beat (§3.8) and a security surface (§5.6). |
| tRPC kept | Typed boundary + zod validation was genuinely good in the predecessor; also where API keys hide. |
| Rates: react-query polling (15s client) over ≤60s server cache | One data path, end-to-end verified. Tooltip timestamps show the **source fetch time and block number**, not the poll time. SSE/Pyth may return in P5 as an enhancement. |
| Ethereum mainnet only, Aave Core only | Every added chain/market multiplies the test matrix without adding demonstrated craft. |
| RSC-first; `"use client"` only at interactive leaf islands | The predecessor's 11/11 client pages threw away the framework; this is a visible craft signal. |
| **Dark-only v1** | Dual-theme doubles the taste/QA surface without adding demonstrated craft; canvas tools are culturally dark. Second theme is a P5 line-item. |
| **Desktop-only composer** with a designed "open on desktop" gate screen | Reviewers open links on phones; an honest, designed gate beats an accidentally-broken canvas. Landing is responsive. |

### Repo layout

```
src/
├── app/                    # landing, composer
├── components/
│   ├── composer/           # canvas, blocks, edges, panels
│   ├── tx/                 # TransactionButton, ExecutionFlow, StepList
│   └── ui/                 # shadcn ports
├── core/                   # ALL money-math. PURE: no fetch, no I/O, no React.
│   ├── rates.ts            # APR/APY math, RAY conversions, trailing-APR derivation
│   ├── health-factor.ts    # HF (min/final), liquidation ratio; bigint/RAY; e-mode aware
│   ├── allocation.ts       # edge allocation / graph flow math
│   ├── graph.ts            # graph structural validation (§5.6): DAG, integrity, bounds
│   ├── plan.ts             # validated graph + chain snapshot → TransactionStep[]
│   ├── errors.ts           # revert decoding: v3.4+ custom errors + legacy code table
│   └── format.ts           # single formatting module (BigInt → display)
├── server/
│   ├── chain/              # sole owner of FINANCE reads; produces block-pinned
│   │                       #   ChainSnapshot objects for core/ (tx-transport
│   │                       #   observation belongs to the client — see below)
│   └── trpc/               # routers: rates, simulate, sandbox
└── lib/                    # store, wagmi config
```

`core/` is the heart: pure functions, typed data in / plain data out. The purity
line is real — `server/chain/` performs every *finance* read and hands `core/` a
**block-pinned snapshot**; `core/` never fetches. UI and server both consume it.

One deliberate boundary split: **finance snapshot reads** (rates, reserves,
oracle prices, balances feeding money-math) belong to `server/chain/`
exclusively; **transaction-transport observation** — receipts, nonces,
replacement detection, wallet/connector state — belongs to the client via wagmi
(§6). The two never mix: transport observation may not feed money-math.

---

## 5. Finance core (the rebuild commitment)

1. **Rates are read; APRs are derived, never asserted.** Exchange rates from
   `weETH.getRate()`, `wstETH.stEthPerToken()`. Staking **APR** = trailing 7-day
   exchange-rate delta via archive reads (now vs now−7d blocks) — an instantaneous
   exchange rate is not an APR. Aave `currentLiquidityRate` /
   `currentVariableBorrowRate` are **annual APRs in RAY** (per-second math happens
   only in the APY compounding conversion, documented in `core/rates.ts`). They are
   utilization-dependent *current* rates: the display is labeled
   **"current-rate run-rate"**, and because our own borrow moves utilization,
   `core/rates.ts` recomputes the post-action rate from the reserve's interest-rate
   strategy parameters for the simulation panel. Every displayed rate's tooltip
   carries method + block + timestamp. Server cache ≤60s.
2. **Net APY is a published equation, not vibes.** Definitions: `E` = initial
   equity (the Input amount); **`b` = the borrow block's allocation — debt opened
   as a fraction of collateral value at open.** After the one closed iteration,
   collateral exposure is `(1+b)·E`, debt is `b·E`. With
   `r_coll = (1+r_stake)·(1+r_supply) − 1` (staking appreciation and Aave supply
   APY compound multiplicatively on collateral) and `r_debt` = the variable
   borrow APY:

   ```
   netAPY = (1+b)·(1+r_coll) − b·(1+r_debt) − 1
   ```

   1-year horizon, current-rate run-rate (§5.1), normalized to `E`;
   incentives/points **excluded and labeled as excluded**. The derivation is the
   docstring of `core/rates.ts`; fixtures pin exact numbers. "Current-rate
   run-rate, one iteration" is the honest headline framing.
3. **Prices come from the market's own oracle.** `AaveOracle.getAssetPrice` on the
   Core market prices HF and USD displays — the same oracle Aave liquidates
   against. `BASE_CURRENCY_UNIT` is **read, not assumed**. No CoinGecko in the
   risk path.
4. **Health factor: three defined quantities, block-pinned inputs, honest
   unknowns.** `core/health-factor.ts` (ported algebra, bigint/RAY internals,
   user-level collateral flags, e-mode category membership + thresholds) computes:
   **current HF** (live positions), **minimum HF during execution** (evaluated
   after every risk-changing step of the plan — this is what borrow blocks
   display and what gating uses), and **final HF** (summary). For the correlated
   flagship pair the displayed liquidation quantity is the **weETH/WETH oracle
   ratio at liquidation** ("liquidates if the weETH/WETH oracle ratio falls
   −X% — a depeg/slashing scenario, not an ETH price level"); unqualified USD
   liquidation prices are banned for correlated pairs. All inputs for one
   computation come from a single block-pinned `ChainSnapshot`. **No data ⇒ HF
   unknown state** — never "safe". Cross-check semantics (precise): pre-execution,
   the *current-position component* is asserted against
   `Pool.getUserAccountData().healthFactor`; post-execution (sandbox/live), the
   realized HF is asserted against the same call on the resulting state.
   Assertion failure renders a visible data-error state, never a silent pick.
5. **Execution amounts are step-output attributions, never balance sweeps.**
   Plan-time literals revert (wei rounding, eETH rebasing) and
   `balanceOf`-at-execution would sweep pre-existing holdings. Every
   `TransactionStep` amount is `literal` (whitelisted: the Input step only) or
   **`step-output(producerStepId)`**, attributed by the most precise available
   signal — never a raw balance delta where a better one exists:
   - **eETH is rebasing**: its output is tracked as a **share delta** (shares are
     rebase-invariant) or the producer's return/event value, converted to an
     amount immediately before the consuming wrap. A raw balance delta is
     contaminated if a rebase lands between checkpoints.
   - **WETH `withdraw` output is its argument** — known exactly; the native
     balance delta already reflects gas, so no additional gas-reserve
     subtraction is applied to it.
   - Plain ERC-20 outputs use the producer's emitted `Transfer` value.

   Outputs are bounded by expected ± a named tolerance. Pre-existing
   eETH/weETH/WETH is provably untouched — the §8 fork test seeds balances **and
   induces a rebase between steps** to prove attribution survives it. Approvals
   are ordered **after** their producing step and bound to the attributed output.
6. **The share-URL is untrusted input; schema validation is not graph validation.**
   The URL transports versioned graph JSON only. It passes zod *shape* validation,
   then `core/graph.ts` **structural validation**: unique IDs, edge referential
   integrity, node/edge count limits, allocation conservation per source, DAG
   acyclicity, supported block/asset combinations, amount bounds. Calldata derives
   only from a graph that passed both. The §8 suite includes the attacker-address
   payload *and* schema-valid-but-structurally-malformed graphs.
7. **Plan validation validates the constraint set recorded for the pinned
   revision.** The P0 protocol matrix (§11) enumerates which constraints apply to
   the deployed Aave Core revision — reserve active/frozen/paused,
   borrowing-enabled, supply *and* borrow caps with headroom, available
   liquidity, e-mode collateral/borrowable membership, LTV-zero/collateral
   eligibility, siloed/isolation rules, oracle-sentinel state, user
   collateral-enable state — and §5.7 validates **exactly that recorded set**,
   surfacing violations on the offending block *before* simulation. Anything
   scoped out is scoped out *in writing in the matrix*, never silently skipped.
   Framing is honest: validation **pre-empts** predictable failures; mainnet is
   concurrent, so residual reverts are decoded, not treated as bugs.
8. **Simulation is honest.** The Simulate button runs the full bundle against the
   sandbox provider (§6); buffers, where unavoidable, are derived from read state
   ± an explicit named bps constant in one place with a justifying comment.

---

## 6. Transaction UX (the centerpiece craft)

The `components/tx/` family is the portfolio centerpiece. It is **extracted and
generalized** from the predecessor's inline single-step TransactionButton —
budgeted as a build, not a port.

**The step state machine (exhaustive):**

```
idle → simulating → ready → awaiting-signature → pending → confirmed
                                   │                │
                                   ├→ user-rejected │→ reverted (decoded)
                                   │  (distinct     │→ timeout (guidance +
                                   │   from error)  │   keep-waiting option)
                                   └──────────────────→ replaced (speed-up/cancel
                                                         detected via nonce watch)
```

- Every state visually distinct; disabled states always explain why. Sandbox mode
  **skips `awaiting-signature`** (no wallet signs) — the badge and step list say so.
- **Two recovery machines, never conflated:**
  - **Simulation recovery:** a failed bundle simulation has *no persisted prefix* —
    recovery is always a **full re-simulation from the base snapshot**. The UI
    labels it "Re-simulate", never "Resume".
  - **Execution recovery:** after a failed/rejected step in real execution, state
    through the last **confirmed** transaction exists on-chain — recovery
    re-simulates the *remaining* steps against current state, then offers to
    continue from the failed step. Never blind retry.
- **Decoded reverts:** viem `decodeErrorResult` against the deployed revision's
  ABI — **custom errors first (Aave v3.4+), legacy `Error(string)` numeric table
  as fallback** (35 = HF below threshold, 51 = supply cap, …) in
  `core/errors.ts`. Raw error surfaced alongside the human message.
- **Gas convention:** step list shows the simulation's gas **estimate**; the
  signature prompt context shows the EIP-1559 **max**. Labels never conflate them.
- **Approvals:** bound to step-output deltas (§5.5), ordered after their producer,
  with a "why am I signing this?" explainer per step.
- **A11y:** step-status changes announce via `aria-live="polite"`; focus moves to
  the failed step's recovery action on failure; fully keyboard-operable.
- **Sandbox infrastructure (P0 spike decides the provider):** candidates are a
  **self-hosted anvil fork** (small Railway container; free, deterministic, doubles
  as the CI fork-test runner) vs **Tenderly Virtual TestNet** (managed, public
  explorer links, paid tier — pricing is a spike output). Either way the
  **security contract** is identical and non-negotiable: the admin/fork RPC is
  reachable only by the server; the server executes **only calldata it built
  itself from a validated graph** — no client-supplied calldata, ever; sessions
  are owned (unguessable session key), TTL'd, per-session tx- and rate-limited,
  and globally capped with a designed **"sandbox at capacity"** state.
  **Snapshot-identity contract:** each session gets its own isolated fork pinned
  to a recorded base block; all reads, simulations, and executions within a
  session share that fork's state; sessions never observe each other; the
  reset policy is explicit (fresh fork per session, destroyed at TTL). TTL/cap
  enforcement needs durable coordination across serverless instances — the spike
  either accepts the provider's own hard limit + graceful rejection, or adds the
  §4 KV exception for the session registry. Bundle-in-one-block simulation is not
  identical to a live multi-block wallet flow; the sandbox badge copy says
  "forked-mainnet demo", not "proof of live behavior".

---

## 7. Design system & taste rules

- **Port the token set** (`globals.css` token ranges per TRANSPLANT.md — not the
  three-design-language sprawl). One design language: the obsidian-teal system.
  **Dark-only in v1.**
- **React Flow chrome is fully custom-styled from the token system** — nodes,
  handles, edges, controls, background grid; the default stylesheet look never
  ships. No minimap (information-free at our graph sizes).
- **Color is semantic only.** Block state (valid / warning / error / executing)
  gets color. Block *type* gets an icon and a label — not a hue-gradient-glow
  identity.
- **Motion tokens:** `--motion-fast: 120ms` (state flips), `--motion-slow: 240ms`
  (panel slide, popover), one standard ease (`cubic-bezier(0.2, 0, 0, 1)`) +
  `ease-out` for exits. Edge flow particles kept (they encode direction/activity)
  but flat — no glow, no pulse. `prefers-reduced-motion` swaps particles for a
  static dashed edge and reduces state flips to opacity. No entrance animations.
  No ambient backgrounds.
- **Type:** body/UI on a tightly-set system stack; `tabular-nums` everywhere
  digits align. Display face is a **P0 decision** with one rule: nothing from the
  overexposed AI-landing set (ClashDisplay, Space Grotesk et al.) — if no face
  earns its place, well-set system type is the choice and the canvas is the
  identity. All numbers through `core/format.ts`.
- **The risk visual on borrow blocks:** minimum-HF-during-execution plus the
  liquidation *ratio* framing (§5.4): "liquidates if weETH/WETH falls −X%". The
  warning threshold is a named constant in `core/health-factor.ts`. Bare HF
  digits changing mid-drag are illegible at canvas zoom; the ratio sentence is
  the display.
- **In-node skeletons:** nodes render their frame immediately; rate/HF slots show
  a shimmer bar sized to the value's layout box (no layout shift on resolve).
- **A11y floor:** canvas keyboard-operable, visible focus states everywhere, ARIA
  labels on all interactive controls, contrast AA on the dark theme. No
  `user-select: none`.
- **Numbers policy (hard rule):** *no silent fallbacks.* The primary enforcement
  is **typed provenance**: every renderable quantity is a `Provenanced<T>` with
  an explicit kind — **`Observed`** (a chain read: source + block + fetchedAt;
  multi-read quantities like the trailing APR carry *all* their read points),
  **`Derived`** (tested math over named inputs, each itself provenanced),
  **`Entered`** (user input, echoed as such), or **`Configured`** (a named
  constant with its definition site). The only components that render
  money/rate/risk numbers require a `Provenanced<T>` or render the explicit
  unavailable state — a bare `number` does not typecheck at the display boundary,
  and nothing may launder a literal into `Observed`. Tooltips render the
  provenance chain. The ESLint ban on numeric-literal `??` fallbacks in `core/`
  and `components/composer/` remains as a belt, not the enforcement.

---

## 8. Quality bar & CI

- **vitest (pure):** 100% of `core/` — rates math (RAY conversions, APR
  derivation, post-action rate recompute, the net-APY formula fixtures),
  HF (min/final, e-mode cases, the unknown state, liquidation-ratio algebra),
  allocation + graph structural validation (including property tests for
  allocation conservation and HF rounding at the HF≈1 boundary), plan snapshots
  for the 13-step flagship fixture (to-address, selector, decoded args,
  amount-provenance per step), errors table, format, and the §5.6 malicious/
  malformed-graph suite.
- **Pinned-mainnet-fork integration (anvil, in CI):** execute the **full 13-step
  plan** against a pinned fork; assert HF against `getUserAccountData` after every
  risk-changing step; seed pre-existing eETH/weETH/WETH balances and prove the
  plan never touches them (§5.5); exercise LTV/cap/HF boundaries. Unit fixtures
  cannot catch stale ABIs, wrong addresses, current custom errors, or rebasing
  transfer behavior — this suite is what makes the correctness claim honest, and
  it must exist **before** canvas polish (§11).
- **Playwright:** the §3 script end-to-end with the wagmi mock connector.
  **Separate manual checklist** for the true live path (real wallet, small real
  funds) run before each release tag.
- **Scheduled production smoke:** §3 steps 1–6 **and 8** — including sandbox
  execution and share rehydration, the surfaces most likely to rot — on a
  schedule against the deployed URL. UI ships a visible **stale-data state** when
  sources fail.
- **GitHub Actions** on every push: typecheck (strict + `noUncheckedIndexedAccess`),
  lint (zero errors, zero warnings), vitest, fork suite, build, Playwright smoke.
- **Runtime env validation** at boot (zod) — missing key fails fast, named error.
- **Hygiene:** zero `any`/ts-ignore, no `console.log` (lint rule; a `log` util
  gates debug output), LICENSE matching the README claim, `engines` pinned, no
  starter assets in `public/`.

---

## 9. Repo presentation

- **README:** story sentence → 20s GIF of the demo script → architecture sketch
  (one diagram) → "every number is real" section (provenance types + fork tests,
  claims scoped to what CI actually proves) → an **explicit backend-judgment
  paragraph** ("why no database") → test/CI badges → honest "what I'd build next"
  (3 bullets max).
- **Commit discipline:** conventional, narrative commits from day one.
  **Port-commit convention: one module per commit**, message carries provenance
  and the applied TRANSPLANT.md edits. No AI attribution.
- **Comment hygiene** (in CLAUDE.md as enforcement): no narrating comments, no
  section-banner ASCII, comments only for non-obvious WHY.
- **CLAUDE.md** (new repo): §5 finance rules + §7 taste rules + comment hygiene as
  enforcement instructions, the §10 porting protocol, pointer to this spec.
  Nothing else. This is a working engineering artifact and is defensible as such.
- **Decision records:** one short `docs/decisions.md` — market pinning, sandbox
  provider choice, no-database, provenance types. Engineering content only;
  anything that reads as author-narrative is banned by the §1 anti-goal.

---

## 10. Porting protocol (context hygiene)

The predecessor repo is a **read-only parts bin**. Rules for any session working on
the new repo:

1. Only files listed in `TRANSPLANT.md` may be opened in the old repo, and only at
   their listed paths.
2. Every port lands with its listed edits applied — a file never enters this repo
   with a known defect "to fix later".
3. `port-with-edits` files get their edits in the same commit as the port.
4. `rebuild-reference` files may be *read* for their good ideas but are rewritten,
   not copied.
5. Anything not in the manifest is treated as if it doesn't exist.

`TRANSPLANT.md` (15-agent vetting pass, 59 files: 0 port-clean, 32 port-with-edits,
23 rebuild-reference, 4 reject) lists every candidate with verdict, required
line-ref'd edits, and dragged dependencies.

---

## 11. Phases (each ends demoable; finance before polish)

| Phase | Deliverable | Gate |
|---|---|---|
| **P0 — Bootstrap + spikes** (~4 days) | Scaffold, CI green on empty app, tokens ported, README skeleton, CLAUDE.md, LICENSE. **Name resolved.** **Sandbox-infra spike:** anvil-on-Railway vs Tenderly VTN — cost, explorer links, TTL/cap mechanics, §6 security contract mapped onto the winner. **Protocol matrix:** Aave Core addresses, deployed revision, custom-error ABI, e-mode category config, EtherFi/Lido/WETH addresses — recorded as the pinned fixture set. Display-face decision. | Actions passing; **sandbox spike ends in an executable proof, not a write-up** — per-session isolation, fork-block identity, snapshot/revert, two concurrent sessions, admin-RPC non-exposure, gas estimation, each demonstrated; protocol matrix + decisions recorded in docs/decisions.md |
| **P1 — Finance core on a fork, headless** (~1.5 wk) | `core/` complete (rates, HF, allocation, graph, plan, errors, format) + `server/chain/` snapshots. The 13-step flagship plan **executes green on the pinned anvil fork in CI** with HF assertions and no-sweep proof. No UI beyond a debug harness. | Full §8 vitest + fork suites green |
| **P2 — Canvas on proven core** (~1.5 wk) | Composer transplanted + reskinned per §7 on top of P1's model: blocks, edges, allocation editing, template, store rebuild, simulation panel, HF-on-canvas, share-URL round-trip | §3 steps 1–3 + 8 pass (mock reads) |
| **P3a — Sandbox execution** (~1 wk) | Provider provisioned per spike, session registry, unsigned execution path, §6 security contract implemented | §3 steps 4–6 pass in Playwright |
| **P3b — Tx UX + live gating** (~1 wk) | Full §6 family: both recovery machines, decoded reverts, replaced/timeout detection, a11y pass on the flow; live-mode gating + existing-position refusal | §3 step 7; manual live checklist documented |
| **P4 — Launch polish** (~3 days) | Landing, OG/meta, README GIF, a11y sweep, scheduled prod smoke (incl. sandbox + share) | Full §3 script green on production URL; Lighthouse a11y ≥ 95 |
| **P5 — Enhancements** (optional, post-launch) | Swap block + aggregator (JIT re-quote per swap step) · existing-position import/merge + eMode transitions · SSE/Pyth · light theme · Base | Only after P4 ships |

Total: **6–8 focused weeks.** The fork-test suite and the §6 execution family are
net-new systems and are budgeted as such — P1 exists so the polished canvas is
built on a model that already survived a real fork, not the other way around.

**Pre-authorized cut order if the timeline slips** (cut from the top, never touch
the fork suite or the prevention/override beat): 1) P5 stays unshipped, 2) live
mode reduces to gating + banner ("sandbox is the demo") — **and the README/story
claims are downgraded in the same commit**, so shipped claims never exceed
shipped reality, 3) landing reduces to README-as-landing.

---

## 12. Open decisions

1. **Name.** Resolve in P0 — blocks the Vercel subdomain, OG assets, README GIF
   URLs. Wants: short, not AI-generic, available subdomain. (Candidates to riff
   on: Blockflow, Loopwright.)
2. **Sandbox provider** — P0 spike output: anvil-on-Railway (est. ~$5–10/mo
   container) vs Tenderly Virtual TestNet (paid tier TBD). Cost is the owner's
   call once the spike prices both.
3. **Old repo:** ~~private immediately?~~ **Done — private as of 2026-07-22.**
4. **Display face** — P0, per the §7 rule.
