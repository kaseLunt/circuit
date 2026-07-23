# Project Control Plane

This directory is the durable governance layer for the project: intent, accepted decisions,
scoped work contracts, evidence, and the current integration pointer. It exists so project state
survives sessions without turning hand-maintained prose into unverified truth.

## Authority split

- The repository owns durable project intent and accepted evidence.
- An external scheduler may assign agents and coordinate execution. In concurrent-writer mode its
  atomic registry owns live claims and leases; committed claim documents are only an audit view.
- Chat and agent memory are never durable authority.

## Cockpit files

| File | Purpose | Update policy |
| --- | --- | --- |
| `VISION.md` | Ratified outcome, boundaries, and project-specific evidence philosophy | Owner review |
| `ROADMAP.md` | Phase plan plus an exact projection of typed work objects | Phase/work transitions |
| `STATUS.md` | Active phase/task, writer mode, enforcement posture and evidence pointers | Transitions only |
| `RULES.md` | Scope, evidence, capture, handoff, and writer rules | Accepted decision |
| `SYSTEM.md` | Control-plane constitution and authority model | Accepted decision |
| `IDEAS.md` | Typed capture and promotion policy | Rarely |

## Typed objects

`horizons/` goals · `work/` work contracts · `ideas/` · `insights/` · `decisions/` · `risks/` ·
`evidence/` · `views/` generated projections · `archive/` superseded reference material.

## Writer mode

The scaffold starts in `writer_mode: serial`: one repository writer/integrator may modify, commit,
or merge files. Parallel readers and reviewers are allowed, but they return findings or patches to
the integrator. Concurrent writers require separate allocator, worktree, merge, and recovery
machinery; changing the field alone does not activate that capability.

The bundled GitHub workflow deliberately labels `pull_request` checks advisory because they run
candidate code. Its `pull_request_target` audit runs policy from `CONTROL_PLANE_TRUST_REF` or the
default branch, imports the PR head/simulated merge only as Git objects, and binds owner approval to
the exact PR/base/head tuple. Configure it as a hosting ruleset required-workflow (or use a
dedicated trusted App) before claiming merge enforcement. The template does not handle
`merge_group`, so merge queues remain unsupported without an external trusted integration.

## Snapshot and evidence rule

A commit gate must judge one coherent staged snapshot. Evidence is valid only for its recorded
commit/input fingerprint and verification context. Working-tree prose, a passing command from an
older commit, or an agent's assertion cannot upgrade evidence.

Achieved work names exact receipts under `evidence/`. A receipt records its work ID, passing
result, strict-UTC observation time, tested ancestor commit, environment, and commands. The
fingerprint detects later work-contract, policy, input, mode, deliverable, or receipt changes; it
does not prove that a human-authored receipt is honest.

Use `doctor.py --receipt-basis <work-id> --snapshot <tested-commit>` to calculate the receipt's
`input_fingerprint` and `contract_fingerprint`. Achievement is rejected if current verification
inputs or the verification contract differ from that tested commit.

## The durable law

Store asserted intent once. Derive everything mechanically possible. Keep human judgment explicit,
dated, and reviewable.
