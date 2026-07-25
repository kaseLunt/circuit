---
id: R-a4314d72-db87-4409-98f6-81610d32e736
type: risk
title: "policy_approval_token prints SERVER-SIDE OWNER APPROVAL for a locally supplied token"
status: open
informs: []
review_when: date:2026-08-08
updated: 2026-07-25
---

# R-a4314d72-db87-4409-98f6-81610d32e736 — policy_approval_token prints SERVER-SIDE OWNER APPROVAL for a locally supplied token

## Context

`policy_approval_token()` (`roadmap/tools/scope_diff.py:181`) hashes a domain separator, the
pull-request number, the base SHA and the head SHA. Every input is public. The token is therefore
not a credential: anyone holding the SHAs can compute it, and `--print-policy-approval-token`
exists precisely to do so.

Its security depends entirely on the value being stored as a repository variable that only an
administrator can set, and being compared inside a trusted `pull_request_target` job. Locally it
proves nothing.

## Evidence

On a local run where the token was generated and then supplied back to the same tool, the replay
exits 0 and emits `SERVER-SIDE OWNER APPROVAL matched PR/base/head token`. Observed 2026-07-25 by
Codex during the D-007 review of `4594e444..4106ba9`, which correctly refused to treat it as
authorization (D-009).

## Consequence

The message asserts server-side authority for what is only a self-consistency check between two
locally supplied strings. A future reader — or a future agent summarising a log — can reasonably
read it as evidence that owner review occurred. That is exactly the confusion RULES §22 exists to
prevent, and it is a plausible route to a fabricated-looking-but-honest false approval claim in a
receipt.

Resolution path: distinguish provenance in the output. When the token arrives via
`--policy-approval` on a local invocation, say so — e.g. `LOCAL TOKEN MATCH (not server-side
authority; proves mechanical replay only)` — and reserve the server-side wording for a genuine
trusted job context. Add a regression check per RULES §23 asserting the local path never emits the
server-side phrasing.

Related: the integrator separately misread the Control plane workflow's aggregate `success` as a
trusted replay when the trusted job was skipped and the advisory replay failed under
`continue-on-error` (recorded in D-009). Both are the same hazard class — a signal that reads
stronger than it is.
