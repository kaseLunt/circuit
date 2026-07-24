---
id: D-008
type: decision
title: Claim leases are recorded, not enforced
status: accepted
date: 2026-07-24
approved_by: Kase Lunt (owner)
supersedes: []
updated: 2026-07-24
---

# D-008 — Claim leases are recorded, not enforced

## Context

The bundled runtime is a **serial writer with a single owner**. A lease exists to fence a
*competing* writer out of a shared resource; with no competitor, its expected value is near
zero. Meanwhile the lease was bundled with the claim's genuinely load-bearing bindings —
`allowed_paths`/`scope_hash`, `branch`/`worktree_id`, and `base_commit` ancestry — so lease
expiry could revoke authority that nothing else in the system doubted.

On 2026-07-24 that produced a hard deadlock with W03 mid-flight. The generation-5 lease was
issued for 8 hours and lapsed overnight; the owner returned to a repository that refused every
commit. All four recovery paths dead-ended for a *same-worktree integrator wanting to continue
the same task*:

- `renew` and `rescope` validated with `check_expiry=True` and refused the lapsed lease.
- `rebind` validates with `check_expiry=False` and *could* have recovered it, but refuses when
  `branch` and `worktree_id` already match, deferring back to `renew`/`rescope`
  (`claim.py:469-475`).
- `release` is permitted on a lapsed claim (`check_expiry=False`, `claim.py:514`), but the
  release cannot be committed alone: `doctor` requires an active work item to hold exactly one
  active claim, and `open` refuses to run against an uncommitted claim file
  (`ensure_path_clean`), so release→reissue cannot be sequenced at all.

An earlier attempt added `--owner-reviewed` expired-lease recovery to `renew`/`rescope`. That
patch was **reverted**: it repaired only the writer (`claim.py`) and not the authority
(`scope_gate.py`), which independently refuses any commit under a lapsed claim and permits an
expired claim only an isolated transition to a terminal status. The tool therefore minted a
renewed lease that the gate would never accept — a worse failure than refusing up front — and
its regression check passed only because it exercised `claim.py` in isolation, never asking the
gate whether the result was committable. A green test against the wrong layer.

## Decision

**Lease liveness is no longer an authority condition.** `issued_at`, `lease_expires`, and
`updated_at` remain recorded on every claim as audit metadata, and their *shape* remains
validated (monotonicity, no future stamps, `lease_expires` follows `issued_at`, window within
`MAX_LEASE_HOURS` of `updated_at`). What is removed is the single liveness condition in
`validate_lease` (`_control_plane.py:247-248`) and every behavior derived from it:

- the `check_live` / `check_expiry` parameters and their plumbing through `validate_claim`,
  `valid_rotation`, `claim.py`, `scope_diff.py`, and `scope_gate.py`;
- the gate's expired-claim branch, which restricted a lapsed claim to an isolated terminal
  transition;
- `doctor`'s lease-expiry diagnostics.

Everything else the claim binds is **retained unchanged** and continues to gate every commit:
scope (`allowed_paths` + `scope_hash`), local binding (`branch` + `worktree_id`), `base_commit`
ancestry, agent/filename agreement, `claim_id` shape, and generation monotonicity. Claim
rotation still requires a generation bump, a fresh `claim_id`, `base_commit == HEAD`, and
separation from product files.

A lapsed timestamp is now a *staleness signal for a human*, not a machine veto.

## Consequences

- The class of failure that stranded W03 is structurally gone: no sequence of tool calls can
  leave a serial integrator unable to commit its own recovery.
- Authority becomes purely **spatial** (which paths, which branch, which base) rather than
  partly **temporal**. This is the honest model for a serial writer: nothing was ever racing
  for the lease, so nothing is lost by not enforcing it.
- Abandonment detection is now a human/`doctor`-informational concern. This is an accepted
  trade: an unattended stale claim no longer self-revokes. Should a concurrent-writer mode ever
  be activated (RULES §5), leases are **not** the mechanism to revive — that requires an
  external atomic allocator with real fencing tokens, per RULES §2.
- `MAX_LEASE_HOURS` is retained as a shape bound so recorded windows stay meaningful, even
  though exceeding one no longer revokes anything.
- Per RULES §23, the confirmed control failure gets regression checks that assert the *gate*
  accepts a commit under a lapsed lease and that shape validation still rejects malformed
  stamps — closing the layer gap that let the reverted patch look green.
- RULES §4 and §21 and `roadmap/SYSTEM.md` are amended to describe leases as recorded metadata;
  §21 continues to require failing closed on scope and binding violations.
