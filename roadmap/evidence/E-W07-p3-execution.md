---
id: E-W07-P3-EXECUTION
type: evidence
title: W07 — the sandbox execution arc, fork-proven and CI-green end to end
status: recorded
work: W07
result: pass
observed_at: 2026-07-29T16:20:00Z
tested_commit: 815ebf21f82885e8c04058afea23484ed378bdb3
environment: github-actions-ubuntu-latest-node-22 (CI run 30469027736 at the remediation head; all five jobs green)
input_fingerprint: sha256:e51f403e998da6f833621a89a86e3736ae02c9a96d709a530d7d480cf1a13cdb
contract_fingerprint: sha256:3830a95987c34a503425e78a0c28d84c8d563787d24dbc70faa69452eb3dd3fa
commands:
  - "gh run view 30469027736   # ci (coverage-enforcing), e2e, fork (28 tests), e2e-fork all green"
  - "npm run test:coverage     # 1267 unit tests; per-glob 100% enforced on src/lib/execution/*.ts"
  - "npm run test:fork         # flagship 14 + session-isolation 10 + execution-drills 4"
  - "npm run test:e2e:fork     # the sandbox execution arc in the browser against the pinned fork"
updated: 2026-07-29
---

# E-W07 — the evidence

## The target, attained as amended

`sandbox-execution-arc-green-on-fork-in-ci` (amended 2026-07-28, owner-ratified): from the composed flagship, the browser arms a session on a hash-verified
pinned fork, reviews every planned call, executes all 13 steps through the session service,
attributes every producer output within named tolerances with provenance citations, and closes
on the still receipt — proven by the `e2e-fork` CI job at the tested commit.

## The chain behind it

Four surfaces, each merged only after an explicit Codex APPROVAL under D-007/D-011:

- attribution module — thread 019fa1a5 (rounds 019fa0cf, 019fa15f, 019fa187)
- sandbox session service — 019fa4b7 (019fa248, 019fa47c, 019fa492, 019fa4a3, 019fa4ae) plus
  the narrow topology fix 019fa4e2
- execution state machine / record / resume — 019fa63d (019fa5f5, 019fa61c)
- tx family + driver + HTTP mount — 019fab73 (019fa6ce advisory, 019fa730, 019fa749,
  019fa75e) plus the e2e-found fixes 019fabb3

Phase-exit review chain, seven rounds to approval: 019fabfb (4) → 019facad (4) → 019facdb (2)
→ 019facec (1) → 019facfc (1) → 019fad1a (1) → **PHASE-EXIT APPROVAL 019fad28** (empty
blocking list; tree-hash-proven no content drift from the reviewed state). Every finding
remediated on main: the owner-ratified P3a/P3b rescope through SPEC §11, charter, and ladder;
the fork execution drills; disclosure surfaces column-wide; the structurally-enforced coverage
claim (object-identity guard, proven negative cases).

Taste desk: AT THE BAR verdict on the rendered column (record at the session's Temp
`taste-verdict-tx-column.md`, captures alongside); its refinements landed in PRs #25/#26.

## What the fork gate now proves

28 tests: the 13-step flagship with rebase and approval-staleness drills (14), two-session
isolation with identity refusal and wire idempotency (10), and the execution drills (4) —
mid-plan revert with the executed prefix intact and zero suffix dispatch, tolerance-breaching
divergence halting with both truths kept, both recovery cells reconciling from fork history
without re-sending, and wire rehydration continuing a dropped client to 13/13.
