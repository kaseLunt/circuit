---
id: R-3a74989b-7625-4d9f-aa65-e024cb795310
type: risk
title: "fork CI flakes on free-tier 429s during anvil upstream storage fetch"
status: open
informs: []
review_when: date:2026-08-09
updated: 2026-07-26
---

# R-3a74989b — fork CI flakes on free-tier 429s during anvil upstream storage fetch

## Context

The `fork` CI job runs anvil against a free-tier Alchemy archive endpoint. Two throttle
surfaces exist: `anvil_reset` (fetching the fork block) and anvil's lazy upstream storage
fetches while tests execute (surfacing as `failed to get storage … Max retries exceeded
HTTP error 429` inside multicall reverts). The first is hardened — `rpcWithRetry`
(5 attempts, 2s linear backoff, `tests/fork/harness.ts`) landed in the W05 window commit.
The second is inside anvil, not the suite, and still flakes: across the last five CI
executions of the W05 close, three needed exactly one rerun (PR #12 initial run, PR #13
initial run + its rerun racing a second throttle window). `ANVIL_CUPS=100`
(`--compute-units-per-second`) already smooths steady-state load; the flake is burst
shaped, concentrated where the clean-fork describe re-forks and captures a full snapshot.

## Disposition (P3 entry review, 2026-07-26 — E-W06)

The two pressures separate: GitHub Actions minutes exhaustion is retired by the public
flip (public repos meter no minutes). The Alchemy free-tier 429 remains open with
retirement option 1 chosen: anvil `--fork-retry-backoff` / `--fork-request-retries`
flags land in W07's first fork-suite commit. The date clock above checks that landing.

## Posture (current, recorded rather than implied)

**Rerun-once.** A 429 failure is environmental, not evidential: the assertions the job
exists for (checkpoint HF cross-check, exact matched-timestamp rate equality) are
deterministic once reads succeed, and no assertion is weakened by rerunning. A SECOND
consecutive failure is treated as a finding, not a throttle.

## Retirement options (P3 entry, pick one)

1. anvil-level retry flags on the upstream fetch path (`--fork-retry-backoff`,
   `--fork-request-retries`) — suite-side, no money change.
2. A paid-tier or dedicated archive key for CI (owner decision; key handling per the
   post-credential-leak policy — secret write-only, never in any tracked file).
3. Serializing the two fork describes' capture phases to halve burst concurrency.

P3's sandbox session service will multiply fork traffic; this risk blocks nothing today
but should be retired before that multiplier lands (hence `review_when: date:2026-08-09`).
