---
id: E-W01-P0-BOOTSTRAP-R2
type: evidence
title: P0 bootstrap re-achieved at the post-W04 tip
status: recorded
work: W01
result: pass
observed_at: 2026-07-23T04:27:08Z
tested_commit: 609a8b1b2fd3bf5d72cf12b9848298e674b501cf
environment: windows-11-node-22-local
input_fingerprint: sha256:f35e5849eff9563e0d0c44be8265d1f227d947a2af092cbe6289893b9eef6ded
contract_fingerprint: sha256:37d7710bf54febceff16e8771961cb42b45e35d89bbc2420bf0c3b45453198c6
commands:
  - "npm run build && npm run typecheck && npm run lint && npm test"
  - "ANVIL_PATH=<foundry> node spikes/sandbox-proof/proof.mjs"
  - "python roadmap/tools/doctor.py"
updated: 2026-07-23
---

# E-W01-R2 — P0 bootstrap re-achieved

W01 was superseded when W04 evolved its invalidated inputs (package.json, the spike proof).
Re-verified at the post-W04 tip: scaffold builds green with zero env vars, strict typecheck
clean, `--max-warnings=0` lint clean, tests pass, and the sandbox spike passes all checks
(including the hardened negative-reachability test). The token port, LICENSE, README, CLAUDE.md,
and pinned decisions (name Circuit, anvil sandbox, v3.7 protocol matrix) remain in place.
Supersedes E-W01-P0-BOOTSTRAP (removed when its inputs changed; content in history at 1de52b5).
