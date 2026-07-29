---
id: W08
type: work
title: P3b — wallet boundary, live gating, and the prevention-and-override beat
phase: P3
status: active
evidence_target: spec-3-steps-4-and-7-green-with-mock-connector
priority: 1
depends_on: [W07]
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
  - eslint.config.mjs
  - scripts/**
  - roadmap/work/W08-p3b-wallet-live-gating.md
deliverables:
  - src/lib/wallet/types.ts
  - src/lib/wallet/config.ts
  - src/lib/wallet/wallet-provider.tsx
  - docs/live-execution-checklist.md
evidence_receipts: []
invalidated_by:
  - SPEC.md
  - src/lib/execution/**
  - src/server/**
  - eslint.config.mjs
review_when: event:invalidated-by-change
updated: 2026-07-29
---

# W08 — P3b: wallet boundary and live gating

**Why this advances the vision:** the sandbox arc (W07) proves execution honestly with zero
risk; P3b makes the same machine speak to a real wallet without weakening one guarantee. It
also retires the only shallow-skim objection to the public repo ("no connect wallet button").

## Objective

The scope the 2026-07-28 W07 amendment moved here, unchanged in substance from the original
charter and the sentinel treatment (rev 3.2, §1/§2.1 forward-bindings D6/D7 at the wallet seam):

1. **Wallet boundary** — wagmi config, EIP-1193 connect surface, mock connector for tests;
   transport observation stays client-side and never reaches `Provenanced` or `core/`.
2. **§3 step 4 — prevention and override.** Borrow past the limit refused client-side with
   LTV/LT from the active eMode configuration; "Simulate anyway" produces a decoded revert in
   the step list; re-simulation reruns the whole bundle, labelled "Re-simulate", never "Resume".
3. **§3 step 7 — live gating.** The mock connector switches to Live; Execute stays gated until
   a fresh simulation against real balances passes; the §2 footprint predicate refuses wallets
   already holding a position. Completed live execution is NOT a gate; the manual live
   checklist is documented in `docs/live-execution-checklist.md`.
4. **Live-mode machine controls** — timeout keep-waiting/give-up driver events, replacement
   classification wiring, live tolerance constants (named, in `tolerance.ts`, never reusing the
   sandbox bound), the live discovery ladder for `dispatch-unresolved`/`persistence-failed`.
5. **T26 canvas write-lockdown** during `executing` (typed rejection strip, palette
   `aria-disabled`).

## Acceptance

- SPEC §3 steps 4 and 7 executed verbatim in Playwright with the mock connector.
- No live-mode success state without a mined receipt; the sequencing, attribution, and
  allowance invariants of W07 hold unchanged under the wallet driver (asserted, not inspected).
- Money-bearing reads never travel the injected provider (lint-enforced; probes extended
  one-to-one).
- Codex final approval per D-007/D-011 (money-path surface; hard gate).

## Canonical commands

```text
npm run typecheck && npm run lint && npm run check:lint-boundaries
npx vitest run --coverage
npx playwright test            # steps 1-3, 8 + the new 4 and 7 beats
```

## Non-goals

- Completed live execution as evidence (the checklist documents the manual path).
- USDC or any new asset leg (W09).

## Handoff

- next: activate after the W07 close; producer brief cites treatment rev 3.2 §1/§2.1 and the
  T-series live-mode rulings (T7 timeout family, T32a replacement grammar).
- read_first: `roadmap/work/W07-p3-execution.md` (the amendment paragraph), the sentinel
  treatment §1 (wallet boundary), SPEC §2 (footprint), SPEC §3 steps 4 and 7.
- hazards: the machine already models every live state — resist rebuilding; this is wiring.
  The injected provider is transport only; one read through it into money-math is the failure.
- scope note (2026-07-29): `scripts/**` joined allowed_paths — the boundary-probe EXPECTED
  table (`scripts/lint-boundaries.mjs`) and the coverage manifest (`scripts/coverage.config.mjs`)
  are single-source gates W08's new probes and the wallet decision module must enrol in;
  W07 carried the same path for the same reason.
