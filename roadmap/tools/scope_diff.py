#!/usr/bin/env python3
"""Review BASE..HEAD commit-by-commit against each parent snapshot's authority.

This ordering lets an isolated metadata commit establish or rotate a claim for later
commits in the same PR, while ensuring metadata can never authorize product paths in
its own commit.  Every changed path, including both rename/copy paths, is checked.
Missing refs and Git failures are fatal.

Usage:
  python roadmap/tools/scope_diff.py BASE HEAD [--agent ID] [--branch NAME]
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import os
import re
import sys

from _control_plane import (
    ControlPlaneError,
    Snapshot,
    commit_exists,
    is_ancestor,
    parse_frontmatter,
    parse_scope,
    parse_utc,
    repo_root,
    run_git,
    scalar,
    scope_contains,
    scope_matches,
    string_list,
    validate_lease,
)
from scope_gate import (
    IMMUTABLE_CLAIM_FIELDS,
    STATUS_TRANSITIONS,
    TERMINAL_CLAIM_STATUSES,
    _field,
    active_claims,
    changed_paths,
    claim_records,
    is_adoption_path,
    is_protected,
    owner_transition_reasons,
    parse_diff_name_status,
    read_status,
    validate_claim,
    validate_immutable_records,
    work_scope_expansions,
)


TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = repo_root(TOOLS)
ZERO_SHA = "0" * 40


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("head")
    parser.add_argument("--agent")
    parser.add_argument("--branch")
    parser.add_argument("--check-live-lease", action="store_true")
    parser.add_argument("--now", help="strict UTC clock override for deterministic tests")
    parser.add_argument("--allow-initial", action="store_true")
    parser.add_argument("--pull-request-number", default="")
    parser.add_argument(
        "--policy-approval",
        default="",
        help="server-side CONTROL_PLANE_POLICY_APPROVAL token for this PR/base/head tuple",
    )
    parser.add_argument(
        "--print-policy-approval-token",
        action="store_true",
        help="print the canonical token for an administrator to set server-side",
    )
    return parser.parse_args()


def committed_changes(parent: str, commit: str):
    result = run_git(
        REPO,
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies",
        f"{parent}..{commit}",
        "--",
    )
    return parse_diff_name_status(result.stdout)


def commits_in_range(base: str, head: str) -> list[str]:
    if not is_ancestor(REPO, base, head):
        raise ControlPlaneError(f"base '{base}' is not an ancestor of head '{head}'")
    output = run_git(
        REPO, "rev-list", "--reverse", "--first-parent", f"{base}..{head}"
    ).stdout
    return [line for line in output.splitlines() if line]


def first_parent(commit: str) -> str:
    line = run_git(REPO, "rev-list", "--parents", "-n", "1", commit).stdout.strip()
    parts = line.split()
    if len(parts) < 2:
        raise ControlPlaneError(f"commit '{commit}' has no parent authority snapshot")
    return parts[1]


def commit_parents(commit: str) -> list[str]:
    line = run_git(REPO, "rev-list", "--parents", "-n", "1", commit).stdout.strip()
    parts = line.split()
    if not parts:
        raise ControlPlaneError(f"commit '{commit}' is unavailable")
    return parts[1:]


def commit_tree(commit: str) -> str:
    return run_git(REPO, "rev-parse", "--verify", f"{commit}^{{tree}}").stdout.strip()


def writer_mode(snapshot: Snapshot) -> None:
    mode = scalar(read_status(snapshot), "writer_mode", "roadmap/STATUS.md", required=True)
    if mode != "serial":
        raise ControlPlaneError(
            f"{snapshot.source}: writer_mode '{mode}' is unsupported by this serial runtime"
        )


def work_by_id(snapshot: Snapshot) -> dict[str, tuple[str, dict]]:
    result: dict[str, tuple[str, dict]] = {}
    for path in snapshot.list("roadmap/work", ".md"):
        data = parse_frontmatter(snapshot.read_text(path), path, required=True)
        object_id = scalar(data, "id", path, required=True)
        if object_id in result:
            raise ControlPlaneError(f"duplicate work id '{object_id}'")
        result[object_id] = (path, data)
    return result


def scope_expansions(parent: Snapshot, commit: Snapshot) -> list[str]:
    return work_scope_expansions(parent, commit)


def require_owner_approval(
    args: argparse.Namespace,
    commit_ref: str,
    reasons: list[str],
) -> str | None:
    if not reasons:
        return None
    if getattr(args, "merge_replay_depth", 0) > 0:
        return (
            f"{commit_ref[:12]}: POST-MERGE REPLAY assumes the trusted pre-merge "
            "PR/base/head owner approval was enforced externally: "
            + "; ".join(reasons)
        )
    expected = policy_approval_token(
        args.pull_request_number, args.resolved_base, args.resolved_head
    )
    approved = args.policy_approval.strip()
    if approved != expected:
        raise ControlPlaneError(
            f"{commit_ref}: owner-gated transition requires repository variable "
            "CONTROL_PLANE_POLICY_APPROVAL to match the canonical PR/base/head token; "
            f"context is PR {args.pull_request_number or '<missing>'}, base "
            f"{args.resolved_base}, head {args.resolved_head}; reasons: "
            + "; ".join(reasons)
        )
    return (
        f"{commit_ref[:12]}: SERVER-SIDE OWNER APPROVAL matched PR/base/head token: "
        + "; ".join(reasons)
    )


def policy_approval_token(pr_number: str, base_sha: str, head_sha: str) -> str:
    if not re.fullmatch(r"[1-9][0-9]*", str(pr_number)):
        raise ControlPlaneError("owner approval requires a positive decimal pull-request number")
    for label, value in (("base", base_sha), ("head", head_sha)):
        if not re.fullmatch(r"[0-9a-f]{40}", value):
            raise ControlPlaneError(
                f"owner approval {label} must be a full lowercase commit SHA"
            )
    payload = (
        b"control-plane-policy-approval-v1\0"
        + str(pr_number).encode("ascii")
        + b"\0"
        + base_sha.encode("ascii")
        + b"\0"
        + head_sha.encode("ascii")
    )
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def validate_claim_change(
    parent: Snapshot,
    commit: Snapshot,
    claim_path: str,
    before: dict,
    paths: list[str],
    now: dt.datetime,
) -> str | None:
    if not commit.exists(claim_path):
        raise ControlPlaneError(f"{claim_path}: deletion is forbidden; record a terminal status")
    after = parse_frontmatter(commit.read_text(claim_path), claim_path, required=True)
    changed_immutable = any(
        _field(before, key) != _field(after, key) for key in IMMUTABLE_CLAIM_FIELDS
    )
    if changed_immutable:
        if any(not path.startswith("roadmap/") for path in paths):
            raise ControlPlaneError(
                "claim rotation/scope change must be isolated from product paths"
            )
        for key in ("agent", "task", "integrator"):
            if _field(before, key) != _field(after, key):
                raise ControlPlaneError(f"{claim_path}: rotation changed stable field '{key}'")
        binding_changed = any(
            _field(before, key) != _field(after, key)
            for key in ("branch", "worktree_id")
        )
        if binding_changed and (
            _field(before, "allowed_paths") != _field(after, "allowed_paths")
            or _field(before, "scope_hash") != _field(after, "scope_hash")
        ):
            raise ControlPlaneError(
                f"{claim_path}: rebind/takeover may not change claim scope"
            )
        old_generation = scalar(before, "generation", claim_path, required=True)
        new_generation = scalar(after, "generation", claim_path, required=True)
        if not old_generation.isdigit() or not new_generation.isdigit():
            raise ControlPlaneError(f"{claim_path}: rotation generation must be numeric")
        if int(new_generation) != int(old_generation) + 1:
            raise ControlPlaneError(f"{claim_path}: rotation must increment generation by one")
        if scalar(before, "claim_id", claim_path) == scalar(after, "claim_id", claim_path):
            raise ControlPlaneError(f"{claim_path}: rotation requires a new claim_id")
        if scalar(after, "status", claim_path, required=True) != "active":
            raise ControlPlaneError(f"{claim_path}: rotated claim must remain active")
        if scalar(after, "base_commit", claim_path, required=True) != parent.commit:
            raise ControlPlaneError(
                f"{claim_path}: rotated claim must bind to its parent commit"
            )
        validate_claim(
            REPO,
            commit,
            claim_path,
            after,
            now,
            check_local_binding=False,
            descendant=commit.source,
            check_expiry=False,
        )
        return "rebind" if binding_changed else "rotation"

    before_status = scalar(before, "status", claim_path, required=True)
    after_status = scalar(after, "status", claim_path, required=True)
    if after_status not in STATUS_TRANSITIONS.get(before_status, {before_status}):
        raise ControlPlaneError(
            f"{claim_path}: invalid status transition {before_status} -> {after_status}"
        )
    validate_lease(
        after,
        claim_path,
        now,
        active=after_status == "active",
        check_live=False,
    )
    return None


def validate_reopen(
    parent: Snapshot,
    commit: Snapshot,
    path: str,
    before: dict,
    after: dict,
    now: dt.datetime,
) -> bool:
    if scalar(before, "status", path, required=True) not in TERMINAL_CLAIM_STATUSES:
        raise ControlPlaneError(f"{path}: only a terminal claim may be reopened")
    if scalar(after, "status", path, required=True) != "active":
        raise ControlPlaneError(f"{path}: reopened claim must be active")
    for key in ("agent", "integrator"):
        if _field(before, key) != _field(after, key):
            raise ControlPlaneError(f"{path}: reopen changed stable field '{key}'")
    binding_changed = any(
        _field(before, key) != _field(after, key)
        for key in ("branch", "worktree_id")
    )
    old_generation = scalar(before, "generation", path, required=True)
    new_generation = scalar(after, "generation", path, required=True)
    if not old_generation.isdigit() or not new_generation.isdigit():
        raise ControlPlaneError(f"{path}: reopen generation must be numeric")
    if int(new_generation) != int(old_generation) + 1:
        raise ControlPlaneError(f"{path}: reopen must increment generation by one")
    if scalar(before, "claim_id", path) == scalar(after, "claim_id", path):
        raise ControlPlaneError(f"{path}: reopen requires a new claim_id")
    if scalar(after, "base_commit", path) != parent.commit:
        raise ControlPlaneError(f"{path}: reopened claim must bind to its parent commit")
    validate_claim(
        REPO,
        commit,
        path,
        after,
        now,
        check_local_binding=False,
        descendant=commit.source,
        check_expiry=False,
    )
    return binding_changed


def validate_claim_record_set(
    parent: Snapshot,
    commit: Snapshot,
    selected: str,
    bootstrap: bool,
    paths: list[str],
    now: dt.datetime,
) -> bool:
    changed = {
        path
        for path in paths
        if path.startswith("roadmap/claims/CLAIM-") and path.endswith(".md")
    }
    if not changed:
        return False
    before = dict(claim_records(parent))
    after = dict(claim_records(commit))
    binding_takeover = False
    for path in sorted(changed):
        if path == selected:
            if bootstrap and path in before:
                binding_takeover = validate_reopen(
                    parent, commit, path, before[path], after[path], now
                )
            continue
        if path in before and path not in after:
            raise ControlPlaneError(f"{path}: claim records may not be deleted")
        if path not in before:
            raise ControlPlaneError(f"{path}: new claim is not the selected serial binding")
        if parent.read_bytes(path) != commit.read_bytes(path):
            raise ControlPlaneError(f"{path}: terminal/non-authority claim records are immutable")
    return binding_takeover


def evaluate_commit(
    parent_ref: str,
    commit_ref: str,
    args: argparse.Namespace,
    now: dt.datetime,
) -> list[str]:
    parent = Snapshot(REPO, parent_ref)
    commit = Snapshot(REPO, commit_ref)
    changes = committed_changes(parent.source, commit.source)
    paths = changed_paths(changes)
    if not paths:
        return []

    # Fresh installation into a mature repository: explicit, isolated, and loudly reviewable.
    if not parent.exists("roadmap/STATUS.md"):
        if not commit.exists("roadmap/STATUS.md"):
            raise ControlPlaneError(
                f"{commit_ref}: parent has no control plane and commit is not an adoption"
            )
        violations = [path for path in paths if not is_adoption_path(path)]
        if violations:
            raise ControlPlaneError(
                f"{commit_ref}: adoption is not isolated: {', '.join(violations)}"
            )
        writer_mode(commit)
        warnings = [
            f"{commit_ref[:12]}: ISOLATED ADOPTION; no parent authority existed"
        ]
        approval = require_owner_approval(
            args, commit_ref, ["isolated control-plane adoption"]
        )
        if approval:
            warnings.append(approval)
        return warnings

    writer_mode(parent)
    writer_mode(commit)
    validate_immutable_records(parent, commit, paths)
    protected = [path for path in paths if is_protected(path)]
    warnings: list[str] = []
    owner_reasons: list[str] = []
    if protected:
        if any(not (is_adoption_path(path) or is_protected(path)) for path in paths):
            raise ControlPlaneError(
                f"{commit_ref}: protected enforcement change is mixed with product paths"
            )

    expansions = scope_expansions(parent, commit)
    owner_reasons.extend(owner_transition_reasons(parent, commit, paths))

    base_claims = active_claims(parent)
    if len(base_claims) > 1:
        raise ControlPlaneError(f"{parent_ref}: serial parent has multiple active claims")
    if base_claims:
        claim_path, claim = base_claims[0]
        agent = scalar(claim, "agent", claim_path, required=True)
        if args.agent and args.agent != agent:
            raise ControlPlaneError(f"{commit_ref}: agent '{args.agent}' does not own parent claim")
        if scalar(claim, "integrator", claim_path, required=True) != "true":
            raise ControlPlaneError(f"{commit_ref}: serial claim is not an explicit integrator")
        scopes = list(
            validate_claim(
                REPO,
                parent,
                claim_path,
                claim,
                now,
                check_local_binding=False,
                descendant=commit.source,
                check_expiry=False,
            )
        )
        scopes.append(parse_scope("roadmap/**"))
        if protected:
            # Isolation above is the meaningful protection; include paths for matching only.
            scopes.extend(parse_scope(path) for path in protected)
        claim_change = None
        if claim_path in paths:
            claim_change = validate_claim_change(
                parent, commit, claim_path, claim, paths, now
            )
        expected_branch = scalar(claim, "branch", claim_path, required=True)
        if claim_change == "rebind":
            rebound = parse_frontmatter(
                commit.read_text(claim_path), claim_path, required=True
            )
            expected_branch = scalar(rebound, "branch", claim_path, required=True)
            owner_reasons.append("active claim rebind/takeover with unchanged scope")
        if args.branch and expected_branch != args.branch:
            raise ControlPlaneError(f"{commit_ref}: claim branch differs from '{args.branch}'")
        label = f"integrator {agent}"
        selected_claim = claim_path
        bootstrap_claim = False
    else:
        head_claims = active_claims(commit)
        if len(head_claims) > 1:
            raise ControlPlaneError(f"{commit_ref}: serial commit has multiple active claims")
        if head_claims:
            path, claim = head_claims[0]
            if scalar(claim, "integrator", path, required=True) != "true":
                raise ControlPlaneError(f"{commit_ref}: new serial claim is not integrator: true")
            if args.agent and scalar(claim, "agent", path, required=True) != args.agent:
                raise ControlPlaneError(f"{commit_ref}: new claim agent mismatch")
            if args.branch and scalar(claim, "branch", path, required=True) != args.branch:
                raise ControlPlaneError(f"{commit_ref}: new claim branch mismatch")
            if scalar(claim, "base_commit", path, required=True) != parent.commit:
                raise ControlPlaneError(
                    f"{path}: new/reopened claim must bind to its parent commit"
                )
            validate_claim(
                REPO,
                commit,
                path,
                claim,
                now,
                check_local_binding=False,
                descendant=commit.source,
                check_expiry=False,
            )
            label = "claim bootstrap"
            selected_claim = path
            bootstrap_claim = True
        else:
            label = "serial setup"
            selected_claim = ""
            bootstrap_claim = False
        scopes = [parse_scope("roadmap/**")]
        if protected:
            scopes.extend(parse_scope(path) for path in protected)

    reopened_takeover = validate_claim_record_set(
        parent, commit, selected_claim, bootstrap_claim, paths, now
    )
    if reopened_takeover:
        owner_reasons.append("terminal claim record moved to another branch/worktree")

    if expansions and any(not path.startswith("roadmap/") for path in paths):
        raise ControlPlaneError(
            f"{commit_ref}: allowed_paths expansion is not metadata-only: "
            + "; ".join(expansions)
        )
    violations = [path for path in paths if not any(scope_matches(scope, path) for scope in scopes)]
    if violations:
        raise ControlPlaneError(
            f"{commit_ref}: {label} changed paths outside parent authority: "
            + ", ".join(violations)
        )
    if expansions:
        warnings.append(
            f"{commit_ref[:12]}: metadata-only scope expansion applies only to later commits: "
            + "; ".join(expansions)
        )
    approval = require_owner_approval(args, commit_ref, owner_reasons)
    if approval:
        warnings.append(approval)
    return warnings


def validate_live_head(head: Snapshot, args: argparse.Namespace, now: dt.datetime) -> None:
    if not args.check_live_lease or not head.exists("roadmap/STATUS.md"):
        return
    claims = active_claims(head)
    if not claims:
        return
    if len(claims) > 1:
        raise ControlPlaneError("head contains multiple active claims")
    path, claim = claims[0]
    validate_claim(
        REPO,
        head,
        path,
        claim,
        now,
        check_local_binding=False,
        descendant=head.source,
        check_expiry=True,
    )


def review_range(
    base: str,
    head: str,
    args: argparse.Namespace,
    now: dt.datetime,
) -> tuple[list[str], int, int]:
    """Replay linear commits, expanding only trivial up-to-date two-parent merges."""
    warnings: list[str] = []
    reviewed = 0
    merges = 0
    for commit in commits_in_range(base, head):
        parents = commit_parents(commit)
        if len(parents) == 1:
            warnings.extend(evaluate_commit(parents[0], commit, args, now))
            reviewed += 1
            continue
        if len(parents) != 2:
            raise ControlPlaneError(
                f"{commit}: only linear commits and normal two-parent merges are supported"
            )
        parent_one, parent_two = parents
        if not is_ancestor(REPO, parent_one, parent_two):
            raise ControlPlaneError(
                f"{commit}: merge branch was not up to date with first parent"
            )
        if commit_tree(commit) != commit_tree(parent_two):
            raise ControlPlaneError(
                f"{commit}: merge tree differs from second-parent tree; integration edits are unsupported"
            )
        args.merge_replay_depth = getattr(args, "merge_replay_depth", 0) + 1
        try:
            nested_warnings, nested_reviewed, nested_merges = review_range(
                parent_one, parent_two, args, now
            )
        finally:
            args.merge_replay_depth -= 1
        warnings.extend(nested_warnings)
        reviewed += nested_reviewed
        merges += nested_merges + 1
    return warnings, reviewed, merges


def main() -> int:
    args = arguments()
    if not commit_exists(REPO, args.head):
        raise ControlPlaneError(f"head commit '{args.head}' is unavailable")
    args.resolved_head = run_git(
        REPO, "rev-parse", "--verify", f"{args.head}^{{commit}}"
    ).stdout.strip()
    now = parse_utc(args.now, "--now") if args.now else dt.datetime.now(dt.timezone.utc)
    if args.base == ZERO_SHA:
        if not args.allow_initial:
            raise ControlPlaneError(
                "initial history has no predecessor; explicit --allow-initial is required"
            )
        print(
            "scope-diff: EXPLICIT INITIAL-HISTORY BOOTSTRAP -- owner review required; "
            "the independent commit-snapshot doctor remains authoritative"
        )
        validate_live_head(Snapshot(REPO, args.head), args, now)
        return 0
    if not commit_exists(REPO, args.base):
        raise ControlPlaneError(f"base commit '{args.base}' is unavailable")
    args.resolved_base = run_git(
        REPO, "rev-parse", "--verify", f"{args.base}^{{commit}}"
    ).stdout.strip()
    if args.print_policy_approval_token:
        print(
            policy_approval_token(
                args.pull_request_number, args.resolved_base, args.resolved_head
            )
        )
        return 0

    warnings, reviewed, merges = review_range(
        args.resolved_base, args.resolved_head, args, now
    )
    validate_live_head(Snapshot(REPO, args.head), args, now)
    for warning in warnings:
        print(f"::warning::{warning}")
    print(
        f"scope-diff: OK -- reviewed {reviewed} linear commit(s) in parent-authority "
        f"order; replayed {merges} normal merge(s)"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ControlPlaneError as exc:
        print(f"scope-diff: FAIL -- {exc}")
        sys.exit(1)
