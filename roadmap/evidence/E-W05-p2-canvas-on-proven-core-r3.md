---
id: E-W05-P2-CANVAS-ON-PROVEN-CORE-R3
type: evidence
title: W05 drift review at the W08 close — the canvas learned to refuse while money moves
status: recorded
work: W05
result: pass
observed_at: 2026-07-30T16:25:00Z
tested_commit: 427bf703e9af0ee6bf05e30d9113cb035d7ad88d
environment: github-actions-ubuntu-latest-node-22 (CI run 30525638520)
input_fingerprint: sha256:6fbf14687b23b716fbe111a1365e6459689a00f6de4c5719fb21175a0739b90e
contract_fingerprint: sha256:5a55bb9205bbfce8079c332710504b7b0b23213952bcb73e2548d51e6a6fd992
commands:
  - "gh run view 30525638520   # e2e job: steps 1-3 and 8 still green, keyless, at the tested commit"
updated: 2026-07-30
---

# E-W05-R3 — drift review (event:invalidated-by-change), W08 close

Supersedes `E-W05-p2-canvas-on-proven-core-r2.md`, which stands as the historical record.
Services the REVIEW-DUE drift the W08 range produced across W05 invalidation inputs.

**Nature of the drift: accretion in the canvas W05 built.** W08 taught the composer the T26
write lockdown — the lock a property of the store (a compile-forced partition of document
writes), stated through aria-disabled refusals with reads and selection fully live — and the
step-4 inline borrow refusal quoting the active regime. The W05 attainments are unweakened:
the canvas, blocks, edges, and simulation column render and behave as attested; the demo
script steps 1 through 3 and 8 remain green and keyless in the recorded run's e2e job at the
tested commit, and the canvas and composer suites pass inside the same run's 1440.
