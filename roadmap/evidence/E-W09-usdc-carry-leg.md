---
id: E-W09-USDC-CARRY-LEG
type: evidence
title: W09 evidence - the USDC carry fork-proven with the eMode constraint
status: recorded
work: W09
result: pass
observed_at: 2026-07-31T17:17:00Z
tested_commit: e8278ca48a017b65a7abf5cc2ebdda6fc25b2dce
environment: github-actions-ubuntu-latest-node-22 (CI run 30649345241; ci, e2e, fork, e2e-fork all green) + local-windows-node-22 (fork rig)
input_fingerprint: sha256:78efb0744df8e1cad4b3b7a7e0240250364a852eab91ba9d28c6ca8e1269726e
contract_fingerprint: sha256:1168040c47716525eb6ff7b4c38d57321b2a2d3fbda9f111cbc795625745b3e8
commands:
  - "gh run view 30649345241   # ci (1504 unit tests), e2e (24 incl. the carry beats), fork (33 incl. 4 carry drills), e2e-fork"
  - "npm run test:fork         # the carry end to end: attribution delta 0n, both boundary sides, hand-built negative controls"
  - "npm run test:coverage     # structural 100s intact; core globally enrolled"
  - "npx playwright test       # the regime contrast on screen, figures computed never typed"
updated: 2026-07-31
---

# E-W09 - the evidence

## The target, attained

`usdc-carry-template-fork-proven-with-emode-constraint`: the carry template - supply weETH,
borrow USDC, no eMode, owner-ratified 6000 bps - composes, simulates, and executes on the
fork with every W07/W08 invariant holding for the USDC leg (transfer-event attribution at
exact equality, zero-after-consume, no USDC approve in any plan). The eMode-category
constraint is compiler-enforced and unit-proven, and the raw revert is fork-proven by
hand-constructed calldata exactly as designed - the product path refuses before calldata
exists, so the drills build their own: borrow(USDC) under eMode 1 reverts
NotBorrowableInEMode, setUserEMode(1) with USDC debt reverts InvalidDebtInEmode, both
selectors chain-observed and self-tested. The client ceiling is proven on BOTH sides of the
line: allocation 7749 settles through the product path with the chain debt byte-identical
to the prediction at the mine timestamp, and 7750 reverts - with the pacing drill proving
the gate holds under arbitrary mine latency. The risk contrast renders honestly: the carry
sits in the amber band at the non-eMode regime (7750/8000) with its own liquidation pair
and the depeg direction stated (USDC downside raises carry HF); no dollar assumption exists
anywhere - the oracle is Capped USDC/USD at its read value, quoted through provenance. The
README shows the demo GIF and the five-check merge gate (objective 0).

## The gate behind it

The D-011 hard gate closed with an explicit Codex APPROVAL (session
019fb8f5-a1fc-77e2-b648-2bb0e078ef88, round 8: no material adversarial finding remains)
after an eight-round chain - 019fb53e, 019fb586, 019fb610, 019fb643, 019fb668, 019fb691,
review-ms8ihcp9, APPROVAL - fifteen findings, every one remediated in the same round with
regressions proven to fail against the defect. The chain caught two real money bugs before
any user saw them (the terminal carry priced as a leveraged loop with a sign-flipped net
APY; allocation-nominal exposures that misprice exactly when the documented oracle cap
binds - the composition is now realized-value-exact over both equity and borrowed sinks
with the additive run-rate form proven against divergent-oracle fixtures), made the exact
boundary proof accrual-sound after CI itself caught a one-ceil-step timestamp freedom, and
consolidated the fork suites onto one shared pristine upstream closing the recorded flake
risk R-3a74989b.
