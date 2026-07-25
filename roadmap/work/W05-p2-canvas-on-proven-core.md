---
id: W05
type: work
title: P2 canvas on the proven core — composer transplanted, reskinned, share-URL round-trip
phase: P2
status: active
evidence_target: spec-3-steps-1-3-and-8-green-in-playwright-on-mock-reads
priority: 1
depends_on: [W03]
blocked_by: []
informs: [H0]
allowed_paths:
  - src/**
  - tests/**
  - e2e/**
  - docs/**
  - .github/**
  - package.json
  - package-lock.json
  - playwright.config.ts
  - vitest.config.ts
  - tsconfig.json
  - eslint.config.mjs
  - .gitignore
  - roadmap/work/W05-p2-canvas-on-proven-core.md
deliverables:
  - src/lib/strategy/types.ts
  - src/core/route-optimizer.ts
  - src/app/store/composer-store.ts
  - src/lib/strategy/templates.ts
  - src/components/canvas/canvas.tsx
  - src/components/composer/sidebar.tsx
  - src/components/composer/simulation-panel.tsx
  - src/lib/share/encode.ts
  - e2e/demo-script.spec.ts
  - playwright.config.ts
  - .github/workflows/ci.yml
evidence_receipts: []
invalidated_by:
  - SPEC.md
  - TRANSPLANT.md
  - src/core/**
  - src/lib/**
  - src/components/**
  - src/app/**
  - e2e/**
  - tests/**
  - package.json
review_when: phase:P2:exit
updated: 2026-07-25
---

# W05 — P2 canvas on the proven core

**Why this advances the vision:** P1 proved the money-math against a real fork with nothing to
look at. P2 is where that model becomes visible without becoming dishonest — the inversion of the
prototype's polish-first failure. Disproof: any number rendering before its source resolves, any
allocation edit that disagrees with `core/`, or a share URL that rehydrates a graph the validator
would have rejected.

## Objective

Transplant and reskin the prototype's composer on top of P1's model, per SPEC §7 and the
`TRANSPLANT.md` manifest, until SPEC §3 steps 1–3 and 8 pass in Playwright against **mock reads**.
No live chain reads, no wallet, no execution — those are P3.

The porting order is fixed by the manifest: `strategy/types.ts` → `route-optimizer.ts` → store
(**rebuild**) → templates (**rebuild**) → canvas + blocks + edges + sidebar. One module per port
commit with provenance in the message; `port-with-edits` files land with **every** listed edit in
the same commit. Anything absent from the manifest does not exist.

Block and edge components land under `src/components/canvas/blocks/` and `edges/` (in scope via
`src/**`) but are deliberately not enumerated in `deliverables` yet: doctor requires achieved
deliverables to be concrete existing files (globs and directories are rejected,
`doctor.py:760`), and the port fixes their names. Amend `deliverables` with the concrete files
in the commit that lands them — a contract amendment, so it is owner-gated by design.

## Acceptance

- **§3 step 1 — template loads.** Land → "Try sandbox" → composer opens with the Leveraged
  Restake Loop template (the SPEC §2 expanded DAG) and a visible Sandbox badge.
- **§3 step 2 — every number is sourced.** Staking APR, supply APY and borrow APR each render
  from a `Provenanced<T>`, with a tooltip citing method + block number + source-fetch timestamp.
  **No number renders before its source resolves** — in-node skeleton treatment, never a
  placeholder value, never a zero standing in for "unknown".
- **§3 step 3 — allocation editing is live and correct.** Dragging borrow allocation 50% → 70%
  updates minimum-HF-during-execution and the liquidation ratio on the block, computed
  client-side over a block-pinned read set; crossing the warning threshold moves the block to its
  warning state. The displayed HF must equal `core/health-factor.ts` for the same inputs — asserted
  in a unit test, not by eye.
- **§3 step 8 — share-URL round-trip.** Copying the share URL and opening it in a clean context
  rehydrates the identical graph, and the payload is validated by `core/graph.ts` before use. The
  malicious-graph suite from W03 must reject a hostile payload arriving by URL exactly as it does
  one arriving in-process.
- **Reskin is complete, not partial (SPEC §7).** Dark-only; every colour, radius and motion value
  from `src/app/globals.css` tokens; colour is semantic state (valid/warning/error/executing),
  never decorative-per-type; no glows, gradient text, ambient backgrounds, entrance animations or
  pulses; `--motion-fast`/`--motion-slow`/`--ease-standard` with a `prefers-reduced-motion`
  treatment; `tabular-nums` wherever digits align; all formatting through `core/format.ts`.
  React Flow's default stylesheet look never ships.
- **A11y floor:** keyboard operability across the composer, visible `.focus-ring`, ARIA on
  interactive controls, no `user-select: none`.
- **Money rules hold at the boundary:** no `?? <number>`, no default prices or rates; `core/`
  stays pure (no fetch, no I/O, no React) and the canvas consumes it rather than reimplementing
  it.
- **Playwright green in CI** on mock reads, as a job alongside `ci` and `fork`.

## Canonical commands

```text
npm test                    # vitest unit suite incl. canvas-model tests
npm run test:e2e            # Playwright §3 steps 1–3 + 8 on mock reads
npm run build && npm run typecheck && npm run lint && npm run check:scripts
python roadmap/tools/doctor.py --snapshot index
```

## Non-goals

- No live chain reads, no wallet connection, no execution, no sandbox session service (P3).
- No swap block, no position import, no SSE/Pyth, no light theme, no Base (P5).
- No saved-systems / "loops" feature — out of SPEC v1 scope, and it drags the save-system modal
  and store slice (manifest L125).
- No multi-chain chrome — Ethereum-mainnet-only; the chain badge is deliberately not ported.

## Handoff

- next: land `src/lib/strategy/types.ts` first (it is the manifest's root dependency), then
  `route-optimizer.ts` **with its two recorded bug fixes** — unroutable edges currently pass
  validation through a dead error branch, and `beforeBlockId` dangles via a second `Date.now()`
  (manifest L63, L76). Neither may be ported as-is.
- read_first: `TRANSPLANT.md` P1 row and the per-file edit lists; SPEC §3 (the demo script is the
  acceptance test), §5.6 (share-URL validation), §7 (taste rules); `src/core/graph.ts` and
  `src/core/plan.ts` module headers — the canvas consumes these, it does not reimplement them.
- hazards: **D-010 applies from this item onward** — work lands via pull request, and until the
  owner completes branch protection + `CONTROL_PLANE_POLICY_APPROVAL` + the required-workflow
  wiring, every owner-gated transition still needs a recorded override. The prototype's
  `protocols.ts` is contaminated with hardcoded APYs/TVLs/GAS_COSTS: port only the
  `id`/`inputAsset`/`outputAsset` slice (manifest L83). The old global stylesheet's "STRATEGY
  BUILDER" section is design language #3 and is deleted wholesale, except the React Flow selection
  styling concept, which is rebuilt from tokens (manifest L526). Numbers must not be lifted from
  the prototype's computed-value code paths — the shape is reference, `core/` is the source.
