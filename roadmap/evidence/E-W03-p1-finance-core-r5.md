---
id: E-W03-P1-FINANCE-CORE-R5
type: evidence
title: W03 drift review at the W08 close — the core gained the borrow-limit verdict
status: recorded
work: W03
result: pass
observed_at: 2026-07-30T16:25:00Z
tested_commit: 427bf703e9af0ee6bf05e30d9113cb035d7ad88d
environment: github-actions-ubuntu-latest-node-22 (CI run 30525638520)
input_fingerprint: sha256:1ebcf29cb9fa4dc292e26cebdd42fa805756195f47510f82b8fe043814c54ec1
contract_fingerprint: sha256:90f0e774e16eb35023384b0d4b305d8fdbee7553321f329dc5ee3a1ea3431380
commands:
  - "gh run view 30525638520   # fork job: the flagship 13-step suite still green; ci: core suites in the 1440"
updated: 2026-07-30
---

# E-W03-R5 — drift review (event:invalidated-by-change), W08 close

Supersedes `E-W03-p1-finance-core-r4.md`, which stands as the historical record. Services the
REVIEW-DUE drift the W08 range produced across W03 invalidation inputs.

**Nature of the drift: the core grew a consumer-facing verdict, its claims stand.** W08 added
`core/borrow-limit.ts` beside the proven rate and risk math — modelling the pool's own
ceil-chained debt valuation with the fork-proven ray primitives, and `rates.ts` gained the
byte-exact `mulDivCeil` port with its own tests. The W03 attainments are unweakened: the rate
model, graph, and plan core still pass their suites inside the recorded run's 1440, and the
flagship fork suite — the 13-step accrual-exact proof — is green in the same run's fork job at
the tested commit. `SupplyLeg` gained `ltvBps` with its own citation builder; no existing
figure changed its derivation.
