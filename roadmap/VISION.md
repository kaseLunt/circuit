# VISION — Strategy Studio (working title)

> Draft until explicitly ratified by the project owner. Keep the durable outcome stable and review
> changes at phase boundaries through a proposed Decision.

## Why this project exists

1. **Craft demonstration:** show what disciplined web3 frontend / design engineering looks like —
   defensible money-math, tests as enforcement, scope restraint, and transaction-UX craft.
2. **Curated successor:** supersedes an earlier private prototype; only vetted, corrected parts are
   carried forward (TRANSPLANT.md).
3. **Durable competence artifact:** the finance core (Aave v3 mechanics, LST/LRT wrapping,
   fork-proven execution) is reusable knowledge regardless of any single application outcome.

## What finished success looks like

The SPEC §3 demo script runs green, in order, on the production URL with no wallet connected, and
the scheduled production smoke keeps proving it. Shortest honest sentence:

> "A node-based DeFi strategy composer — every number on screen carries its provenance, every
> money-path is unit- and fork-tested, and the execution UX is the part I'm proudest of."

## Permanent non-goals

- Not a product: no user-growth, TVL, or revenue ambitions; no fabricated traction claims, ever.
- No feature breadth for its own sake; anything outside SPEC v1 + P5 needs a ratified Decision.
- No fabricated numbers: nothing renders without provenance (SPEC §7).
- No self-referential meta-docs: the repo speaks about the product and its engineering, never
  about its author's goals.
- No multi-chain, no database-backed user state, no wallet-auth (SIWE) in v1.
- Shipped claims never exceed shipped reality (SPEC §11 claims-downgrade rule).

## Evidence philosophy

Evidence targets are project-specific. Define what each target means through reproducible commands,
artifacts, environments, and review—not through a universal label alone.

Use these rules for every project:

- an evidence target is asserted intent; attained evidence is derived;
- evidence applies only to the recorded commit and fingerprinted inputs;
- relevant input changes invalidate prior attainment until verification is rerun;
- local correctness, variation/interaction robustness, and user-visible demonstration are distinct
  claims when the project needs them;
- unsupported or unverified behavior stays explicit.

**This project's ladder (SPEC §8), each rung a distinct claim:**

1. `vitest` pure suite — core/ math correctness on fixtures.
2. Pinned-mainnet-fork suite (anvil, in CI) — the 13-step plan executes against real protocol
   state; HF asserted against Aave after every risk-changing step; no-sweep proof.
3. Playwright + wagmi mock connector — the §3 script end-to-end against mocked reads.
4. Scheduled production smoke — the deployed URL keeps working (sandbox execution and share-URL
   rehydration included).

None of these commands exist until the P0 scaffold lands; until then the only runnable check is
`python roadmap/tools/doctor.py` (structural governance validation only — it proves nothing about
the product).

## Architectural principles

- `core/` is pure: finance math takes block-pinned snapshots, never fetches (SPEC §4).
- Every renderable quantity is `Provenanced<T>` — Observed / Derived / Entered / Configured.
- Finance reads belong to `server/chain/`; transaction-transport observation belongs to the client;
  the two never mix.
- Two recovery machines: simulation recovery restarts from base; execution recovery resumes after
  confirmed state.
- Finance before polish: no canvas work on an unproven model (P1 before P2).
- Deletion over accretion: the predecessor is a read-only parts bin governed by TRANSPLANT.md.

## Review record

- status: ratified
- owner ratification: 2026-07-23 (owner-directed transition)
- next review: P0 exit gate
