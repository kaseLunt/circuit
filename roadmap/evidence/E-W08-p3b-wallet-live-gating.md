---
id: E-W08-P3B-WALLET-LIVE-GATING
type: evidence
title: W08 evidence — SPEC section 3 steps 4 and 7 green with the mock connector
status: recorded
work: W08
result: pass
observed_at: 2026-07-30T16:25:00Z
tested_commit: 427bf703e9af0ee6bf05e30d9113cb035d7ad88d
environment: github-actions-ubuntu-latest-node-22 (CI run 30525638520; ci, e2e, fork, e2e-fork all green) + local-windows-node-22 (fork rig, ANVIL_PORT 8548)
input_fingerprint: sha256:e30e3c1034cb5380ade8c2f6c276b3c885d62f98e24a70ad54209e68a41beb4e
contract_fingerprint: sha256:ad6333c7774385335013a4ae64c171f6e2d457c49e3bb152d9720923360a4f2a
commands:
  - "gh run view 30525638520   # ci (coverage-enforcing), e2e, fork, e2e-fork all green at the tested commit"
  - "npm run test:coverage     # 1440 unit tests; execution glob and wallet gate held at 100/100/100 structurally"
  - "npx playwright test       # 22 hermetic beats incl. SPEC 3.4 prevention-and-override and 3.7 live gating"
  - "npm run test:e2e:fork     # the decoded-revert beat and the live-gate clearing beat through the real wallet router"
  - "npm run check:lint-boundaries   # 65 prohibited routes, each refused exactly once"
updated: 2026-07-30
---

# E-W08 — the evidence

## The target, attained

`spec-3-steps-4-and-7-green-with-mock-connector`: SPEC section 3 step 4 — the borrow past the
limit refused client-side, inline, quoting the ACTIVE eMode regime by name with the ceiling
math beside it (the protocol-exact rounding chain, pinned at the 9299/9300 boundary);
"Simulate anyway" lifts the gate and the fork returns its own decoded evidence — selector
0x6679996d, HealthFactorLowerThanLiquidationThreshold, read from the chain and never invented;
re-simulation reruns the whole bundle labelled "Re-simulate", never "Resume". SPEC section 3
step 7 — the mock connector switches the app to Live; Execute stays gated until a fresh
block-pinned simulation against real balances passes (captured through the wallet router and
our configured RPC, never the injected provider; the standing binds plan hash, snapshot
identity, and the capture readings); the section 2 footprint predicate refuses wallets already
holding a position; fabricated readings attach only to fabricated wallets. Both beats run in
Playwright with the mock connector — hermetically and on the pinned fork through the real
router. Completed live execution is deliberately NOT claimed: no dispatch path exists, and
docs/live-execution-checklist.md records the manual path and what is not wired.

## The gate behind it

The D-011 hard gate closed with an explicit Codex APPROVAL (session
019fb215-da34-7d90-ba57-48c73d9ba3e9, round 15: "No realistic D-011 blocker found") after a
fourteen-round adversarial chain — 019fafeb-era sessions 019fafe8, 019fb049, 019fb077,
019fb0bd, 019fb0e9, 019fb110, 019fb128, 019fb141, 019fb15c, 019fb173, 019fb188, 019fb1d1,
019fb1e5, 019fb1ff — twenty-six findings, every one remediated in the same round with
regressions proven to fail against the defect. The chain hardened the protocol rounding to
the pool's own arithmetic, the wallet trust boundary, the write lockdown, the session
lifecycle end to end (identity-bound standings, generation-bound arms, the exhaustive
session-refusal classifier, overwrite-on-arm pointer discipline, tombstone finality with
admission revalidation), and the control plane's own terminal-transition enforcement.
