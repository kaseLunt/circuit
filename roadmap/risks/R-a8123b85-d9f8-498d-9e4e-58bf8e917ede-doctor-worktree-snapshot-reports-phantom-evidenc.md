---
id: R-a8123b85-d9f8-498d-9e4e-58bf8e917ede
type: risk
title: "doctor worktree snapshot reports phantom evidence invalidation under core.autocrlf"
status: open
informs: []
review_when: date:2026-08-08
updated: 2026-07-25
---

# R-a8123b85-d9f8-498d-9e4e-58bf8e917ede — doctor worktree snapshot reports phantom evidence invalidation under core.autocrlf

## Context

`verification_input_fingerprint` / `snapshot_fingerprint` hash each matched path's **file bytes**
(`_control_plane.py:497`). On a checkout with `core.autocrlf=true`, tracked text files are CRLF on
disk and LF in the object store, so the byte hash of the worktree can never equal the byte hash of
any commit or the index. Receipt validation requires
`recorded == tested == current` (`doctor.py:340-357`), where `current` comes from the doctor's
snapshot — which defaults to `worktree`.

## Evidence

Observed 2026-07-25 at commit `99832bd`, immediately after W03 became `achieved` with a stamped
receipt:

| Snapshot | Result |
|---|---|
| `--snapshot HEAD` | OK — 0 errors |
| `--snapshot index` | OK — 0 errors |
| `--snapshot worktree` (the default) | FAIL — `current inputs/deliverables differ from the tested commit` |

`doctor.py --receipt-basis W03` returns the identical `input_fingerprint`
(`sha256:b0affcbf…`) and `contract_fingerprint` (`sha256:34a2db1a…`) at both `5cb5ee4` and
`99832bd`, and those are exactly the values the receipt records — so nothing has drifted.
`git config core.autocrlf` is `true` and `file src/core/plan.ts` reports CRLF terminators while the
committed blob is LF.

## Consequence

Any bare `python roadmap/tools/doctor.py` on a Windows checkout reports phantom evidence
invalidation as soon as a work item has a receipt covering byte-hashed deliverables. This is
corrosive in a specific way: it is indistinguishable at a glance from genuine staleness, which is
the signal the whole evidence-freshness mechanism exists to provide. A future integrator following
W03's own canonical-commands list — which prescribes exactly that bare invocation — will hit it and
may reasonably conclude the receipt is stale, or worse, learn to ignore the error.

The authoritative paths are unaffected: the pre-commit hook uses `--snapshot index` and CI uses
`--snapshot <sha>`, both of which read the object store. So this is a false negative in local
diagnosis, not a hole in enforcement.

Resolution options, in rough order of preference:
1. Normalise bytes before hashing text files in `snapshot_fingerprint` (strip CR), so worktree and
   object-store views agree.
2. Have the worktree snapshot read blobs via `git show :path` / `git cat-file` rather than the
   filesystem, making every snapshot object-store-based.
3. Add `* text=auto eol=lf` to `.gitattributes` so checkouts are LF — narrower, and does not fix
   an existing CRLF working copy.
4. Failing all of the above, default `--snapshot` to `index` and document that `worktree` is
   advisory. Weakest option: it hides rather than fixes the inconsistency.

Per RULES §23 the fix should carry a regression check that hashes a CRLF fixture and asserts the
worktree and commit snapshots agree.
