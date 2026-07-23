#!/usr/bin/env python3
"""Fail-closed staged-index scope gate for the bundled serial writer runtime.

Authority comes from the committed claim and work-item charter, never from metadata
expanded in the commit being checked.  A new claim or a rotated claim is therefore a
metadata-only transition; newly granted paths become usable only after that transition
is committed.  The bundled runtime intentionally supports one explicit integrator in
one worktree.  Distributed writer allocation belongs to an external atomic scheduler.

Usage: python roadmap/tools/scope_gate.py [--base HEAD] [--now UTC] [--adopt]
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys
import uuid
from dataclasses import dataclass

from _control_plane import (
    ControlPlaneError,
    Scope,
    Snapshot,
    commit_exists,
    current_branch,
    is_ancestor,
    parse_frontmatter,
    parse_scope,
    parse_utc,
    repo_root,
    run_git,
    scalar,
    scope_contains,
    scope_hash,
    scope_matches,
    string_list,
    validate_lease,
)


TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = repo_root(TOOLS)
AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
CAPTURE_SCOPES = (
    "roadmap/ideas/**",
    "roadmap/insights/**",
    "roadmap/risks/**",
)
PROTECTED_SCOPES = (
    "roadmap/VISION.md",
    "roadmap/SYSTEM.md",
    "roadmap/RULES.md",
    "roadmap/tools/**",
    ".github/**",
    ".githooks/**",
    ".control-plane/**",
    ".claude/**",
    "CLAUDE.md",
    "AGENTS.md",
    ".gitattributes",
)
ADOPTION_SCOPES = (
    "roadmap/**",
    ".github/workflows/control-plane.yml",
    ".githooks/**",
    ".control-plane/**",
    ".claude/**",
    "CLAUDE.md",
    "AGENTS.md",
    ".gitignore",
    ".gitattributes",
)
IMMUTABLE_CLAIM_FIELDS = (
    "agent",
    "task",
    "claim_id",
    "generation",
    "integrator",
    "branch",
    "worktree_id",
    "base_commit",
    "allowed_paths",
    "scope_hash",
    "issued_at",
)
STATUS_TRANSITIONS = {
    "active": {"active", "released", "failed", "abandoned"},
}
TERMINAL_CLAIM_STATUSES = {"released", "failed", "abandoned"}
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


@dataclass(frozen=True)
class Change:
    status: str
    paths: tuple[str, ...]


@dataclass(frozen=True)
class Authority:
    agent: str
    claim_path: str
    claim: dict
    scopes: tuple[Scope, ...]
    integrator: bool
    bootstrap: bool = False
    expired: bool = False
    binding_mismatch: bool = False


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="HEAD", help="committed authority snapshot")
    parser.add_argument("--now", help="strict UTC clock override for deterministic tests")
    parser.add_argument(
        "--adopt",
        action="store_true",
        help="explicit isolated adoption when BASE has no control plane",
    )
    parser.add_argument(
        "--allow-protected",
        action="store_true",
        help="explicit local acknowledgement for an isolated enforcement change",
    )
    return parser.parse_args()


def local_worktree_id(repo: str) -> str:
    canonical = os.path.normcase(os.path.realpath(repo)).replace("\\", "/")
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "control-plane-worktree:" + canonical))


def parse_diff_name_status(output: str) -> list[Change]:
    """Parse Git's NUL form and preserve both source and destination of R/C entries."""
    tokens = output.split("\0")
    if tokens and tokens[-1] == "":
        tokens.pop()
    changes: list[Change] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        first_path = ""
        if "\t" in token:
            status, first_path = token.split("\t", 1)
        else:
            status = token
        if not status or status[0] not in "ACDMRTUXB":
            raise ControlPlaneError(f"unrecognized git name-status token '{status}'")
        needed = 2 if status[0] in "RC" else 1
        paths: list[str] = []
        if first_path:
            paths.append(first_path)
        while len(paths) < needed:
            if index >= len(tokens):
                raise ControlPlaneError(f"truncated git name-status record '{status}'")
            paths.append(tokens[index])
            index += 1
        changes.append(Change(status=status, paths=tuple(paths)))
    return changes


def staged_changes(repo: str, base: str | None, staged: Snapshot) -> list[Change]:
    args = [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies",
        base or EMPTY_TREE,
        staged.treeish,
    ]
    args.append("--")
    result = run_git(repo, *args)
    return parse_diff_name_status(result.stdout)


def changed_paths(changes: list[Change]) -> list[str]:
    return [path for change in changes for path in change.paths]


def matches_any(path: str, raw_scopes: tuple[str, ...]) -> bool:
    return any(scope_matches(parse_scope(value), path) for value in raw_scopes)


def is_protected(path: str) -> bool:
    return matches_any(path, PROTECTED_SCOPES)


def is_adoption_path(path: str) -> bool:
    return matches_any(path, ADOPTION_SCOPES)


def snapshot_record(snapshot: Snapshot, path: str) -> dict | None:
    if not snapshot.exists(path):
        return None
    return parse_frontmatter(snapshot.read_text(path), path, required=True)


def work_scope_expansions(before: Snapshot, after: Snapshot) -> list[str]:
    old_by_id: dict[str, tuple[str, dict]] = {}
    new_by_id: dict[str, tuple[str, dict]] = {}
    for snapshot, target in ((before, old_by_id), (after, new_by_id)):
        for path in snapshot.list("roadmap/work", ".md"):
            data = snapshot_record(snapshot, path)
            assert data is not None
            target[scalar(data, "id", path, required=True)] = (path, data)
    findings: list[str] = []
    for object_id in sorted(old_by_id.keys() & new_by_id.keys()):
        old_path, old = old_by_id[object_id]
        new_path, new = new_by_id[object_id]
        old_scopes = [
            parse_scope(value, f"{old_path}:allowed_paths")
            for value in string_list(old, "allowed_paths", old_path)
        ]
        new_scopes = [
            parse_scope(value, f"{new_path}:allowed_paths")
            for value in string_list(new, "allowed_paths", new_path)
        ]
        expanded = [
            scope.raw
            for scope in new_scopes
            if not any(scope_contains(parent, scope) for parent in old_scopes)
        ]
        if expanded:
            findings.append(f"{object_id}: {', '.join(expanded)}")
    return findings


def _section_body(text: str, heading: str) -> str:
    match = re.search(rf"^## {re.escape(heading)}\s*$", text, re.M)
    if not match:
        return ""
    return re.split(r"^## ", text[match.end():], maxsplit=1, flags=re.M)[0].strip()


def durable_work_contract(snapshot: Snapshot, path: str, data: dict) -> tuple:
    text = snapshot.read_text(path)
    return (
        _field(data, "evidence_target"),
        _field(data, "deliverables"),
        _field(data, "invalidated_by"),
        tuple(
            _section_body(text, heading)
            for heading in ("Acceptance", "Non-goals", "Canonical commands")
        ),
    )


def owner_transition_reasons(
    before: Snapshot,
    after: Snapshot,
    paths: list[str],
) -> list[str]:
    """One semantic classifier shared by the local acknowledgement and trusted CI."""
    reasons: list[str] = []
    protected = [path for path in paths if is_protected(path)]
    if protected:
        reasons.append(
            "protected runtime/governance paths changed: " + ", ".join(protected)
        )
    if "roadmap/ROADMAP.md" in paths:
        reasons.append("ROADMAP phase/order/state projection changed")
    before_status = read_status(before)
    after_status = read_status(after)
    if "roadmap/STATUS.md" in paths:
        changed = [
            key
            for key in (
                "active_phase",
                "active_task",
                "project_state",
                "writer_mode",
                "parallel_readers",
                "enforcement",
                "enforcement_evidence",
            )
            if _field(before_status, key) != _field(after_status, key)
        ]
        if changed:
            reasons.append("STATUS authority changed: " + ", ".join(changed))
    enforcement_paths = set(
        string_list(before_status, "enforcement_evidence", "roadmap/STATUS.md")
        + string_list(after_status, "enforcement_evidence", "roadmap/STATUS.md")
    )
    for path in sorted(set(paths)):
        if path in enforcement_paths:
            reasons.append(f"referenced enforcement evidence changed: {path}")
        typed_path = any(
            path.startswith(prefix)
            for prefix in (
                "roadmap/decisions/",
                "roadmap/ideas/",
                "roadmap/work/",
                "roadmap/evidence/",
                "roadmap/claims/",
            )
        ) and path.endswith(".md")
        old = snapshot_record(before, path) if typed_path else None
        new = snapshot_record(after, path) if typed_path else None
        if path.startswith("roadmap/decisions/") and path.endswith(".md"):
            if new:
                old_status = scalar(old or {}, "status", path)
                new_status = scalar(new, "status", path, required=True)
                if new_status == "accepted" and old_status != "accepted":
                    reasons.append(f"{path} entered accepted")
                if _field(old or {}, "approved_by") != _field(new, "approved_by"):
                    reasons.append(f"{path} approved_by changed")
            if old and scalar(old, "status", path) == "accepted":
                if not new or before.read_bytes(path) != after.read_bytes(path):
                    reasons.append(f"accepted decision changed: {path}")
        elif path.startswith("roadmap/ideas/") and path.endswith(".md"):
            if new and scalar(new, "status", path, required=True) == "promoted":
                if scalar(old or {}, "status", path) != "promoted":
                    reasons.append(f"{path} was promoted")
        elif path.startswith("roadmap/work/") and path.endswith(".md"):
            if new:
                old_status = scalar(old or {}, "status", path)
                new_status = scalar(new, "status", path, required=True)
                if old_status != new_status and new_status in {
                    "committed",
                    "active",
                    "achieved",
                    "superseded",
                    "rejected",
                    "archived",
                }:
                    reasons.append(f"{path} entered durable status:{new_status}")
                if old and old_status in {"committed", "active", "achieved"}:
                    if durable_work_contract(before, path, old) != durable_work_contract(
                        after, path, new
                    ):
                        reasons.append(f"durable work verification contract changed: {path}")
        elif path.startswith("roadmap/evidence/") and path.endswith(".md"):
            if old and scalar(old, "status", path) == "recorded":
                if not new or before.read_bytes(path) != after.read_bytes(path):
                    reasons.append(f"recorded evidence changed: {path}")
        elif re.fullmatch(r"roadmap/claims/CLAIM-[^/]+\.md", path):
            if old and new and scalar(old, "status", path) in TERMINAL_CLAIM_STATUSES:
                if scalar(new, "status", path) == "active" and any(
                    _field(old, key) != _field(new, key)
                    for key in ("branch", "worktree_id")
                ):
                    reasons.append(f"terminal claim takeover: {path}")
    reasons.extend(
        f"work scope expanded: {finding}"
        for finding in work_scope_expansions(before, after)
    )
    return list(dict.fromkeys(reasons))


def _record_body(snapshot: Snapshot, path: str) -> str:
    text = snapshot.read_text(path).replace("\r\n", "\n").replace("\r", "\n")
    match = re.match(r"\A---\n.*?\n---\n?", text, re.S)
    if not match:
        raise ControlPlaneError(f"{path}: malformed immutable record frontmatter")
    return text[match.end():]


def _supersession_target(snapshot: Snapshot, object_id: str) -> tuple[str, dict] | None:
    for directory in ("roadmap/decisions", "roadmap/evidence"):
        for path in snapshot.list(directory, ".md"):
            data = snapshot_record(snapshot, path)
            assert data is not None
            if scalar(data, "id", path) == object_id:
                return path, data
    return None


def validate_immutable_records(
    before: Snapshot,
    after: Snapshot,
    paths: list[str],
) -> None:
    """Preserve accepted decisions and recorded receipts as append-only audit objects."""
    for path in sorted(set(paths)):
        if not (
            path.endswith(".md")
            and path.startswith(("roadmap/decisions/", "roadmap/evidence/"))
        ):
            continue
        old = snapshot_record(before, path)
        if not old:
            continue
        old_type = scalar(old, "type", path)
        protected_record = (
            old_type == "decision" and scalar(old, "status", path) == "accepted"
        ) or (
            old_type in {"evidence", "enforcement"}
            and scalar(old, "status", path) == "recorded"
        )
        if not protected_record or before.read_bytes(path) == (
            after.read_bytes(path) if after.exists(path) else b""
        ):
            continue
        new = snapshot_record(after, path)
        if not new:
            raise ControlPlaneError(f"{path}: immutable lifecycle record may not be deleted/renamed")
        if scalar(new, "status", path, required=True) != "superseded":
            raise ControlPlaneError(
                f"{path}: immutable lifecycle record may only transition to superseded"
            )
        pointer = scalar(new, "superseded_by", path, required=True)
        target = _supersession_target(after, pointer)
        if not target or target[0] == path:
            raise ControlPlaneError(f"{path}: superseded_by must name a new typed record")
        if scalar(target[1], "type", target[0], required=True) != old_type:
            raise ControlPlaneError(f"{path}: supersession target must preserve record type")
        expected_status = "accepted" if old_type == "decision" else "recorded"
        if scalar(target[1], "status", target[0], required=True) != expected_status:
            raise ControlPlaneError(
                f"{path}: supersession target must be status:{expected_status}"
            )
        old_id = scalar(old, "id", path, required=True)
        if old_id not in string_list(target[1], "supersedes", target[0]):
            raise ControlPlaneError(
                f"{path}: supersession target must list old id '{old_id}' in supersedes"
            )
        old_payload = {
            key: value
            for key, value in old.items()
            if key not in {"status", "superseded_by", "updated"}
        }
        new_payload = {
            key: value
            for key, value in new.items()
            if key not in {"status", "superseded_by", "updated"}
        }
        if old_payload != new_payload or _record_body(before, path) != _record_body(after, path):
            raise ControlPlaneError(
                f"{path}: supersession may change only status, superseded_by, and updated"
            )


def read_status(snapshot: Snapshot) -> dict:
    path = "roadmap/STATUS.md"
    return parse_frontmatter(snapshot.read_text(path), path, required=True)


def claim_records(snapshot: Snapshot) -> list[tuple[str, dict]]:
    records: list[tuple[str, dict]] = []
    for path in snapshot.list("roadmap/claims", ".md"):
        if not re.fullmatch(r"roadmap/claims/CLAIM-[^/]+\.md", path):
            continue
        records.append(
            (path, parse_frontmatter(snapshot.read_text(path), path, required=True))
        )
    return records


def active_claims(snapshot: Snapshot) -> list[tuple[str, dict]]:
    return [
        (path, data)
        for path, data in claim_records(snapshot)
        if scalar(data, "status", path, required=True) == "active"
    ]


def find_work_item(snapshot: Snapshot, task: str) -> tuple[str, dict]:
    for path in snapshot.list("roadmap/work", ".md"):
        data = parse_frontmatter(snapshot.read_text(path), path, required=True)
        if scalar(data, "id", path) == task:
            return path, data
    raise ControlPlaneError(f"claim task '{task}' has no work item in {snapshot.source}")


def effective_scopes(snapshot: Snapshot, claim_path: str, claim: dict) -> tuple[Scope, ...]:
    task = scalar(claim, "task", claim_path, required=True)
    work_path, work = find_work_item(snapshot, task)
    if scalar(work, "status", work_path, required=True) != "active":
        raise ControlPlaneError(f"{claim_path}: task '{task}' is not active")
    task_scopes = tuple(
        parse_scope(value, f"{work_path}:allowed_paths")
        for value in string_list(work, "allowed_paths", work_path)
    )
    if not task_scopes:
        raise ControlPlaneError(f"{work_path}: active work item has no allowed_paths")
    claim_values = string_list(claim, "allowed_paths", claim_path)
    scopes = (
        tuple(parse_scope(value, f"{claim_path}:allowed_paths") for value in claim_values)
        if claim_values
        else task_scopes
    )
    if not scopes:
        raise ControlPlaneError(f"{claim_path}: effective scope is empty")
    for claimed in scopes:
        if not any(scope_contains(parent, claimed) for parent in task_scopes):
            raise ControlPlaneError(
                f"{claim_path}: scope '{claimed.raw}' is outside task '{task}'"
            )
    expected_hash = scope_hash(scopes)
    actual_hash = scalar(claim, "scope_hash", claim_path, required=True)
    if actual_hash != expected_hash:
        raise ControlPlaneError(
            f"{claim_path}: scope_hash is stale ({actual_hash} != {expected_hash}); "
            "make a metadata-only claim.py rescope transition"
        )
    return scopes


def validate_claim(
    repo: str,
    snapshot: Snapshot,
    path: str,
    claim: dict,
    now: dt.datetime,
    *,
    check_local_binding: bool,
    descendant: str,
    check_expiry: bool = True,
) -> tuple[Scope, ...]:
    agent = scalar(claim, "agent", path, required=True)
    if not AGENT_RE.fullmatch(agent):
        raise ControlPlaneError(f"{path}: invalid agent id '{agent}'")
    if os.path.basename(path) != f"CLAIM-{agent}.md":
        raise ControlPlaneError(f"{path}: agent does not match claim filename")
    claim_id = scalar(claim, "claim_id", path, required=True)
    if not UUID_RE.fullmatch(claim_id):
        raise ControlPlaneError(f"{path}: claim_id must be a lowercase UUID")
    generation = scalar(claim, "generation", path, required=True)
    if not generation.isdigit() or int(generation) < 1:
        raise ControlPlaneError(f"{path}: generation must be a positive integer")
    integrator = scalar(claim, "integrator", path, required=True)
    if integrator not in ("true", "false"):
        raise ControlPlaneError(f"{path}: integrator must be true or false")
    validate_lease(
        claim, path, now, active=True, check_live=check_expiry
    )
    base = scalar(claim, "base_commit", path, required=True)
    if not FULL_SHA_RE.fullmatch(base) or not commit_exists(repo, base):
        raise ControlPlaneError(f"{path}: base_commit must name an existing full SHA")
    if not is_ancestor(repo, base, descendant):
        raise ControlPlaneError(f"{path}: base_commit is not an ancestor of {descendant}")
    if check_local_binding:
        branch = scalar(claim, "branch", path, required=True)
        if branch != current_branch(repo):
            raise ControlPlaneError(
                f"{path}: claim branch '{branch}' does not match '{current_branch(repo)}'"
            )
        worktree = scalar(claim, "worktree_id", path, required=True)
        if worktree != local_worktree_id(repo):
            raise ControlPlaneError(f"{path}: claim belongs to a different worktree")
    return effective_scopes(snapshot, path, claim)


def _field(data: dict, key: str) -> object:
    return data.get(key, []) if key == "allowed_paths" else data.get(key, "")


def valid_rotation(
    repo: str,
    base_path: str,
    before: dict,
    staged: Snapshot,
    after: dict,
    now: dt.datetime,
    expected_base: str,
    *,
    allow_rebind: bool = False,
) -> bool:
    stable = ("agent", "task", "integrator")
    if not allow_rebind:
        stable += ("branch", "worktree_id")
    if any(_field(before, key) != _field(after, key) for key in stable):
        return False
    if allow_rebind and (
        _field(before, "allowed_paths") != _field(after, "allowed_paths")
        or _field(before, "scope_hash") != _field(after, "scope_hash")
    ):
        return False
    old_generation = scalar(before, "generation", base_path, required=True)
    new_generation = scalar(after, "generation", base_path, required=True)
    if not old_generation.isdigit() or not new_generation.isdigit():
        return False
    if int(new_generation) != int(old_generation) + 1:
        return False
    if scalar(after, "status", base_path, required=True) != "active":
        return False
    if scalar(before, "claim_id", base_path) == scalar(after, "claim_id", base_path):
        return False
    if scalar(after, "base_commit", base_path) != expected_base:
        return False
    try:
        validate_claim(
            repo,
            staged,
            base_path,
            after,
            now,
            check_local_binding=True,
            check_expiry=True,
            descendant=expected_base,
        )
    except ControlPlaneError:
        return False
    return True


def validate_staged_claim_transition(
    repo: str,
    authority: Authority,
    staged: Snapshot,
    all_paths: list[str],
    now: dt.datetime,
    expected_base: str,
    *,
    allow_rebind: bool = False,
) -> None:
    if authority.claim_path not in all_paths:
        return
    if not staged.exists(authority.claim_path):
        raise ControlPlaneError(f"{authority.claim_path}: active claim may not be deleted")
    after = parse_frontmatter(
        staged.read_text(authority.claim_path), authority.claim_path, required=True
    )
    changed_immutable = any(
        _field(authority.claim, key) != _field(after, key)
        for key in IMMUTABLE_CLAIM_FIELDS
    )
    if changed_immutable:
        if not all(path.startswith("roadmap/") for path in all_paths):
            raise ControlPlaneError(
                "claim rotation/scope change must be committed separately from product files"
            )
        if not valid_rotation(
            repo,
            authority.claim_path,
            authority.claim,
            staged,
            after,
            now,
            expected_base,
            allow_rebind=allow_rebind,
        ):
            raise ControlPlaneError(
                f"{authority.claim_path}: invalid claim rotation; use claim.py "
                + ("rebind" if allow_rebind else "rescope")
            )
        return
    before_status = scalar(authority.claim, "status", authority.claim_path, required=True)
    after_status = scalar(after, "status", authority.claim_path, required=True)
    if after_status not in STATUS_TRANSITIONS.get(before_status, {before_status}):
        raise ControlPlaneError(
            f"{authority.claim_path}: invalid status transition {before_status} -> {after_status}"
        )
    validate_lease(
        after,
        authority.claim_path,
        now,
        active=after_status == "active",
        check_live=after_status == "active",
    )


def validate_reopened_claim(
    repo: str,
    path: str,
    before: dict,
    after: dict,
    staged: Snapshot,
    now: dt.datetime,
    expected_base: str,
    *,
    allow_binding_rotation: bool,
) -> None:
    prior_status = scalar(before, "status", path, required=True)
    if prior_status not in TERMINAL_CLAIM_STATUSES:
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
    if binding_changed and not allow_binding_rotation:
        raise ControlPlaneError(
            f"{path}: terminal-record takeover requires explicit owner review"
        )
    old_generation = scalar(before, "generation", path, required=True)
    new_generation = scalar(after, "generation", path, required=True)
    if not old_generation.isdigit() or not new_generation.isdigit():
        raise ControlPlaneError(f"{path}: reopen generation must be numeric")
    if int(new_generation) != int(old_generation) + 1:
        raise ControlPlaneError(f"{path}: reopen must increment generation by one")
    if scalar(before, "claim_id", path) == scalar(after, "claim_id", path):
        raise ControlPlaneError(f"{path}: reopen requires a new claim_id")
    if scalar(after, "base_commit", path) != expected_base:
        raise ControlPlaneError(f"{path}: reopened claim must bind to the frozen base commit")
    validate_claim(
        repo,
        staged,
        path,
        after,
        now,
        check_local_binding=True,
        descendant=expected_base,
        check_expiry=True,
    )


def validate_all_claim_mutations(
    repo: str,
    base: Snapshot,
    staged: Snapshot,
    authority: Authority | None,
    paths: list[str],
    now: dt.datetime,
    expected_base: str,
    *,
    allow_binding_rotation: bool,
) -> None:
    changed_claims = {
        path
        for path in paths
        if re.fullmatch(r"roadmap/claims/CLAIM-[^/]+\.md", path)
    }
    if not changed_claims:
        return
    before = dict(claim_records(base))
    after = dict(claim_records(staged))
    selected = authority.claim_path if authority else ""
    for path in sorted(changed_claims):
        if path == selected:
            if authority and authority.bootstrap and path in before:
                validate_reopened_claim(
                    repo,
                    path,
                    before[path],
                    after[path],
                    staged,
                    now,
                    expected_base,
                    allow_binding_rotation=allow_binding_rotation,
                )
            # New bootstrap and active-claim lifecycle/rotation are validated elsewhere.
            continue
        if path in before and path not in after:
            raise ControlPlaneError(f"{path}: claim records may not be deleted")
        if path not in before:
            raise ControlPlaneError(f"{path}: new claim is not the selected serial binding")
        if base.read_bytes(path) != staged.read_bytes(path):
            raise ControlPlaneError(f"{path}: terminal/non-authority claim records are immutable")


def resolve_authority(
    repo: str,
    base: Snapshot,
    staged: Snapshot,
    now: dt.datetime,
    base_commit: str,
) -> Authority | None:
    base_status = read_status(base)
    staged_status = read_status(staged)
    for label, status in ((base.source, base_status), ("index", staged_status)):
        mode = scalar(status, "writer_mode", "roadmap/STATUS.md", required=True)
        if mode != "serial":
            raise ControlPlaneError(
                f"{label}: writer_mode '{mode}' is unsupported; install an external atomic allocator"
            )
    committed = active_claims(base)
    if len(committed) > 1:
        raise ControlPlaneError("serial runtime found more than one committed active claim")
    requested_agent = os.environ.get("CONTROL_PLANE_AGENT", "").strip()
    if committed:
        path, claim = committed[0]
        agent = scalar(claim, "agent", path, required=True)
        if requested_agent and requested_agent != agent:
            raise ControlPlaneError(
                f"CONTROL_PLANE_AGENT '{requested_agent}' does not own the active claim"
            )
        scopes = validate_claim(
            repo,
            base,
            path,
            claim,
            now,
            check_local_binding=False,
            descendant=base_commit,
            check_expiry=False,
        )
        integrator = scalar(claim, "integrator", path, required=True) == "true"
        if not integrator:
            raise ControlPlaneError(
                "the bundled serial runtime requires an explicit integrator claim"
            )
        expires = parse_utc(
            scalar(claim, "lease_expires", path, required=True),
            f"{path}:lease_expires",
        )
        binding_mismatch = (
            scalar(claim, "branch", path, required=True) != current_branch(repo)
            or scalar(claim, "worktree_id", path, required=True) != local_worktree_id(repo)
        )
        return Authority(
            agent,
            path,
            claim,
            scopes,
            integrator,
            expired=expires <= now,
            binding_mismatch=binding_mismatch,
        )

    staged_active = active_claims(staged)
    if len(staged_active) > 1:
        raise ControlPlaneError("serial runtime found more than one staged active claim")
    if staged_active:
        path, claim = staged_active[0]
        agent = scalar(claim, "agent", path, required=True)
        if requested_agent and requested_agent != agent:
            raise ControlPlaneError(
                f"CONTROL_PLANE_AGENT '{requested_agent}' does not match the new claim"
            )
        if scalar(claim, "integrator", path, required=True) != "true":
            raise ControlPlaneError("new serial claims must explicitly set integrator: true")
        validate_claim(
            repo,
            staged,
            path,
            claim,
            now,
            check_local_binding=True,
            check_expiry=True,
            descendant=base_commit,
        )
        if scalar(claim, "base_commit", path, required=True) != base_commit:
            raise ControlPlaneError(
                f"{path}: new/reopened claim must bind to the frozen base commit"
            )
        return Authority(agent, path, claim, tuple(), True, bootstrap=True)
    return None


def main() -> int:
    args = arguments()
    base_available = commit_exists(REPO, args.base)
    adoption_requested = args.adopt or os.environ.get("CONTROL_PLANE_ADOPT") == "1"
    protected_acknowledged = (
        args.allow_protected
        or os.environ.get("CONTROL_PLANE_OWNER_REVIEWED") == "1"
    )
    if not base_available and not adoption_requested:
        raise ControlPlaneError(
            f"base commit/ref '{args.base}' is unavailable; only an explicit isolated adoption may proceed"
        )
    now = parse_utc(args.now, "--now") if args.now else dt.datetime.now(dt.timezone.utc)
    base: Snapshot | None = Snapshot(REPO, args.base) if base_available else None
    base_ref = base.commit if base else None
    # Freeze the index once, then derive both changed paths and file bytes from that
    # exact tree. A concurrent `git add` cannot create a mixed authorization view.
    staged = Snapshot(REPO, "index")
    changes = staged_changes(REPO, base_ref, staged)
    if not changes:
        print("scope-gate: no staged changes")
        return 0
    paths = changed_paths(changes)
    base_has_control_plane = False
    if base:
        base_has_control_plane = base.exists("roadmap/STATUS.md")
    if not base_has_control_plane:
        if not adoption_requested:
            raise ControlPlaneError(
                "BASE has no committed control plane; rerun this isolated installation with "
                "CONTROL_PLANE_ADOPT=1 (owner review required)"
            )
        violations = [path for path in paths if not is_adoption_path(path)]
        if violations:
            print("scope-gate: BLOCKED -- adoption commit contains non-control-plane paths:")
            for path in violations:
                print(f"  - {path}")
            return 1
        # Ensure adoption is complete enough for the independent staged doctor to validate.
        read_status(staged)
        print(
            "scope-gate: OK -- EXPLICIT ISOLATED ADOPTION; owner review is required "
            "because no predecessor authority exists"
        )
        return 0

    assert base is not None
    validate_immutable_records(base, staged, paths)
    owner_reasons = owner_transition_reasons(base, staged, paths)
    if owner_reasons and not protected_acknowledged:
        print("scope-gate: BLOCKED -- owner acknowledgement required for durable transition:")
        for reason in owner_reasons:
            print(f"  - {reason}")
        print(
            "rerun with CONTROL_PLANE_OWNER_REVIEWED=1 after review; this local flag is "
            "only an acknowledgement, not authenticated server authority"
        )
        return 1
    protected = [path for path in paths if is_protected(path)]
    if protected:
        if not protected_acknowledged:
            print("scope-gate: BLOCKED -- protected enforcement surfaces require explicit owner review:")
            for path in protected:
                print(f"  - {path}")
            print("rerun with CONTROL_PLANE_OWNER_REVIEWED=1 only after reviewing an isolated change")
            return 1
        if any(not (is_adoption_path(path) or is_protected(path)) for path in paths):
            raise ControlPlaneError(
                "protected enforcement changes must be isolated from product paths"
            )

    assert base.commit is not None
    authority = resolve_authority(REPO, base, staged, now, base.commit)
    validate_all_claim_mutations(
        REPO,
        base,
        staged,
        authority,
        paths,
        now,
        base.commit,
        allow_binding_rotation=protected_acknowledged,
    )

    if authority is None:
        # Initial serial setup has no writer authority.  It may configure only the cockpit.
        allowed = (parse_scope("roadmap/**"),)
        label = "serial setup"
    elif authority.bootstrap:
        # A staged claim cannot authorize its own product paths.
        allowed = (parse_scope("roadmap/**"),)
        label = f"claim bootstrap ({authority.agent})"
    else:
        allowed_list = list(authority.scopes)
        allowed_list.extend(parse_scope(value) for value in CAPTURE_SCOPES)
        allowed_list.append(parse_scope(authority.claim_path))
        if authority.integrator:
            allowed_list.append(parse_scope("roadmap/**"))
        allowed = tuple(allowed_list)
        label = f"integrator {authority.agent}"
        if authority.binding_mismatch:
            if not protected_acknowledged:
                raise ControlPlaneError(
                    "claim belongs to another branch/worktree; run claim.py rebind and commit "
                    "with CONTROL_PLANE_OWNER_REVIEWED=1"
                )
            if any(not path.startswith("roadmap/") for path in paths):
                raise ControlPlaneError("claim rebind must be an isolated roadmap-only transition")
            if authority.claim_path not in paths:
                raise ControlPlaneError("claim rebind must rotate the claim record")
        validate_staged_claim_transition(
            REPO,
            authority,
            staged,
            paths,
            now,
            base.commit,
            allow_rebind=authority.binding_mismatch,
        )
        if authority.expired and not authority.binding_mismatch:
            if any(not path.startswith("roadmap/") for path in paths):
                raise ControlPlaneError(
                    "expired claim may only perform an isolated roadmap cleanup transition"
                )
            if not staged.exists(authority.claim_path):
                raise ControlPlaneError("expired claim record may not be deleted")
            expired_after = parse_frontmatter(
                staged.read_text(authority.claim_path), authority.claim_path, required=True
            )
            if scalar(
                expired_after, "status", authority.claim_path, required=True
            ) not in TERMINAL_CLAIM_STATUSES:
                raise ControlPlaneError(
                    "expired claim must transition to released, failed, or abandoned"
                )

    if protected_acknowledged and protected:
        allowed = tuple(list(allowed) + [parse_scope(value) for value in PROTECTED_SCOPES])

    violations = [path for path in paths if not any(scope_matches(spec, path) for spec in allowed)]
    if violations:
        print(f"scope-gate: BLOCKED -- {label}; paths outside committed authority:")
        for path in violations:
            print(f"  - {path}")
        print("allowed:")
        for spec in allowed:
            print(f"  - {spec.raw}")
        return 1
    if authority and authority.bootstrap and any(not path.startswith("roadmap/") for path in paths):
        print("scope-gate: BLOCKED -- claim bootstrap must be metadata-only")
        return 1
    if protected:
        print("scope-gate: OWNER-REVIEWED protected enforcement transition:")
        for path in protected:
            print(f"  - {path}")
    elif owner_reasons:
        print("scope-gate: LOCAL OWNER ACKNOWLEDGEMENT (not authenticated):")
        for reason in owner_reasons:
            print(f"  - {reason}")
    print(f"scope-gate: OK -- {label}; {len(paths)} path(s)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ControlPlaneError as exc:
        print(f"scope-gate: BLOCKED -- {exc}")
        sys.exit(1)
