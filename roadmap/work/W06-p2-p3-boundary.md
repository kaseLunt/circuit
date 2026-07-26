---
id: W06
type: work
title: P2→P3 boundary — public narrative, phase transition, P3 charter
phase: P2
status: achieved
evidence_target: readme-license-landed-and-p3-charter-ratified
priority: 0
depends_on: [W05]
blocked_by: []
informs: [H0]
allowed_paths:
  - README.md
  - LICENSE
  - docs/**
  - roadmap/work/W06-p2-p3-boundary.md
  - roadmap/work/W07-p3-execution.md
deliverables:
  - README.md
  - LICENSE
evidence_receipts:
  - roadmap/evidence/E-W06-p2-p3-boundary.md
invalidated_by:
  - SPEC.md
  - roadmap/decisions/**
review_when: event:invalidated-by-change
updated: 2026-07-26
evidence_fingerprint: sha256:77586685fb11512699913b10f80bff6b92e5b5a7160b67273c845e9807d94fb2
---

# W06 — P2→P3 boundary

**Why this advances the vision:** the repo went public at the W05 close with no narrative.
A public repo without its README hands the framing to whoever finds it first. The boundary
also owes the ledger its standing P3-entry items and the next phase its charter.

## Objective

1. Land `README.md` (humanized, owner-approved draft) and `LICENSE` (MIT) at the root.
2. Flip the P2 phase row to Done and open P3 in the ladder.
3. Draft `W07-p3-execution.md` from the sentinel's execution treatment
   (`p3-execution-treatment.md`: eight surfaces, the 19-seam attack table, resumePlan and
   riskLedger-seeding pre-findings, the attribution-module-identity directive).
4. Disposition the P3-entry ledger items: R-3a74989b (fork 429 posture — partly retired by
   the public flip, since public repos get unlimited Actions minutes), the
   `pull_request_target` fork-PR hardening review the public flip opened, and the standing
   persona policy (circuit-sentinel consults before any execution surface).

## Acceptance

- README and LICENSE on `main`, README passing the humanizer sweep and the owner's style
  rules (no em/en dashes, no negative parallelism, no banned vocabulary).
- Ladder shows P2 Done and P3 In progress; STATUS points at the active boundary task until
  W07 activates.
- W07 exists with concrete allowed_paths and deliverables, informed by the treatment.
- Boundary receipt recorded with the usual stamp discipline.

## Canonical commands

```text
python roadmap/tools/doctor.py --snapshot index
python -c "..."             # the humanizer/style ban sweep over README.md (recorded in receipt)
gh pr checks <n>            # the four required checks still gate every landing
```

## Non-goals

- No product code. The boundary writes prose and governance objects only.
- No GIF capture gate: the README ships with the image commented out behind a TODO;
  capturing it is W07-adjacent polish, welcome any time.

## Handoff

- next: land README + LICENSE (PR, owner token — STATUS/ladder/claim ride along), then the
  phase flip and W07 draft as the second boundary PR.
- read_first: `C:\Users\kasel\AppData\Local\Temp\w05\p3-execution-treatment.md` (the W07
  source material); R-3a74989b; the persona policy note in `.remember/remember.md`.
- hazards: README.md and LICENSE are root files new to version control — they are in this
  object's allowed_paths and nowhere else; any future edit needs an active claim covering
  them. All public-facing prose passes the humanizer skill before landing (installed
  globally at `~/.claude/skills/humanizer`).
