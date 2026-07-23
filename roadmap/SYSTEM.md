# Control Plane — constitution

> This document defines how the project tracks itself. It is a proposed baseline until the owner
> accepts the control-plane Decision. Later changes require another accepted Decision.

## Enforcement status

The scaffold starts at **bootstrap**, with `enforcement_evidence: []`. Files and checks being
present does not prove that hooks ran, CI passed, a hosting ruleset requires the trusted audit, or
every actor is covered. Built-in postures are `bootstrap`, `local-advisory`, `ci-unprotected`, and
`merge-gated-attested`. “Attested” deliberately does not mean independently verified: the
repository can validate the shape, binding, and freshness of an external observation, but cannot
authenticate its own prose. A verified claim requires a trusted hosting ruleset, required workflow
or App, and independently produced evidence.

## Governing principle

**Store intent; derive status from evidence.** A derived fact is mechanically consistent with the
available evidence at one snapshot; it is not timeless truth.

## Authority split

The control plane has two layers:

- **Governance layer — repository:** durable vision, accepted decisions, typed work contracts,
  merged artifacts/evidence, risks, and audit projections.
- **Scheduler layer — external runtime:** agent assignment, cancellation, retry, and—in separately
  activated concurrent-writer mode—atomic live claims, generations, leases, worktrees, and merge
  queue state.

Chat is neither layer. In concurrent mode, committed claim files may preserve an audit projection,
but normal branches cannot act as an atomic lock registry.

## Effective writer mode

`STATUS.md` records the effective mode, not an aspiration.

### Serial writer — default

- One writer/integrator owns repository modifications, the staged index, commits, control-plane
  transitions, and merges.
- Parallel agents may read, research, review, or prepare suggestions. They submit results to the
  integrator and do not commit independently.
- `STATUS.active_task` is the one committing work item.
- Path scope still applies to the serial writer.
- The bundled active claim is a checked task/scope binding for that integrator, not a concurrency
  lock. Activate the work item and STATUS in the working tree, open exactly one claim, then stage
  and commit the transition together before implementation files may use its scope.
- Keep the governed branch up to date and preserve its commit chain. Integration supports a
  fast-forward or a normal two-parent no-FF merge whose first parent is an ancestor of the second
  and whose tree exactly equals the second-parent tree. Squash merges, history-rewriting rebases
  after claim/evidence issuance, octopus merges, and merge-time edits are unsupported; rotate
  affected full-SHA bindings after any deliberate history rewrite.

### Concurrent writer — separately activated

Changing `writer_mode` alone has no effect. Activation requires an accepted project Decision and
mechanical enforcement of all of the following:

1. one CI-green full base commit for each writer wave;
2. an atomic scheduler registry outside ordinary product branches;
3. unique claim IDs plus monotonic generations;
4. one bound branch and worktree per writer;
5. globally disjoint path and semantic-resource scopes with integrator-only shared surfaces;
6. complete diff attribution, including deletions and both sides of renames;
7. protected integration plus exact prospective merge-commit checks and serialized merging
   supplied by the external concurrent-mode integrator (the bundled serial audit is not that
   allocator or queue);
8. explicit failure, expiry, abandonment, transfer, and recovery states;
9. fencing before automatic reassignment of expired work.

Same-host worktrees can use an OS-locked registry below Git's common directory for cooperative
race safety. Cross-host writers require authenticated identity, transactional coordination, and
server-enforced policy. Neither is a security property of a checked-in claim file.

## Snapshot model

Use one source snapshot for each decision:

- **working tree:** editable workspace; never authoritative for staged commit authorization;
- **staged index:** proposed commit snapshot used by local scope and structural gates;
- **commit or merge candidate:** immutable snapshot evaluated as data by trusted policy code;
- **protected integration branch:** accepted shared state after required checks and review.

Tools that parse objects, normalize paths, or resolve scope must share the same implementation and
failure semantics. A staged/working-tree disagreement is either handled explicitly or rejected.

## Object categories

| Category | Examples | Authority |
| --- | --- | --- |
| Asserted intent | vision, priority, active pointer | Human-owned and reviewed |
| Asserted reality | external blocker, access gap, risk | Owner plus review trigger |
| Immutable record | accepted decision, run artifact, observation | Append-only or superseded |
| Derived mechanic | readiness, projection, evidence freshness | Tool-generated or validated |
| Human judgment | promotion, relevance, acceptance | Never silently automated |

## Lifecycle

Use the smallest lifecycle that the tools enforce. The baseline is:

`inbox → candidate/proposed → committed → active → achieved | superseded | rejected | archived`

- Ideas and findings may enter cheaply as `inbox` or `candidate`.
- Decisions remain `proposed` until explicit owner ratification changes them to `accepted`.
- Work becomes `active` only in a coherent transition with `STATUS.active_task` in serial mode.
- Objects are superseded or archived, not silently deleted.
- A review trigger is advisory unless a tool actually blocks the relevant transition.

## Evidence and invalidation

An evidence target is a work contract. Attainment requires a receipt tied to the evaluated
snapshot and should record:

- full commit or merge-candidate identity;
- relevant input fingerprint from `invalidated_by`;
- exact verification commands and exit results;
- toolchain/environment identity where relevant;
- deterministic seeds, fixtures, or external artifact identities where relevant;
- reviewer or CI artifact link when required by the project's evidence policy.

Relevant input changes invalidate attainment until verification is rerun. Over-invalidate first;
under-invalidation creates stale green claims.

The bundled validator requires achieved work to list one or more exact `evidence_receipts` under
`roadmap/evidence/`. Each receipt is a typed object with `type: evidence`, `status: recorded`, the
bound `work` ID, `result: pass`, strict-UTC `observed_at`, an ancestor `tested_commit`, a named
`environment`, `input_fingerprint`, `contract_fingerprint`, a nonempty `commands` list, and
`updated`. Generate the two tested hashes from the verified commit with
`doctor.py --receipt-basis <work-id> --snapshot <commit>`. The work fingerprint covers the complete
work contract (excluding its self-referential fingerprint field), invalidation policy, matched
paths, Git modes, deliverables, and receipt bytes. `doctor.py --stamp <work-id>` only binds that
staged proof/input snapshot; it does not execute or vouch for the receipt's commands. CI or a
reviewer must establish that the receipt is truthful.

## Exact projections

Each fact has one authoritative home. ROADMAP's work table is generated or validated from work
frontmatter; ID, title, phase, dependencies, evidence target, and status must match exactly.
STATUS contains only the active integration pointer, `project_state`, effective writer mode,
asserted blockers, and current enforcement posture. An active project has exactly one In progress
phase. A complete project may retain its last `active_phase` pointer but has no active task, work,
or claim. Views must not invent stronger state.

## Handoff contract

Every active work item carries a `## Handoff` with:

- `next`: the smallest safe resumable action;
- `read_first`: authoritative files/artifacts to inspect before editing;
- `hazards`: dirty state, unresolved decisions, fragile invariants, or forbidden surfaces.

Update the handoff on transitions, not ceremonially on every commit. Chat-only context does not
satisfy the contract.

## Enforcement layers

- **Validator:** structural consistency, references, lifecycle, exact projections, evidence
  freshness, and mode invariants.
- **Local hooks:** fast staged-snapshot feedback; bypassable by design.
- **Control-plane selftests:** synthetic negative tests proving each safety rule fires.
- **Candidate CI:** the `pull_request` doctor/selftest jobs execute candidate code and are advisory.
- **Trusted PR audit:** the `pull_request_target` job checks out policy code from
  `CONTROL_PLANE_TRUST_REF` (or the server-owned default branch), runs only for
  `CONTROL_PLANE_TARGET_BRANCH` (or the default branch), treats PR files only as Git objects,
  replays `base..head`, and inspects `refs/pull/N/merge`. It requires that simulated merge to have
  exactly `(base, head)` parents and the same tree as the up-to-date head.
- **Owner gate:** durable semantic transitions require repository variable
  `CONTROL_PLANE_POLICY_APPROVAL` to equal the canonical SHA-256 token over PR number, full base
  SHA, and full head SHA. A new push invalidates it. `scope_diff.py --print-policy-approval-token`
  computes the value; knowing the value is not authorityâ€”ability to change the server variable is.
- **Branch protection/merge policy:** makes required CI authoritative only when verified for all
  relevant writers and integrators.

The bundled `pull_request_target` audit is a candidate for a hosting ruleset required-workflow, not
an ordinary head status guarantee. Until the host is configured to require that trusted workflow
for the protected ref, report at most `ci-unprotected`. Merge queues are not handled by this
template because it has no trusted `merge_group` integration; either disable them or provide and
attest an external merge-group verifier. Post-merge push replay is advisory and assumes the trusted
pre-merge PR approval already ran.

## Honest guarantee

The control plane can prove consistency with available evidence at a named snapshot. It cannot
prove that intent remains wise, evidence is complete, or external systems are truthful. Bound
those limits with small asserted state, review triggers, explicit uncertainty, and visible
enforcement gaps—never with stronger prose.
