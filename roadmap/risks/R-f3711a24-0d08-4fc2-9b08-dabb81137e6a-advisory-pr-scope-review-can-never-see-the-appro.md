---
id: R-f3711a24-0d08-4fc2-9b08-dabb81137e6a
type: risk
title: "Advisory PR scope review can never see the approval token and stays red on every governance PR"
status: open
informs: []
review_when: date:2026-08-08
updated: 2026-07-25
---

# R-f3711a24-0d08-4fc2-9b08-dabb81137e6a — Advisory PR scope review can never see the approval token and stays red on every governance PR

## Context

The `pull_request`-event advisory scope review (`control-plane.yml:70-78`) invokes
`scope_diff.py "$BASE_SHA" "$HEAD_SHA" --branch "$HEAD_BRANCH"` with **no
`--pull-request-number` and no `--policy-approval`**, and unlike the push-flow replay it has no
`continue-on-error`. Any PR containing an owner-gated transition therefore fails this check
unconditionally — the owner's token exists as a repository variable, but this job never reads it.

## Evidence

PR #1 (the W05 activation, 2026-07-25): after the owner set `CONTROL_PLANE_POLICY_APPROVAL` and
the **trusted** audit passed with `scope-diff: OK -- reviewed 3 linear commit(s)`, the advisory
review re-ran and failed again with the same
`owner approval requires a positive decimal pull-request number`. Merge state reported
`UNSTABLE` despite every required check being green.

## Consequence

A red X that structurally cannot turn green on exactly the PRs that matter most (governance
transitions) trains the owner to ignore red X's — the same hazard class as `R-a4314d72` and the
`continue-on-error` masking recorded in D-009: a signal that reads stronger than it is, inverted.
Every future governance PR will carry a permanent failure badge that means nothing.

Resolution options: (1) pass `--pull-request-number "$PR_NUMBER" --policy-approval
"$POLICY_APPROVAL"` to the advisory run too — it fires on `pull_request`, which exposes the PR
number, and `vars.` are readable there; or (2) mark it `continue-on-error: true` with the D-003
advisory rationale, matching the push replay. Option 1 is strictly better: the advisory check
then gives fast feedback with the same semantics as the trusted audit instead of a guaranteed
failure. Either way the fix is a protected-path workflow edit and lands via its own PR.
