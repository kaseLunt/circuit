---
id: E-W03-P1-FINANCE-CORE-R6
type: evidence
title: W03 drift review at the W09 close - the core generalized to six decimals
status: recorded
work: W03
result: pass
observed_at: 2026-07-31T17:17:00Z
tested_commit: e8278ca48a017b65a7abf5cc2ebdda6fc25b2dce
environment: github-actions-ubuntu-latest-node-22 (CI run 30649345241; ci, e2e, fork, e2e-fork all green) + local-windows-node-22
commands:
  - "gh run view 30649345241   # fork job: the flagship 13-step suite green among 33 tests; ci: core suites in the 1504"
updated: 2026-07-31
input_fingerprint: sha256:e652025189a04ba4782dba368d697cd2596cad365b9b2f16ba7e23c64e92d9b7
contract_fingerprint: sha256:90f0e774e16eb35023384b0d4b305d8fdbee7553321f329dc5ee3a1ea3431380
---

# E-W03-P1-FINANCE-CORE-R6 - drift review (event:invalidated-by-change), W09 close

Supersedes `E-W03-p1-finance-core-r5.md`, which stands as the historical record. Services the drift the W09 range
(PRs #33-#35) produced across this item's invalidation inputs.

**Nature of the drift: the core grew, its claims stand.** W09 enrolled USDC and
generalized the valuation to arbitrary asset units (valueInBase with assetUnit, the
floor and ceil base conversions from one home, liquidationRatioWad unit-normalized) and the
composition model became realized-value-exact over both equity and borrowed sinks. The W03
attainments are unweakened: the flagship fork suite - the 13-step accrual-exact proof - is
green in the recorded run at the tested commit, and every landed rate, graph, and plan pin
either held byte-identical or moved by measured wei-dust with its cause stated in the
fixtures (the debt ceil; the realized-magnitude normalization).
