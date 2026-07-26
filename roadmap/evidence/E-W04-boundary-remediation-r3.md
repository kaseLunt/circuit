---
id: E-W04-BOUNDARY-REMEDIATION-R3
type: evidence
title: W04 drift review at the W05 close — protection posture strengthened
status: recorded
work: W04
result: pass
observed_at: 2026-07-26T20:36:30Z
tested_commit: b9a825a437da8322da56de0f27ae44f491cf7ed9
environment: github-hosted branch protection + actions (trusted audit, ci, fork, e2e)
input_fingerprint: sha256:433b4c411be3a4e4e3b34a90558aca77950c8aaf52d1ab25a68c7bb909ea8e05
contract_fingerprint: sha256:d082a915d312239af0e3b1c650bb4c272c780ecb80ab55e9b52197dcb65069c2
commands:
  - "gh api repos/kaseLunt/circuit/branches/main/protection/required_status_checks/contexts   # [trusted audit, ci, fork, e2e]"
updated: 2026-07-26
---

# E-W04-R3 — drift review (event:invalidated-by-change), W05 close

Supersedes `E-W04-boundary-remediation-r2.md`, which stands as the historical record.

**Nature of the drift: the protected surface grew, under the protocol W04 established.**
`.github/workflows/ci.yml` gained the `e2e` job — owner-reviewed in-session (PR #10, landed
under CONTROL_PLANE_OWNER_REVIEWED with the CONTROL_PLANE_POLICY_APPROVAL token for its
reviewed head), and the owner added `e2e` to the required checks. Every mechanism W04
attested remains live and was exercised repeatedly across the W05 range: the trusted audit
passed on every PR; the scope gate blocked two genuinely unauthorized shapes during the
close itself (a stale claim-authority snapshot, and a claim rotation mixed with product
files) — refusals that are the control working, recorded here as evidence of enforcement,
not incident.
