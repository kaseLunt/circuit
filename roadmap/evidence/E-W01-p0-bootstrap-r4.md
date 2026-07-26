---
id: E-W01-P0-BOOTSTRAP-R4
type: evidence
title: W01 drift review at the W05 close — bootstrap substance intact under accretion
status: recorded
work: W01
result: pass
observed_at: 2026-07-26T20:36:30Z
tested_commit: b9a825a437da8322da56de0f27ae44f491cf7ed9
environment: local-windows-node-22 + github-actions-ubuntu-latest-node-22
input_fingerprint: sha256:0e7bd2bf47317bab7c7c5cf27f759eb79f0845a5cd2826407612ff8820831855
contract_fingerprint: sha256:37d7710bf54febceff16e8771961cb42b45e35d89bbc2420bf0c3b45453198c6
commands:
  - "npm run build && npm run typecheck && npm run lint && npm run check:scripts && npm test"
updated: 2026-07-26
---

# E-W01-R4 — drift review (event:invalidated-by-change), W05 close

Supersedes `E-W01-p0-bootstrap-r3.md`, which stands as the historical record. This receipt
services the REVIEW-DUE drift doctor reported after the W05 range (PRs #5–#13) touched W01's
invalidation inputs.

**Nature of the drift: accretion, not contradiction.** W05 extended the configs W01
established — `eslint.config.mjs` gained the components-path money bans and two declared
console writers; `vitest.config.ts` gained the deliberate coverage enrolments; `tsconfig`/
`package.json` gained the Playwright toolchain. No W01 claim is weakened: the scaffolding,
toolchain pins and command surface it attested still exist and still run. Re-verified at the
tested commit: build, typecheck, zero-warning lint, check:scripts and the full unit suite
(721 passing) all green — the same canonical commands the original receipt recorded, on the
grown tree.
