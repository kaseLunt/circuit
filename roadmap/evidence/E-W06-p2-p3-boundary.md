---
id: E-W06-P2-P3-BOUNDARY
type: evidence
title: W06 — README and LICENSE landed, P3 charter ratified, entry items dispositioned
status: recorded
work: W06
result: pass
observed_at: 2026-07-26T22:30:00Z
tested_commit: 3c6da9ff3409fac46a913036f5804d094758d306
environment: github-actions-ubuntu-latest-node-22 (CI run 30224076696) + humanizer-skill-2.9.1
input_fingerprint: sha256:345fe2c1bff35f230a362fbda26ead36a2d26962af971804adb0011543cfbfb6
contract_fingerprint: sha256:b54e766881fb538d7c1f38dd5f5d995c98c61aa691089ff5d682eed15a50dc9d
commands:
  - "python style-ban sweep over README.md   # zero dash-family chars, banned vocabulary, negative parallelisms, bold spans"
  - "gh run view 30224076696   # ci/fork/e2e green on main at the tested commit"
updated: 2026-07-26
---

# E-W06 — the boundary's evidence

## README and LICENSE

PR #16 (merge 2e44af2) landed both at the root. The README passed the owner's style rules
and the humanizer skill's 33-pattern audit (mechanical sweep on record: zero dash-family
characters, banned vocabulary, negative parallelisms, curly quotes, and bold spans). Every
number, commit SHA, and review-thread ID in it traces to the repo. The owner read and
approved the draft before it landed, and approved the ray gloss added in the closing PR.
The demo GIF ships commented out behind a TODO with the director's choreography preserved
as a production note.

## P3 charter

`roadmap/work/W07-p3-execution.md` exists as `candidate` with 27 concrete deliverables and
no globs, drafted from the sentinel's execution treatment (eight surfaces, the 19-seam
attack table, the resumePlan and riskLedger-seeding pre-findings, and the directive that
`src/lib/execution/attribution.ts` and the fork suite consume one implementation).
Activation is a later owner-gated transition; `depends_on: [W05, W06]` holds it until this
boundary is achieved.

## P3-entry dispositions

- **R-3a74989b (fork CI flakes).** Two pressures were conflated and are now separated: the
  GitHub Actions minutes exhaustion is retired by the public flip (public repos meter no
  minutes); the Alchemy free-tier 429 during anvil's upstream storage fetch remains open
  with retirement option 1 chosen (anvil `--fork-retry-backoff` / `--fork-request-retries`
  flags, suite-side, no owner dependency) to land in W07's first fork-suite commit. The
  rerun-once posture stands until then.
- **`pull_request_target` fork-PR surface (opened by the public flip).** Reviewed at the
  boundary: the privileged audit job executes only default-branch policy code
  (`CONTROL_PLANE_TRUST_REF`), checks out PR content as inert data with
  `persist-credentials: false`, and never executes candidate files; the advisory tier runs
  unprivileged on `pull_request`. `secrets.FORK_RPC_URL` rides a plain `pull_request`
  trigger, which GitHub withholds from external fork PRs, so external PRs fail the fork
  gate closed. Recorded residuals: external contributors cannot pass the `fork` check
  (accepted for now), and `scope_diff.py` parses hostile candidate bytes in the privileged
  job (pure-Python parsing, no execution of candidate content; accepted).
- **Persona policy.** circuit-sentinel consults precede implementation on every P3
  execution surface; circuit-taste gates every visual batch; both run at native fable.
  Public-facing prose passes the humanizer skill before landing.
