---
id: E-W01-P0-BOOTSTRAP-R3
type: evidence
title: P0 bootstrap re-verified at the P1 exit boundary
status: recorded
work: W01
result: pass
observed_at: 2026-07-25T08:41:00Z
tested_commit: 4d30bd382db46b79c912473b5b46ea98119bd3ce
environment: github-actions-ubuntu-latest-node-22 (run 30147191782) + windows-11-node-22-local + anvil-v1.7.1
input_fingerprint: sha256:3e3e3230ef69fdc49fa2ad5121fd3b14b5251c592665fb4aede8256eefc9087b
contract_fingerprint: sha256:37d7710bf54febceff16e8771961cb42b45e35d89bbc2420bf0c3b45453198c6
commands:
  - "npm ci && npm run build && npm run typecheck && npm run lint && npm test"
  - "ANVIL_PATH=<foundry> node spikes/sandbox-proof/proof.mjs"
  - "python roadmap/tools/doctor.py --snapshot HEAD"
updated: 2026-07-25
---

# E-W01-R3 — P0 bootstrap re-verified at the P1→P2 boundary

Supersedes `E-W01-p0-bootstrap-r2.md`, which remains as history. Written because W01's
`review_when: phase:P0:exit` came due once `active_phase` passed P0, and the review found the
evidence genuinely stale rather than merely overdue.

## Why re-verification was required

W01's `invalidated_by` names `SPEC.md`, `TRANSPLANT.md`, `package.json` and
`.github/workflows/**`. Three of those changed during W03: `package.json` gained
`check:scripts`, `.github/workflows/ci.yml` gained the fork job and the parse gate, and
`.github/workflows/control-plane.yml` had its `--check-live-lease(s)` flags removed under D-008.
The recorded input fingerprint moved from `sha256:f35e5849…` to `sha256:3e3e3230…`, so per
RULES §13 the attained claim could not stand without rerunning verification.

## Re-verification result

Evidence target `ci-green-scaffold-plus-executable-sandbox-proof` is **re-attained**.

- **CI green:** run `30147191782` at `4d30bd3` — job `ci` success (build, typecheck, lint,
  `check:scripts`, `Tests 152 passed`) and job `fork` success (`Tests 9 passed`). The scaffold is
  green under the *current* workflow definitions, which is precisely what changed.
- **Sandbox spike still executable — not a write-up.** `node spikes/sandbox-proof/proof.mjs`
  re-run 2026-07-25 against anvil v1.7.1, exit 0, `RESULT: ALL CHECKS PASSED`, all seven checks:
  fork-block identity (both sessions pinned to 25608584), faucet via `anvil_setBalance`, gas
  estimation in range (45060), unsigned impersonated WETH deposit mined (`status=0x1`),
  snapshot/revert restoring the pre-snapshot value exactly, per-session isolation (concurrent
  session B saw none of A's mutations), and admin-RPC non-exposure (answers on loopback, refused
  on the non-loopback address).
- **Control plane:** `doctor.py --snapshot HEAD` — 0 errors.

Nothing in the P0 deliverable set regressed; the changed inputs were additive CI and tooling
changes made by W03.

## Review disposition

`review_when` moves from `phase:P0:exit` to `event:invalidated-by-change`. The phase-exit trigger
has fired and been serviced, and as coded it would remain permanently due for every later phase
(`doctor.py:838`), which converts a real signal into standing noise. The event trigger states the
condition that actually matters for an achieved item in a completed phase: re-review when one of
its `invalidated_by` inputs changes.
