# ROADMAP — here → there

> Phase intent is asserted. The work table is an exact projection of files under `work/`: every row
> has one object, and ID, title, phase, evidence target, dependencies, and status must match its
> frontmatter exactly. Generate the table or validate it mechanically; never update a copy by feel.

## Phases

Phases mirror SPEC.md §11; the SPEC's gate column is the review gate for each boundary.

| ID | Phase | Goal | State |
| --- | --- | --- | --- |
| P0 | Bootstrap + spikes | Scaffold + CI green; sandbox provider proven executable; protocol matrix, name, display face pinned | Done |
| P1 | Finance core on a fork | core/ + server/chain complete; 13-step flagship plan executes green on pinned anvil fork in CI | Done |
| P2 | Canvas on proven core | Composer transplanted + reskinned on P1's model; §3 steps 1–3, 8 pass | Done |
| P3 | Execution | Sandbox execution (provider, session registry, §6 security contract) + full tx UX family, both recovery machines, a11y, live gating; §3 steps 4–7 pass. SPEC splits this internally into P3a/P3b | **In progress** |
| P4 | Launch polish | Landing, OG/meta, README GIF, scheduled prod smoke; full §3 green on production | Planned — **MVP line** |
| P5 | Enhancements | Swap+aggregator, position import, SSE/Pyth, light theme, Base | Parked |

Crossing a phase or MVP boundary requires the configured review gate and current evidence. Do not
claim the gate is automated unless a validator actually enforces it.

## Work ladder — exact projection

| ID | Work item | Phase | Depends on | Evidence target | Status |
| --- | --- | --- | --- | --- | --- |
| W01 | P0 bootstrap — scaffold, CI, spikes, and pinned decisions | P0 | — | ci-green-scaffold-plus-executable-sandbox-proof | achieved |
| W02 | Land founding product docs — spec and transplant manifest | P0 | — | docs-landed-and-compliant-with-vision-antigoals | achieved |
| W03 | P1 finance core — 13-step plan green on a pinned fork, headless | P1 | W04 | thirteen-step-plan-green-on-pinned-fork-in-ci | achieved |
| W04 | Disposition the P0→P1 boundary review findings | P0 | — | boundary-review-blockers-cleared-and-reconfirmed | achieved |
| W05 | P2 canvas on the proven core — composer transplanted, reskinned, share-URL round-trip | P2 | W03 | spec-3-steps-1-3-and-8-green-in-playwright-on-mock-reads | achieved |
| W06 | P2→P3 boundary — public narrative, phase transition, P3 charter | P2 | W05 | readme-license-landed-and-p3-charter-ratified | achieved |
| W07 | P3 execution — sandbox session service, the tx UX family, live gating | P3 | W05, W06 | spec-3-steps-4-7-green-in-playwright-against-sandbox-fork | active |

The rows above project `work/W01-p0-bootstrap.md`, `work/W02-founding-docs.md`, and
`work/W03-p1-finance-core.md`, `work/W04-boundary-review-remediation.md`, and
`work/W05-p2-canvas-on-proven-core.md`. Work objects are created when their phase approaches, not
speculatively — one committing work item at a time (serial writer).

## Evidence model

Each work item defines its own falsifiable acceptance checks, canonical commands, deliverables, and
`invalidated_by` inputs. `STATUS.md` points to current integration work; it does not establish
attainment.

## Design dependencies

- `SPEC.md` v2.2 — product, architecture, finance rules, quality bar, phases (survived three
  adversarial review passes before implementation began).
- `TRANSPLANT.md` — vetted parts manifest and porting order from the earlier private prototype;
  the §10 porting protocol is binding on every port commit.
- P0's protocol matrix (docs/decisions.md, once recorded) — the pinned constraint set that P1's
  validation implements.
