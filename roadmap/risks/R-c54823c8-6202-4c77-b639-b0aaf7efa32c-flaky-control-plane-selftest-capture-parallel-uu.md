---
id: R-c54823c8-6202-4c77-b639-b0aaf7efa32c
type: risk
title: "Flaky control-plane selftest: capture:parallel-uuid-ids"
status: open
informs: []
review_when: date:2026-08-07
updated: 2026-07-24
---

# R-c54823c8-6202-4c77-b639-b0aaf7efa32c — Flaky control-plane selftest: capture:parallel-uuid-ids

## Context

`capture:parallel-uuid-ids` in `roadmap/tools/selftest.py` failed once and passed on an
immediate re-run of the same commit, with no intervening change. Observed 2026-07-24 while
landing D-008; the D-008 edits do not touch `new.py` or any capture path.

## Evidence

The failing run reported `capture: FAIL -- capture target: destination escapes repository root`
from one of the parallel `new.py` spawns, while six sibling spawns in the same batch succeeded
and wrote well-formed `roadmap/ideas/IDEA-<uuid>-same-title.md` files. The error originates in
the `safe_worktree_path` / `normalize_repo_path` containment check, which suggests a transient
path-resolution disagreement (realpath vs. the repo root the child computes) rather than a
genuine traversal attempt — plausibly a Windows temp-dir short-path/symlink resolution race
under concurrent spawns.

## Consequence

A control-plane test that fails intermittently is corrosive in both directions: it trains the
integrator to re-run rather than investigate, and it could mask a real containment regression.
It also makes the selftest unsuitable as a required CI check until deterministic. The
containment check itself is failing *closed* (refusing the write), so the risk is to
confidence and to CI signal, not to repository integrity.

Resolution path: make the child's repo-root resolution canonical and identical to the parent's
(resolve once, pass it down rather than recomputing per process), then assert the check with a
deterministic fixture instead of relying on concurrent spawns to surface it.
