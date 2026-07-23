---
id: D-002
type: decision
title: Project commit and attribution policy
status: accepted
date: 2026-07-22
approved_by: Kase Lunt (owner)
supersedes: []
updated: 2026-07-22
---

# D-002 — Project commit and attribution policy

## Context

Commit formatting, authorship, attribution, signing, and automation policy belong to the project
owner. Recorded here after inspection of the repository's actual practice; accepted by the owner
on 2026-07-23.

## Policy

- **Format:** conventional, narrative commits — `type: subject` with a body explaining why, not a
  restatement of the diff. Types in use: `init`, `docs`, `governance`, `chore`, `port`, `feat`,
  `fix`, `test`, `ci`.
- **Ports:** one module per commit; the message records provenance (source path in the earlier
  prototype) and confirms the TRANSPLANT.md edits were applied in the same commit.
- **Attribution:** author and committer are the owner's personal identity
  (`kaselunt.dev@gmail.com`, pinned repo-locally). No AI attribution trailers of any kind
  (no Co-Authored-By, no Generated-with).
- **Signing:** not required.
- **Enforcement reality:** the local pre-commit gate (doctor + scope-gate) and the in-repo GitHub
  workflow are feedback, not server-enforced authority; no branch protection or required checks
  are configured yet. This record must be updated if that changes.
- **Audited override paths:** `CONTROL_PLANE_ADOPT=1` (isolated adoption when no committed
  authority exists) and `CONTROL_PLANE_OWNER_REVIEWED=1` (owner acknowledgement of governance
  transitions). Both are local acknowledgements, logged by the gate output; neither is
  authenticated server authority. Hook bypass flags (`--no-verify`) are prohibited.
