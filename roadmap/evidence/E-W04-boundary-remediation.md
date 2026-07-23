---
id: E-W04-BOUNDARY-REMEDIATION
type: evidence
title: Boundary-review blockers cleared and reconfirmed by Codex
status: recorded
work: W04
result: pass
observed_at: 2026-07-23T04:27:08Z
tested_commit: 609a8b1b2fd3bf5d72cf12b9848298e674b501cf
environment: windows-11-node-22-local + codex-senior-review (session 019f8c0b)
input_fingerprint: sha256:d5ca112155fd1b11e6c185b98d5a40172414735f48902d2fe93f486570b2dbf6
contract_fingerprint: sha256:d082a915d312239af0e3b1c650bb4c272c780ecb80ab55e9b52197dcb65069c2
commands:
  - "RPC_URL=<archive> node scripts/protocol-reads.mjs"
  - "ANVIL_PATH=<foundry> node spikes/sandbox-proof/proof.mjs"
  - "npm run build && npm run typecheck && npm run lint && npm test"
  - "python roadmap/tools/doctor.py"
updated: 2026-07-23
---

# E-W04 — boundary-review remediation, Codex-confirmed

The D-004 P0→P1 boundary review's 18 findings were dispositioned across four Codex passes in
session 019f8c0b (recorded in this repo's task history). Final Codex verdict: **"Yes — W04 may
close and W03 may activate."** Both remaining items confirmed RESOLVED: (1) credential purged
from all reachable *and* reflog history (`git log --all --reflog` sweep = 0); (2) the
packed-`uint128` rebase slot-discovery contract in W03 is soundly specified.

Evidence at the tested commit:
- **Reproducible protocol matrix:** `scripts/protocol-reads.mjs` hard-pins block 25,592,678
  (hash-guarded), requires an archive RPC, serializes only a redacted provider label, reruns
  byte-identical. `docs/protocol-matrix-reads.json`: 77 reads, 76 successes, one documented
  expected revert (`getRevision`), zero unexpected failures. Revision corrected to Aave v3.7 via
  implementation mapping.
- **Honest sandbox proof:** `spikes/sandbox-proof/proof.mjs` — ALL CHECKS PASSED, including the
  genuine negative-reachability admin-RPC test.
- **Scaffold + suite green** (build, typecheck, `--max-warnings=0` lint, test); `no-console`
  enforced on `src/**`.
- **W03 contract** amended to implementable determinism (derived-borrow formula, share-based
  no-sweep invariants, exact packed-uint128 rebase mutation, scaled-balance assertions, v3.7
  validation set, required archive `FORK_RPC_URL`).

Owner decision recorded: the exposed free-tier archive key is not rotated (private repo,
accepted risk).
