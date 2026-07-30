---
id: E-W04-BOUNDARY-REMEDIATION-R5
type: evidence
title: W04 drift review at the W08 close — dispositions stand, the lattice grew
status: recorded
work: W04
result: pass
observed_at: 2026-07-30T16:25:00Z
tested_commit: 427bf703e9af0ee6bf05e30d9113cb035d7ad88d
environment: github-actions-ubuntu-latest-node-22 (CI run 30525638520)
input_fingerprint: sha256:caf5a008f84a5002a89eef421e292d9021b27d58da0cef9859a321d0ae426523
contract_fingerprint: sha256:9b251f3c9bfafa26c51b4fc7fb53a81eab1fa6a594a9fab2420c245b56dde1a4
commands:
  - "gh run view 30525638520   # full ladder green on the candidate at the tested commit"
  - "npm run check:lint-boundaries   # 65 prohibited routes, each refused exactly once"
updated: 2026-07-30
---

# E-W04-R5 — drift review (event:invalidated-by-change), W08 close

Supersedes `E-W04-boundary-remediation-r4.md`, which stands as the historical record. Services
the REVIEW-DUE drift the W08 range produced across W04 invalidation inputs.

**Nature of the drift: the boundary discipline W04 established was extended, not eroded.** The
quarantine W04 remediated into the lint layer grew the wallet lattice this phase — wagmi
confined to the boundary directories, the wallet module banned from provenance, server
modules, own clients, and core money values (type-only excepted), every route with a
one-to-one probe: 27 new routes since the last review, 65 total, each still refused exactly
once by the central exact-multiset gate. The W04 dispositions stand unchanged; the recorded
run is green at the tested commit.
