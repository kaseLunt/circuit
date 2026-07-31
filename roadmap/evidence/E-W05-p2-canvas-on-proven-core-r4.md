---
id: E-W05-P2-CANVAS-ON-PROVEN-CORE-R4
type: evidence
title: W05 drift review at the W09 close - the canvas states regimes and pairs
status: recorded
work: W05
result: pass
observed_at: 2026-07-31T17:17:00Z
tested_commit: e8278ca48a017b65a7abf5cc2ebdda6fc25b2dce
environment: github-actions-ubuntu-latest-node-22 (CI run 30649345241; ci, e2e, fork, e2e-fork all green) + local-windows-node-22
commands:
  - "gh run view 30649345241   # e2e job: steps 1-3 and 8 still green, keyless, at the tested commit"
updated: 2026-07-31
input_fingerprint: sha256:d3da138e690dd24d9aeca85cad76b35d17534f22acfd0874704df83f539bf18f
contract_fingerprint: sha256:5a55bb9205bbfce8079c332710504b7b0b23213952bcb73e2548d51e6a6fd992
---

# E-W05-P2-CANVAS-ON-PROVEN-CORE-R4 - drift review (event:invalidated-by-change), W09 close

Supersedes `E-W05-p2-canvas-on-proven-core-r3.md`, which stands as the historical record. Services the drift the W09 range
(PRs #33-#35) produced across this item's invalidation inputs.

**Nature of the drift: accretion in the canvas W05 built.** W09 taught the borrow
block to state its governing regime on every verdict, name its own liquidation pair, and
carry the debt-direction note for the uncorrelated carry. The W05 attainments are
unweakened: the demo script steps 1 through 3 and 8 remain green and keyless in the
recorded run at the tested commit, and the canvas and composer suites pass inside the same
run.
