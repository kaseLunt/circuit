---
id: D-009
type: decision
title: "Owner override for owner-gated transitions in the W03 range (no trusted audit exists)"
status: accepted
date: 2026-07-25
approved_by: Kase Lunt (owner)
supersedes: []
updated: 2026-07-25
---

# D-009 — Owner override binding 4594e444..4106ba9

## Context

D-007 makes an explicit Codex APPROVAL verdict a hard gate for complex work, with an owner
override as the only exception, recorded with rationale. This record is that override, scoped to
one commit range and one specific gap.

Codex reviewed the W03 surface across four rounds in sessions `019f9690`, `019f9754` and
`019f9799`. It **accepted every technical finding and all seven divergences**: the source-verified
e-mode LTV/LT semantics, the hashed address-root pin with market confirmation, the claim
regeneration after the history split, the split itself, the reads-log reordering, and the Node
parse gate. It independently authenticated the CI evidence via `gh` against this private
repository, and it mutation-tested that `docs/address-roots.json` changes invalidate a W03
receipt fingerprint.

One gap remained, and it is **not** a defect in the work. Nine commits in this range are
owner-gated transitions. Owner review for each occurred in session: the owner authorized it and
the integrator set `CONTROL_PLANE_OWNER_REVIEWED=1` at commit time. But RULES §8 is explicit that
this local flag is an acknowledgement only, and that remote authority is the exact server-side
PR/base/head approval token evaluated by trusted policy code. No such attestation exists for this
range, because nothing here landed through a pull request:

- `control-plane.yml` gates the `Trusted audit candidate` job on `pull_request_target`
  (`control-plane.yml:6`, `:99`), so a direct push can never run it. For this range it is
  **skipped**.
- The push-flow replay that does run is advisory by design per D-003 and carries
  `continue-on-error: true` (`control-plane.yml:84`), so the workflow reports green even when the
  replay fails.
- In run `30143028740` at this head, that advisory replay logged
  `scope-diff: FAIL -- owner approval requires a positive decimal pull-request number`.
- `STATUS.md` has recorded this posture as a blocker from the outset: the workflow exists in-repo
  but no branch protection or required check is configured, and the pre-commit hook is
  cooperative only.

A correction is recorded here because the integrator initially misreported it. The Control plane
workflow's **workflow-level** `success` was reported as "trusted history replay accepted." That
was false: the trusted job was skipped and the only replay that ran failed, masked by
`continue-on-error`. Codex caught it; the integrator then confirmed it independently. The
enforcement posture is at most `ci-unprotected` per RULES §22.

## Decision

**The owner overrides the D-007 requirement for server-side attestation of the nine owner-gated
transitions in `4594e444cb26643cf338c3dedc529f87abefd6ec..4106ba9dd501e02777f05dc2b39c55321f3b6e74`,
and only for that.** The override covers the *attestation mechanism*, not any technical finding:
Codex approved the substance.

Owner rationale: the review this gate exists to compel actually happened — each transition was
authorized explicitly and contemporaneously — and the missing artifact is a server-side token that
is structurally unobtainable for commits that arrived by direct push. Re-landing already-published
history through a pull request to manufacture the artifact would rewrite public history at
disproportionate cost for no gain in scrutiny.

The nine owner-gated commits, each verified to touch the surface named:

| Commit | Gate reason |
|---|---|
| `ec3e9cc7` | protected runtime/governance paths: `.githooks/`, `control-plane.yml`, `roadmap/tools/**` |
| `37fdbfc1` | protected `roadmap/RULES.md` |
| `4888e8bc` | W03 scope expanded to `scripts/**` (metadata-only) |
| `78a12252` | protected `.github/workflows/ci.yml` |
| `96c8fea7` | D-008 entered `accepted`; `approved_by` changed |
| `31cc8b7a` | W03 durable verification contract changed |
| `0980abbb` | protected `roadmap/SYSTEM.md` |
| `1a15ca6f` | protected `.github/workflows/ci.yml` |
| `4106ba9d` | W03 durable verification contract changed |

**History-replay evidence, in Codex's required wording:**

> Independent Codex execution confirmed that the 22-commit range is mechanically replayable under
> current policy. The uncredentialed replay failed for missing PR-bound owner approval; a locally
> generated synthetic token produced a complete mechanical pass but does not evidence actual owner
> authorization.

This must not be described as "trusted history replay passed."

Codex established why a local token cannot authenticate: `policy_approval_token()`
(`scope_diff.py:181`) hashes a domain separator, PR number, base SHA and head SHA — all public
inputs, no secret material. Anyone holding the SHAs can compute it, so generating it locally and
supplying it back proves replayability only. The tool's `SERVER-SIDE OWNER APPROVAL matched`
message is not factually true for a local execution; it means only that two locally supplied
strings matched.

## Consequences

- W03 may proceed to `achieved` on its receipt, which must cite Codex's approval of every
  technical finding **and** this override for the attestation gap. It may not claim a trusted
  audit occurred.
- This override is **not** precedent for future work items. It is bound to one explicit range and
  expires with it.
- The underlying posture gap is untouched and remains open: while work lands by direct push, the
  trusted `pull_request_target` audit can never fire, so the strongest enforcement tier is
  structurally unreachable and every owner-gated transition will need an override. Closing that
  properly requires PR flow plus branch protection with a required workflow — an owner posture
  decision deferred to the P1 exit, not resolved here.
- `policy_approval_token()`'s local behaviour is misleading enough to warrant a follow-up: the
  emitted `SERVER-SIDE OWNER APPROVAL matched` line should distinguish a locally supplied token
  from a server-provided one, so a future reader cannot mistake mechanical replay for authorized
  review. Captured as a risk, not fixed here.
