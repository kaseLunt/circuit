---
id: E-W07-P3-EXECUTION-R2
type: evidence
title: W07 drift review at the W08 head — the sandbox arc intact under the successor
status: recorded
work: W07
result: pass
observed_at: 2026-07-30T14:15:00Z
tested_commit: 427bf703e9af0ee6bf05e30d9113cb035d7ad88d
environment: github-actions-ubuntu-latest-node-22 (CI run 30525638520 at the W08 remediation head; all four jobs green)
input_fingerprint: sha256:5a9631c6a2a4028a58bd7818291cc4fceea0d8bab6c934c8eaec9382e7eee975
contract_fingerprint: sha256:3830a95987c34a503425e78a0c28d84c8d563787d24dbc70faa69452eb3dd3fa
commands:
  - "gh run view 30525638520   # ci (coverage-enforcing), e2e, fork (28 tests), e2e-fork all green"
  - "npm run test:coverage     # 1440 unit tests; per-glob 100% enforced on src/lib/execution/*.ts"
  - "npm run test:fork         # flagship + session-isolation + execution-drills, green at this head"
  - "npm run test:e2e:fork     # the sandbox execution arc in the browser against the pinned fork"
updated: 2026-07-30
---

# E-W07-R2 — drift review at the W08 head

Supersedes `E-W07-p3-execution.md`, which stands as the historical record. This receipt
services the same-phase drift the W08 successor produced across W07 evidenced inputs.

**Nature of the drift: accretion by charter, not contradiction.** W08 is the split phase
successor whose stated work is to evolve the execution surface W07 evidenced: the driver
gained the session-lifecycle hardening of the fourteen-round D-011 chain (identity-bound
standings, generation-bound arms, the exhaustive session-refusal classifier, overwrite-on-arm
pointer discipline, tombstone finality with admission revalidation), the wallet boundary landed
beside the machine, and the tolerance module gained the live constants. No W07 claim is
weakened: the sandbox execution arc — arm, review, execute, attribute, receipt — still passes
in the browser against the hash-verified pinned fork, proven by the `e2e-fork` job of the CI
run recorded above at exactly this tested commit; the execution money path still holds its
structurally enforced 100 percent; the 28-test fork gate is green on the grown tree. The
attained target `sandbox-execution-arc-green-on-fork-in-ci` remains attained, re-verified at
the tested commit with the same canonical commands the original receipt recorded.
