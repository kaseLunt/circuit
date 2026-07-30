# circuit

[![CI](https://github.com/kaseLunt/circuit/actions/workflows/ci.yml/badge.svg)](https://github.com/kaseLunt/circuit/actions/workflows/ci.yml)

A visual DeFi strategy composer. Drag a leveraged restake loop onto a canvas, watch the health
factor move as you change the allocation, and open any figure to see the chain read behind it
and the block it was read at.

<!--
  Choreography record for the committed capture (docs/demo.gif):
  Choreography (SPEC §3 steps 1-3, one take, 20s loop, no audio, no captions):

    0:00  Land on / and click "Try sandbox". The flagship is already on screen.
    0:03  Hold on the borrow block's Borrow APY. Open its provenance tooltip and stop
          for three seconds on "observed ... @ block 25592678".
    0:07  Drag the borrow allocation 50% to 70% in one continuous gesture.
          The health factor and the liquidation sentence track the drag.
    0:11  The block flips valid to warning at 64%. Let the colour land.
    0:13  Hold inside the warning state at 70%. Read the liquidation sentence.
    0:18  Freeze. Loop.

  The loop ends on the 70% configuration. 70% is BORROW_BPS in
  tests/fork/flagship-plan.test.ts, the exact allocation the 13-step plan executes
  against a pinned mainnet fork in CI. The last frame of the GIF is the configuration
  the fork suite proves.

-->

![circuit composing a leveraged restake loop](docs/demo.gif)

## Every number carries its provenance

A bare `number` cannot reach a money, rate, or risk display boundary. It arrives wrapped in
`Provenanced<T>`, and the wrapper says where the value came from. There are exactly four forms
([`src/core/provenance.ts`](src/core/provenance.ts)):

| Form | What it claims | What it must carry |
|---|---|---|
| `Observed` | read from chain state | contract and method, block number, the block's own timestamp |
| `Derived` | computed by tested math | the formula, its provenanced inputs, and its qualifications |
| `Entered` | a human typed it | a statement to that effect |
| `Configured` | a named constant | the constant's name and the file that defines it |

The enforcement is structural:

- `Observed` has no public constructor. The only path is `observationMinter(block, fetchedAt)`,
  which `server/chain` creates from one block-pinned snapshot, so observations cannot drift
  across blocks. An ESLint rule forbids forging the shape via an object literal anywhere else
  in the repo.
- A derivation that mixes blocks throws. A value assembled from two moments of chain state
  would look like a single reading, so `derived()` walks its inputs' observed leaves and
  throws if it finds more than one block.
- One licensed exception exists, with the inverse guard. A trailing APR is a rate of change,
  so it has two endpoints and therefore two reads at two blocks. `derivedOverWindow()`
  requires at least two distinct blocks and a non-empty `windowReason`, and appends the
  reason to the derivation's notes, so the tooltip explains the crossing.

There are two provenance surfaces. On the canvas, a tooltip is a trust glance: capped at
depth 1, with an explicit "N more derivation steps" row when the tree goes deeper. In the
simulation panel, clicking a figure opens an inline disclosure: the full tree, in the panel's
own flow, selectable, with focus moved in and Escape returning to the trigger. The split came
from a measurement. The Net APY derivation is 60 entries and renders 2528px tall against a
902px viewport, which no floating box can hold.

Provenance updates mid-gesture. The flagship template ships with a borrow allocation of
5000 bps. Untouched, that figure discloses as `configured DEFAULT_BORROW_ALLOCATION_BPS
(templates.ts)`. After the first drag, the same figure discloses as `entered by user`.
Claiming `Entered` for a value nobody entered is the same class of error as claiming
`Observed` for a value nobody read.

Unknown renders as prose. The recorded weETH supply APY is about 2.6e-7. The app renders
`<0.01%`, because `0.00%` would assert a zero rate. While a source is in flight, the slot
shows a skeleton at the value's layout size. When a source cannot resolve, the slot says so in
words. [`e2e/demo-script.spec.ts`](e2e/demo-script.spec.ts) asserts that `NaN`, `undefined`,
`∞`, and a bare `0.00%` are absent from the canvas.

## The math is chain-proven

`src/core/` is pure. It does not fetch, perform I/O, or import React. It consumes block-pinned
snapshots and produces plans and risk.
[`tests/fork/flagship-plan.test.ts`](tests/fork/flagship-plan.test.ts) executes the full
13-step flagship plan against a mainnet fork pinned to block 25,592,678, twice, on every PR.

Run one seeds adversarial state. Before the plan runs, the fixture gives the wallet
pre-existing eETH, weETH, and WETH, then induces a rebase between steps by writing eETH's
packed-accounting storage word (+1.0000% of `totalPooledEther`; the slot scan must find
exactly one match, and the test asserts both neighbour slots unchanged). In this state, a
`balanceOf`-sweep accounting model would spend the user's pre-existing holdings. Afterwards
the run asserts:

- weETH residual 0 wei, WETH residual 0 wei, eETH share residual within the aggregate
  wrap-dust bound of 2 integer shares.
- Native accounting exactly: `nativeBefore - nativeAfter == inputWei + gasPaid`.
- Health factor against `Pool.getUserAccountData().healthFactor` after every risk-changing
  step: the no-debt sentinel matched exactly (`2^256 - 1`), and within 1e-8 relative once
  debt exists.

Run two uses a clean fork and exact comparisons. The suite re-forks at the pin and verifies
the block hash, because a reset that silently landed elsewhere would measure every later
assertion against the wrong history. It then runs the same plan without seeding or rebase, so
the prediction and the execution are the same sequence:

- The suite compares every `riskLedger` checkpoint numerically against
  `getUserAccountData`, step by step, at the moment the step produced it. Three checkpoints,
  all three compared, and it asserts the count itself, so a silently skipped comparison
  fails the suite.
- It asserts the minimum health factor sits at the borrow step, mid-execution, below the
  final HF. A reading taken only after execution would miss it.
- It reproduces the WETH post-action borrow rate exactly, with `toBe`, by re-running the
  interest-rate strategy at the borrow transaction's own block timestamp. Nothing between
  the pinned block and that transaction touches the WETH reserve, so re-running the model
  reproduces the protocol's arithmetic to the ray (Aave's 27-decimal fixed-point unit).

The suite also pins the wrong model, which proves the assertions are able to fail:

- It asserts the stale stored-index debt model (the defect the reviewer caught) understates
  the borrow rate by at least 143,098,107,621,621,733 ray, about 7 parts per billion of the
  rate itself, and lands strictly below the rate the protocol wrote.
- It asserts that the previous 1e-6 relative bound accepts that wrong model; the error sits
  roughly 149x inside it. That is why the borrow leg was tightened to exact equality, and
  why loosening the bound back would fail a test.
- The weETH supply leg keeps a relative bound and earns it: the stale model lands 3.7e-6
  away, outside the 1e-6 tolerance, and the suite asserts that failure directly.

The demo script itself is a test. [`e2e/demo-script.spec.ts`](e2e/demo-script.spec.ts) runs
SPEC §3 steps 1-3 and 8 against a production build with `workers: 1`. `retries` is 0 because
a pass that needs a second attempt is a flake. The suite computes every expected figure from
`core/risk.ts` over the same snapshot the browser runs, through the same `core/format.ts`
formatter the component uses. A hardcoded `1.42` would pass while the app and the core
disagreed. The suite also checks each observed citation line separately, because over joined
text one correctly cited read would cover for a dozen uncited ones.

## How it was built

AI agents built this project under a verification regime I designed. The receipts are in
`git log` and `roadmap/`, and every claim below is checkable there.

### An adversarial reviewer with a hard veto

[`roadmap/decisions/D-007`](roadmap/decisions/D-007-codex-final-approval.md) makes an
independent reviewer (Codex, a separate model in a resumable session) a required
final-approval gate for complex work: any `core/` or money-math module, any calldata or
execution path, any security-bearing surface, any phase boundary. If the reviewer withholds
approval, the work stays open: fix, re-review, repeat. The gate exists because the advisory
version had already caught defects that would have shipped, including a health-factor error
the integrator introduced by overriding the reviewer.

The review chain that closed the risk-simulation work ran fourteen threads across four
commits before it approved. Each commit message cites its chain by thread ID:

| Commit | Threads | Final approval |
|---|---|---|
| `aa6b9e0` (`core/risk.ts` simulation) | 3 | `019f9d2d` |
| `0849d74` + `74b77a2` (param-origin provenance, store id reservation) | 5 | `019f9dc4` |
| `bcf2228` + `d439c03` (staking-APR window, disclosure surface) | 6 | `019fa00c` |

What those rounds caught:

- Next-index accrual. The post-action rate model used the stored borrow index instead of
  accruing it to the action's own block. The fix was then pinned from both directions: the
  corrected model asserted exactly, and the wrong model asserted to fail with a named lower
  bound.
- Provenance laundering. The recorded-reads snapshot holds no account reads, so the sandbox
  now mints `configured()` for the e-mode category and Aave footprint instead of forging an
  `Observed`. `boolRead` throws on any non-boolean shape; `"false"`, `0`, and `null` all
  fail closed into the designed unavailable state.
- A multi-undo document corruption. Generated ids were reserved only against the current
  document, so an edge id could collide with one still living in the history stacks and
  inherit its provenance stamp. The fix is a generic invariant: every `Configured` stamp's
  value must equal the constant it names, asserted across all four minting sites at every
  undo and redo depth. With the fix reverted, the test fails with
  `remint: 2 undo(s) deep: FULL_ALLOCATION_BPS cites 6000`.
- A geometry defect invisible to DOM assertions. An open disclosure was in the document and
  on top of the row beneath it, because `Row` was a fixed 36px box. The test compares
  bounding boxes: the neighbour must move down and its top must clear the disclosure's
  bottom edge.
- Evidence that vanished on green runs. A geometry measurement lived in a Playwright
  annotation, which the configured reporters drop, and artifacts upload only on failure.
  The measurement now also emits a workflow `::notice`, so the numbers appear in the run
  log of every pass.

### A standing design director that gates in pixels

Taste review runs as a second standing agent, and it reviews rendered frames. Two catches
that were invisible in a diff:

- Unavailable prose dressed as a figure. A caller-supplied style ramp applied to a slot
  whether or not the slot resolved, so "not quoted" could render wearing the typography of
  a number. The fix (`slotClassName`) applies a ramp only where a value actually renders.
- Three qualifications silently deleted. `Derived.notes` was a single slot, so attaching a
  cross-block window licence to a derivation that already carried a qualification overwrote
  it, including "incentives and points excluded by construction", which stopped rendering
  anywhere. The director caught it on before-and-after artifacts. `notes` is a list today,
  and a test (`MINT_QUALIFICATIONS`) asserts all 18 mint qualifications against the
  rendered trail.

The director's verdict is recorded in the commit that lands the work, and blocking findings
land as their own fix commit. `c0219ac` exists because the shipped tooltip cited method and
block but omitted the block time SPEC §3 requires.

### Deviation ledgers in the commit messages

Where an implementation departed from its written contract, the commit that made the
departure enumerates it with its justification. `0fc60cf` ships `D3` (canvas.css unlayered,
because `@xyflow` base.css is unlayered and a `@layer` block provably cannot override it) and
`D5` (nine live regions: one per owning container, three containers plus six blocks).
`d439c03` records a measurement that corrected an earlier deviation's premise: deviation 2
assumed a cold share arrival paints the wrong document for one hydration beat, and the build
output showed React Flow mounts no nodes during SSR at all. The beat is zero. The test now
asserts that directly: a per-frame probe records every document the page ever renders, and
the arriving one must be the only one.

### A serial-writer control plane with policy-gated paths

`roadmap/` is a typed control plane. Work items declare `allowed_paths` and `deliverables` up
front, a scope-diff policy replays every commit against the active claim, and one writer
holds the lane at a time. From [`D-010`](roadmap/decisions/D-010-pr-flow-from-p2.md) onward,
work lands via pull request, because the repository's strongest enforcement tier is gated on
`pull_request_target` and was structurally unreachable from a direct push. Owner-gated
changes (CI config, the work contract itself) require a `CONTROL_PLANE_POLICY_APPROVAL` token
re-issued per reviewed head, so each approval leaves an artifact.

Taken together: the health-factor function is proved against the chain it models, the wrong
version of it is pinned as a failing control, and the reviewer who caught the defect held a
veto. A reader can verify each of those claims from the linked files in a few minutes.

## What this does not do yet

Claims here stay within what CI proves.

- The composer runs on recorded chain reads. Every value comes from a committed reads log
  captured at block 25,592,678 and minted through the same `observationMinter` the live path
  uses. A test asserts the recorded snapshot produces the same simulation as the
  anvil-proven fork snapshot. The sandbox session service, live chain reads, wallet
  connection, and execution are P3. The fork suite executes the real 13 steps; the browser
  does not, yet.
- Gas is unquoted. Every gas slot renders "not quoted", and the reason appears once at the
  owning container: no provider exists to quote against until P3a. An invented estimate
  would fabricate a number. The row self-retires when quoting arrives.
- Aave rates are current-rate run-rates. `currentLiquidityRate` and
  `currentVariableBorrowRate` are utilization-dependent instantaneous rates. The UI says
  "current-rate run-rate" on the face of every Aave figure, and tests assert the string is
  present. Net APY is a one-year, one-iteration projection at today's rates with incentives
  and points excluded, and the derivation tree says so.
- The staking figure is an APR and says so. It is a trailing 7-day exchange-rate delta
  (2.361493% at the pin), annualized linearly with no compounding. The rate kind is a field
  in the type, set at the derivation site, and the label reads it.
- Desktop-only composer, dark theme only, Ethereum mainnet only, Aave v3 Core only. Each is
  a recorded decision.

## Stack

Next.js 16 (App Router, RSC-first) · React 19 · TypeScript strict with
`noUncheckedIndexedAccess` · React Flow, fully custom-styled from tokens · Tailwind v4 ·
viem v2 · zustand · vitest · anvil fork tests · Playwright. There is no database, auth, or
server-side user state; strategies live in `localStorage` and in a share URL fragment.

## Run it

```bash
npm ci
npm run dev          # dev server
npm run build        # production build (no env vars required)
npm run typecheck    # tsc --noEmit, strict
npm run lint         # zero errors, zero warnings
npm test             # vitest: core/, store, components
npm run test:e2e     # Playwright: SPEC §3 steps 1-3 + 8 on the recorded reads
npm run test:fork    # anvil fork suite (requires an archive-capable FORK_RPC_URL)
```

Five checks are required to merge:

| Check | What it proves |
|---|---|
| `ci` | build, typecheck, zero-warning lint, script parse gate, full vitest suite |
| `e2e` | the demo script, against a production build, on the recorded read set |
| `fork` | the 13-step flagship plan against pinned mainnet state, twice |
| `e2e-fork` | the sandbox execution arc — arm, review, execute, attribute, receipt — driven in a real browser against a per-session anvil fork whose pin is hash-verified from the committed read log |
| Control plane trusted audit | scope, claim, and owner-approval policy replayed by server-owned code against the simulated merge |

The product contract is [`SPEC.md`](SPEC.md). The porting contract is
[`TRANSPLANT.md`](TRANSPLANT.md). The enforcement rules every change is held to are
[`CLAUDE.md`](CLAUDE.md). The decision record is [`roadmap/decisions/`](roadmap/decisions/).

## License

MIT
