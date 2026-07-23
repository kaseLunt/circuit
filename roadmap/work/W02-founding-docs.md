---
id: W02
type: work
title: Land founding product docs — spec and transplant manifest
phase: P0
status: candidate
evidence_target: docs-landed-and-compliant-with-vision-antigoals
priority: 0
depends_on: []
blocked_by: []
informs: [H0]
allowed_paths:
  - SPEC.md
  - TRANSPLANT.md
  - roadmap/work/W02-founding-docs.md
deliverables:
  - SPEC.md
  - TRANSPLANT.md
evidence_receipts: []
invalidated_by:
  - SPEC.md
  - TRANSPLANT.md
review_when: phase:P0:exit
updated: 2026-07-22
---

# W02 — Land founding product docs

**Why this advances the vision:** every later work item derives its contract from the product
spec and the porting manifest; they must land through governance so their content is bound to the
VISION anti-goals from the first commit. Disproof: any anti-goal violation (author-narrative
framing, fabricated claims) present in the landed docs.

## Objective

Commit SPEC.md (v2.2 — hardened by three adversarial review passes) and TRANSPLANT.md (the
vetted parts manifest for the earlier private prototype) as the founding product documents.

## Acceptance

- Both files present and committed under this item's authority.
- Content complies with the VISION anti-goals ("no self-referential meta-docs", "no fabricated
  numbers") — owner-directed review, recorded in the evidence receipt.
- `python roadmap/tools/doctor.py` green at the landing commit.

## Non-goals

- No spec content changes — landing only.
- No edits outside the two deliverables.

## Canonical commands

```text
python roadmap/tools/doctor.py
```

## Evidence

No attained evidence yet; record acceptance results against the landing commit in a receipt,
then stamp per RULES.md.

## Handoff

- next: after closure, W01 (P0 bootstrap) is the staged candidate; owner ratification of
  VISION/H0/D-001/D-002 remains open.
- read_first: roadmap/VISION.md anti-goals; SPEC.md §1.
- hazards: future SPEC/TRANSPLANT edits can drift from the anti-goals — recheck compliance at
  every phase exit.
