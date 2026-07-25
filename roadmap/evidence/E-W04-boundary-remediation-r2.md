---
id: E-W04-BOUNDARY-REMEDIATION-R2
type: evidence
title: Boundary-review remediation re-verified at the P1 exit boundary
status: recorded
work: W04
result: pass
observed_at: 2026-07-25T08:41:00Z
tested_commit: 4d30bd382db46b79c912473b5b46ea98119bd3ce
environment: github-actions-ubuntu-latest-node-22 (run 30147191782) + windows-11-node-22-local + anvil-v1.7.1 + codex-review-sessions-019f9690/019f9754
input_fingerprint: sha256:e2982c79bcf44ef6ba39bae32ec39a5d91d1553c4c61391260ca368045219b39
contract_fingerprint: sha256:d082a915d312239af0e3b1c650bb4c272c780ecb80ab55e9b52197dcb65069c2
commands:
  - "RPC_URL=<archive> node scripts/protocol-reads.mjs --verify-roots"
  - "ANVIL_PATH=<foundry> node spikes/sandbox-proof/proof.mjs"
  - "npm run build && npm run typecheck && npm run lint && npm run check:scripts && npm test"
  - "python roadmap/tools/doctor.py --snapshot HEAD"
updated: 2026-07-25
---

# E-W04-R2 — boundary remediation re-verified at the P1→P2 boundary

Supersedes `E-W04-boundary-remediation.md`, which remains as history. Written because W04's
`review_when: phase:P0:exit` came due and the review found two of its recorded facts superseded.

## Why re-verification was required

W04's `invalidated_by` names `docs/protocol-matrix.md`, `docs/protocol-matrix-reads.json` and
`scripts/**` — **all three** changed during W03. The recorded input fingerprint moved from
`sha256:d5ca1121…` to `sha256:e2982c79…`.

Two specific claims in the original receipt are now outdated and are corrected here:

1. It recorded **"77 reads, 76 successes, one documented expected revert"**. The log now holds
   **79 reads, 78 successes plus the same expected revert** (`getRevision`), after
   `getReserveDeficit` was added for WETH and weETH to resolve matrix §9 item 3.
2. It described the matrix as reproducible from a hard-pinned block with anchors
   "round-trip-verified". Address provenance has since been strengthened: the four irreducible
   roots are pinned to a hashed upstream artifact (`docs/address-roots.json`), `eETH`/EtherFi
   LP/`stETH` are derived on-chain, and `--verify-roots` re-fetches and re-hashes the artifact.

Neither correction weakens W04's claim; both strengthen it.

## Re-verification result

Evidence target `boundary-review-blockers-cleared-and-reconfirmed` is **re-attained**.

- **Reproducible protocol matrix:** `node scripts/protocol-reads.mjs --verify-roots` — exit 0,
  79 reads, 0 unexpected failures, roots verified against the pinned upstream artifact
  (79,914 bytes, sha256 `1a862b73…`), and the log reproduces byte-identically.
- **Honest sandbox proof:** `spikes/sandbox-proof/proof.mjs` re-run, exit 0,
  `RESULT: ALL CHECKS PASSED`, including the genuine negative-reachability admin-RPC test.
- **Scaffold + suites green:** CI run `30147191782` — `Tests 152 passed`, fork `Tests 9 passed`,
  plus build, typecheck, zero-warning lint and `check:scripts`.
- **Control plane:** `doctor.py --snapshot HEAD` — 0 errors.
- **The W03 contract W04 amended has since been executed to completion.** W04's remediation
  rewrote W03 into an implementable contract (derived-borrow formula, share-based no-sweep
  invariants, the exact packed-`uint128` rebase mutation, scaled-balance assertions, the v3.7
  validation set, required archive `FORK_RPC_URL`). Every one of those is now demonstrated green
  on the pinned fork in CI — including the empirical slot scan, which located slot 207 as the
  unique packed accounting word on both local and GitHub hardware. That is the strongest available
  confirmation that the boundary-review disposition was sound rather than merely plausible.

The owner decision recorded in the original stands unchanged: the exposed free-tier archive key is
not rotated (private repo, accepted risk).

## Review disposition

`review_when` moves from `phase:P0:exit` to `event:invalidated-by-change`, for the reason given in
`E-W01-p0-bootstrap-r3.md`: the phase trigger has been serviced and would otherwise remain
permanently due, and input change is the condition that actually matters for an achieved item in a
completed phase.
