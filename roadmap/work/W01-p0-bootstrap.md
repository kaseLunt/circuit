---
id: W01
type: work
title: P0 bootstrap — scaffold, CI, spikes, and pinned decisions
phase: P0
status: achieved
evidence_target: ci-green-scaffold-plus-executable-sandbox-proof
priority: 1
depends_on: []
blocked_by: []
informs: [H0]
allowed_paths:
  - .github/**
  - src/**
  - public/**
  - docs/**
  - spikes/**
  - package.json
  - package-lock.json
  - tsconfig.json
  - next.config.ts
  - eslint.config.mjs
  - vitest.config.mjs
  - playwright.config.ts
  - postcss.config.mjs
  - README.md
  - LICENSE
  - CLAUDE.md
  - .gitignore
  - roadmap/work/W01-p0-bootstrap.md
deliverables:
  - package.json
  - .github/workflows/ci.yml
  - src/app/globals.css
  - CLAUDE.md
  - LICENSE
  - README.md
  - docs/decisions.md
  - spikes/sandbox-proof/proof.mjs
  - spikes/sandbox-proof/proof-output.txt
evidence_receipts:
  - roadmap/evidence/E-W01-p0-bootstrap-r8.md
invalidated_by:
  - SPEC.md
  - TRANSPLANT.md
  - package.json
  - .github/workflows/**
review_when: event:invalidated-by-change
updated: 2026-07-25
evidence_fingerprint: sha256:bba3fbf999483d1578121fa55cb47457664f843a7cef7a4275853c06d716e947
---

# W01 — P0 bootstrap: scaffold, CI, spikes, and pinned decisions

**Why this advances the vision:** H0 requires provable claims; nothing is provable until a
scaffold with enforced CI exists and the two load-bearing unknowns (sandbox provider, protocol
matrix) are pinned by executable proof rather than assumption. Disproof: CI red, spike proof not
demonstrable, or any pinned value asserted without a recorded read.

## Objective

Stand up the repo per SPEC §11 P0: Next.js 16 scaffold building green in Actions with zero code
beyond the skeleton; predecessor token ranges ported per TRANSPLANT.md; CLAUDE.md (enforcement
rules only), LICENSE, README skeleton; the sandbox-infra spike (anvil-on-Railway vs Tenderly VTN)
resolved by executable proof; the Aave Core protocol matrix recorded; name and display face
decided and recorded in docs/decisions.md.

## Acceptance

- `.github/workflows/ci.yml` runs typecheck + lint + test + build on push and is green on `main`.
- Token port lands with the TRANSPLANT.md edits for `globals.css` applied in the same commit.
- Sandbox spike ends in an **executable proof** (SPEC §11 P0 gate): per-session isolation,
  fork-block identity, snapshot/revert, two concurrent sessions, admin-RPC non-exposure, and gas
  estimation each demonstrated by a committed script under `spikes/sandbox-proof/` with its
  output recorded; the provider decision cites the proof.
- Protocol matrix recorded in docs/decisions.md: Aave Core addresses, deployed revision, error
  ABI, e-mode category config, applicable §5.7 constraint set, EtherFi/Lido/WETH addresses — each
  value from a recorded read, none hand-typed from memory.
- Name + display-face decisions recorded (display face per SPEC §7 anti-overexposure rule).
- Negative case: a clean clone with no env vars still typechecks, lints, and builds (no
  module-scope env throws).

## Non-goals

- No `core/` finance implementation (that is P1's scope, gated on this item's protocol matrix).
- No canvas/UI beyond the scaffold skeleton and tokens.
- No porting beyond the P0 rows of TRANSPLANT.md's porting-order table.

## Canonical commands

```text
npm ci
npx tsc --noEmit
npm run lint
npm test
npm run build
python roadmap/tools/doctor.py
# sandbox spike proof (exact invocation recorded with the spike):
#   spikes/sandbox-proof/run.*
```

The npm commands do not exist until the scaffold lands in this work item; recording them here is
intent, not attained evidence.

## Evidence

No attained evidence yet. First commit and verify the deliverable while this work remains active.
Then record the tested commit, environment, commands, and result in a receipt; change this work to
`achieved`, add each staged receipt path to `evidence_receipts`, and run `doctor.py --stamp W01`.
Restage the stamped work object. Stamping binds the staged contract/proof/input snapshot and does
not run the commands for you. Calculate the receipt's `input_fingerprint` and
`contract_fingerprint` with `doctor.py --receipt-basis W01 --snapshot <tested-commit>`.

## Handoff

- next: Owner ratifies VISION/H0 and D-001/D-002, then activates this item by setting
  `STATUS.active_task: W01` and this file's `status: active` in one transition ("start P0").
- read_first: SPEC.md §4 (architecture), §7 (taste rules), §8 (quality bar), §11 P0 row;
  TRANSPLANT.md P0 rows (globals.css, lib/utils.ts, components/ui/*).
- hazards: The sandbox spike is the schedule-critical unknown — if neither provider passes the
  executable proof affordably, SPEC §6/§11 need a Decision before P3a, not a silent workaround.
  Do not port any file without applying its TRANSPLANT.md edits in the same commit.
