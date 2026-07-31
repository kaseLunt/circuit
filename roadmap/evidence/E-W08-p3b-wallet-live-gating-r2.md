---
id: E-W08-P3B-WALLET-LIVE-GATING-R2
type: evidence
title: W08 drift review at the W09 close - the wallet boundary intact beside the carry
status: recorded
work: W08
result: pass
observed_at: 2026-07-31T17:17:00Z
tested_commit: e8278ca48a017b65a7abf5cc2ebdda6fc25b2dce
environment: github-actions-ubuntu-latest-node-22 (CI run 30649345241; ci, e2e, fork, e2e-fork all green) + local-windows-node-22
commands:
  - "gh run view 30649345241   # e2e job: the SPEC 3.4 and 3.7 beats green among the 24; ci: gate.ts at 100"
updated: 2026-07-31
input_fingerprint: sha256:3b038cbff0d67381c016176cc287efcff49241a76af268caf243c91afe8eb96e
contract_fingerprint: sha256:ad6333c7774385335013a4ae64c171f6e2d457c49e3bb152d9720923360a4f2a
---

# E-W08-P3B-WALLET-LIVE-GATING-R2 - drift review (event:invalidated-by-change), W09 close

Supersedes `E-W08-p3b-wallet-live-gating.md`, which stands as the historical record. Services the drift the W09 range
(PRs #33-#35) produced across this item's invalidation inputs.

**Nature of the drift: accretion in W08 invalidation inputs.** W09 bounded
fork-session RPC transport (the one bounded helper exported to the fork infra) and the
carry landed beside the wallet surfaces without touching their guarantees. No W08 claim is
weakened: the SPEC section 3 step 4 and step 7 beats run green in the recorded run at the
tested commit, the wallet gate holds 100/100/100 structurally, and the quarantine lattice
is unchanged at 65 routes.
