---
id: W04
type: work
title: Disposition the P0→P1 boundary review findings
phase: P0
status: active
evidence_target: boundary-review-blockers-cleared-and-reconfirmed
priority: 0
depends_on: []
blocked_by: []
informs: [H0]
allowed_paths:
  - docs/**
  - spikes/**
  - scripts/**
  - src/app/page.tsx
  - src/app/layout.tsx
  - package.json
  - package-lock.json
  - vitest.config.ts
  - .github/**
  - roadmap/work/W03-p1-finance-core.md
  - roadmap/work/W04-boundary-review-remediation.md
deliverables:
  - scripts/protocol-reads.mjs
  - docs/protocol-matrix.md
  - docs/protocol-matrix-reads.json
  - spikes/sandbox-proof/proof.mjs
  - spikes/sandbox-proof/proof-output.txt
  - roadmap/work/W03-p1-finance-core.md
evidence_receipts: []
invalidated_by:
  - docs/protocol-matrix.md
  - docs/protocol-matrix-reads.json
  - scripts/**
review_when: phase:P0:exit
updated: 2026-07-23
---

# W04 — Disposition the P0→P1 boundary review

**Why this advances the vision:** the D-004 boundary review found the protocol fixture
non-deterministic and partially unverified (revision misidentified; four cap reads failed in the
committed log while the matrix claimed them verified). P1's money-math cannot build on that.
Disproof: any blocking finding still open at the re-review.

## Objective

Clear all blocking findings of the 2026-07-23 boundary review (Codex session 019f8c0b, recorded
verbatim in this repo's task history):

1. **Matrix regeneration (findings 1–6):** a committed, reproducible `scripts/protocol-reads.mjs`
   regenerates every read at ONE pinned block (number + hash + timestamp recorded); revision
   identified from implementation-address/bytecode mapping to the deployment artifact (v3.7
   expected), not changelog inference; extend with the revision's validation set (available
   liquidity, isolation/siloed state, e-mode isolated-category flag, oracle-sentinel
   applicability), both reserves' interest-rate strategy addresses + parameters + state, oracle
   `getSourceOfAsset` + block-pinned `getAssetPrice` for WETH/weETH, and the current EtherFi
   LiquidityPool implementation ABI with deposit-return/share-rounding semantics.
2. **W03 amendment (findings 7–13, 17):** derived-borrow provenance form with exact integer
   formula and rounding direction; share-based no-sweep invariants with named integer dust
   bounds; the single pinned fork fixture; `test:fork` wiring contract (runner, pinned anvil
   version, install, readiness, cleanup, RPC handling, zero-test = fail); falsifiable final-state
   assertion list; explicit EtherFi-flagship-only execution scope for P1; deliverables +
   invalidated_by extended to the evidence-producing machinery.
3. **Proof honesty (finding 14):** replace the constant-true admin-RPC check with a real negative
   reachability test (non-loopback connection attempt must fail); regenerate committed output;
   record remaining P3a operational gates in docs/decisions.md (finding 15).
4. **Scaffold hardening (finding 16):** `--max-warnings=0` lint, pinned Node line; zero-test
   passes noted for removal at first real test (W03).
5. **Naming residue (finding 18):** page/layout say Circuit.

## Acceptance

- `RPC_URL=<archive> node scripts/protocol-reads.mjs` reproduces `docs/protocol-matrix-reads.json`
  at the hard-pinned, hash-verified block with **zero unexpected failures** (the single
  documented expected revert, `getRevision`, is itself recorded evidence); reruns are
  byte-identical; the matrix cites only values present in that log.
- Revision claim backed by implementation-address mapping evidence, not inference.
- W03 amended per above; doctor green.
- Proof output shows a genuine failed connection attempt from a non-loopback address.
- **Codex re-review (same session) confirms all blocking findings cleared** before this item's
  receipt is stamped.

## Non-goals

- No `core/` implementation; no W03 activation (that follows the re-review).
- No P3a operational work (TTL/registry/caps) — recorded as deferred gates only.

## Canonical commands

```text
RPC_URL=<archive> node scripts/protocol-reads.mjs
ANVIL_PATH=<foundry> node spikes/sandbox-proof/proof.mjs
npm run build && npm run typecheck && npm run lint && npm test
python roadmap/tools/doctor.py
```

## Evidence

No attained evidence yet; the receipt records the re-review verdict, the pinned block, and the
reads log (76 successes, one documented expected revert, zero unexpected failures).

## Handoff

- next: after closure, activate W03 in the transition that flips P0→Done / P1→In progress.
- read_first: the boundary-review findings (18 items); docs/protocol-matrix.md; SPEC §5.
- hazards: viem lands as a dependency here (the reads script needs it) — that is in-scope for
  this item's package.json authority. Do not let the reads script depend on anything outside
  the repo.
