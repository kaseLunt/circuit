---
id: E-W01-P0-BOOTSTRAP-R5
type: evidence
title: W01 drift review at the W06 boundary — root docs added, substance intact
status: recorded
work: W01
result: pass
observed_at: 2026-07-26T22:30:00Z
tested_commit: 3c6da9ff3409fac46a913036f5804d094758d306
environment: github-actions-ubuntu-latest-node-22 (CI run 30224076696 at the tested commit)
input_fingerprint: sha256:72c79e3ae73f569b4203a9a4fe599475dd9aa26d76daf43ff5659cddd41cfcd7
contract_fingerprint: sha256:37d7710bf54febceff16e8771961cb42b45e35d89bbc2420bf0c3b45453198c6
commands:
  - "gh run view 30224076696   # ci/fork/e2e green on main at the tested commit"
updated: 2026-07-26
---

# E-W01-R5 — drift review (event:invalidated-by-change), W06 boundary

Supersedes `E-W01-p0-bootstrap-r4.md`, which stands as the historical record.

The drift: PR #16 added `README.md` and `LICENSE` at the repo root, and the closing PR added the ray gloss, all inside W01's
invalidation inputs. Neither changes any W01 claim; they are additive documentation on the
scaffolding W01 attested. The full check ladder ran green on `main` at the tested commit
(CI run 30224076696: ci, fork, e2e).
