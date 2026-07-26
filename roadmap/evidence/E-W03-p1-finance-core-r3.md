---
id: E-W03-P1-FINANCE-CORE-R3
type: evidence
title: W03 drift review at the W05 close — fork gate still green on the extended core
status: recorded
work: W03
result: pass
observed_at: 2026-07-26T20:36:30Z
tested_commit: b9a825a437da8322da56de0f27ae44f491cf7ed9
environment: github-actions-ubuntu-latest-node-22 + anvil-v1.7.1 (foundry-toolchain) + codex-review-sessions (risk 019f9d2d, shell 019f9dc4, window 019fa00c)
input_fingerprint: sha256:1572665537788a3a135d1fec1f0217bb33f296e5d4f82034852b870325c60f56
contract_fingerprint: sha256:34a2db1a80bf3f6fa7b39aeca6f17fd8efba82c39a2395e6ca507bfa7411f71a
commands:
  - "FORK_RPC_URL=<archive-secret> npm run test:fork   # CI job `fork`, required check, green on PR #13 head 89406d17 and the W05 range"
  - "npm test   # 721 passing at the tested commit"
updated: 2026-07-26
---

# E-W03-R3 — drift review (event:invalidated-by-change), W05 close

Supersedes `E-W03-p1-finance-core-r2.md`, which stands as the historical record (contract
fingerprint unchanged from r2 — only inputs drifted).

**Nature of the drift: the W05 range changed core.** `plan.ts` gained the flows recording,
the oracle-price-unavailable refusal, exact-wrapper inflow specs and wrapParam origins;
`provenance.ts` gained ParamOrigins, `derivedOverWindow` and structured trail entries;
`format.ts` gained display formatters and the sub-precision bound; `risk.ts` was added on
top of the W03 modules. Every one of these changes carried its own D-007 approval (the
session chain culminating in 019f9d2d, 019f9dc4, 019fa00c).

**The W03 claim itself — the 13-step flagship plan proven against the pinned fork with
byte-exact reproductions — still holds, strengthened.** The same fork suite runs as a
required CI check on every PR; the W05 range EXTENDED it (clean-fork checkpoint-by-checkpoint
HF cross-check against getUserAccountData; matched-timestamp exact WETH rate assertion with a
stale-model negative control) and never weakened an assertion. Green on the PR #13 head
(89406d17, run 30218898457) immediately before the tested commit merged; the byte-exact
baseline reproduction of both reserves' recorded rates remains asserted in the suite.
