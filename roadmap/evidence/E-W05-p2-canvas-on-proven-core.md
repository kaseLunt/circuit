---
id: E-W05-P2-CANVAS-ON-PROVEN-CORE
type: evidence
title: W05 — SPEC §3 steps 1–3 and 8 green in Playwright on mock reads, in CI
status: recorded
work: W05
result: pass
observed_at: 2026-07-26T20:36:30Z
tested_commit: b9a825a437da8322da56de0f27ae44f491cf7ed9
environment: github-actions-ubuntu-latest-node-22 + playwright-chromium (production build) + anvil-v1.7.1 + codex-phase-session-019fa026
input_fingerprint: sha256:5703ee22fb39e775f3859e089fd47030a95b33e71988ad1571c35f457d03851f
contract_fingerprint: sha256:62811552afcfb58d24e8060da41ae3a037f45a055f0f148c1db4ccc53b380d41
commands:
  - "npm run test:e2e   # CI job `e2e`, required check — 16 passing incl. §3 steps 1-3 + 8"
  - "npm run build && npm run typecheck && npm run lint && npm run check:scripts && npm test   # 721 passing"
  - "FORK_RPC_URL=<archive-secret> npm run test:fork   # CI job `fork`, required check"
  - "gh run view <main-run-at-tested-commit>   # ci/fork/e2e conclusions at b9a825a"
updated: 2026-07-26
---

# E-W05 — the P2 evidence target, met in CI

## The target and its evidence

`spec-3-steps-1-3-and-8-green-in-playwright-on-mock-reads`. The `e2e` job runs
`e2e/demo-script.spec.ts` (16 tests) against a production build on every PR and is a
**required check** on `main` alongside `Trusted audit`, `ci` and `fork`. At the tested
commit the full ladder is green — CI run 30220090728 on `main` at `b9a825a` (ci, fork,
e2e all success), preceded by the same three checks green on the merge-gated heads of
every PR in the range (PRs #5–#14, range `fe5f065..b9a825a`).

What the suite proves, step by step: **§3 step 1** — land → Try sandbox → nine flagship
blocks and eight edges by id, Sandbox badge, pinned-block citation, slider at the shipped
5000 bps. **§3 step 2** — supply APY, borrow APY and the trailing staking APR located by
the values `core/risk.ts` computes over the same snapshot, every observed line in every
derivation tree matching `observed <method> @ block <n> · <block time>`, the cross-block
window citing both read points, nothing left `aria-busy`, no placeholder values. **§3
step 3** — twenty real ArrowRight presses 5000→7000; displayed HF and liquidation ratio
equal `simulate()` through the same formatters (the displayed-HF-equals-core pin is also
a unit assertion against an independently constructed `computeHealthFactor`); the
valid→warning crossing lands at 6400 bps with exactly one live-region announcement.
**§3 step 8** — the copied `#g=` fragment decodes through the one pipeline to the
fork-proven graph; a fresh browser context rehydrates the identical signature including
the derived HF and warning state; the W03 hostile payload and a damaged token arriving
by URL land the refusal with zero nodes and no substitution.

## Gates the phase passed

Every core/money commit in the range carries an individual **D-007 Codex approval**
(fourteen review threads across four commits; final approvals 019f9d2d (risk),
019f9dc4 (shell provenance), 019fa00c (window batch)). Every visual batch carries a
design-director verdict, closed **AT THE BAR** — including one full director succession
run entirely on the written record. The **phase-exit review** (Codex session 019fa026)
audited the range `fe5f065..db83115` at phase grain: all 34 deliverables exist,
acceptance criteria met, core purity and money rules verified by sweep — and withheld
on four findings, each remediated before this receipt: (1) the numeric-`??` ban extended
src/-wide (PR #14); (2) the edge popover's Disconnect hover brought inside the 4.5:1 AA
floor and back to the button API's destructive-is-irreversible grammar (PR #14); (3) the
record gaps closed — Q2/Q5 dispositions below, the fork-flake posture recorded as
`R-3a74989b`, the FCP measurement made durable as a CI notice (PR #14); (4) exact CI
evidence and the prerequisite drift receipts recorded here and in E-W01-R4 / E-W03-R3 /
E-W04-R3.

## Deviation ledger — final dispositions

D1 saved-loops omission (ratified non-goal; dead type deleted, PR #13) · D2 min-HF
provenance (closed by `core/risk.ts` + canvas wiring) · D3 unlayered canvas.css
(ratified) · D4 control positions (ratified, display-gated) · D5 live regions 3+6=9
(ratified) · D6 coverage weight (closed, PR #13) · D7 StrategyCanvas API +
stale-while-revalidate (closed) · D8 bps slider (closed) · D9–D11 (recorded final-state
choices) · **Q1** window split (closed by the window commit) · **Q2** `derivedOverWindow`
ratified with the inverse ≥2-distinct-blocks guard — landed in the window commit,
recorded here per phase finding 3 · **Q3** trailing APR used directly, labelled APR
(landed; the rate-kind is structural) · **Q4** oracle-stack 1:1 valuations (landed;
assumptions named in derivation strings) · **Q5** type move `SimulationResult`/
`ComputedBlockValue`/`YieldSource` into core with re-exports — landed in PR #7,
recorded here per phase finding 3 · **Q6** gas stays null through P2 (open by design,
P3a; every gas slot renders the director-ruled "not quoted" grammar).

## Known hazards, recorded

`R-3a74989b`: the fork CI job can 429-flake in anvil's upstream storage fetch on the
free-tier archive endpoint; posture is rerun-once (a second consecutive failure is a
finding), retirement options queued for P3 entry. The ~53–92 ms shell→canvas FCP gap is
a React Flow SSR property, measured per run and emitted as a durable CI notice.
