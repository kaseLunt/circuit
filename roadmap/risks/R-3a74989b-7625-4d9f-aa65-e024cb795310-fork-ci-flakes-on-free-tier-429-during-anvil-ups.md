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

Option 1 landed 2026-07-26 in W07's attribution-extraction commit, with a correction:
`--fork-request-retries` does not exist in anvil 1.7.1; the real flags are `--retries`
(rate-limit retry count, 10) and `--fork-retry-backoff` (initial backoff, ms, 2000),
verified against the pinned binary and env-overridable per the ANVIL_CUPS pattern.

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
4. Owner-offered dRPC key (free tier includes archive). Switching is a secret-value
   change only (`FORK_RPC_URL`), no code change; key handling per the
   post-credential-leak policy — secret write-only, never in any tracked file.

P3's sandbox session service will multiply fork traffic; this risk blocks nothing today
but should be retired before that multiplier lands (hence `review_when: date:2026-08-09`).

## Option 4 verdict (2026-07-27): dRPC free tier non-viable, paid-only

Empirical, owner's free dRPC key: light head-state calls answer (~490ms), but ANY block or
state fetch at the pinned height is refused by dRPC's gateway with HTTP 408 "Request timeout
on the free plan" (code 30) after ~2.2s — 0/8 attempts, header-only included. anvil's fork
bootstrap dies on its first request, and `--retries` does not apply (408, not 429). Option 4
therefore requires a paid dRPC plan; the owner declined (correctly — no need exists while
Alchemy free carries CI). Alchemy remains primary. Keyless public endpoints re-verified the
same day: headers yes, archive state no.

## Related finding (2026-07-27): anvil-under-anvil historical-tag wedge — retired

The session service's fork drills exposed a distinct failure the 429 posture did not cover:
an anvil serving CONCURRENT state reads at a historical tag (a block behind its own head) to
a forked child wedges permanently — it stops answering even `eth_blockNumber` and never
recovers. Minimal reproduction: base mined +3 past the pin, 30 parallel reads at the pinned
tag = instant total wedge (12/12 probes dead); the identical burst against a pristine base
(head == pin) = fully healthy (~60ms). This wedge — not throttling — caused three identical
fork-job failures on PR #20 once session drills ran after the flagship suite had mined the
shared base. Retired in PR #20: the fork suite gives the session service a dedicated
never-mutated upstream anvil plus a head==PIN assertion that turns any re-arming into a loud
failure. Standing doctrine for any future shared-anvil rig (demo included): session upstreams
must be head-stable or remote. Accepted CI cost: one extra remote bootstrap per run and one
cold first capture through CUPS.
