#!/usr/bin/env python3
"""Manage serial task/scope bindings with safe local lifecycle transitions.

These records are not distributed locks.  The bundled runtime deliberately refuses
claim mutations when more than one linked worktree exists and supports one explicit
integrator claim.  A real concurrent writer wave requires an external transactional
allocator with fencing tokens.

Usage:
  python roadmap/tools/claim.py open AGENT TASK --integrator [--owner-reviewed] [--hours N] [--path SCOPE ...]
  python roadmap/tools/claim.py renew AGENT [--hours N]
  python roadmap/tools/claim.py rescope AGENT [--hours N] [--path SCOPE ...]
  python roadmap/tools/claim.py rebind AGENT --owner-reviewed [--hours N]
  python roadmap/tools/claim.py release AGENT [--status released|failed|abandoned]
  python roadmap/tools/claim.py list
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

from _control_plane import (
    ControlPlaneError,
    Snapshot,
    current_branch,
    full_head,
    git_common_dir,
    parse_frontmatter,
    parse_scope,
    repo_root,
    run_git,
    safe_worktree_path,
    scalar,
    scope_contains,
    scope_hash,
    string_list,
)
from scope_gate import active_claims, local_worktree_id, validate_claim


TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = repo_root(TOOLS)
AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
TASK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MAX_LEASE_HOURS = 24
FINAL_STATUSES = {"released", "failed", "abandoned"}


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    opened = sub.add_parser("open")
    opened.add_argument("agent")
    opened.add_argument("task")
    opened.add_argument("--integrator", action="store_true")
    opened.add_argument(
        "--owner-reviewed",
        action="store_true",
        help="authorize terminal-record takeover onto this branch/worktree",
    )
    opened.add_argument("--hours", type=int, default=8)
    opened.add_argument("--path", action="append", default=[])

    renewed = sub.add_parser("renew")
    renewed.add_argument("agent")
    renewed.add_argument("--hours", type=int, default=8)

    rescoped = sub.add_parser("rescope")
    rescoped.add_argument("agent")
    rescoped.add_argument("--hours", type=int, default=8)
    rescoped.add_argument("--path", action="append", default=[])

    rebound = sub.add_parser(
        "rebind",
        help="owner-reviewed recovery after moving/cloning the serial worktree",
    )
    rebound.add_argument("agent")
    rebound.add_argument("--owner-reviewed", action="store_true")
    rebound.add_argument("--hours", type=int, default=8)

    released = sub.add_parser("release")
    released.add_argument("agent")
    released.add_argument("--status", choices=sorted(FINAL_STATUSES), default="released")

    sub.add_parser("list")
    return parser.parse_args()


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_hours(hours: int) -> None:
    if hours < 1 or hours > MAX_LEASE_HOURS:
        raise ControlPlaneError(f"lease hours must be between 1 and {MAX_LEASE_HOURS}")


def claim_rel(agent: str) -> str:
    if not AGENT_RE.fullmatch(agent):
        raise ControlPlaneError(
            "agent must match [a-z0-9][a-z0-9._-]{0,63}"
        )
    return f"roadmap/claims/CLAIM-{agent}.md"


def linked_worktrees() -> list[str]:
    result = run_git(REPO, "worktree", "list", "--porcelain")
    return [line[9:] for line in result.stdout.splitlines() if line.startswith("worktree ")]


def ensure_serial_environment() -> None:
    worktrees = linked_worktrees()
    if len(worktrees) != 1:
        raise ControlPlaneError(
            f"bundled claims support exactly one linked worktree; found {len(worktrees)}. "
            "Use an external atomic allocator before launching concurrent writers"
        )
    snapshot = Snapshot(REPO, "worktree")
    status_path = "roadmap/STATUS.md"
    status = parse_frontmatter(snapshot.read_text(status_path), status_path, required=True)
    if scalar(status, "writer_mode", status_path, required=True) != "serial":
        raise ControlPlaneError("bundled claim.py supports only writer_mode: serial")


def ensure_path_clean(path: str) -> None:
    result = run_git(REPO, "status", "--porcelain=v1", "-z", "--", path)
    if result.stdout:
        raise ControlPlaneError(
            f"{path} has staged or unstaged changes; commit or restore them before mutating its claim"
        )


@contextmanager
def claim_lock():
    lock_path = Path(git_common_dir(REPO), "control-plane-claim.lock")
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise ControlPlaneError(
            f"another claim operation is active, or a stale lock needs review: {lock_path}"
        ) from exc
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(f"pid={os.getpid()}\n")
            stream.flush()
            os.fsync(stream.fileno())
        yield
    finally:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def work_item(snapshot: Snapshot, task: str) -> tuple[str, dict]:
    if not TASK_RE.fullmatch(task):
        raise ControlPlaneError("task id contains unsupported characters")
    for path in snapshot.list("roadmap/work", ".md"):
        data = parse_frontmatter(snapshot.read_text(path), path, required=True)
        if scalar(data, "id", path) == task:
            if scalar(data, "status", path, required=True) != "active":
                raise ControlPlaneError(f"task '{task}' must be active before it is claimed")
            return path, data
    raise ControlPlaneError(f"no work item has id '{task}'")


def requested_scopes(snapshot: Snapshot, task: str, requested: list[str]):
    path, data = work_item(snapshot, task)
    task_scopes = [
        parse_scope(value, f"{path}:allowed_paths")
        for value in string_list(data, "allowed_paths", path)
    ]
    if not task_scopes:
        raise ControlPlaneError(f"{path}: active task has no allowed_paths")
    scopes = (
        [parse_scope(value, "--path") for value in requested]
        if requested
        else task_scopes
    )
    for scope in scopes:
        if not any(scope_contains(parent, scope) for parent in task_scopes):
            raise ControlPlaneError(
                f"requested scope '{scope.raw}' is outside task '{task}'"
            )
    return scopes


def render_claim(data: dict) -> str:
    order = (
        "claim_id",
        "generation",
        "agent",
        "task",
        "status",
        "integrator",
        "branch",
        "worktree_id",
        "base_commit",
        "allowed_paths",
        "scope_hash",
        "issued_at",
        "lease_expires",
        "updated_at",
    )
    lines = ["---"]
    for key in order:
        value = data.get(key)
        if isinstance(value, list):
            if value:
                lines.append(f"{key}:")
                lines.extend(f"  - {item}" for item in value)
            else:
                lines.append(f"{key}: []")
        else:
            lines.append(f"{key}: {value}")
    lines.extend(
        [
            "---",
            "",
            f"# Claim: {data['agent']} -> {data['task']}",
            "",
            "This is a serial task/scope binding, not a distributed lock.",
            "",
        ]
    )
    return "\n".join(lines)


def read_claim(agent: str) -> tuple[str, dict]:
    relative = claim_rel(agent)
    snapshot = Snapshot(REPO, "worktree")
    if not snapshot.exists(relative):
        raise ControlPlaneError(f"no claim exists for '{agent}'")
    return relative, parse_frontmatter(
        snapshot.read_text(relative), relative, required=True
    )


def next_generation(existing: dict | None, path: str) -> int:
    if not existing:
        return 1
    raw = scalar(existing, "generation", path, required=True)
    if not raw.isdigit() or int(raw) < 1:
        raise ControlPlaneError(f"{path}: invalid prior generation")
    return int(raw) + 1


def open_claim(args: argparse.Namespace) -> int:
    if not args.integrator:
        raise ControlPlaneError(
            "the bundled serial runtime requires explicit --integrator; "
            "worker lanes require an external atomic allocator"
        )
    validate_hours(args.hours)
    relative = claim_rel(args.agent)
    ensure_path_clean(relative)
    snapshot = Snapshot(REPO, "worktree")
    scopes = requested_scopes(snapshot, args.task, args.path)
    existing: dict | None = None
    binding_rotated = False
    target = safe_worktree_path(REPO, relative, "claim target")
    if target.exists():
        existing = parse_frontmatter(target.read_text(encoding="utf-8"), relative, required=True)
        prior_status = scalar(existing, "status", relative, required=True)
        if prior_status == "active":
            raise ControlPlaneError(f"agent '{args.agent}' already has a live claim")
        if prior_status not in FINAL_STATUSES:
            raise ControlPlaneError(
                f"{relative}: lifecycle status '{prior_status}' is unsupported by the bundled serial runtime"
            )
        if scalar(existing, "agent", relative, required=True) != args.agent:
            raise ControlPlaneError(f"{relative}: prior claim agent does not match its filename")
        binding_rotated = (
            scalar(existing, "branch", relative, required=True) != current_branch(REPO)
            or scalar(existing, "worktree_id", relative, required=True)
            != local_worktree_id(REPO)
        )
        if binding_rotated and not args.owner_reviewed:
            raise ControlPlaneError(
                f"{relative}: terminal claim belongs to another branch/worktree; "
                "reopen takeover requires --owner-reviewed"
            )
    active = active_claims(snapshot)
    if active:
        owner = scalar(active[0][1], "agent", active[0][0], required=True)
        raise ControlPlaneError(
            f"serial runtime already has an active claim owned by '{owner}'"
        )
    now = utc_now()
    data = {
        "claim_id": str(uuid.uuid4()),
        "generation": str(next_generation(existing, relative)),
        "agent": args.agent,
        "task": args.task,
        "status": "active",
        "integrator": "true",
        "branch": current_branch(REPO),
        "worktree_id": local_worktree_id(REPO),
        "base_commit": full_head(REPO),
        "allowed_paths": [scope.raw for scope in scopes],
        "scope_hash": scope_hash(scopes),
        "issued_at": iso(now),
        "lease_expires": iso(now + dt.timedelta(hours=args.hours)),
        "updated_at": iso(now),
    }
    atomic_write(target, render_claim(data))
    if binding_rotated:
        print(
            f"{relative}: owner-reviewed terminal-record takeover staged; commit only roadmap "
            "metadata with CONTROL_PLANE_OWNER_REVIEWED=1"
        )
    else:
        print(relative)
    return 0


def renew_claim(args: argparse.Namespace) -> int:
    validate_hours(args.hours)
    relative, data = read_claim(args.agent)
    ensure_path_clean(relative)
    if scalar(data, "status", relative, required=True) != "active":
        raise ControlPlaneError("only an active claim can be renewed")
    now = utc_now()
    validate_claim(
        REPO,
        Snapshot(REPO, "worktree"),
        relative,
        data,
        now,
        check_local_binding=True,
        descendant="HEAD",
        check_expiry=True,
    )
    data["lease_expires"] = iso(now + dt.timedelta(hours=args.hours))
    data["updated_at"] = iso(now)
    atomic_write(safe_worktree_path(REPO, relative, "claim target"), render_claim(data))
    print(f"renewed {args.agent} through {data['lease_expires']}")
    return 0


def rescope_claim(args: argparse.Namespace) -> int:
    validate_hours(args.hours)
    relative, data = read_claim(args.agent)
    ensure_path_clean(relative)
    if scalar(data, "status", relative, required=True) != "active":
        raise ControlPlaneError("only an active claim can be rescoped")
    now = utc_now()
    validate_claim(
        REPO,
        Snapshot(REPO, "worktree"),
        relative,
        data,
        now,
        check_local_binding=True,
        descendant="HEAD",
        check_expiry=True,
    )
    task = scalar(data, "task", relative, required=True)
    scopes = requested_scopes(Snapshot(REPO, "worktree"), task, args.path)
    generation = scalar(data, "generation", relative, required=True)
    if not generation.isdigit():
        raise ControlPlaneError(f"{relative}: invalid generation")
    data.update(
        {
            "claim_id": str(uuid.uuid4()),
            "generation": str(int(generation) + 1),
            "base_commit": full_head(REPO),
            "allowed_paths": [scope.raw for scope in scopes],
            "scope_hash": scope_hash(scopes),
            "issued_at": iso(now),
            "lease_expires": iso(now + dt.timedelta(hours=args.hours)),
            "updated_at": iso(now),
        }
    )
    atomic_write(safe_worktree_path(REPO, relative, "claim target"), render_claim(data))
    print(f"rescoped {args.agent}; generation {data['generation']}")
    return 0


def rebind_claim(args: argparse.Namespace) -> int:
    """Rotate only location identity and lease after explicit human takeover review."""
    if not args.owner_reviewed:
        raise ControlPlaneError(
            "rebind is a recovery/takeover operation and requires --owner-reviewed"
        )
    validate_hours(args.hours)
    relative, data = read_claim(args.agent)
    ensure_path_clean(relative)
    if scalar(data, "status", relative, required=True) != "active":
        raise ControlPlaneError("only an active claim can be rebound")
    now = utc_now()
    validate_claim(
        REPO,
        Snapshot(REPO, "worktree"),
        relative,
        data,
        now,
        check_local_binding=False,
        descendant="HEAD",
        check_expiry=False,
    )
    branch = current_branch(REPO)
    worktree = local_worktree_id(REPO)
    if (
        scalar(data, "branch", relative, required=True) == branch
        and scalar(data, "worktree_id", relative, required=True) == worktree
    ):
        raise ControlPlaneError(
            f"{relative}: claim already belongs to this branch and worktree; use renew or rescope"
        )
    generation = scalar(data, "generation", relative, required=True)
    if not generation.isdigit() or int(generation) < 1:
        raise ControlPlaneError(f"{relative}: invalid generation")
    data.update(
        {
            "claim_id": str(uuid.uuid4()),
            "generation": str(int(generation) + 1),
            "branch": branch,
            "worktree_id": worktree,
            "base_commit": full_head(REPO),
            "issued_at": iso(now),
            "lease_expires": iso(now + dt.timedelta(hours=args.hours)),
            "updated_at": iso(now),
        }
    )
    atomic_write(safe_worktree_path(REPO, relative, "claim target"), render_claim(data))
    print(
        f"rebound {args.agent}; generation {data['generation']}. "
        "Stage only roadmap metadata, review it, then commit with "
        "CONTROL_PLANE_OWNER_REVIEWED=1"
    )
    return 0


def release_claim(args: argparse.Namespace) -> int:
    relative, data = read_claim(args.agent)
    ensure_path_clean(relative)
    if scalar(data, "status", relative, required=True) != "active":
        raise ControlPlaneError("only an active claim can be released")
    now = utc_now()
    validate_claim(
        REPO,
        Snapshot(REPO, "worktree"),
        relative,
        data,
        now,
        check_local_binding=True,
        descendant="HEAD",
        check_expiry=False,
    )
    data["status"] = args.status
    data["updated_at"] = iso(now)
    atomic_write(safe_worktree_path(REPO, relative, "claim target"), render_claim(data))
    print(f"{args.status}: {args.agent}")
    return 0


def list_claims() -> int:
    snapshot = Snapshot(REPO, "worktree")
    for path in snapshot.list("roadmap/claims", ".md"):
        data = parse_frontmatter(snapshot.read_text(path), path, required=True)
        print(
            " | ".join(
                [
                    scalar(data, "agent", path, required=True),
                    scalar(data, "task", path, required=True),
                    scalar(data, "status", path, required=True),
                    f"generation={scalar(data, 'generation', path, required=True)}",
                    f"expires={scalar(data, 'lease_expires', path, required=True)}",
                ]
            )
        )
    return 0


def main() -> int:
    args = arguments()
    if args.command == "list":
        return list_claims()
    ensure_serial_environment()
    with claim_lock():
        if args.command == "open":
            return open_claim(args)
        if args.command == "renew":
            return renew_claim(args)
        if args.command == "rescope":
            return rescope_claim(args)
        if args.command == "rebind":
            return rebind_claim(args)
        if args.command == "release":
            return release_claim(args)
    raise ControlPlaneError(f"unsupported command '{args.command}'")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ControlPlaneError as exc:
        print(f"claim: FAIL -- {exc}")
        sys.exit(1)
