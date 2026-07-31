---
id: E-W01-P0-BOOTSTRAP-R8
type: evidence
title: W01 drift review at the W09 close - scaffolding intact under the carry phase
status: recorded
work: W01
result: pass
observed_at: 2026-07-31T17:17:00Z
tested_commit: e8278ca48a017b65a7abf5cc2ebdda6fc25b2dce
environment: github-actions-ubuntu-latest-node-22 (CI run 30649345241; ci, e2e, fork, e2e-fork all green) + local-windows-node-22
commands:
  - "gh run view 30649345241   # ci, e2e, fork, e2e-fork green at the tested commit"
  - "npm run build && npm run check:scripts   # re-run locally on the grown tree, green"
updated: 2026-07-31
input_fingerprint: sha256:78464b968c028bc9b994f189e6198062a96ce62ba37f71acf6fad62d46826b56
contract_fingerprint: sha256:88fb062fdf2c6bcfc864134ccfcf786c8576f5a6bbb410c9c2ddb151cf561f9a
---

# E-W01-P0-BOOTSTRAP-R8 - drift review (event:invalidated-by-change), W09 close

Supersedes `E-W01-p0-bootstrap-r7.md`, which stands as the historical record. Services the drift the W09 range
(PRs #33-#35) produced across this item's invalidation inputs.

**Nature of the drift: accretion, not contradiction.** W09 extended the surfaces W01
established - the reads generator grew per-reserve helpers and the USDC section (80/80
pre-existing reads byte-identical), docs gained the USDC matrix rows, and the scripts and
configs W01 attested still exist and still run: build and check:scripts re-run locally;
typecheck, zero-warning lint, and the full unit suite (1504 passing) green in the recorded
run at the tested commit.
