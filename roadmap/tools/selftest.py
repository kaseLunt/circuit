#!/usr/bin/env python3
"""Fully synthetic mutation and integration tests for the bundled runtime.

All repositories, IDs, clocks, claims, and work items are created under temporary
directories.  No assertion depends on the installing project's live roadmap state.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from _control_plane import (
    Snapshot,
    parse_frontmatter,
    parse_scope,
    parse_utc,
    scope_hash,
    snapshot_fingerprint,
)


TOOLS = Path(__file__).resolve().parent
PYTHON = sys.executable
TOOL_NAMES = (
    "_control_plane.py",
    "doctor.py",
    "scope_gate.py",
    "scope_diff.py",
    "claim.py",
    "new.py",
)
FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        if detail:
            print("       " + detail[-600:].replace("\n", "\n       "))
        FAILURES.append(name)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def run(
    args: list[str],
    cwd: Path,
    *,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    merged = dict(os.environ)
    merged["PYTHONDONTWRITEBYTECODE"] = "1"
    for key in (
        "CONTROL_PLANE_AGENT",
        "CONTROL_PLANE_ADOPT",
        "CONTROL_PLANE_OWNER_REVIEWED",
    ):
        merged.pop(key, None)
    if env:
        merged.update(env)
    return subprocess.run(
        args,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=merged,
    )


def git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return run(["git", *args], repo)


def must(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode != 0:
        raise RuntimeError(
            f"{label} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}"
        )


def tool(repo: Path, name: str, *args: str, env: dict[str, str] | None = None):
    return run(
        [PYTHON, str(repo / "roadmap" / "tools" / name), *args],
        repo,
        env=env,
    )


def approval_args(base: str, head: str, pr_number: str = "17") -> tuple[str, ...]:
    return (
        "--pull-request-number",
        pr_number,
        "--policy-approval",
        policy_approval_token(pr_number, base, head),
    )


def policy_approval_token(pr_number: str, base: str, head_sha: str) -> str:
    payload = (
        b"control-plane-policy-approval-v1\0"
        + pr_number.encode("ascii")
        + b"\0"
        + base.encode("ascii")
        + b"\0"
        + head_sha.encode("ascii")
    )
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def copy_tools(repo: Path) -> None:
    destination = repo / "roadmap" / "tools"
    destination.mkdir(parents=True, exist_ok=True)
    for name in TOOL_NAMES:
        shutil.copy2(TOOLS / name, destination / name)


def init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    must(git(path, "init", "-q", "-b", "main"), "git init")
    must(git(path, "config", "user.name", "Synthetic Test"), "git config name")
    must(git(path, "config", "user.email", "synthetic@example.invalid"), "git config email")
    must(git(path, "config", "core.autocrlf", "false"), "git config autocrlf")


def worktree_id(repo: Path) -> str:
    canonical = os.path.normcase(os.path.realpath(repo)).replace("\\", "/")
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "control-plane-worktree:" + canonical))


def status_text(active: bool) -> str:
    return (
        "---\n"
        "active_phase: P0\n"
        f"active_task: {'W0' if active else 'none'}\n"
        "project_state: active\n"
        "writer_mode: serial\n"
        "parallel_readers: allowed\n"
        "enforcement: bootstrap\n"
        "enforcement_evidence: []\n"
        "updated: 2030-01-01\n"
        "---\n\n# Synthetic status\n"
    )


def work_text(status: str, scopes: list[str]) -> str:
    scope_lines = "\n".join(f"  - {scope}" for scope in scopes)
    return (
        "---\n"
        "id: W0\n"
        "type: work\n"
        "title: Synthetic work\n"
        "phase: P0\n"
        f"status: {status}\n"
        "evidence_target: Correct\n"
        "depends_on: []\n"
        "blocked_by: []\n"
        "deliverables:\n"
        "  - src/allowed.txt\n"
        "evidence_receipts: []\n"
        "allowed_paths:\n"
        f"{scope_lines}\n"
        "invalidated_by:\n"
        "  - src/**\n"
        "updated: 2030-01-01\n"
        "---\n\n"
        "# Synthetic work\n\n"
        "## Acceptance\n"
        "The disposable source file remains readable and every policy gate returns the expected result.\n\n"
        "## Non-goals\n"
        "This fixture does not contact networks, production services, or the installing project.\n\n"
        "## Canonical commands\n"
        "Run the bundled selftest with the current Python interpreter from any clean checkout.\n\n"
        "## Handoff\n"
        "- next: Continue the entirely synthetic task using only disposable fixture files; "
        "this sentence is deliberately long enough to prove resumability validation.\n"
        "- read_first: roadmap/work/W0.md and the synthetic source fixture.\n"
        "- hazards: No external systems or live project state are involved in this test.\n"
    )


def roadmap_text(status: str) -> str:
    return (
        "# Synthetic roadmap\n\n"
        "## Phases\n"
        "| ID | Phase | Goal | State |\n"
        "|---|---|---|---|\n"
        "| P0 | Synthetic | Test | **In progress** |\n\n"
        "## Work ladder — exact projection\n"
        "| ID | Title | Phase | Depends on | Evidence target | Status |\n"
        "|---|---|---|---|---|---|\n"
        f"| W0 | Synthetic work | P0 | — | Correct | {status} |\n"
    )


def write_control_plane(repo: Path, status: str = "candidate", scopes: list[str] | None = None) -> None:
    scopes = scopes or ["src/**"]
    copy_tools(repo)
    write(repo / "roadmap" / "STATUS.md", status_text(status == "active"))
    write(repo / "roadmap" / "ROADMAP.md", roadmap_text(status))
    write(repo / "roadmap" / "VISION.md", "# Synthetic vision\n")
    write(repo / "roadmap" / "SYSTEM.md", "# Synthetic system\n")
    write(repo / "roadmap" / "RULES.md", "# Synthetic rules\n")
    write(repo / "roadmap" / "work" / "W0.md", work_text(status, scopes))
    write(repo / ".github" / "workflows" / "control-plane.yml", "name: synthetic\n")
    write(repo / ".githooks" / "pre-commit", "#!/bin/sh\nexit 0\n")


def set_work_state(repo: Path, status: str, scopes: list[str]) -> None:
    write(repo / "roadmap" / "STATUS.md", status_text(status == "active"))
    write(repo / "roadmap" / "ROADMAP.md", roadmap_text(status))
    write(repo / "roadmap" / "work" / "W0.md", work_text(status, scopes))


def head(repo: Path) -> str:
    result = git(repo, "rev-parse", "HEAD")
    must(result, "rev-parse HEAD")
    return result.stdout.strip()


def commit_all(repo: Path, message: str) -> str:
    must(git(repo, "add", "-A"), "git add")
    must(
        git(repo, "commit", "-q", "--no-verify", "-m", message),
        "git commit",
    )
    return head(repo)


def render_claim(repo: Path, base: str, scopes: list[str]) -> str:
    parsed = [parse_scope(scope) for scope in scopes]
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    issued = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    expires = (now + dt.timedelta(hours=8)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        "---\n"
        "claim_id: 11111111-1111-4111-8111-111111111111\n"
        "generation: 1\n"
        "agent: synthetic\n"
        "task: W0\n"
        "status: active\n"
        "integrator: true\n"
        "branch: main\n"
        f"worktree_id: {worktree_id(repo)}\n"
        f"base_commit: {base}\n"
        "allowed_paths:\n"
        + "\n".join(f"  - {scope}" for scope in scopes)
        + "\n"
        f"scope_hash: {scope_hash(parsed)}\n"
        f"issued_at: {issued}\n"
        f"lease_expires: {expires}\n"
        f"updated_at: {issued}\n"
        "---\n\n# Synthetic claim\n"
    )


def replace_claim_times(
    text: str,
    *,
    issued: str,
    updated: str,
    expires: str,
) -> str:
    replacements = {
        "issued_at": issued,
        "updated_at": updated,
        "lease_expires": expires,
    }
    for key, value in replacements.items():
        text, count = re.subn(
            rf"^{key}:.*$", f"{key}: {value}", text, count=1, flags=re.M
        )
        if count != 1:
            raise RuntimeError(f"synthetic claim omitted {key}")
    return text


def receipt_basis(repo: Path, tested_commit: str, work_id: str = "W0") -> tuple[str, str]:
    result = tool(
        repo,
        "doctor.py",
        "--receipt-basis",
        work_id,
        "--snapshot",
        tested_commit,
    )
    must(result, "derive immutable receipt basis")
    fields = {
        key: value
        for line in result.stdout.splitlines()
        if ": " in line
        for key, value in [line.split(": ", 1)]
    }
    return fields["input_fingerprint"], fields["contract_fingerprint"]


def evidence_text(
    tested_commit: str,
    input_fingerprint: str,
    contract_fingerprint: str,
    work_id: str = "W0",
) -> str:
    return (
        "---\n"
        "id: E-SYNTHETIC\n"
        "type: evidence\n"
        "title: Synthetic verification receipt\n"
        "status: recorded\n"
        f"work: {work_id}\n"
        "result: pass\n"
        "observed_at: 2000-01-01T00:00:00Z\n"
        f"tested_commit: {tested_commit}\n"
        f"input_fingerprint: {input_fingerprint}\n"
        f"contract_fingerprint: {contract_fingerprint}\n"
        "environment: disposable local synthetic repository\n"
        "commands:\n"
        "  - synthetic-verification-command\n"
        "updated: 2000-01-01\n"
        "---\n\n"
        "# Synthetic verification receipt\n"
    )


def enforcement_text(
    posture: str,
    *,
    merge_fields: bool = False,
    observed_commit: str = "",
) -> str:
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    observed = (now - dt.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    expires = (now + dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    attested = posture == "merge-gated-attested"
    extra = (
        "required_checks:\n"
        "  - Trusted parent-authority scope review\n"
        "actor_coverage:\n"
        "  - repository administrators\n"
        "provider: synthetic-host\n"
        "repository_id: synthetic-repository-id\n"
        "protected_ref: refs/heads/main\n"
        "ruleset_id: synthetic-ruleset\n"
        "workflow_identity: synthetic/trusted-control-plane@immutable\n"
        "trust_ref: refs/heads/main\n"
        "required_check_source: synthetic-ruleset-required-workflow\n"
        "direct_push: blocked\n"
        "admin_bypass: blocked\n"
        "merge_queue: disabled\n"
        f"observed_commit: {observed_commit}\n"
        f"expires_at: {expires}\n"
        if merge_fields
        else ""
    )
    limitations = "limitations: []\n" if attested else (
        "limitations:\n  - disposable fixture only\n"
    )
    return (
        "---\n"
        "id: ENF-SYNTHETIC\n"
        "type: enforcement\n"
        "title: Synthetic enforcement observation\n"
        "status: recorded\n"
        f"posture: {posture}\n"
        f"observed_at: {observed if attested else '2000-01-01T00:00:00Z'}\n"
        "checks:\n"
        "  - synthetic control-plane check observed\n"
        f"{limitations}"
        f"{extra}"
        f"updated: {now.date().isoformat() if attested else '2000-01-01'}\n"
        "---\n\n# Synthetic enforcement observation\n"
    )


def build_candidate(repo: Path) -> str:
    init_repo(repo)
    write_control_plane(repo)
    write(repo / "src" / "allowed.txt", "allowed\n")
    write(repo / "outside.txt", "outside\n")
    return commit_all(repo, "synthetic candidate baseline")


def build_active(repo: Path) -> tuple[str, str]:
    initial = build_candidate(repo)
    set_work_state(repo, "active", ["src/**"])
    write(
        repo / "roadmap" / "claims" / "CLAIM-synthetic.md",
        render_claim(repo, initial, ["src/**"]),
    )
    active = commit_all(repo, "synthetic activation")
    return initial, active


def output(result: subprocess.CompletedProcess[str]) -> str:
    return (result.stdout + "\n" + result.stderr).strip()


def reset(repo: Path, target: str = "HEAD") -> None:
    must(git(repo, "reset", "--hard", "-q", target), "git reset --hard")
    must(git(repo, "clean", "-fdq"), "git clean")


def test_shared_primitives() -> None:
    print("Shared primitive mutations")
    try:
        parse_frontmatter("---\nid: one\nid: two\n---\n", "synthetic", required=True)
        duplicate_failed = False
    except Exception:
        duplicate_failed = True
    check("primitive:duplicate-frontmatter-key", duplicate_failed)
    try:
        parse_utc("2030-02-30T00:00:00Z", "synthetic")
        calendar_failed = False
    except Exception:
        calendar_failed = True
    check("primitive:real-calendar-time", calendar_failed)
    try:
        parse_scope("src/*.py", "synthetic")
        wildcard_failed = False
    except Exception:
        wildcard_failed = True
    check("primitive:exact-or-subtree-only", wildcard_failed)


def test_doctor_and_gate(root: Path) -> None:
    print("Doctor and staged-index gate")
    repo = root / "doctor-gate"
    _, active = build_active(repo)
    result = tool(repo, "doctor.py", "--snapshot", "index", "--check-live-leases")
    check("doctor:synthetic-baseline", result.returncode == 0, output(result))

    write(repo / "src" / "allowed.txt", "frozen-index change\n")
    must(git(repo, "add", "src/allowed.txt"), "stage frozen-index input")
    frozen = Snapshot(str(repo), "index")
    write(repo / "outside.txt", "later live-index change\n")
    must(git(repo, "add", "outside.txt"), "mutate live index after freeze")
    frozen_diff = git(
        repo,
        "diff",
        "--name-only",
        "HEAD",
        frozen.treeish,
        "--",
    )
    must(frozen_diff, "diff frozen tree")
    frozen_paths = [line for line in frozen_diff.stdout.splitlines() if line]
    gate_source = read(repo / "roadmap" / "tools" / "scope_gate.py")
    check(
        "gate:diff-and-bytes-share-frozen-index",
        frozen_paths == ["src/allowed.txt"]
        and "staged.treeish" in gate_source
        and '"--cached"' not in gate_source,
        str(frozen_paths),
    )
    reset(repo, active)

    status_path = repo / "roadmap" / "STATUS.md"
    valid = read(status_path)
    write(status_path, valid.replace("writer_mode: serial\n", "writer_mode: serial\nwriter_mode: serial\n"))
    must(git(repo, "add", "roadmap/STATUS.md"), "stage duplicate")
    write(status_path, valid)
    result = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "doctor:index-not-worktree",
        result.returncode == 1 and "duplicate" in output(result).casefold(),
        output(result),
    )
    reset(repo, active)

    claim_path = repo / "roadmap" / "claims" / "CLAIM-synthetic.md"
    claim = read(claim_path)
    write(
        claim_path,
        re.sub(
            r"^lease_expires:.*$",
            "lease_expires: 2099-02-30T00:00:00Z",
            claim,
            count=1,
            flags=re.M,
        ),
    )
    must(git(repo, "add", "roadmap/claims/CLAIM-synthetic.md"), "stage bad lease")
    result = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "doctor:invalid-calendar-lease",
        result.returncode == 1 and "invalid calendar" in output(result),
        output(result),
    )
    reset(repo, active)

    claim = read(claim_path)
    future = replace_claim_times(
        claim,
        issued="2999-01-01T00:00:00Z",
        updated="2999-01-01T00:00:00Z",
        expires="2999-01-01T08:00:00Z",
    )
    write(claim_path, future)
    must(git(repo, "add", "roadmap/claims/CLAIM-synthetic.md"), "stage future lease")
    result = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "lease:future-issued-rejected",
        result.returncode == 1 and "may not be in the future" in output(result),
        output(result),
    )
    reset(repo, active)

    claim = read(claim_path)
    overlong = replace_claim_times(
        claim,
        issued="2000-01-01T00:00:00Z",
        updated="2000-01-01T00:00:00Z",
        expires="2000-01-03T00:00:00Z",
    )
    write(claim_path, overlong)
    must(git(repo, "add", "roadmap/claims/CLAIM-synthetic.md"), "stage overlong lease")
    result = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "lease:overlong-window-rejected",
        result.returncode == 1 and "exceeds 24 hours" in output(result),
        output(result),
    )
    reset(repo, active)

    claim = replace_claim_times(
        read(claim_path),
        issued="2000-01-01T00:00:00Z",
        updated="2000-01-01T00:00:00Z",
        expires="2000-01-01T08:00:00Z",
    )
    write(claim_path, claim)
    expired_head = commit_all(repo, "synthetic expired lease")
    write(repo / "src" / "allowed.txt", "expired writer output\n")
    must(git(repo, "add", "src/allowed.txt"), "stage expired output")
    blocked = tool(repo, "scope_gate.py")
    reset(repo, expired_head)
    renewal = tool(repo, "claim.py", "renew", "synthetic")
    released = tool(repo, "claim.py", "release", "synthetic")
    set_work_state(repo, "candidate", ["src/**"])
    must(git(repo, "add", "roadmap"), "stage expired cleanup")
    cleanup = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    check(
        "lease:expired-output-blocked-cleanup-allowed",
        blocked.returncode == 1
        and renewal.returncode == 1
        and released.returncode == 0
        and cleanup.returncode == 0,
        "\n".join(map(output, (blocked, renewal, released, cleanup))),
    )
    reset(repo, active)

    write(repo / "src" / "allowed.txt", "changed\n")
    must(git(repo, "add", "src/allowed.txt"), "stage allowed")
    result = tool(repo, "scope_gate.py")
    check("gate:in-scope", result.returncode == 0, output(result))
    reset(repo, active)

    write(repo / "outside.txt", "changed\n")
    must(git(repo, "add", "outside.txt"), "stage outside")
    result = tool(repo, "scope_gate.py")
    check(
        "gate:out-of-scope",
        result.returncode == 1 and "outside.txt" in output(result),
        output(result),
    )
    reset(repo, active)

    must(git(repo, "mv", "src/allowed.txt", "outside-renamed.txt"), "rename out")
    result = tool(repo, "scope_gate.py")
    check(
        "gate:rename-destination-checked",
        result.returncode == 1 and "outside-renamed.txt" in output(result),
        output(result),
    )
    reset(repo, active)

    must(git(repo, "mv", "outside.txt", "src/moved.txt"), "rename in")
    result = tool(repo, "scope_gate.py")
    check(
        "gate:rename-source-checked",
        result.returncode == 1 and "outside.txt" in output(result),
        output(result),
    )
    reset(repo, active)

    workflow = repo / ".github" / "workflows" / "control-plane.yml"
    write(workflow, "name: protected change\n")
    must(git(repo, "add", str(workflow.relative_to(repo))), "stage protected")
    denied = tool(repo, "scope_gate.py")
    allowed = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    check(
        "gate:protected-owner-ack-required",
        denied.returncode == 1 and allowed.returncode == 0,
        output(denied) + "\n" + output(allowed),
    )
    reset(repo, active)

    claim = read(claim_path)
    write(claim_path, re.sub(r"^scope_hash:.*$", "scope_hash: sha256:" + "0" * 64, claim, flags=re.M))
    must(git(repo, "add", "roadmap/claims/CLAIM-synthetic.md"), "stage scope hash")
    doctor = tool(repo, "doctor.py", "--snapshot", "index")
    gate = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    check(
        "claim:scope-hash-enforced",
        doctor.returncode == 1 and gate.returncode == 1,
        output(doctor) + "\n" + output(gate),
    )
    reset(repo, active)

    result = tool(repo, "scope_gate.py", "--base", "deadbeef")
    check("gate:missing-git-ref-fails-closed", result.returncode == 1, output(result))


def test_reviewer_core_rules(root: Path) -> None:
    print("Reviewer-driven snapshot and schema rules")
    repo = root / "core-rules"
    _, active = build_active(repo)

    first = snapshot_fingerprint(Snapshot(str(repo), "index"), ["src/**"])
    second = snapshot_fingerprint(
        Snapshot(str(repo), "index"), ["src/**", "outside.txt"]
    )
    check("fingerprint:invalidated-policy-bound", first != second)

    before_mode = snapshot_fingerprint(
        Snapshot(str(repo), "index"), ["src/allowed.txt"]
    )
    must(git(repo, "update-index", "--chmod=+x", "src/allowed.txt"), "stage executable mode")
    after_mode = snapshot_fingerprint(
        Snapshot(str(repo), "index"), ["src/allowed.txt"]
    )
    check("fingerprint:git-mode-bound", before_mode != after_mode)
    reset(repo, active)

    write(
        repo / "roadmap" / "ideas" / "missing-id.md",
        "---\ntype: idea\ntitle: Missing id\nstatus: inbox\nupdated: 2030-01-01\n---\n",
    )
    must(git(repo, "add", "roadmap/ideas/missing-id.md"), "stage missing id")
    result = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "schema:typed-file-requires-id",
        result.returncode == 1 and "missing required field 'id'" in output(result),
        output(result),
    )
    reset(repo, active)

    write(
        repo / "roadmap" / "ideas" / "wrong-type.md",
        "---\nid: IDEA-00000000-0000-4000-8000-000000000001\n"
        "type: risk\ntitle: Wrong directory type\nstatus: open\nupdated: 2030-01-01\n---\n",
    )
    must(git(repo, "add", "roadmap/ideas/wrong-type.md"), "stage wrong type")
    result = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "schema:directory-type-contract",
        result.returncode == 1 and "roadmap/ideas" in output(result),
        output(result),
    )
    reset(repo, active)

    fake = roadmap_text("active").replace("**In progress**", "Planned")
    fake += "\n## Decoy table\n| P9 | Fake | Fake | **In progress** |\n"
    write(repo / "roadmap" / "ROADMAP.md", fake)
    write(
        repo / "roadmap" / "STATUS.md",
        status_text(True).replace("active_phase: P0", "active_phase: P9"),
    )
    must(git(repo, "add", "roadmap/ROADMAP.md", "roadmap/STATUS.md"), "stage fake phase")
    result = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "phase:decoy-row-not-authority",
        result.returncode == 1 and "P9" in output(result),
        output(result),
    )
    reset(repo, active)

    roadmap = roadmap_text("active").replace(
        "| P0 | Synthetic | Test | **In progress** |",
        "| P0 | Synthetic | Test | **In progress** |\n| P1 | Later | Test | Planned |",
    ).replace("| W0 | Synthetic work | P0 |", "| W0 | Synthetic work | P1 |")
    write(repo / "roadmap" / "ROADMAP.md", roadmap)
    write(
        repo / "roadmap" / "work" / "W0.md",
        work_text("active", ["src/**"]).replace("phase: P0", "phase: P1"),
    )
    must(git(repo, "add", "roadmap/ROADMAP.md", "roadmap/work/W0.md"), "stage phase mismatch")
    result = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "phase:active-work-matches-status",
        result.returncode == 1 and "active work phase" in output(result),
        output(result),
    )
    reset(repo, active)

    receipt = "roadmap/evidence/E-SYNTHETIC.md"
    work_path = repo / "roadmap" / "work" / "W0.md"
    work = read(work_path).replace(
        "evidence_receipts: []", f"evidence_receipts:\n  - {receipt}"
    )
    write(work_path, work)
    write(
        repo / "roadmap" / "evidence" / "E-SYNTHETIC.md",
        evidence_text(active, *receipt_basis(repo, active)),
    )
    must(git(repo, "add", "roadmap/work/W0.md", receipt), "stage stamp inputs")
    write(work_path, work + "\nunstaged divergence\n")
    result = tool(repo, "doctor.py", "--stamp", "W0")
    check(
        "stamp:rejects-index-worktree-divergence",
        result.returncode == 1 and "working tree differs" in output(result),
        output(result),
    )

    achieved_repo = root / "achieved-rules"
    build_candidate(achieved_repo)
    achieved = work_text("achieved", ["src/**"]).replace(
        "  - src/allowed.txt\n", "  - roadmap/work/W0.md\n", 1
    )
    write(achieved_repo / "roadmap" / "work" / "W0.md", achieved)
    write(achieved_repo / "roadmap" / "ROADMAP.md", roadmap_text("achieved"))
    must(git(achieved_repo, "add", "roadmap"), "stage achieved mutation")
    result = tool(achieved_repo, "doctor.py", "--snapshot", "index")
    check(
        "achieved:no-self-deliverable-and-receipt-required",
        result.returncode == 1
        and "own achieved deliverable" in output(result)
        and "evidence_receipts" in output(result),
        output(result),
    )


def test_evidence_round_trip(root: Path) -> None:
    print("Evidence stamp and invalidation round-trip")
    repo = root / "evidence-round-trip"
    baseline = build_candidate(repo)
    set_work_state(repo, "achieved", ["src/**"])
    receipt = "roadmap/evidence/E-SYNTHETIC.md"
    work_path = repo / "roadmap" / "work" / "W0.md"
    work = read(work_path).replace(
        "evidence_receipts: []", f"evidence_receipts:\n  - {receipt}"
    )
    write(work_path, work)
    write(repo / receipt, evidence_text(baseline, *receipt_basis(repo, baseline)))
    must(git(repo, "add", "roadmap"), "stage achieved contract and receipt")
    stamped = tool(
        repo,
        "doctor.py",
        "--stamp",
        "W0",
        "--now",
        "2030-01-02T00:00:00Z",
    )
    stamped_text = read(work_path)
    must(git(repo, "add", "roadmap/work/W0.md"), "stage evidence fingerprint")
    valid = tool(
        repo,
        "doctor.py",
        "--snapshot",
        "index",
        "--now",
        "2030-01-02T00:00:00Z",
    )
    check(
        "evidence:achieved-stamp-round-trip",
        stamped.returncode == 0
        and "evidence_fingerprint: sha256:" in stamped_text
        and valid.returncode == 0,
        output(stamped) + "\n" + output(valid),
    )

    write(
        work_path,
        stamped_text.replace(
            "this sentence is deliberately long enough",
            "this materially changed sentence is deliberately long enough",
        ),
    )
    must(git(repo, "add", "roadmap/work/W0.md"), "stage work contract mutation")
    invalidated = tool(
        repo,
        "doctor.py",
        "--snapshot",
        "index",
        "--now",
        "2030-01-02T00:00:00Z",
    )
    check(
        "evidence:work-contract-mutation-invalidates-stamp",
        invalidated.returncode == 1 and "evidence INVALIDATED" in output(invalidated),
        output(invalidated),
    )


def test_enforcement_posture(root: Path) -> None:
    print("Evidence-backed enforcement posture")
    repo = root / "enforcement-posture"
    baseline = build_candidate(repo)
    status_path = repo / "roadmap" / "STATUS.md"
    evidence_rel = "roadmap/evidence/ENF-SYNTHETIC.md"

    write(
        status_path,
        read(status_path).replace("parallel_readers: allowed", "parallel_readers: maybe"),
    )
    must(git(repo, "add", "roadmap/STATUS.md"), "stage invalid reader posture")
    invalid_readers = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "enforcement:parallel-readers-enum",
        invalid_readers.returncode == 1 and "parallel_readers" in output(invalid_readers),
        output(invalid_readers),
    )
    reset(repo, baseline)

    unsupported = read(status_path).replace(
        "enforcement: bootstrap\nenforcement_evidence: []",
        "enforcement: ci-unprotected\nenforcement_evidence: []",
    )
    write(status_path, unsupported)
    must(git(repo, "add", "roadmap/STATUS.md"), "stage unsupported posture assertion")
    missing = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "enforcement:non-bootstrap-requires-evidence",
        missing.returncode == 1 and "requires enforcement_evidence" in output(missing),
        output(missing),
    )
    reset(repo, baseline)

    asserted = read(status_path).replace(
        "enforcement: bootstrap\nenforcement_evidence: []",
        f"enforcement: ci-unprotected\nenforcement_evidence:\n  - {evidence_rel}",
    )
    write(status_path, asserted)
    write(repo / evidence_rel, enforcement_text("ci-unprotected"))
    must(git(repo, "add", "roadmap"), "stage observed CI posture")
    local_denied = tool(repo, "scope_gate.py")
    local_allowed = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    valid = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "enforcement:typed-observation-validates-and-owner-gates",
        local_denied.returncode == 1
        and local_allowed.returncode == 0
        and valid.returncode == 0,
        "\n".join(map(output, (local_denied, local_allowed, valid))),
    )

    merge_status = asserted.replace("enforcement: ci-unprotected", "enforcement: merge-gated-attested")
    write(status_path, merge_status)
    write(repo / evidence_rel, enforcement_text("merge-gated-attested"))
    must(git(repo, "add", "roadmap"), "stage incomplete merge-gated posture")
    incomplete = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "enforcement:merge-gated-needs-coverage",
        incomplete.returncode == 1 and "required_checks" in output(incomplete),
        output(incomplete),
    )

    write(
        repo / evidence_rel,
        enforcement_text(
            "merge-gated-attested",
            merge_fields=True,
            observed_commit=baseline,
        ),
    )
    must(git(repo, "add", evidence_rel), "stage complete merge-gated evidence")
    complete = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "enforcement:merge-gated-complete-observation",
        complete.returncode == 0,
        output(complete),
    )


def test_project_completion(root: Path) -> None:
    print("Project completion lifecycle")
    repo = root / "project-complete"
    build_candidate(repo)
    status_path = repo / "roadmap" / "STATUS.md"
    roadmap_path = repo / "roadmap" / "ROADMAP.md"
    write(
        status_path,
        read(status_path).replace("project_state: active", "project_state: complete"),
    )
    write(roadmap_path, read(roadmap_path).replace("**In progress**", "Complete"))
    must(git(repo, "add", "roadmap/STATUS.md", "roadmap/ROADMAP.md"), "stage completion")
    denied = tool(repo, "scope_gate.py")
    allowed = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    complete = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "project:complete-allows-zero-in-progress-and-owner-gates",
        denied.returncode == 1 and allowed.returncode == 0 and complete.returncode == 0,
        "\n".join(map(output, (denied, allowed, complete))),
    )
    write(roadmap_path, read(roadmap_path).replace("Complete", "**In progress**"))
    must(git(repo, "add", "roadmap/ROADMAP.md"), "stage nonterminal complete phase")
    nonterminal = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "project:complete-requires-zero-in-progress",
        nonterminal.returncode == 1 and "requires zero In progress" in output(nonterminal),
        output(nonterminal),
    )

    active_repo = root / "project-complete-invalid"
    build_active(active_repo)
    active_status = active_repo / "roadmap" / "STATUS.md"
    active_roadmap = active_repo / "roadmap" / "ROADMAP.md"
    invalid_status = read(active_status).replace("project_state: active", "project_state: complete")
    invalid_status = invalid_status.replace("active_task: W0", "active_task: none")
    write(active_status, invalid_status)
    write(active_roadmap, read(active_roadmap).replace("**In progress**", "Complete"))
    must(git(active_repo, "add", "roadmap"), "stage invalid completion")
    invalid = tool(active_repo, "doctor.py", "--snapshot", "index")
    check(
        "project:complete-rejects-active-work-and-claims",
        invalid.returncode == 1
        and "may not have active work" in output(invalid)
        and "may not have active claims" in output(invalid),
        output(invalid),
    )


def test_owner_semantics_and_immutability(root: Path) -> None:
    print("Owner semantic parity and immutable lifecycle records")
    repo = root / "owner-semantics"
    base = build_candidate(repo)
    captured = tool(repo, "new.py", "idea", "routine capture")
    idea_rel = captured.stdout.strip()
    must(git(repo, "add", idea_rel), "stage routine idea")
    local_capture = tool(repo, "scope_gate.py")
    capture_head = commit_all(repo, "routine idea capture")
    ci_capture = tool(repo, "scope_diff.py", base, capture_head)
    check(
        "owner:routine-capture-needs-no-owner-token",
        captured.returncode == 0
        and local_capture.returncode == 0
        and ci_capture.returncode == 0,
        "\n".join(map(output, (captured, local_capture, ci_capture))),
    )

    idea_path = repo / idea_rel
    write(idea_path, read(idea_path).replace("status: inbox", "status: promoted"))
    must(git(repo, "add", idea_rel), "stage idea promotion")
    local_denied = tool(repo, "scope_gate.py")
    local_allowed = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    promoted = commit_all(repo, "owner-reviewed idea promotion")
    ci_denied = tool(repo, "scope_diff.py", capture_head, promoted)
    wrong_token = tool(
        repo,
        "scope_diff.py",
        capture_head,
        promoted,
        "--pull-request-number",
        "18",
        "--policy-approval",
        policy_approval_token("17", capture_head, promoted),
    )
    ci_allowed = tool(
        repo,
        "scope_diff.py",
        capture_head,
        promoted,
        *approval_args(capture_head, promoted),
    )
    check(
        "owner:promotion-local-ack-and-server-context-token",
        local_denied.returncode == 1
        and local_allowed.returncode == 0
        and ci_denied.returncode == 1
        and wrong_token.returncode == 1
        and ci_allowed.returncode == 0,
        "\n".join(
            map(output, (local_denied, local_allowed, ci_denied, wrong_token, ci_allowed))
        ),
    )

    enforcement_rel = "roadmap/evidence/ENF-IMMUTABLE.md"
    write(repo / enforcement_rel, enforcement_text("ci-unprotected"))
    must(git(repo, "add", enforcement_rel), "stage routine unreferenced evidence")
    evidence_gate = tool(repo, "scope_gate.py")
    evidence_head = commit_all(repo, "record routine enforcement evidence")
    write(repo / enforcement_rel, read(repo / enforcement_rel) + "\nrewritten history\n")
    must(git(repo, "add", enforcement_rel), "stage recorded evidence rewrite")
    rewrite_gate = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    rewritten = commit_all(repo, "synthetic forbidden evidence rewrite")
    rewrite_ci = tool(repo, "scope_diff.py", evidence_head, rewritten)
    check(
        "records:recorded-evidence-is-append-only",
        evidence_gate.returncode == 0
        and rewrite_gate.returncode == 1
        and rewrite_ci.returncode == 1,
        "\n".join(map(output, (evidence_gate, rewrite_gate, rewrite_ci))),
    )

    decision_repo = root / "immutable-decision"
    build_candidate(decision_repo)
    decision = tool(decision_repo, "new.py", "decision", "immutable accepted decision")
    decision_rel = decision.stdout.strip()
    decision_path = decision_repo / decision_rel
    accepted_text = read(decision_path).replace("status: proposed", "status: accepted")
    accepted_text = accepted_text.replace("updated:", "approved_by: synthetic-owner\nupdated:")
    write(decision_path, accepted_text)
    accepted_head = commit_all(decision_repo, "record accepted decision")
    decision_path.unlink()
    must(git(decision_repo, "add", "-u", decision_rel), "stage accepted decision deletion")
    decision_gate = tool(
        decision_repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    deleted_head = commit_all(decision_repo, "synthetic forbidden decision deletion")
    decision_ci = tool(decision_repo, "scope_diff.py", accepted_head, deleted_head)
    check(
        "records:accepted-decision-cannot-disappear",
        decision.returncode == 0
        and decision_gate.returncode == 1
        and decision_ci.returncode == 1,
        output(decision_gate) + "\n" + output(decision_ci),
    )

    contract_repo = root / "durable-contract"
    _, active = build_active(contract_repo)
    contract_path = contract_repo / "roadmap" / "work" / "W0.md"
    write(
        contract_path,
        read(contract_path).replace(
            "The disposable source file remains readable",
            "The revised disposable source file remains readable",
        ),
    )
    must(git(contract_repo, "add", "roadmap/work/W0.md"), "stage contract rewrite")
    contract_denied = tool(contract_repo, "scope_gate.py")
    contract_allowed = tool(
        contract_repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    contract_head = commit_all(contract_repo, "owner-reviewed contract rewrite")
    contract_ci_denied = tool(contract_repo, "scope_diff.py", active, contract_head)
    contract_ci_allowed = tool(
        contract_repo,
        "scope_diff.py",
        active,
        contract_head,
        *approval_args(active, contract_head),
    )
    check(
        "owner:durable-verification-contract-is-gated",
        contract_denied.returncode == 1
        and contract_allowed.returncode == 0
        and contract_ci_denied.returncode == 1
        and contract_ci_allowed.returncode == 0,
        "\n".join(
            map(
                output,
                (
                    contract_denied,
                    contract_allowed,
                    contract_ci_denied,
                    contract_ci_allowed,
                ),
            )
        ),
    )


def test_claim_lifecycle(root: Path) -> None:
    print("Serial claim lifecycle")
    repo = root / "claim-life"
    build_candidate(repo)
    set_work_state(repo, "active", ["src/**"])

    result = tool(repo, "claim.py", "open", "writer", "W0")
    check(
        "claim:explicit-integrator-required",
        result.returncode == 1 and "--integrator" in output(result),
        output(result),
    )
    result = tool(repo, "claim.py", "open", "writer", "W0", "--integrator")
    claim_path = repo / "roadmap" / "claims" / "CLAIM-writer.md"
    data = parse_frontmatter(read(claim_path), "claim", required=True) if claim_path.exists() else {}
    valid_uuid = False
    try:
        valid_uuid = str(uuid.UUID(str(data.get("claim_id", "")))) == data.get("claim_id")
    except ValueError:
        pass
    check(
        "claim:uuid-full-sha-real-time",
        result.returncode == 0
        and valid_uuid
        and bool(re.fullmatch(r"[0-9a-f]{40}", str(data.get("base_commit", ""))))
        and parse_utc(str(data.get("issued_at", "")), "issued") is not None
        and bool(data.get("scope_hash")),
        output(result),
    )
    must(git(repo, "add", "roadmap"), "stage claim bootstrap")
    gate = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    doctor = tool(repo, "doctor.py", "--snapshot", "index", "--check-live-leases")
    check(
        "claim:bootstrap-metadata-only-valid",
        gate.returncode == 0 and doctor.returncode == 0,
        output(gate) + "\n" + output(doctor),
    )
    commit_all(repo, "synthetic claim bootstrap")

    result = tool(repo, "claim.py", "renew", "writer", "--hours", "2")
    must(git(repo, "add", "roadmap/claims/CLAIM-writer.md"), "stage renewal")
    gate = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    check("claim:renewal-transition", result.returncode == 0 and gate.returncode == 0, output(gate))
    commit_all(repo, "synthetic renewal")

    result = tool(repo, "claim.py", "release", "writer")
    set_work_state(repo, "candidate", ["src/**"])
    must(git(repo, "add", "roadmap"), "stage release")
    gate = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    doctor = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "claim:release-with-task-transition",
        result.returncode == 0 and gate.returncode == 0 and doctor.returncode == 0,
        output(gate) + "\n" + output(doctor),
    )
    released = commit_all(repo, "synthetic release")
    claim_path.unlink()
    must(git(repo, "add", "-u", "roadmap/claims/CLAIM-writer.md"), "stage claim deletion")
    gate = tool(repo, "scope_gate.py")
    deleted = commit_all(repo, "synthetic forbidden claim deletion")
    reviewed = tool(repo, "scope_diff.py", released, deleted, "--branch", "main")
    check(
        "claim:terminal-record-is-immutable",
        gate.returncode == 1 and reviewed.returncode == 1,
        output(gate) + "\n" + output(reviewed),
    )

    other = root / "claim-worktrees"
    build_candidate(other)
    set_work_state(other, "active", ["src/**"])
    linked = root / "linked-worktree"
    must(
        git(other, "worktree", "add", "-q", "-b", "synthetic-extra", str(linked)),
        "add linked worktree",
    )
    result = tool(other, "claim.py", "open", "writer", "W0", "--integrator")
    check(
        "claim:no-fake-concurrent-worktrees",
        result.returncode == 1 and "exactly one linked worktree" in output(result),
        output(result),
    )


def test_claim_rebind(root: Path) -> None:
    print("Owner-reviewed clone/move recovery")
    source = root / "rebind-source"
    _, active = build_active(source)
    moved = root / "rebind-clone"
    must(
        git(
            root,
            "-c",
            "core.autocrlf=false",
            "clone",
            "-q",
            str(source),
            str(moved),
        ),
        "clone active repository",
    )
    must(git(moved, "config", "user.name", "Synthetic Test"), "clone git config name")
    must(
        git(moved, "config", "user.email", "synthetic@example.invalid"),
        "clone git config email",
    )
    must(git(moved, "config", "core.autocrlf", "false"), "clone git config autocrlf")
    claim_path = moved / "roadmap" / "claims" / "CLAIM-synthetic.md"
    before = parse_frontmatter(read(claim_path), "claim before rebind", required=True)

    write(moved / "src" / "allowed.txt", "blocked before rebind\n")
    must(git(moved, "add", "src/allowed.txt"), "stage pre-rebind output")
    blocked = tool(moved, "scope_gate.py")
    check(
        "rebind:moved-binding-blocks-output",
        blocked.returncode == 1 and "claim.py rebind" in output(blocked),
        output(blocked),
    )
    must(
        git(moved, "restore", "--staged", "--worktree", "src/allowed.txt"),
        "restore pre-rebind output",
    )

    denied = tool(moved, "claim.py", "rebind", "synthetic")
    approved = tool(
        moved,
        "claim.py",
        "rebind",
        "synthetic",
        "--owner-reviewed",
        "--hours",
        "2",
    )
    after = parse_frontmatter(read(claim_path), "claim after rebind", required=True)
    check(
        "rebind:explicit-command-rotates-binding-only",
        denied.returncode == 1
        and "--owner-reviewed" in output(denied)
        and approved.returncode == 0
        and after.get("claim_id") != before.get("claim_id")
        and int(str(after.get("generation"))) == int(str(before.get("generation"))) + 1
        and after.get("branch") == "main"
        and after.get("worktree_id") == worktree_id(moved)
        and after.get("base_commit") == active
        and after.get("allowed_paths") == before.get("allowed_paths")
        and after.get("scope_hash") == before.get("scope_hash"),
        output(denied) + "\n" + output(approved),
    )

    write(moved / "src" / "allowed.txt", "mixed with rebind\n")
    must(
        git(moved, "add", "roadmap/claims/CLAIM-synthetic.md", "src/allowed.txt"),
        "stage mixed rebind",
    )
    mixed = tool(
        moved,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    check(
        "rebind:must-be-metadata-only",
        mixed.returncode == 1 and "isolated roadmap-only" in output(mixed),
        output(mixed),
    )
    must(
        git(moved, "restore", "--staged", "--worktree", "src/allowed.txt"),
        "restore mixed product output",
    )
    unreviewed = tool(moved, "scope_gate.py")
    reviewed = tool(
        moved,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    check(
        "rebind:local-owner-review-fence",
        unreviewed.returncode == 1
        and "OWNER_REVIEWED" in output(unreviewed)
        and reviewed.returncode == 0,
        output(unreviewed) + "\n" + output(reviewed),
    )
    rebound = commit_all(moved, "owner-reviewed synthetic claim rebind")
    ci = tool(
        moved,
        "scope_diff.py",
        active,
        rebound,
        "--branch",
        "main",
        *approval_args(active, rebound),
    )
    check(
        "rebind:ci-recognizes-and-warns",
        ci.returncode == 0 and "rebind/takeover" in output(ci),
        output(ci),
    )

    write(moved / "src" / "allowed.txt", "authorized after rebind\n")
    must(git(moved, "add", "src/allowed.txt"), "stage post-rebind output")
    allowed = tool(moved, "scope_gate.py")
    check("rebind:later-output-authorized", allowed.returncode == 0, output(allowed))


def test_terminal_claim_handoff(root: Path) -> None:
    print("Owner-reviewed terminal claim handoff")
    repo = root / "terminal-handoff"
    build_candidate(repo)
    set_work_state(repo, "active", ["src/**"])
    must(
        tool(repo, "claim.py", "open", "writer", "W0", "--integrator"),
        "open feature A claim",
    )
    feature_a = commit_all(repo, "activate feature A")
    must(tool(repo, "claim.py", "release", "writer"), "release feature A claim")
    set_work_state(repo, "candidate", ["src/**"])
    released = commit_all(repo, "release feature A")
    must(git(repo, "switch", "-q", "-c", "feature-b"), "switch to feature B")
    set_work_state(repo, "active", ["src/**"])

    denied_open = tool(repo, "claim.py", "open", "writer", "W0", "--integrator")
    opened = tool(
        repo,
        "claim.py",
        "open",
        "writer",
        "W0",
        "--integrator",
        "--owner-reviewed",
    )
    must(git(repo, "add", "roadmap"), "stage feature B terminal takeover")
    denied_gate = tool(repo, "scope_gate.py")
    allowed_gate = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    check(
        "claim:terminal-handoff-local-owner-fence",
        denied_open.returncode == 1
        and "--owner-reviewed" in output(denied_open)
        and opened.returncode == 0
        and denied_gate.returncode == 1
        and allowed_gate.returncode == 0,
        "\n".join(map(output, (denied_open, opened, denied_gate, allowed_gate))),
    )
    feature_b = commit_all(repo, "owner-reviewed feature B takeover")
    denied_ci = tool(
        repo, "scope_diff.py", released, feature_b, "--branch", "feature-b"
    )
    allowed_ci = tool(
        repo,
        "scope_diff.py",
        released,
        feature_b,
        "--branch",
        "feature-b",
        *approval_args(released, feature_b),
    )
    check(
        "claim:terminal-handoff-server-approval",
        denied_ci.returncode == 1
        and allowed_ci.returncode == 0
        and "terminal claim record" in output(allowed_ci),
        output(denied_ci) + "\n" + output(allowed_ci),
    )
    check("claim:feature-a-history-preserved", bool(feature_a) and bool(released))


def test_adoption(root: Path) -> None:
    print("Fresh and unborn adoption")
    repo = root / "mature-adoption"
    init_repo(repo)
    write(repo / "product.txt", "mature product\n")
    mature = commit_all(repo, "mature repository")
    write_control_plane(repo)
    must(git(repo, "add", "roadmap", ".github", ".githooks"), "stage adoption")
    denied = tool(repo, "scope_gate.py")
    allowed = tool(repo, "scope_gate.py", env={"CONTROL_PLANE_ADOPT": "1"})
    check(
        "adoption:explicit-isolated-path",
        denied.returncode == 1 and allowed.returncode == 0,
        output(denied) + "\n" + output(allowed),
    )
    write(repo / "product.txt", "mixed product\n")
    must(git(repo, "add", "product.txt"), "stage mixed product")
    mixed = tool(repo, "scope_gate.py", env={"CONTROL_PLANE_ADOPT": "1"})
    check(
        "adoption:mixed-product-blocked",
        mixed.returncode == 1 and "product.txt" in output(mixed),
        output(mixed),
    )
    must(git(repo, "reset", "-q", "--", "product.txt"), "unstage product")
    write(repo / "product.txt", "mature product\n")
    adoption = commit_all(repo, "isolated control-plane adoption")
    denied_review = tool(repo, "scope_diff.py", mature, adoption)
    reviewed = tool(
        repo,
        "scope_diff.py",
        mature,
        adoption,
        *approval_args(mature, adoption),
    )
    check(
        "adoption:committed-range-warning",
        denied_review.returncode == 1
        and reviewed.returncode == 0
        and "ADOPTION" in output(reviewed),
        output(denied_review) + "\n" + output(reviewed),
    )

    unborn = root / "unborn-adoption"
    init_repo(unborn)
    write_control_plane(unborn)
    must(git(unborn, "add", "-A"), "stage unborn adoption")
    result = tool(unborn, "scope_gate.py", env={"CONTROL_PLANE_ADOPT": "1"})
    check("adoption:unborn-head", result.returncode == 0, output(result))
    first = commit_all(unborn, "initial synthetic control plane")
    result = tool(unborn, "scope_diff.py", "0" * 40, first, "--allow-initial")
    check(
        "adoption:explicit-initial-history",
        result.returncode == 0 and "INITIAL-HISTORY" in output(result),
        output(result),
    )


def test_commit_order_scope_diff(root: Path) -> None:
    print("Commit-ordered scope review")
    repo = root / "scope-order"
    _, base = build_active(repo)

    set_work_state(repo, "active", ["src/**", "outside.txt"])
    result = tool(repo, "claim.py", "rescope", "synthetic")
    must(git(repo, "add", "roadmap"), "stage rescope")
    gate = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    check(
        "scope:metadata-only-rotation",
        result.returncode == 0 and gate.returncode == 0,
        output(result) + "\n" + output(gate),
    )
    metadata = commit_all(repo, "synthetic metadata-only scope rotation")
    write(repo / "outside.txt", "now authorized\n")
    must(git(repo, "add", "outside.txt"), "stage later output")
    gate = tool(repo, "scope_gate.py")
    check("scope:later-commit-uses-new-scope", gate.returncode == 0, output(gate))
    final = commit_all(repo, "synthetic later product output")
    reviewed = tool(
        repo,
        "scope_diff.py",
        base,
        final,
        "--branch",
        "main",
        *approval_args(base, final),
    )
    check(
        "scope:commit-by-commit-parent-authority",
        reviewed.returncode == 0,
        output(reviewed),
    )

    reset(repo, base)
    set_work_state(repo, "active", ["src/**", "outside.txt"])
    must(tool(repo, "claim.py", "rescope", "synthetic"), "rescope for combined commit")
    write(repo / "outside.txt", "combined\n")
    must(git(repo, "add", "-A"), "stage combined expansion")
    gate = tool(
        repo,
        "scope_gate.py",
        env={"CONTROL_PLANE_OWNER_REVIEWED": "1"},
    )
    check(
        "scope:same-commit-expansion-blocked-locally",
        gate.returncode == 1 and "separately" in output(gate),
        output(gate),
    )
    combined = commit_all(repo, "synthetic unsafe combined expansion")
    reviewed = tool(repo, "scope_diff.py", base, combined, "--branch", "main")
    check(
        "scope:same-commit-expansion-blocked-in-ci",
        reviewed.returncode == 1
        and ("metadata-only" in output(reviewed) or "isolated from product" in output(reviewed)),
        output(reviewed),
    )

    reset(repo, base)
    must(git(repo, "mv", "src/allowed.txt", "outside-renamed.txt"), "range rename")
    renamed = commit_all(repo, "synthetic cross-scope rename")
    reviewed = tool(repo, "scope_diff.py", base, renamed, "--branch", "main")
    check(
        "scope-diff:both-rename-paths",
        reviewed.returncode == 1 and "outside-renamed.txt" in output(reviewed),
        output(reviewed),
    )

    reset(repo, base)
    write(repo / ".github" / "workflows" / "control-plane.yml", "name: reviewed runtime update\n")
    protected = commit_all(repo, "synthetic isolated enforcement update")
    denied = tool(repo, "scope_diff.py", base, protected, "--branch", "main")
    reviewed = tool(
        repo,
        "scope_diff.py",
        base,
        protected,
        "--branch",
        "main",
        *approval_args(base, protected),
    )
    check(
        "scope-diff:protected-isolated-warning",
        denied.returncode == 1
        and reviewed.returncode == 0
        and "SERVER-SIDE OWNER APPROVAL" in output(reviewed),
        output(denied) + "\n" + output(reviewed),
    )

    missing = tool(repo, "scope_diff.py", "deadbeef", protected)
    check("scope-diff:missing-base-fails-closed", missing.returncode == 1, output(missing))


def test_merge_replay(root: Path) -> None:
    print("Normal merge replay")
    repo = root / "merge-replay"
    _, base = build_active(repo)
    must(git(repo, "switch", "-q", "-c", "feature-clean"), "create clean feature")
    write(repo / "src" / "allowed.txt", "clean feature output\n")
    feature = commit_all(repo, "clean feature output")
    must(git(repo, "switch", "-q", "main"), "return to main for clean merge")
    must(
        git(repo, "merge", "-q", "--no-ff", "--no-verify", "-m", "clean merge", "feature-clean"),
        "create normal two-parent merge",
    )
    merge = head(repo)
    replayed = tool(repo, "scope_diff.py", base, merge, "--branch", "main")
    check(
        "merge:up-to-date-second-parent-tree-replayed",
        replayed.returncode == 0 and "replayed 1 normal merge" in output(replayed),
        output(replayed),
    )

    reset(repo, base)
    must(git(repo, "switch", "-q", "-c", "feature-edited"), "create edited feature")
    write(repo / "src" / "allowed.txt", "edited feature output\n")
    commit_all(repo, "edited feature output")
    must(git(repo, "switch", "-q", "main"), "return to main for edited merge")
    must(
        git(repo, "merge", "-q", "--no-ff", "--no-commit", "feature-edited"),
        "prepare edited merge",
    )
    write(repo / "src" / "integration.txt", "integration-only edit\n")
    must(git(repo, "add", "src/integration.txt"), "stage integration edit")
    tampered = commit_all(repo, "merge with integration edit")
    rejected = tool(repo, "scope_diff.py", base, tampered, "--branch", "main")
    check(
        "merge:integration-tree-edit-rejected",
        rejected.returncode == 1 and "merge tree differs" in output(rejected),
        output(rejected),
    )

    owner_repo = root / "merge-owner-replay"
    build_candidate(owner_repo)
    captured = tool(owner_repo, "new.py", "idea", "merge owner transition")
    idea_rel = captured.stdout.strip()
    owner_base = commit_all(owner_repo, "capture idea before branch")
    must(git(owner_repo, "switch", "-q", "-c", "feature-owner"), "create owner feature")
    idea_path = owner_repo / idea_rel
    write(idea_path, read(idea_path).replace("status: inbox", "status: promoted"))
    owner_feature = commit_all(owner_repo, "owner-approved promotion on feature")
    must(git(owner_repo, "switch", "-q", "main"), "return for owner merge")
    must(
        git(
            owner_repo,
            "merge",
            "-q",
            "--no-ff",
            "--no-verify",
            "-m",
            "merge owner-approved feature",
            "feature-owner",
        ),
        "merge owner-approved feature",
    )
    owner_merge = head(owner_repo)
    post_merge = tool(owner_repo, "scope_diff.py", owner_base, owner_merge)
    check(
        "merge:post-merge-replay-assumes-trusted-pr-approval",
        captured.returncode == 0
        and bool(feature)
        and bool(owner_feature)
        and post_merge.returncode == 0
        and "POST-MERGE REPLAY assumes" in output(post_merge),
        output(post_merge),
    )


def test_capture_concurrency(root: Path) -> None:
    print("Collision-resistant capture")
    repo = root / "capture"
    build_candidate(repo)
    processes = [
        subprocess.Popen(
            [PYTHON, str(repo / "roadmap" / "tools" / "new.py"), "idea", "same title"],
            cwd=repo,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        for _ in range(8)
    ]
    results = [process.communicate() + (process.returncode,) for process in processes]
    files = sorted((repo / "roadmap" / "ideas").glob("*.md"))
    ids: list[str] = []
    valid = True
    for path in files:
        try:
            data = parse_frontmatter(read(path), str(path), required=True)
            raw = str(data["id"])
            uuid.UUID(raw.split("-", 1)[1])
            ids.append(raw)
        except Exception:
            valid = False
    check(
        "capture:parallel-uuid-ids",
        all(result[2] == 0 for result in results)
        and len(files) == 8
        and len(set(ids)) == 8
        and valid,
        str(results),
    )
    generated = [
        tool(repo, "new.py", kind, "quoted: # synthetic title")
        for kind in ("idea", "insight", "decision", "risk")
    ]
    must(git(repo, "add", "roadmap/ideas", "roadmap/insights", "roadmap/decisions", "roadmap/risks"), "stage captures")
    doctor = tool(repo, "doctor.py", "--snapshot", "index")
    check(
        "capture:all-types-match-schema",
        all(result.returncode == 0 for result in generated) and doctor.returncode == 0,
        "\n".join(output(result) for result in generated) + "\n" + output(doctor),
    )


def main() -> int:
    test_shared_primitives()
    with tempfile.TemporaryDirectory(prefix="control-plane-selftest-") as temporary:
        root = Path(temporary)
        test_doctor_and_gate(root)
        test_reviewer_core_rules(root)
        test_evidence_round_trip(root)
        test_enforcement_posture(root)
        test_project_completion(root)
        test_owner_semantics_and_immutability(root)
        test_claim_lifecycle(root)
        test_claim_rebind(root)
        test_terminal_claim_handoff(root)
        test_adoption(root)
        test_commit_order_scope_diff(root)
        test_merge_replay(root)
        test_capture_concurrency(root)
    print(f"\n{'FAIL' if FAILURES else 'OK'} -- {len(FAILURES)} failing")
    if FAILURES:
        print("failures: " + ", ".join(FAILURES))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
