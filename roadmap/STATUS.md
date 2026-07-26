---
active_phase: P2
active_task: W06
project_state: active
writer_mode: serial
parallel_readers: allowed
enforcement: bootstrap
enforcement_evidence: []
updated: 2026-07-26
---

# STATUS — integration pointer

> Update asserted state only on transitions. Derive work status and evidence from typed objects and
> artifacts rather than duplicating them here.

The frontmatter fields above are the machine-validated integration pointer and enforcement posture.
`project_state: active` requires exactly one In progress phase. `project_state: complete` permits a
zero-In-progress terminal roadmap, requires `active_task: W06`, and forbids active work or claims;
`active_phase` may remain as the last-phase pointer.
`enforcement_evidence` is empty only at bootstrap; later postures point to typed, current
observations under `roadmap/evidence/`. Even `merge-gated-attested` is an evidence claim, not a
self-certified guarantee.
Do not repeat their current values in prose: duplicated phase, task, health, or writer-mode text can
drift without changing authority.

## Current integration task

Read `active_task` above. When it is `none`, the staged candidate is `W01` (P0 bootstrap); it
activates only through the owner transition below.

## Blockers

- Owner ratification pending: `VISION.md`, `H0`, `D-001`, `D-002` are draft/proposed.
- The name decision (SPEC §12.1) blocks P0 *completion*, not P0 start.
- Remote enforcement is unverified: the GitHub workflow exists in-repo but no branch protection or
  required check is configured; the local pre-commit hook is cooperative only.
- Product verification commands do not exist until the W01 scaffold lands; `doctor.py` is the only
  runnable check and it validates governance structure, not the product.

## Next owner transition

Ratify `VISION.md` + `H0` and accept or amend `D-001`/`D-002`, then — in one coherent transition —
set `active_task: W01` here and `status: active` in `roadmap/work/W01-p0-bootstrap.md`
("start P0").
