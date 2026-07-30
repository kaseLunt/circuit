# Live execution — the manual checklist

**A completed live execution is NOT an acceptance gate** (SPEC §3 step 7, verbatim: "Completed
live execution is *not* an acceptance gate — no reviewer executes with a funded wallet"). This
file is the honest record of the path a person walks with real funds, what the product does and
does not do for them today, and what has to be wired before anyone walks it.

Nothing below is aspirational. Where a step is not implemented, it says so and names the state
the product renders instead.

---

## 0. What is landed, and what is not

| Piece | State |
|---|---|
| Wallet boundary — `WalletSession`, connectors, transport quarantine | **Landed** (`src/lib/wallet/`) |
| Live gate — chain, `eth_getCode`, SPEC §2 footprint, simulation freshness, plan/snapshot drift | **Landed as decisions** (`src/lib/wallet/gate.ts`, unit-proven) |
| Seam READINGS through our own RPC (`eth_getCode` + the footprint sweep) | **Landed** (`/api/wallet` → `src/server/trpc/wallet-router.ts` → `src/server/chain/live-readiness.ts`). Requires `LIVE_CHAIN_RPC_URL` (server-only env); a deployment without it answers a stated refusal and the gate refuses with the reason on screen. See §1. |
| Live snapshot capture (`captureChainSnapshot` for the connected address) | **Landed** — the same readiness call returns the block-pinned capture over the wire (`src/lib/live/snapshot-wire.ts`), rebuilt client-side through the one minting definition. See §2. |
| Live simulation against real balances | **Landed as the gate-clearing path** — "Simulate against this wallet" runs `buildPlan`/`riskLedger` over the captured snapshot and mints the `LiveSimulationStanding` (address + plan hash + block identity + monotonic time) the Execute gate consumes. Until it runs, Execute is gated by `no-fresh-simulation`; after any document edit it regates on `plan-drift`. |
| Live dispatch (`eth_sendTransaction` through the connector) | **Not wired.** No signature is ever requested today; a cleared gate arms the SANDBOX driver only. |
| Live tolerances / timeouts / regate window | **Landed** (`src/lib/execution/tolerance.ts`: `LIVE_OUTPUT_TOLERANCE`, `LIVE_HF_REL_POW`, `LIVE_SIMULATION_MAX_AGE_MS`, `LIVE_STEP_TIMEOUT_MS`) |
| Machine states for every live outcome | **Landed** (`src/lib/execution/machine.ts` — timeout keep-waiting/give-up, both replacement classifications, `halted-wallet-changed`, the D3/D6 recovery cells) |

The product therefore **refuses** rather than pretends. Connecting a wallet switches the
session to Live and every path to a signature is gated by a stated reason.

---

## 1. Before the first live run — wire the seam readings

Two facts gate the connect, and neither may be asked of the injected provider (seam A1 — a
malicious extension can forge what it answers):

1. `eth_getCode(address)` — a code-bearing account (contract wallet, or an EIP-7702-delegated
   EOA) can exhaust WETH9's 2300-gas ETH-send stipend. This is not hypothetical: the fork suite
   hit it on mainnet and had to route around it (`tests/fork/flagship-plan.test.ts:327-333`),
   and the sandbox mints code-free session actors for the same reason.
2. The SPEC §2 footprint predicate — any Aave Core debt **or any aToken balance**,
   collateral-enabled or not.

Both come from our own configured RPC: the wallet router's `readiness` procedure
(`/api/wallet`, `src/server/trpc/wallet-router.ts`) performs `eth_getCode` and the footprint
sweep in ONE `captureChainSnapshot` call (`src/server/chain/live-readiness.ts`) — the
footprint is the capture's own `hasAaveFootprint`, never a second predicate — and
`liveSeam` (`src/lib/live/live-transport.ts`) adapts it to `WalletSeamSource`.

Wire the deployment by setting `LIVE_CHAIN_RPC_URL` (server-only env, never `NEXT_PUBLIC_*`).
Without it, the router answers a stated `live-chain-unconfigured` refusal, the connect surface
reports the readings as `unknown`, and the gate refuses with the reason on screen. That is the
correct behaviour for a missing source (SPEC §5), not a bug to route around.

---

## 2. Before the first live run — the live snapshot (landed)

Live mode's simulation runs against a `ChainSnapshot` captured **for the connected address**,
at a pinned block, through `captureChainSnapshot(client, { user: address })` — the same
readiness call §1 describes. That call is the ONE crossing the whole wallet boundary exists to
permit: the address goes in, and `eModeCategoryId` / `hasAaveFootprint` come back `Observed`,
replacing the sandbox's `Configured` pair (`src/lib/recorded-reads/sandbox-snapshot.ts`). The
capture crosses to the client as raw reads plus block identity (`src/lib/live/snapshot-wire.ts`,
strict-parsed) and is re-minted through the one snapshot-building definition
(`snapshotFrom`, pinned to the capture's own block).

Nothing else from the wallet may cross. Its reported balances, its gas estimates, and its
provider's reads are transport and stay client-side.

"Simulate against this wallet" (the execution column, live mode) runs `buildPlan`/`riskLedger`
over that snapshot and mints the standing the gate consumes. The standing binds the address,
the plan hash, and the capture's block number + hash: an edited document regates as
`plan-drift`, a superseded capture as `snapshot-drift` — both BEFORE the staleness clock, and
both cleared only by re-simulating.

---

## 3. The manual run — preconditions

Do all of these before connecting a funded wallet.

- [ ] The deployment is on **Ethereum mainnet** and the app's own RPC is configured and
      reachable. The gate refuses `chainId !== 1` before any signature request, but check it
      rather than relying on the refusal.
- [ ] The wallet is a **plain EOA with no code** — check `eth_getCode` yourself. If the account
      has an EIP-7702 delegation, remove it or use a different account: the plan contains
      `WETH.withdraw`, and the delegated call can run out of gas inside the 2300-gas stipend.
- [ ] The wallet has **no Aave Core position** — no debt and no aToken balance on any reserve.
      Live v1 opens a new position and does not merge; merging is P5, and pretending otherwise
      would ship wrong risk numbers.
- [ ] The wallet holds the input ETH **plus gas** for 13 transactions. The flagship's step count
      is fixed; budget accordingly.
- [ ] The strategy on the canvas is the one you intend to run, and its borrow allocation is
      inside the limit (the block refuses past it, with the LTV/LT of the active e-mode
      configuration shown).
- [ ] You have read the pre-sign card for **every** step, not just the first. Each one states
      the contract, the function, the arguments, and the consequence, all read from the same
      plan object the calldata is built from.

## 4. The manual run — during

- [ ] The simulation must be **fresh**. Execute regates past `LIVE_SIMULATION_MAX_AGE_MS`
      (two minutes — ten mainnet blocks). If it regates, re-simulate; do not look for a way
      around it. The button that reruns is labelled **"Re-simulate"**, never "Resume".
- [ ] Do not switch accounts or networks mid-run. The plan's calldata embeds `onBehalfOf` for
      the address pinned at `ready`; a change halts the run (`halted: wallet-changed`) and
      nothing further is sent. This is designed behaviour, and recovering means reconnecting
      and re-simulating.
- [ ] A step that does not confirm within `LIVE_STEP_TIMEOUT_MS` (ninety seconds) offers
      **keep waiting** or **stop watching**. The chain has not spoken at that point, so neither
      does the copy: an unwatched transaction is not a failed one. If you stop watching, the
      recovery re-simulation is what discovers whether it later landed.
- [ ] A **replaced** transaction is classified before anything final is claimed. A repriced copy
      keeps the step alive under a new hash; a replacement that did something else stops the run
      at that step, because the nonce is spent and the original can never land.
- [ ] If a step's attributed output diverges from the prediction beyond
      `LIVE_OUTPUT_TOLERANCE`, the run **halts** and nothing further is dispatched. Do not look
      for an override: the next step's calldata would be built from a number the machine cannot
      vouch for. Read the PREDICTED / ATTRIBUTED / TOLERANCE figures on the halted card, and
      re-simulate the remaining steps before deciding anything.

## 5. The manual run — after

- [ ] Record, for the receipt: the block the simulation was pinned to, the 13 transaction
      hashes, the attributed output of every producing step, and the final health factor as
      **both** the chain's reading and the prediction.
- [ ] Check that every approval's allowance reads **zero** after its consuming step. The engine
      checks this and halts on a residue; verify it independently for a live run.
- [ ] If anything halted, failed, or was left unresolved, do NOT retry blind. The recovery path
      is: re-simulate the remaining steps against current state, read the result, and only then
      continue from the failed step.

---

## 6. What this checklist is not

It is not a claim that the live path has been exercised. No live run has been performed, and
this repo publishes no screenshot, hash, or figure suggesting one has. When a live run happens,
its receipt belongs in `roadmap/` with the hashes above, and this section is what it replaces.
