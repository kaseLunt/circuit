---
id: E-W01-P0-BOOTSTRAP
type: evidence
title: P0 bootstrap acceptance — CI green, spike proof, matrix recorded, decisions pinned
status: recorded
work: W01
result: pass
observed_at: 2026-07-23T02:33:57Z
tested_commit: 3eb370d5f9a14d2f885f3a57ede1ea845a09d01d
environment: windows-11-node-22-local + github-actions-ubuntu (runs 29974640179, 29974640172)
input_fingerprint: sha256:3f98184464957fed274c5150b422ffe6a0cc28e82af1d6716febdb338255d970
contract_fingerprint: sha256:37d7710bf54febceff16e8771961cb42b45e35d89bbc2420bf0c3b45453198c6
commands:
  - "npm run build"
  - "npm run typecheck"
  - "npm run lint"
  - "npm test"
  - "git clone . /tmp/circuit-clean && cd /tmp/circuit-clean && npm ci && npm run build  # no env vars"
  - "ANVIL_PATH=<foundry> node spikes/sandbox-proof/proof.mjs  # output committed"
  - "python roadmap/tools/doctor.py"
updated: 2026-07-22
---

# E-W01 — P0 bootstrap acceptance

All acceptance items verified at the tested commit:

- **CI green on main:** GitHub Actions runs 29974640179 (CI: install/build/typecheck/lint/test)
  and 29974640172 (control plane) both `success` at the tested commit; same suite green locally.
- **Token port:** globals.css landed at `5c7708e` with the TRANSPLANT.md edits applied in that
  commit (decoration deleted, reduced-motion added; deviations recorded in the message).
- **Sandbox spike:** `spikes/sandbox-proof/proof.mjs` — ALL CHECKS PASSED (output committed at
  `0b56ddc`): fork-block identity, per-session isolation, faucet, gas estimation, unsigned
  execution (real WETH deposit on forked mainnet state), snapshot/revert, 127.0.0.1 binding.
  Provider decision (anvil) cites this proof in docs/decisions.md.
- **Protocol matrix:** docs/protocol-matrix.md + raw read log docs/protocol-matrix-reads.json
  (`f495408`) — every value from a recorded read; UNVERIFIED items flagged, none guessed.
- **Name + display face:** recorded in docs/decisions.md (`bb28bff`): Circuit — Visual DeFi
  Strategy Builder (repo renamed to kaseLunt/circuit); system stacks until a face earns its
  place.
- **Negative case:** clean clone with zero env vars — npm ci, build, typecheck, lint, test all
  green (no module-scope env throws).
- **Senior review (D-004):** not dispatched for this work item — bootstrap scaffolding and
  recorded-read documents, no money-math; the P0→P1 boundary review will put the matrix and
  spike in front of Codex before P1 builds on them.
