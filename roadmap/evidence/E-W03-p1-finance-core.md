---
id: E-W03-P1-FINANCE-CORE
type: evidence
title: 13-step flagship plan green on the pinned fork in CI, Codex-approved with a recorded override
status: recorded
work: W03
result: pass
observed_at: 2026-07-25T05:57:19Z
tested_commit: 645650269bcec382a983c58da0d7a79a96d49fe0
environment: github-actions-ubuntu-latest-node-22 + anvil-v1.7.1 (foundry-toolchain) + codex-review-sessions-019f9690/019f9754/019f9799
input_fingerprint: sha256:b0affcbf6eef734bac7a4badce2832306c2680e5dd7b69c82d6dd3c2922dd542
contract_fingerprint: sha256:34a2db1a80bf3f6fa7b39aeca6f17fd8efba82c39a2395e6ca507bfa7411f71a
commands:
  - "npm run build && npm run typecheck && npm run lint && npm run check:scripts && npm test"
  - "FORK_RPC_URL=<archive-secret> npm run test:fork"
  - "RPC_URL=<archive> node scripts/protocol-reads.mjs --verify-roots"
  - "python roadmap/tools/doctor.py"
  - "python roadmap/tools/scope_diff.py 4594e444cb26643cf338c3dedc529f87abefd6ec 645650269bcec382a983c58da0d7a79a96d49fe0"
updated: 2026-07-25
---

# E-W03 — P1 finance core, fork-green in CI and Codex-approved

Evidence target `thirteen-step-plan-green-on-pinned-fork-in-ci` is **attained**.

## Fixture identity

Block `25,592,678`, hash
`0x7f1f53176578a6df42c94948c10623f002cca61398208c888edce99eaedbf0de`, timestamp
2026-07-23T03:14:11Z. anvil **v1.7.1** (CI via `foundry-toolchain`; locally the pinned
`foundry_v1.7.1_win32_amd64.zip`, sha256
`6d41121b4bbb809845821c903619cfee75ed364f2bdc58a6787c9b0454114537`, verified against the
published checksum). `FORK_RPC_URL` is an archive-capable repository secret; the pinned block has
aged out of public nodes' recent-state windows, so there is no fallback.

## Attained evidence

**CI run 30143028744** at `4106ba9d` (both jobs `success`, retrieved and confirmed by Codex via
authenticated `gh` against this private repository):
- job `ci` — build, typecheck, lint, `check:scripts`, and `npm test`: `Test Files 8 passed (8)`,
  `Tests 152 passed (152)`.
- job `fork` — `npm run test:fork` against the pinned fixture: `Test Files 1 passed (1)`,
  `Tests 9 passed (9)`, zero skipped, anvil `Version: 1.7.1`. All 13 SPEC §2 steps execute, with
  HF asserted against `Pool.getUserAccountData()` after every risk-changing step.

**CI run 30142264963** at `762cf4e5` (both jobs `success`) — its authenticated fork log records
the cross-machine reproductions: `weETH: reserve deficit (live read) = 0`,
`WETH: reserve deficit (live read) = 52964453911883321543567`, `rebase: slot 207`, rebase delta
`19089270207046560429339`.

**Deficit corroboration (four independent derivations of one value).** WETH's `reserve.deficit`
was first *predicted* by inverting the v3.7 rate strategy — the recorded `variableBorrowRate`
reproduced exactly from recorded state while the recorded `liquidityRate` would not reproduce at
deficit 0, and weETH's did. It was then read from an archive RPC at the pinned block, read live
from a local anvil fork, and read live from a fork on GitHub runners. All four agree on
`52964453911883321543567`. `rates.test.ts` reproduces both reserves' `liquidityRate` exactly at
the recorded deficits and asserts WETH does **not** reproduce at deficit 0, so the dependency
cannot silently disappear. Matrix §9 item 3 is resolved.

**Determinism.** The reads log regenerates byte-identically; the rebase mutation independently
located slot 207 as the unique packed accounting word on both local and CI hardware, applying the
same delta.

**Address provenance.** Exactly four addresses are not on-chain reads
(`PoolAddressesProvider`, `WETH`, `weETH`, `wstETH`); none is a literal in a script. They are
pinned by `docs/address-roots.json` to `bgd-labs/aave-address-book` `src/AaveV3Ethereum.sol` at
commit `ad35d3403b02ff0b4ce27acc23b92781b44f78f4`, 79,914 bytes, sha256
`1a862b7389de3d59ee77680a8edb451a29e630a07813a0c5becdce65d730a22a` — independently fetched and
confirmed by Codex. `eETH`, the EtherFi LiquidityPool and `stETH` are derived on-chain.

## Codex review (D-007)

Reviewed across four rounds in sessions `019f9690`, `019f9754` (turns 1–4) and `019f9799`. Codex
**accepted every technical finding and all seven divergences**, including the two the integrator
raised deliberately: reading the Aave sources rather than implementing Codex's summarised table
(which surfaced the LTV/LT asymmetry Codex had not stated), and pinning the address roots with
market membership as *confirmation* rather than making the market the source. Codex independently
verified the four-branch e-mode semantics against `ValidationLogic.getUserReserveLtv` and
`GenericLogic.calculateUserAccountData`, mutation-tested that `docs/address-roots.json` edits
invalidate this receipt's fingerprints, and re-derived this receipt's `input_fingerprint` and
`contract_fingerprint` to the same values recorded above.

Codex's final verdict was **APPROVAL WITHHELD**, for one reason only: no independently
authenticated owner approval exists for the nine owner-gated transitions in this range. That is an
attestation gap, not a defect — see the override below.

## Enforcement posture (stated plainly)

No trusted `pull_request_target` audit exists for this head. The trusted job is gated on that
event (`control-plane.yml:6`, `:99`) and is **skipped** for a direct push; the push-flow replay
that does run is advisory by design per D-003 and carries `continue-on-error: true`
(`control-plane.yml:84`), so the workflow reports green even when that replay fails — and in run
`30143028740` it did fail, with
`scope-diff: FAIL -- owner approval requires a positive decimal pull-request number`. The posture
is therefore at most `ci-unprotected` per RULES §22. An earlier integrator summary described this
workflow's aggregate `success` as "trusted history replay accepted"; that was false and is
retracted here and in D-009.

History-replay evidence, in Codex's required wording:

> Independent Codex execution confirmed that the 22-commit range is mechanically replayable under
> current policy. The uncredentialed replay failed for missing PR-bound owner approval; a locally
> generated synthetic token produced a complete mechanical pass but does not evidence actual owner
> authorization.

This receipt does **not** claim that a trusted history replay passed.

## Owner override

**D-009** (accepted 2026-07-25, Kase Lunt) overrides the D-007 requirement for server-side
attestation of the nine owner-gated transitions in
`4594e444cb26643cf338c3dedc529f87abefd6ec..4106ba9dd501e02777f05dc2b39c55321f3b6e74`, and only
that. Owner rationale: the review the gate compels did occur — each transition was authorized
explicitly and contemporaneously in session — and the missing artifact is a server-side token that
is structurally unobtainable for commits that arrived by direct push. The override is bound to
that range and is not precedent.

Two follow-ups remain open and are recorded rather than resolved: the posture gap itself (while
work lands by direct push the trusted audit can never fire, so every owner-gated transition needs
an override — an owner posture decision deferred to the P1 exit), and
`R-a4314d72` (`policy_approval_token()` prints `SERVER-SIDE OWNER APPROVAL matched` for a locally
supplied token, reading as authority it does not carry).
