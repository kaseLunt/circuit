# RULES — scope, evidence, and execution discipline

> These rules are the project-neutral default. Project-specific policy may refine them through an
> accepted Decision, but tools and prose must describe the same effective behavior.

## Authority and execution mode

1. **The repository owns durable governance.** Vision, accepted decisions, work contracts, merged
   evidence, and durable handoffs live in version control. Chat and agent memory do not.
2. **Scheduling is separate.** An external runtime may assign and stop agents. In a future
   concurrent-writer mode, its atomic registry—not branch-local claim files—owns live leases.
3. **Serial writer is the default.** Exactly one writer/integrator may modify the repository,
   stage, commit, or merge. Parallel readers may inspect and return findings; an agent that edits or
   commits is a writer regardless of its label.
4. **Keep one active phase and one committing task in serial mode.** Starting another committing
   task requires completing, parking, or superseding the current one in a coherent transition.
   The activation transition also creates exactly one explicit integrator claim bound to that
   task, branch, worktree, full base SHA, lease, and scope hash; it is accountability metadata,
   not a distributed lock.
5. **Do not enable concurrent writers by editing `STATUS.md`.** Require an accepted Decision and
   verified atomic allocation, isolated worktrees, disjoint ownership, protected integration,
   exact merge-candidate checks, and recovery/fencing behavior.

## Scope control

6. **No implementation without a typed work object.** Every active task names the vision outcome
   it advances, dependencies, non-goals, owned paths, deliverables, and evidence target.
7. **Commit scope is explicit.** Judge all staged additions, modifications, deletions, and renames
   against `allowed_paths`. Scope expansion is an owner/integrator transition, not an executor
   convenience.
8. **Protect governance surfaces and semantic transitions.** Constitution/runtime files; STATUS
   authority fields; ROADMAP phase/order/state; work activation, durable status, scope, or
   verification-contract changes; accepted Decisions; idea promotion; claim takeover; and the
   enforcement evidence named by STATUS require owner review. Local
   `CONTROL_PLANE_OWNER_REVIEWED=1` is an acknowledgement only. Remote authority is the exact
   server-side PR/base/head approval token evaluated by immutable trusted policy code.
9. **Capture tangents without changing priority.** Material future work goes to `ideas/`; reusable
   findings to `insights/`; plan threats to `risks/`; architectural choices to proposed Decisions.
10. **Capture is not ratification.** Agents may propose. Only the configured human review may accept
    a Decision, promote an idea, reprioritize phases, or change durable project claims.
    Routine inbox/candidate captures, proposed Decisions, and unreferenced evidence receipts do not
    require that ratification merely to be recorded.

## Snapshot and evidence discipline

11. **Use one coherent snapshot.** Commit authorization reads the staged index. CI evaluates the
    candidate commit or merge commit. Do not combine working-tree control state with staged product
    state when deciding whether a commit is allowed.
12. **Attainment is derived.** `evidence_target` states the desired proof. Attained evidence must
    cite commands/artifacts and the commit/input fingerprint to which it applies. Achieved work
    lists typed, staged `evidence_receipts`; stamping binds bytes and policy but never substitutes
    for running the recorded commands.
13. **Relevant changes invalidate evidence.** Start with conservative `invalidated_by` paths. Rerun
    verification before restoring an attained claim after those inputs change.
14. **Done means accepted output plus current evidence.** Code volume, elapsed time, or a green test
    from another snapshot is not completion.
15. **Derived facts have one home.** Generate or validate ROADMAP status, readiness, review queues,
    evidence freshness, and counts. Do not maintain unvalidated narrative copies.
    Accepted Decisions and recorded evidence/enforcement objects are append-only: supersede them
    with a new authoritative typed record and an explicit pointer; never delete, rename, or rewrite
    their historical payload.

## Capture and handoff

16. **Capture material state while it is discovered.** Do not rely on a session-end hook; the
    process may stop without one.
17. **Maintain a cold-start handoff.** Every active work item includes `next`, `read_first`, and
    `hazards`, updated on scope, blocker, transfer, or completion transitions.
18. **Record blockers immediately.** Derive dependency blockers; assert external blockers with an
    owner and review trigger.
19. **Start by reading:** `STATUS.md` → `ROADMAP.md` → `SYSTEM.md` → the active work item.
20. **End by verifying:** rerun prescribed checks, update state only if a transition occurred, and
    leave the handoff sufficient for a new integrator to resume without chat history.

## Enforcement honesty

21. **Fail closed on a precondition the executor does not own.** Report a dirty or contradictory
    state, failing gate, expired authority, or out-of-scope path. Agents do not bypass hooks or
    permission gates; any human override is explicit and auditable.
22. **Hooks and candidate jobs are feedback, not remote authority.** `pull_request` jobs execute
    mutable candidate code. The base/trust-ref `pull_request_target` audit becomes authoritative
    only when a hosting ruleset required-workflow or dedicated App enforces it for every actor.
    Otherwise the posture is at most `ci-unprotected`; the repository may record a fresh
    `merge-gated-attested` observation but cannot self-certify “verified.”
    Merge queues require a separate trusted `merge_group` integration and are unsupported here.
23. **Every confirmed control failure gets a regression check.** Test validator and gate rules with
    synthetic fixtures that do not depend on live roadmap state.
