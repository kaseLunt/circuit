---
id: E-W03-P1-FINANCE-CORE-R4
type: evidence
title: W03 drift review at the W07 close — core untouched, its consumers grew
status: recorded
work: W03
result: pass
observed_at: 2026-07-29T16:20:00Z
tested_commit: 815ebf21f82885e8c04058afea23484ed378bdb3
environment: github-actions-ubuntu-latest-node-22 (CI run 30469027736 at the remediation head)
input_fingerprint: sha256:6bc7a750fcd94d6068f0cbbc97197d050d0747ed7d0990a9b24b6a2d30befdd6
contract_fingerprint: sha256:90f0e774e16eb35023384b0d4b305d8fdbee7553321f329dc5ee3a1ea3431380
commands:
  - "gh run view 30469027736   # fork job: flagship 13-step suite still green among 28 tests"
updated: 2026-07-29
---

# E-W03-R4 — drift review (event:invalidated-by-change), W07 close

Supersedes `E-W03-p1-finance-core-r3.md`, which stands as the historical record.

The drift: the fork suite W03 attested was joined by session-isolation and execution-drills,
and its embedded attribution logic was extracted to `src/lib/execution/attribution.ts`
(W07's identity-preserving extraction — 87 assertion lines byte-identical). The 13-step
flagship still passes on the same pinned block with the same exact-agreement assertions;
core/ itself saw no W07 commits. The boundary lint (core cannot import execution or server)
is probe-enforced at 38 routes.
