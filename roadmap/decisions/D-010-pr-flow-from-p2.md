---
id: D-010
type: decision
title: "Work lands via pull request from P2 onward, so the trusted audit can actually run"
status: accepted
date: 2026-07-25
approved_by: Kase Lunt (owner)
supersedes: []
updated: 2026-07-25
---

# D-010 — PR flow from P2 onward

## Context

D-009 deferred this decision to the P1 exit. It is now due.

Through P0 and P1, work landed by direct push to `main`. That makes the repository's strongest
enforcement tier **structurally unreachable**, not merely unconfigured:

- The `Trusted audit candidate` job is gated on `pull_request_target`
  (`control-plane.yml:6`, `:99`), so a direct push can never run it — it is reported `skipped`.
- The push-flow replay that does run is advisory by design per D-003 and carries
  `continue-on-error: true` (`control-plane.yml:84`), so the workflow reports green even when the
  replay fails. At `4106ba9` it did fail, with
  `scope-diff: FAIL -- owner approval requires a positive decimal pull-request number`, while
  GitHub still showed the run green.
- `policy_approval_token()` hashes only public inputs (`scope_diff.py:181`), so it authenticates
  nothing unless an administrator sets it as a repository variable and a *trusted* job compares it
  in a PR-bound context. Generated locally it proves mechanical replay only (`R-a4314d72`).

The practical consequence was visible immediately: closing W03 required D-009 to override the
attestation of nine owner-gated transitions. P2 touches more protected surface than P1 did — the
canvas transplant brings `src/app/**`, component work, and repeated `TRANSPLANT.md` port commits —
so on the current posture every one of those would need its own override. D-009 says explicitly
that it is not precedent; honouring that means fixing the posture rather than repeating the
override.

`STATUS.md` has carried this as a blocker since bootstrap: the workflow exists in-repo but no
branch protection or required check is configured, and the pre-commit hook is cooperative only.

## Decision

**From P2 onward, work lands on a branch and merges into `main` via pull request.** Direct pushes
to `main` are reserved for the exceptional case and each one still requires a recorded override.

This requires owner setup that no agent can perform, and until it is in place the posture is
unchanged:

1. **Branch protection on `main`** — require a pull request before merging, and require the
   Control plane trusted audit as a status check.
2. **Set the `CONTROL_PLANE_POLICY_APPROVAL` repository variable** to the canonical
   PR/base/head token for the pull request being approved. This is the owner's attestation act;
   it is what makes `SERVER-SIDE OWNER APPROVAL matched` a true statement rather than a
   self-consistency check.
3. Wire the trusted workflow as a hosting-ruleset **required workflow** so it is enforced for
   every actor, per RULES §22 — without that, the posture remains at most `ci-unprotected` no
   matter what the workflow file says.

Steps 1 and 3 are one-time. Step 2 recurs per owner-gated PR, and is the point: the review becomes
an artifact rather than a local acknowledgement.

## Consequences

- Owner-gated transitions in P2 stop needing per-item overrides. The gate D-007 describes becomes
  enforceable rather than cooperative.
- `merge-gated-attested` becomes reachable as an enforcement posture. It still may not be
  self-certified — RULES §22 requires a fresh typed observation under `roadmap/evidence/`, and
  `STATUS.enforcement` stays `bootstrap` until one exists.
- The serial-writer model is unchanged. One branch, one work item, one integrator at a time; the
  PR is an attestation boundary, not a concurrency mechanism.
- Until the owner completes steps 1–3, P2 work either waits or lands under the same override
  regime as P1. This decision does not retroactively attest anything: D-009's range keeps its
  override, and `4594e444..0829059` remains push-landed.
- `R-a4314d72` (the misleading `SERVER-SIDE OWNER APPROVAL matched` line on a local token) becomes
  more urgent once real tokens are in play, because the two cases will then be genuinely
  confusable in a log.
