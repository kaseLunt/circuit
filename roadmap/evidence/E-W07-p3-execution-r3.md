---
id: E-W07-P3-EXECUTION-R3
type: evidence
title: W07 drift review at the W09 close - the sandbox arc green on the shared upstream
status: recorded
work: W07
result: pass
observed_at: 2026-07-31T17:17:00Z
tested_commit: e8278ca48a017b65a7abf5cc2ebdda6fc25b2dce
environment: github-actions-ubuntu-latest-node-22 (CI run 30649345241; ci, e2e, fork, e2e-fork all green) + local-windows-node-22
commands:
  - "gh run view 30649345241   # ci (1504 tests, execution glob at 100), fork (33 tests), e2e-fork all green"
updated: 2026-07-31
input_fingerprint: sha256:452c991be4d85a7ccfd1d51074872995a275ebf800bec63aaaff84d1cbc60ef0
contract_fingerprint: sha256:3830a95987c34a503425e78a0c28d84c8d563787d24dbc70faa69452eb3dd3fa
---

# E-W07-P3-EXECUTION-R3 - drift review (event:invalidated-by-change), W09 close

Supersedes `E-W07-p3-execution-r2.md`, which stands as the historical record. Services the drift the W09 range
(PRs #33-#35) produced across this item's invalidation inputs.

**Nature of the drift: accretion by the successors.** W09 grew the fork gate to 33
tests across four files, consolidated the session suites onto one shared pristine upstream
(the R-3a74989b remediation - head-and-hash pinned at boot and teardown, per-suite
brackets), and bounded every fork probe. No W07 claim is weakened: the sandbox execution
arc - arm, review, execute, attribute, receipt - passes in the browser against the
hash-verified pinned fork in the recorded run at exactly this tested commit, and the
execution money path still holds its structurally enforced 100 percent.
