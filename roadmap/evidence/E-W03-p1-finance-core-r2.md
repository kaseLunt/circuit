---
id: E-W03-P1-FINANCE-CORE-R2
type: evidence
title: W03 re-recorded at the achieve-transition tip
status: recorded
work: W03
result: pass
observed_at: 2026-07-25T06:11:00Z
tested_commit: 5cb5ee46caac4680a0cf5e49c99ed3da37748b60
environment: github-actions-ubuntu-latest-node-22 + anvil-v1.7.1 (foundry-toolchain) + codex-review-sessions-019f9690/019f9754/019f9799
input_fingerprint: sha256:b0affcbf6eef734bac7a4badce2832306c2680e5dd7b69c82d6dd3c2922dd542
contract_fingerprint: sha256:34a2db1a80bf3f6fa7b39aeca6f17fd8efba82c39a2395e6ca507bfa7411f71a
commands:
  - "npm run build && npm run typecheck && npm run lint && npm run check:scripts && npm test"
  - "FORK_RPC_URL=<archive-secret> npm run test:fork"
  - "RPC_URL=<archive> node scripts/protocol-reads.mjs --verify-roots"
  - "python roadmap/tools/doctor.py"
  - "python roadmap/tools/scope_diff.py 4594e444cb26643cf338c3dedc529f87abefd6ec 4106ba9dd501e02777f05dc2b39c55321f3b6e74 --pull-request-number 1 --policy-approval <locally generated: proves mechanical replay only, never authorization>"
updated: 2026-07-25
---

# E-W03-R2 — same evidence, re-recorded at the correct tested commit

Supersedes `roadmap/evidence/E-W03-p1-finance-core.md`, which remains untouched as the historical
record per RULES §15. **The evidence itself is unchanged and is not restated here — read the
original for the full account.** This receipt exists to correct two recording errors in it.

**1. Stale `tested_commit`.** The original recorded `645650269bcec382a983c58da0d7a79a96d49fe0`,
the commit *before* the achieve transition, so `doctor` correctly reported
`current inputs/deliverables differ from the tested commit`. Both fingerprints were in fact
identical at either commit (`b0affcbf…` / `34a2db1a…` — the achieve transition touched only
`roadmap/` files, none of them a W03 input or deliverable), so only the pointer was wrong. It now
names `5cb5ee46caac4680a0cf5e49c99ed3da37748b60`, the commit whose state was measured. The
original could not simply be edited: a committed `recorded` evidence object is append-only and the
gate refused it — `immutable lifecycle record may only transition to superseded`.

**2. Misrecorded replay command.** The original's `commands` list cited the wrong head for the
`scope_diff.py` replay and omitted the flags actually used. It now names the range Codex actually
replayed (`4594e444..4106ba9d`) and marks the approval token as locally generated, so the command
cannot be misread as evidence of owner authorization — the precise confusion recorded in
`R-a4314d72`.

## Carried forward unchanged

- Evidence target `thirteen-step-plan-green-on-pinned-fork-in-ci` is **attained**: CI run
  `30143028744` at `4106ba9d`, job `ci` green (`Tests 152 passed`) and job `fork` green
  (`Tests 9 passed`, zero skipped, anvil v1.7.1) against pinned block `25,592,678` — both
  retrieved and confirmed by Codex via authenticated `gh`.
- Codex accepted every technical finding and all seven divergences; its `APPROVAL WITHHELD` rested
  solely on the absence of server-side attestation for nine owner-gated transitions.
- **D-009** records the owner override for that attestation gap alone, bound to
  `4594e444..4106ba9d`, and is not precedent.
- Enforcement posture is at most `ci-unprotected` per RULES §22. No trusted `pull_request_target`
  audit exists for this head. This receipt does **not** claim a trusted history replay passed; the
  replay evidence stands in Codex's required wording, quoted in the original.
