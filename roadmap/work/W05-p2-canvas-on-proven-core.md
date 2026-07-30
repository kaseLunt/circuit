---
id: W05
type: work
title: P2 canvas on the proven core — composer transplanted, reskinned, share-URL round-trip
phase: P2
status: achieved
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
  - vitest.config.mjs
  - tsconfig.json
  - eslint.config.mjs
  - .gitignore
  - scripts/**
  - roadmap/work/W05-p2-canvas-on-proven-core.md
deliverables:
  - src/lib/strategy/types.ts
  - src/core/route-optimizer.ts
  - src/core/risk.ts
  - src/app/store/composer-store.ts
  - src/app/store/composer-provider.tsx
  - src/lib/strategy/templates.ts
  - src/lib/recorded-reads/recorded-snapshot.ts
  - src/components/canvas/canvas.tsx
  - src/components/canvas/canvas.css
  - src/components/canvas/flow-edge.tsx
  - src/components/canvas/selection-action-bar.tsx
  - src/components/canvas/canvas-empty-state.tsx
  - src/components/canvas/blocks/base-block.tsx
  - src/components/canvas/blocks/block-value-badge.tsx
  - src/components/canvas/blocks/input-block.tsx
  - src/components/canvas/blocks/stake-block.tsx
  - src/components/canvas/blocks/lend-block.tsx
  - src/components/canvas/blocks/borrow-block.tsx
  - src/components/canvas/blocks/auto-wrap-block.tsx
  - src/components/canvas/blocks/index.ts
  - src/components/composer/sidebar.tsx
  - src/components/composer/simulation-panel.tsx
  - src/components/composer/composer-shell.tsx
  - src/components/composer/sandbox-composer.tsx
  - src/components/composer/simulation-host.tsx
  - src/components/composer/arrival.ts
  - src/components/composer/share-link.tsx
  - src/components/composer/share-refusal.tsx
  - src/components/shared/sourced-value.tsx
  - src/lib/share/encode.ts
  - src/lib/share/share-url.ts
  - e2e/demo-script.spec.ts
  - playwright.config.ts
  - .github/workflows/ci.yml
evidence_receipts:
  - roadmap/evidence/E-W05-p2-canvas-on-proven-core-r3.md
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
review_when: event:invalidated-by-change
updated: 2026-07-26
evidence_fingerprint: sha256:868ca1c800cf9d077da771d45576aa1a1e6457801d065d7b58afc21977859aff
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

**Contract amendment (owner-reviewed, 2026-07-26):** deliverables enumerated with the concrete
files the port fixed (the amendment this section promised — blocks family, canvas chrome, store
binding, host/share surfaces, core/risk.ts, the recorded-reads builder). `scripts/**` and
`docs/protocol-matrix-reads.json` enter `allowed_paths` for the staking-APR trailing-window
capture: SPEC §5.1's staking APR needs one archive read ~7 days before the pinned block, which
means one change to `scripts/protocol-reads.mjs` and a re-capture of the committed reads log.
The archive read uses the existing runtime-built RPC endpoint; no URL or key is ever committed
(post-credential-leak policy).

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
- hazards: **D-010 applies from this item onward** — work lands via pull request; branch
  protection and the trusted audit are LIVE (PR #1). **Branch discipline the replay policy
  enforces (learned on PR #2):** merge commits are legal only in the integration orientation
  (first parent an ancestor of the second — an up-to-date branch landing into main), so
  "merge main into the feature branch" is structurally banned; keep `w05` linear via
  rebase-onto + `--force-with-lease` when main moves mid-PR, and after every PR merge reset the
  branch onto the new tip (`git checkout -B w05 origin/main` — the claim binds the branch NAME,
  which survives the reset). Never force-push main. Product-only PRs need no approval token;
  owner-gated PRs need the `CONTROL_PLANE_POLICY_APPROVAL` token re-issued per reviewed head. The prototype's
  `protocols.ts` is contaminated with hardcoded APYs/TVLs/GAS_COSTS: port only the
  `id`/`inputAsset`/`outputAsset` slice (manifest L83). The old global stylesheet's "STRATEGY
  BUILDER" section is design language #3 and is deleted wholesale, except the React Flow selection
  styling concept, which is rebuilt from tokens (manifest L526). Numbers must not be lifted from
  the prototype's computed-value code paths — the shape is reference, `core/` is the source.
