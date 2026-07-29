---
id: W07
type: work
title: P3a execution — sandbox session service and the tx UX family on the fork
phase: P3
status: active
evidence_target: sandbox-execution-arc-green-on-fork-in-ci
priority: 1
depends_on: [W05, W06]
blocked_by: []
informs: [H0]
allowed_paths:
  - src/**
  - tests/**
  - e2e/**
  - docs/**
  - .github/**
  - scripts/**
  - package.json
  - package-lock.json
  - playwright.config.ts
  - vitest.config.ts
  - vitest.config.mjs
  - vitest.fork.config.ts
  - tsconfig.json
  - eslint.config.mjs
  - SPEC.md
  - next.config.ts
  - roadmap/work/W07-p3-execution.md
deliverables:
  - src/lib/execution/attribution.ts
  - src/lib/execution/attribution.test.ts
  - src/lib/execution/types.ts
  - src/lib/execution/machine.ts
  - src/lib/execution/machine.test.ts
  - src/lib/execution/tolerance.ts
  - src/lib/execution/record.ts
  - src/lib/execution/resume.ts
  - src/lib/execution/resume.test.ts
  - src/server/sandbox/session-registry.ts
  - src/server/sandbox/fork-session.ts
  - src/server/sandbox/execute-step.ts
  - src/server/trpc/sandbox-router.ts
  - src/components/tx/step-list.tsx
  - src/components/tx/execution-flow.tsx
  - src/components/tx/pre-sign-review.tsx
  - src/components/tx/transaction-button.tsx
  - tests/fork/flagship-plan.test.ts
  - tests/fork/execution-drills.test.ts
  - tests/fork/session-isolation.test.ts
  - e2e/demo-script.spec.ts
  - e2e/demo-script-fork.spec.ts
  - e2e/playwright.fork.config.ts
  - eslint.config.mjs
  - SPEC.md
  - .github/workflows/ci.yml
evidence_receipts: []
invalidated_by:
  - SPEC.md
  - src/core/**
  - src/lib/**
  - src/server/**
  - src/components/**
  - src/app/**
  - e2e/**
  - tests/**
  - eslint.config.mjs
  - SPEC.md
  - package.json
review_when: phase:P3:exit
updated: 2026-07-26
---

# W07 — P3a execution

**Why this advances the vision:** P1 proved the money-math on a fork with nothing to look at;
P2 made it visible without making it dishonest. P3 is where the numbers move money — the phase
where a rendered figure and a signed byte string must be the same fact, and where every honest
failure mode (revert, timeout, divergence, expiry, wallet swap) is a designed state instead of a
toast over a spinner. Disproof: a second derivation of any amount anywhere in the execution path,
a success rendered without a mined receipt, a prediction quietly substituted for an attribution,
or transport observation (nonce, gas, injected-provider reads) reaching `Provenanced` or `core/`.

## Objective

Implement SPEC §6 and the P3a sandbox execution arc (per the 2026-07-28 amendment) on top of P1's proven model and P2's canvas, under the
binding pre-implementation treatment at
`C:\Users\kasel\AppData\Local\Temp\w05\p3-execution-treatment.md` (Protocol-Execution Security
Director, circuit, delivered 2026-07-26). **This charter constrains and points; the treatment is
the specification.** Of its eight surfaces, six are in scope here — execution state machine,
approval scoping, pre-sign review, sandbox session service, attribution, and the taste handoffs,
under the A1–A24+ seam table — and its §10 conditions are pre-announced review verdicts, not
advisory notes. The wallet boundary and live-gating surfaces are W08's (the 2026-07-28
amendment); the treatment binds them there unchanged.

New code lands in the module homes the treatment fixes, and nowhere else:

```
src/lib/wallet/          (W08 — wagmi config, connect boundary, transport observation)
src/lib/execution/       plan/step state machines, attribution, tolerances, execution record,
                         resumePlan — client-side driver
src/server/sandbox/      session registry, fork lifecycle, per-step execute path
src/server/trpc/         the sandbox router (schemas carry no calldata, addresses, or amounts)
src/components/tx/       StepList, ExecutionFlow, PreSignReview, TransactionButton — BUILD, not
                         port (SPEC §6; TRANSPLANT execution-ui entries are reference at most)
```

**Order is fixed by the extraction directive.** The first commit is treatment §6.4: extract
`resolveAmount`/`executeStep` from `tests/fork/flagship-plan.test.ts` (both copies, `:205-277`
and `:779-839`) into `src/lib/execution/attribution.ts` behind the injectable `AttributionReads`
interface, and refactor the fork suite to consume it. After that commit the shipped attribution
code is the code the fork gate proves, by identity rather than resemblance. Everything else in
this item builds on that module.

**Phase split (SPEC §11) — AMENDED 2026-07-28 (owner-ratified; phase review 019fabfb).** This
work object now covers P3a ONLY: the sandbox path — provider provisioned, session registry,
server-built execution, and the sandbox execution arc (arm → review → execute → attribute →
receipt) proven in the browser against a pinned fork in CI. P3b — the wallet boundary, live-mode
gating with the §2 footprint refusal, the §3 prevention-and-override beat (step 4) and live-gating
beat (step 7), timeout keep-waiting/give-up controls, T26 canvas lockdown, and the manual live
checklist — moves to W08. The original charter said one object covers both because the shared
spines (state machine, attribution, pre-sign surface) are common code; those spines are BUILT and
merged, so the split now cuts along mode, not architecture. The phase-exit review correctly
refused the old evidence-target label: the sandbox arc is not SPEC §3 steps 4 and 7, and the
receipts must claim exactly what was proven.

**Deliverables are enumerated as far as the treatment names them.** The execution-surface
components beyond the four `components/tx/` files — designed refusal and edge states, the
divergence surface, the partial-execution recovery surface, the sandbox chrome additions — get
enumerated by amendment once the taste handoffs (treatment §8) are ruled, mirroring the W05
block-component amendment. `eslint.config.mjs` is a deliverable because the money/transport
quarantine is enforced there, and it is in `invalidated_by` for the same reason: if the
`no-restricted-imports` boundary changes, every claim resting on it is stale.

## Acceptance

- **The sandbox execution arc, in the browser, on the fork, in CI.** From the composed flagship:
  arm a session, review every planned call (full targets, signatures, bound amounts, tolerance
  contract, session facts), execute all 13 steps against the session fork with their lifecycles
  rendered, every producer output attributed within named tolerances with provenance citations,
  and the still receipt (N+1 success glyphs exactly, CHAIN/PREDICTED agreement, the
  forked-mainnet badge). Gas renders from receipts only — the sandbox quotes no estimates and
  says so rather than conflating (T36.4). No success state exists without a mined receipt.
- *(Moved to W08 by the 2026-07-28 amendment: the §3 step-4 prevention-and-override beat and
  the §3 step-7 live-gating beat, including the mock connector, fresh-simulation gate, and the
  §2 footprint refusal.)*
- **Server builds everything (SPEC §6, treatment §5.2).** No sandbox endpoint schema accepts a
  `to`, `data`, address, or amount; zod strict; `planHash` reconciled against the server's own
  rebuild; `(sessionKey, planHash, stepIndex)` makes `executeStep` idempotent under retry with a
  per-session mutex and strict sequencing.
- **One encode site, one derivation.** `encodeStep` is the only calldata construction site
  (lint-restricted); the pre-sign surface renders from the same `PlanSuccess` and the same
  `flows` wrappers the canvas rendered, never from re-decoded calldata.
- **Attribution is the §5.5 whitelist and nothing else.** Share-delta, Transfer-event, and
  withdraw-argument only; no `balanceOf` sweep anywhere; money-bearing reads go through our
  configured RPC, never the injected provider; every attributed amount is compared to the
  prediction within named tolerances derived from fork receipts, and beyond-tolerance halts.
- **Sequencing invariant.** Step k+1 is not dispatchable until step k is attributed within
  tolerance — asserted on the machine, not by inspection.
- **Allowance hygiene.** No approve reaches MAX under any input; allowances are read before they
  are assumed; allowance is zero after each consuming step, asserted on the fork.
- **Fork gate extended, never lowered (treatment §9).** Attribution-module identity, four
  allowance-zero assertions, the failure drill (executed prefix intact, zero suffix transactions
  sent), the divergence drill, the resumption drill, the idempotency drill, and the two-session
  isolation check all green in CI alongside the existing suite.
- **Recovery is honest (treatment §2.3).** Resumption runs `resumePlan` over the frozen
  `TransactionStep[]`, never `buildPlan` over the document; the riskLedger seeding choice is
  recorded in writing — typed initial position or chain-read HF per risk step, labelled as such.
- **Taste and a11y.** Every execution surface is token-derived per SPEC §7 with a
  `prefers-reduced-motion` treatment; step-status changes announce via `aria-live="polite"`;
  focus moves to the failed step's recovery action; keyboard-operable throughout.
- **Codex final approval (D-007).** Every commit in this phase is money-path; an explicit Codex
  APPROVAL verdict gates each landing and the phase exit, with verdicts recorded in the receipt.

## Non-goals

- No swap block, no position import or eMode transitions, no SSE/Pyth, no light theme, no Base
  (P5).
- No new protocol arithmetic. Prediction has one home: `core/rates.ts` and `core/risk.ts`. Any
  post-action state math written inside execution code is a blocking finding.
- No landing polish, OG assets, or README GIF (P4).
- No fourth attribution mechanism, no allowance convenience helpers, no retry-on-revert
  affordance of any kind.
- No KV or storage use beyond the SPEC §4 session-registry exception.

## Canonical commands

```text
npm test                    # vitest unit suite incl. attribution + machine + resume tests
npm run test:fork           # anvil fork suite: flagship + the treatment §9 drills
npm run test:e2e:fork      # Playwright: the sandbox execution arc against the session fork
npm run build && npm run typecheck && npm run lint && npm run check:scripts
python roadmap/tools/doctor.py --snapshot index
```

## Handoff

- next: the P3a close — evidence receipt over the CI-green sandbox arc, phase-exit approval
  per D-007/D-011, claim release, then the owner-gated W08 activation (wallet boundary and
  live gating live there; the treatment's §1 surface binds W08 unchanged). The build sequence
  this handoff originally ordered (attribution extraction → session service → tx family) is
  complete and merged.
- read_first: `C:\Users\kasel\AppData\Local\Temp\w05\p3-execution-treatment.md` in full — it is
  binding, and §10 lists the eleven review verdicts already announced. Then SPEC §3 (execution beats),
  §5.5 (attribution whitelist), §5.7 (validation set), §6 (the whole transaction-UX contract),
  §11 P3a/P3b rows; `src/core/plan.ts` `AmountSpec`/`encodeStep` and the `BlockFlow` header;
  `src/core/risk.ts` `riskLedger` and `postActionDebtOf`; `tests/fork/flagship-plan.test.ts`
  `:205-277` (the engine's real spec) and `:376-380` (the EIP-7702 receipt behind the code-free
  EOA check).
- hazards: **circuit-sentinel consults BEFORE implementation on every execution surface** —
  standing persona policy, not per-commit discretion; the treatment is its first ruling and the
  surfaces in its §8 need joint rulings with circuit-taste before those components are built.
  **D-007 applies to everything in this phase** — it is all money-path, so no commit here is the
  trivial/mechanical exemption. The eleven pre-announced blocking conditions live in treatment
  §10 and are not restated here; read them before writing code, not at review. **R-3a74989b**
  (fork CI 429 flakes) carries `review_when: phase:P3:entry` and must be dispositioned at
  activation — the session service multiplies fork traffic, so the rerun-once posture is not
  survivable at P3 volume; pick one of its three retirement options. The `pull_request_target`
  fork-PR hardening review the public flip opened lands before any workflow in this item gains
  secret access. The **fork suite proves shipped code or it proves nothing**: if the extraction
  is skipped or the suite keeps a private copy of `resolveAmount`, the gate degrades from
  identity to resemblance and the item is not done.
