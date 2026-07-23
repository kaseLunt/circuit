#!/usr/bin/env python3
"""Validate the repo-native control plane from one coherent repository snapshot.

Usage:
  python roadmap/tools/doctor.py [--snapshot worktree|index|<commit>] [--check-live-leases]
  python roadmap/tools/doctor.py --stamp <work-id>
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys

from _control_plane import (
    ControlPlaneError,
    Snapshot,
    commit_exists,
    is_ancestor,
    parse_frontmatter,
    parse_iso_date,
    parse_scope,
    parse_utc,
    repo_root,
    safe_worktree_path,
    scalar,
    scope_contains,
    scope_hash,
    scope_matches,
    scopes_overlap,
    snapshot_fingerprint,
    string_list,
    validate_lease,
)


TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = repo_root(TOOLS)
WORKLIKE = {"work", "experiment", "milestone"}
OBJECT_DIRS = {"horizons", "work", "ideas", "insights", "decisions", "risks", "evidence"}
DIRECTORY_TYPES = {
    "horizons": {"goal", "horizon"},
    "work": WORKLIKE,
    "ideas": {"idea"},
    "insights": {"insight"},
    "decisions": {"decision"},
    "risks": {"risk"},
    "evidence": {"evidence", "enforcement"},
}
WORK_STATUSES = {"inbox", "candidate", "committed", "active", "achieved", "superseded", "rejected", "archived"}
DECISION_STATUSES = {"proposed", "accepted", "superseded", "deprecated", "rejected"}
EVIDENCE_STATUSES = {"recorded", "superseded", "rejected"}
TYPE_STATUSES = {
    "goal": {"candidate", "committed", "achieved", "superseded", "archived"},
    "horizon": {"candidate", "committed", "achieved", "superseded", "archived"},
    "idea": {"inbox", "candidate", "promoted", "rejected", "archived"},
    "insight": {"candidate", "accepted", "superseded", "archived"},
    "risk": {"open", "accepted", "mitigated", "closed", "superseded", "archived"},
    "enforcement": {"recorded", "superseded"},
}
ENFORCEMENT_POSTURES = {
    "bootstrap",
    "local-advisory",
    "ci-unprotected",
    "merge-gated-attested",
}
CLAIM_STATUSES = {"active", "released", "failed", "abandoned"}
AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", default="worktree")
    parser.add_argument("--check-live-leases", action="store_true")
    parser.add_argument("--now", help="fixed strict-UTC clock for deterministic tests")
    parser.add_argument("--stamp", metavar="WORK_ID")
    parser.add_argument("--receipt-basis", metavar="WORK_ID")
    return parser.parse_args()


def stamp(work_id: str, now: dt.datetime) -> int:
    snapshot = Snapshot(REPO, "index")
    for path in snapshot.list("roadmap/work", ".md"):
        data = parse_frontmatter(snapshot.read_text(path), path, required=True)
        if scalar(data, "id", path) != work_id:
            continue
        invalidated = string_list(data, "invalidated_by", path)
        if not invalidated:
            raise ControlPlaneError(f"{path}: cannot stamp without invalidated_by")
        receipts = string_list(data, "evidence_receipts", path)
        if not receipts:
            raise ControlPlaneError(
                f"{path}: cannot stamp without at least one staged evidence_receipt"
            )
        for receipt in receipts:
            if not snapshot.exists(receipt):
                raise ControlPlaneError(f"{path}: staged evidence receipt is absent: {receipt}")
        fingerprint = evidence_fingerprint(snapshot, data, path)
        target = safe_worktree_path(REPO, path, "stamp target")
        text = target.read_text(encoding="utf-8")
        if text != snapshot.read_text(path):
            raise ControlPlaneError(
                f"{path}: working tree differs from the staged object; refusing a mixed-snapshot stamp"
            )
        for receipt in receipts:
            validate_evidence_receipt(snapshot, receipt, work_id, now)
        closing = text.find("\n---", 3)
        if closing < 0:
            raise ControlPlaneError(f"{path}: malformed frontmatter")
        if "evidence_fingerprint" in data:
            scalar(data, "evidence_fingerprint", path, required=True)
            frontmatter = text[:closing]
            replaced, count = re.subn(
                r"^evidence_fingerprint:.*$",
                f"evidence_fingerprint: {fingerprint}",
                frontmatter,
                count=1,
                flags=re.M,
            )
            if count != 1:
                raise ControlPlaneError(f"{path}: malformed evidence_fingerprint field")
            text = replaced + text[closing:]
        else:
            text = text[:closing] + f"\nevidence_fingerprint: {fingerprint}" + text[closing:]
        target.write_text(text, encoding="utf-8", newline="\n")
        print(
            f"stamped {work_id}: {fingerprint} ({path}); this binds the staged proof/input "
            "snapshot but does not itself run the recorded verification commands"
        )
        return 0
    raise ControlPlaneError(f"no staged work item has id '{work_id}'")


def work_ladder_rows(text: str, errors: list[str]) -> dict[str, list[str]]:
    """Parse the six-column work projection without pretending Markdown is YAML."""
    rows: dict[str, list[str]] = {}
    in_ladder = False
    for line_number, line in enumerate(text.splitlines(), start=1):
        if line.startswith("## "):
            in_ladder = line[3:].strip().casefold().startswith("work ladder")
            continue
        if not in_ladder or not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if not cells or cells[0] == "ID" or set(cells[0]) <= {"-", ":"}:
            continue
        if len(cells) != 6:
            errors.append(
                f"ROADMAP.md:{line_number}: work ladder row must contain exactly six columns"
            )
            continue
        object_id = cells[0]
        if object_id in rows:
            errors.append(f"ROADMAP.md:{line_number}: duplicate work ladder id '{object_id}'")
            continue
        rows[object_id] = cells
    return rows


def phase_table_rows(text: str, errors: list[str]) -> list[tuple[str, str]]:
    """Return (phase id, row text) from only the ROADMAP Phases section."""
    rows: list[tuple[str, str]] = []
    in_phases = False
    for line_number, line in enumerate(text.splitlines(), start=1):
        if line.startswith("## "):
            in_phases = line[3:].strip().casefold() == "phases"
            continue
        if not in_phases or not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if not cells or cells[0] == "ID" or set(cells[0]) <= {"-", ":"}:
            continue
        if len(cells) != 4 or not re.fullmatch(r"P\d+", cells[0]):
            errors.append(
                f"ROADMAP.md:{line_number}: phase row must be four columns with a P<number> id"
            )
            continue
        state = cells[-1].replace("*", "").replace("`", "").strip()
        rows.append((cells[0], state))
    return rows


def evidence_fingerprint(snapshot: Snapshot, data: dict, path: str) -> str:
    specs = (
        string_list(data, "invalidated_by", path)
        + string_list(data, "deliverables", path)
        + string_list(data, "evidence_receipts", path)
    )
    # Preserve first occurrence so duplicate policy entries cannot create a second
    # spelling of the same evidence contract.
    unique = list(dict.fromkeys(specs))
    input_fingerprint = snapshot_fingerprint(snapshot, unique, exclude=path)
    contract = snapshot.read_text(path).replace("\r\n", "\n").replace("\r", "\n")
    lines = contract.split("\n")
    if lines and lines[0] == "---":
        try:
            closing = lines.index("---", 1)
        except ValueError as exc:
            raise ControlPlaneError(f"{path}: malformed work frontmatter") from exc
        lines = [
            line
            for index, line in enumerate(lines)
            if not (0 < index < closing and line.startswith("evidence_fingerprint:"))
        ]
    digest = hashlib.sha256()
    digest.update(b"control-plane-work-evidence-v3\0")
    digest.update(input_fingerprint.encode("ascii"))
    digest.update(b"\0")
    digest.update("\n".join(lines).encode("utf-8"))
    return "sha256:" + digest.hexdigest()


def find_work_record(snapshot: Snapshot, work_id: str) -> tuple[str, dict]:
    for candidate in snapshot.list("roadmap/work", ".md"):
        data = parse_frontmatter(snapshot.read_text(candidate), candidate, required=True)
        if scalar(data, "id", candidate) == work_id:
            return candidate, data
    raise ControlPlaneError(f"{snapshot.source}: no work object has id '{work_id}'")


def verification_specs(data: dict, path: str) -> list[str]:
    return list(
        dict.fromkeys(
            string_list(data, "invalidated_by", path)
            + string_list(data, "deliverables", path)
        )
    )


def verification_contract_fingerprint(
    snapshot: Snapshot, path: str, data: dict
) -> str:
    excluded = {"status", "evidence_receipts", "evidence_fingerprint", "updated", "review_when"}
    contract_frontmatter = {
        key: value for key, value in data.items() if key not in excluded
    }
    text = snapshot.read_text(path)
    sections = {
        heading: section_body(text, heading)
        for heading in ("Objective", "Acceptance", "Non-goals", "Canonical commands")
    }
    body = json.dumps(
        {"frontmatter": contract_frontmatter, "sections": sections},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(
        b"control-plane-verification-contract-v1\0" + body
    ).hexdigest()


def verification_input_fingerprint(
    snapshot: Snapshot, path: str, data: dict
) -> str:
    specs = verification_specs(data, path)
    if not specs:
        raise ControlPlaneError(f"{path}: verification basis has no inputs/deliverables")
    return snapshot_fingerprint(snapshot, specs, exclude=path)


def print_receipt_basis(work_id: str, source: str) -> int:
    snapshot = Snapshot(REPO, source)
    if not snapshot.commit:
        raise ControlPlaneError("--receipt-basis requires an immutable commit snapshot")
    path, data = find_work_record(snapshot, work_id)
    print(f"tested_commit: {snapshot.commit}")
    print(
        "input_fingerprint: "
        + verification_input_fingerprint(snapshot, path, data)
    )
    print(
        "contract_fingerprint: "
        + verification_contract_fingerprint(snapshot, path, data)
    )
    return 0


def validate_evidence_receipt(
    snapshot: Snapshot,
    receipt: str,
    work_id: str,
    now: dt.datetime,
    *,
    require_pass: bool = True,
) -> None:
    if not receipt.startswith("roadmap/evidence/") or not snapshot.exists(receipt):
        raise ControlPlaneError(
            f"{receipt}: evidence receipt is absent or outside roadmap/evidence/"
        )
    data = parse_frontmatter(snapshot.read_text(receipt), receipt, required=True)
    scalar(data, "id", receipt, required=True)
    scalar(data, "title", receipt, required=True)
    parse_iso_date(scalar(data, "updated", receipt, required=True), f"{receipt}:updated")
    if scalar(data, "type", receipt, required=True) != "evidence":
        raise ControlPlaneError(f"{receipt}: evidence receipt must have type:evidence")
    receipt_status = scalar(data, "status", receipt, required=True)
    if receipt_status not in EVIDENCE_STATUSES:
        raise ControlPlaneError(f"{receipt}: invalid evidence status '{receipt_status}'")
    if require_pass and receipt_status != "recorded":
        raise ControlPlaneError(f"{receipt}: achieved evidence receipt must be status:recorded")
    if scalar(data, "work", receipt, required=True) != work_id:
        raise ControlPlaneError(f"{receipt}: evidence receipt does not bind work '{work_id}'")
    result = scalar(data, "result", receipt, required=True)
    if result not in {"pass", "fail"}:
        raise ControlPlaneError(f"{receipt}: evidence result must be pass or fail")
    if require_pass and result != "pass":
        raise ControlPlaneError(f"{receipt}: achieved work requires result:pass")
    observed = parse_utc(
        scalar(data, "observed_at", receipt, required=True), f"{receipt}:observed_at"
    )
    if observed > now:
        raise ControlPlaneError(f"{receipt}: observed_at may not be in the future")
    tested_commit = scalar(data, "tested_commit", receipt, required=True)
    if not FULL_SHA_RE.fullmatch(tested_commit) or not commit_exists(REPO, tested_commit):
        raise ControlPlaneError(f"{receipt}: tested_commit must name an existing full SHA")
    descendant = snapshot.commit or "HEAD"
    if not is_ancestor(REPO, tested_commit, descendant):
        raise ControlPlaneError(
            f"{receipt}: tested_commit is not an ancestor of {descendant}"
        )
    scalar(data, "environment", receipt, required=True)
    tested_snapshot = Snapshot(REPO, tested_commit)
    tested_path, tested_work = find_work_record(tested_snapshot, work_id)
    current_path, current_work = find_work_record(snapshot, work_id)
    tested_contract = verification_contract_fingerprint(
        tested_snapshot, tested_path, tested_work
    )
    current_contract = verification_contract_fingerprint(
        snapshot, current_path, current_work
    )
    recorded_contract = scalar(data, "contract_fingerprint", receipt, required=True)
    if recorded_contract != tested_contract or current_contract != tested_contract:
        raise ControlPlaneError(
            f"{receipt}: verification contract differs from the tested commit"
        )
    tested_inputs = verification_input_fingerprint(
        tested_snapshot, tested_path, tested_work
    )
    current_inputs = verification_input_fingerprint(snapshot, current_path, current_work)
    recorded_inputs = scalar(data, "input_fingerprint", receipt, required=True)
    if recorded_inputs != tested_inputs or current_inputs != tested_inputs:
        raise ControlPlaneError(
            f"{receipt}: current inputs/deliverables differ from the tested commit"
        )
    if not string_list(data, "commands", receipt):
        raise ControlPlaneError(f"{receipt}: evidence receipt must list commands")


def validate_enforcement_record(
    snapshot: Snapshot,
    path: str,
    expected_posture: str,
    now: dt.datetime,
) -> None:
    if not re.fullmatch(r"roadmap/evidence/[^/]+\.md", path) or not snapshot.exists(path):
        raise ControlPlaneError(
            f"{path}: enforcement evidence is absent or outside roadmap/evidence/"
        )
    data = parse_frontmatter(snapshot.read_text(path), path, required=True)
    if scalar(data, "type", path, required=True) != "enforcement":
        raise ControlPlaneError(f"{path}: enforcement evidence must have type:enforcement")
    if scalar(data, "status", path, required=True) != "recorded":
        raise ControlPlaneError(f"{path}: active enforcement evidence must be status:recorded")
    if scalar(data, "posture", path, required=True) != expected_posture:
        raise ControlPlaneError(
            f"{path}: posture does not match STATUS enforcement '{expected_posture}'"
        )
    observed = parse_utc(
        scalar(data, "observed_at", path, required=True), f"{path}:observed_at"
    )
    if observed > now:
        raise ControlPlaneError(f"{path}: observed_at may not be in the future")
    if not string_list(data, "checks", path):
        raise ControlPlaneError(f"{path}: enforcement evidence must list checks")
    limitations = string_list(data, "limitations", path)
    if expected_posture != "merge-gated-attested" and not limitations:
        raise ControlPlaneError(f"{path}: enforcement evidence must list limitations")
    if expected_posture == "merge-gated-attested":
        if limitations:
            raise ControlPlaneError(
                f"{path}: merge-gated attestation has unresolved limitations"
            )
        required_checks = string_list(data, "required_checks", path)
        if not required_checks or any(item.casefold() == "none" for item in required_checks):
            raise ControlPlaneError(
                f"{path}: merge-gated attestation must list concrete required_checks"
            )
        actor_coverage = string_list(data, "actor_coverage", path)
        if not actor_coverage or any(item.casefold() in {"none", "nobody"} for item in actor_coverage):
            raise ControlPlaneError(
                f"{path}: merge-gated attestation must list actor_coverage"
            )
        for field in (
            "provider",
            "repository_id",
            "ruleset_id",
            "workflow_identity",
            "trust_ref",
            "required_check_source",
        ):
            scalar(data, field, path, required=True)
        protected_ref = scalar(data, "protected_ref", path, required=True)
        if not protected_ref.startswith("refs/heads/"):
            raise ControlPlaneError(f"{path}: protected_ref must be a refs/heads/... ref")
        for field in ("direct_push", "admin_bypass"):
            if scalar(data, field, path, required=True) != "blocked":
                raise ControlPlaneError(f"{path}: {field} must be blocked")
        merge_queue = scalar(data, "merge_queue", path, required=True)
        if merge_queue not in {"disabled", "externally-validated"}:
            raise ControlPlaneError(
                f"{path}: merge_queue must be disabled or externally-validated"
            )
        observed_commit = scalar(data, "observed_commit", path, required=True)
        if not FULL_SHA_RE.fullmatch(observed_commit) or not commit_exists(REPO, observed_commit):
            raise ControlPlaneError(f"{path}: observed_commit must be an existing full SHA")
        descendant = snapshot.commit or "HEAD"
        if not is_ancestor(REPO, observed_commit, descendant):
            raise ControlPlaneError(
                f"{path}: observed_commit is not an ancestor of {descendant}"
            )
        expires = parse_utc(
            scalar(data, "expires_at", path, required=True), f"{path}:expires_at"
        )
        if expires <= observed or expires > observed + dt.timedelta(hours=24):
            raise ControlPlaneError(
                f"{path}: attestation expiry must be within 24 hours after observed_at"
            )
        if expires <= now:
            raise ControlPlaneError(f"{path}: merge-gated attestation has expired")


def section_body(text: str, heading: str) -> str:
    match = re.search(rf"^## {re.escape(heading)}\s*$", text, re.M)
    if not match:
        return ""
    return re.split(r"^## ", text[match.end():], maxsplit=1, flags=re.M)[0].strip()


def substantive_section(text: str, heading: str, path: str, errors: list[str]) -> str:
    body = section_body(text, heading)
    if not body:
        errors.append(f"{path}: missing or empty '## {heading}' section")
    elif re.search(
        r"\[(?:insert|state|name|replace|describe|list|link)\b", body, re.I
    ):
        errors.append(f"{path}: '## {heading}' is still a placeholder")
    return body


def main() -> int:
    args = arguments()
    if args.receipt_basis:
        return print_receipt_basis(args.receipt_basis, args.snapshot)
    if args.stamp:
        stamp_now = (
            parse_utc(args.now, "--now")
            if args.now
            else dt.datetime.now(dt.timezone.utc)
        )
        return stamp(args.stamp, stamp_now)

    errors: list[str] = []
    warnings: list[str] = []
    infos: list[str] = []
    try:
        snapshot = Snapshot(REPO, args.snapshot)
    except ControlPlaneError as exc:
        print(f"control-plane doctor: FAIL -- {exc}")
        return 1

    case_map: dict[str, str] = {}
    for path in sorted(snapshot.files):
        folded = path.casefold()
        if folded in case_map and case_map[folded] != path:
            errors.append(f"case-colliding repository paths: '{case_map[folded]}' and '{path}'")
        case_map[folded] = path

    required_files = ("roadmap/STATUS.md", "roadmap/ROADMAP.md", "roadmap/VISION.md", "roadmap/SYSTEM.md", "roadmap/RULES.md")
    for path in required_files:
        if not snapshot.exists(path):
            errors.append(f"required control-plane file missing: {path}")

    objects: dict[str, tuple[str, dict, str]] = {}
    status: dict = {}
    roadmap_text = ""
    for path in snapshot.list("roadmap", ".md"):
        if path.startswith("roadmap/archive/"):
            continue
        try:
            text = snapshot.read_text(path)
            top = path.split("/")[1] if path.count("/") >= 2 else ""
            required = top in OBJECT_DIRS or path in ("roadmap/STATUS.md",)
            data = parse_frontmatter(text, path, required=required)
        except ControlPlaneError as exc:
            errors.append(str(exc))
            continue
        if path == "roadmap/STATUS.md":
            status = data
        if path == "roadmap/ROADMAP.md":
            roadmap_text = text
        object_id = data.get("id")
        if top in OBJECT_DIRS:
            try:
                object_id = scalar(data, "id", path, required=True)
                object_type = scalar(data, "type", path, required=True)
                scalar(data, "title", path, required=True)
                scalar(data, "status", path, required=True)
                if object_type not in DIRECTORY_TYPES[top]:
                    errors.append(
                        f"{path}: type '{object_type}' is invalid for roadmap/{top}/ "
                        f"(expected {sorted(DIRECTORY_TYPES[top])})"
                    )
            except ControlPlaneError as exc:
                errors.append(str(exc))
                continue
        if object_id:
            if isinstance(object_id, list):
                errors.append(f"{path}: id must be a scalar")
                continue
            object_id = str(object_id)
            if object_id in objects:
                errors.append(f"duplicate id '{object_id}' ({objects[object_id][0]} and {path})")
            else:
                objects[object_id] = (path, data, text)

    phase_rows = phase_table_rows(roadmap_text, errors)
    phases = [phase for phase, _ in phase_rows]
    if len(set(phases)) != len(phases):
        errors.append("ROADMAP phase IDs must be unique")
    in_progress = [phase for phase, state in phase_rows if state.casefold() == "in progress"]

    active_phase = ""
    active_task = ""
    project_state = ""
    writer_mode = ""
    parallel_readers = ""
    enforcement = ""
    enforcement_evidence: list[str] = []
    if status:
        try:
            active_phase = scalar(status, "active_phase", "roadmap/STATUS.md", required=True)
            active_task = scalar(status, "active_task", "roadmap/STATUS.md", required=True)
            project_state = scalar(
                status, "project_state", "roadmap/STATUS.md", required=True
            )
            writer_mode = scalar(status, "writer_mode", "roadmap/STATUS.md", required=True)
            parallel_readers = scalar(
                status, "parallel_readers", "roadmap/STATUS.md", required=True
            )
            enforcement = scalar(
                status, "enforcement", "roadmap/STATUS.md", required=True
            )
            if "enforcement_evidence" not in status:
                raise ControlPlaneError(
                    "roadmap/STATUS.md: missing required field 'enforcement_evidence'"
                )
            enforcement_evidence = string_list(
                status, "enforcement_evidence", "roadmap/STATUS.md"
            )
            parse_iso_date(
                scalar(status, "updated", "roadmap/STATUS.md", required=True),
                "roadmap/STATUS.md:updated",
            )
        except ControlPlaneError as exc:
            errors.append(str(exc))
        if project_state and project_state not in {"active", "complete"}:
            errors.append("roadmap/STATUS.md: project_state must be active or complete")
        if project_state == "active" and len(in_progress) != 1:
            errors.append(
                f"active project requires exactly one In progress phase; found {in_progress or 'none'}"
            )
        if project_state == "complete" and in_progress:
            errors.append(
                f"complete project requires zero In progress phases; found {in_progress}"
            )
        if parallel_readers and parallel_readers not in {"allowed", "forbidden"}:
            errors.append(
                "roadmap/STATUS.md: parallel_readers must be allowed or forbidden"
            )
        if enforcement and enforcement not in ENFORCEMENT_POSTURES:
            errors.append(
                f"roadmap/STATUS.md: invalid enforcement posture '{enforcement}'"
            )
        if len(enforcement_evidence) != len(set(enforcement_evidence)):
            errors.append("roadmap/STATUS.md: duplicate enforcement_evidence entries")
        if writer_mode and writer_mode != "serial":
            errors.append(
                f"roadmap/STATUS.md: writer_mode '{writer_mode}' is unsupported by the bundled runtime; "
                "true writer waves require the external atomic allocator described in SYSTEM.md"
            )
        if active_phase and active_phase not in phases:
            errors.append(f"STATUS active_phase '{active_phase}' is absent from ROADMAP phases {phases}")
        if len(in_progress) == 1 and active_phase and active_phase != in_progress[0]:
            errors.append(f"STATUS active_phase '{active_phase}' != ROADMAP In progress phase '{in_progress[0]}'")

    ladder = work_ladder_rows(roadmap_text, errors)
    projected_work = {
        object_id: (path, data)
        for object_id, (path, data, _) in objects.items()
        if path.startswith("roadmap/work/")
    }
    for ladder_id, cells in ladder.items():
        if ladder_id not in projected_work:
            errors.append(f"ROADMAP work ladder row '{ladder_id}' has no object under roadmap/work/")
            continue
        path, data = projected_work[ladder_id]
        try:
            expected = [
                ladder_id,
                scalar(data, "title", path, required=True),
                scalar(data, "phase", path, required=True),
                ", ".join(string_list(data, "depends_on", path)) or "—",
                scalar(data, "evidence_target", path, required=True),
                scalar(data, "status", path, required=True),
            ]
            labels = ("id", "title", "phase", "depends_on", "evidence_target", "status")
            for label, displayed, actual in zip(labels, cells, expected):
                if displayed != actual:
                    errors.append(
                        f"ROADMAP work ladder '{ladder_id}' {label} is '{displayed}' "
                        f"but {path} declares '{actual}'"
                    )
        except ControlPlaneError as exc:
            errors.append(str(exc))
    for object_id, (path, _) in projected_work.items():
        if object_id not in ladder:
            errors.append(f"{path}: missing from ROADMAP exact work ladder projection")

    phase_index = {phase: index for index, phase in enumerate(phases)}
    today = dt.datetime.now(dt.timezone.utc).date()
    if args.now:
        try:
            now = parse_utc(args.now, "--now")
            today = now.date()
        except ControlPlaneError as exc:
            errors.append(str(exc))
            now = dt.datetime.now(dt.timezone.utc)
    else:
        now = dt.datetime.now(dt.timezone.utc)

    if enforcement in ENFORCEMENT_POSTURES:
        if enforcement != "bootstrap" and not enforcement_evidence:
            errors.append(
                f"roadmap/STATUS.md: enforcement '{enforcement}' requires enforcement_evidence"
            )
        for evidence_path in enforcement_evidence:
            try:
                validate_enforcement_record(
                    snapshot, evidence_path, enforcement, now
                )
            except ControlPlaneError as exc:
                errors.append(str(exc))

    active_work: list[str] = []
    graph: dict[str, list[str]] = {}
    for object_id, (path, data, text) in objects.items():
        try:
            object_type = scalar(data, "type", path, required=True)
            object_status = scalar(data, "status", path, required=True)
            parse_iso_date(
                scalar(data, "updated", path, required=True), f"{path}:updated"
            )
            if "date" in data:
                parse_iso_date(scalar(data, "date", path, required=True), f"{path}:date")
            if "review_by" in data:
                parse_iso_date(
                    scalar(data, "review_by", path, required=True), f"{path}:review_by"
                )
            informs = string_list(data, "informs", path)
            supersedes = string_list(data, "supersedes", path)
            for field, refs in (("informs", informs), ("supersedes", supersedes)):
                for ref in refs:
                    if ref not in objects:
                        errors.append(f"{path}: {field} -> missing id '{ref}'")

            if object_type in WORKLIKE:
                if object_status not in WORK_STATUSES:
                    errors.append(f"{path}: invalid work status '{object_status}'")
                phase = scalar(data, "phase", path, required=True)
                if phase not in phases:
                    errors.append(f"{path}: phase '{phase}' is absent from ROADMAP")
                evidence_target = scalar(data, "evidence_target", path, required=True)
                if "evidence_level" in data:
                    errors.append(f"{path}: evidence_level is derived and may not be hand-set")
                dependencies = string_list(data, "depends_on", path)
                blocked = string_list(data, "blocked_by", path)
                graph[object_id] = []
                for field, refs in (("depends_on", dependencies), ("blocked_by", blocked)):
                    for ref in refs:
                        if ref not in objects:
                            errors.append(f"{path}: {field} -> missing id '{ref}'")
                        elif str(objects[ref][1].get("type", "")) in WORKLIKE and field == "depends_on":
                            graph[object_id].append(ref)
                allowed_raw = string_list(data, "allowed_paths", path)
                invalidated_raw = string_list(data, "invalidated_by", path)
                allowed = [parse_scope(item, f"{path}:allowed_paths") for item in allowed_raw]
                invalidated = [
                    parse_scope(item, f"{path}:invalidated_by") for item in invalidated_raw
                ]
                if len({item.raw.casefold() for item in allowed}) != len(allowed):
                    errors.append(f"{path}: duplicate allowed_paths entries")
                if object_status == "active":
                    active_work.append(object_id)
                    if active_phase and phase != active_phase:
                        errors.append(
                            f"{path}: active work phase '{phase}' != STATUS active_phase "
                            f"'{active_phase}'"
                        )
                    if blocked:
                        errors.append(f"{path}: active but blocked_by={blocked}")
                    for dependency in dependencies:
                        if dependency in objects and str(objects[dependency][1].get("type", "")) in WORKLIKE:
                            dep_status = str(objects[dependency][1].get("status", ""))
                            if dep_status != "achieved":
                                errors.append(f"{path}: active but dependency '{dependency}' is status:{dep_status}")
                if object_status in {"active", "achieved"}:
                    deliverables = string_list(data, "deliverables", path)
                    if not deliverables:
                        errors.append(f"{path}: {object_status} work must declare deliverables")
                    if not invalidated_raw:
                        errors.append(f"{path}: {object_status} work must declare invalidated_by")
                    placeholder_scopes = [
                        value
                        for value in allowed_raw + deliverables + invalidated_raw
                        if value.startswith("path/to/")
                    ]
                    if placeholder_scopes or evidence_target.casefold() == "project-defined":
                        errors.append(
                            f"{path}: {object_status} work still contains scaffold scope/evidence placeholders"
                        )
                    substantive_section(text, "Acceptance", path, errors)
                    substantive_section(text, "Non-goals", path, errors)
                    substantive_section(text, "Canonical commands", path, errors)
                    segment = substantive_section(text, "Handoff", path, errors)
                    if segment:
                        for key in ("next", "read_first", "hazards"):
                            match = re.search(
                                rf"^\s*[-*]?\s*{key}:\s*(.+)$", segment, re.M
                            )
                            if not match or len(match.group(1).strip()) < 12:
                                errors.append(
                                    f"{path}: Handoff '{key}' must contain a substantive value"
                                )
                if object_status == "achieved":
                    deliverables = string_list(data, "deliverables", path)
                    for deliverable in deliverables:
                        if deliverable.endswith("/**") or not snapshot.exists(deliverable):
                            errors.append(f"{path}: achieved deliverable is absent from {args.snapshot}: {deliverable}")
                        if deliverable == path or deliverable.startswith("roadmap/work/"):
                            errors.append(
                                f"{path}: a work object cannot count as its own achieved deliverable: "
                                f"{deliverable}"
                            )
                    receipts = string_list(data, "evidence_receipts", path)
                    if not receipts:
                        errors.append(f"{path}: achieved work must name evidence_receipts")
                    for receipt in receipts:
                        validate_evidence_receipt(snapshot, receipt, object_id, now)
                    for invalidation_scope in invalidated:
                        if not any(
                            candidate != path
                            and scope_matches(invalidation_scope, candidate)
                            for candidate in snapshot.files
                        ):
                            errors.append(
                                f"{path}: invalidated_by scope matches no file in "
                                f"{args.snapshot}: {invalidation_scope.raw}"
                            )
                    stored = scalar(data, "evidence_fingerprint", path)
                    if not stored:
                        errors.append(f"{path}: achieved without evidence_fingerprint; verify then run doctor.py --stamp {object_id}")
                    elif invalidated_raw:
                        current = evidence_fingerprint(snapshot, data, path)
                        if current != stored:
                            errors.append(f"{path}: evidence INVALIDATED ({stored} != {current})")
            elif object_type == "decision":
                if object_status not in DECISION_STATUSES:
                    errors.append(f"{path}: invalid decision status '{object_status}'")
                if object_status == "accepted" and not scalar(data, "approved_by", path):
                    errors.append(f"{path}: accepted decision lacks approved_by")
            elif object_type == "evidence":
                if object_status not in EVIDENCE_STATUSES:
                    errors.append(f"{path}: invalid evidence status '{object_status}'")
                referenced_work = scalar(data, "work", path, required=True)
                if referenced_work not in objects:
                    errors.append(f"{path}: evidence work -> missing id '{referenced_work}'")
                validate_evidence_receipt(
                    snapshot, path, referenced_work, now, require_pass=False
                )
            elif object_type in TYPE_STATUSES and object_status not in TYPE_STATUSES[object_type]:
                errors.append(f"{path}: invalid {object_type} status '{object_status}'")

            review_when = scalar(data, "review_when", path)
            if review_when:
                due = False
                if review_when == "now":
                    due = True
                elif review_when.startswith("date:"):
                    due = parse_iso_date(review_when[5:], f"{path}:review_when") <= today
                elif re.fullmatch(r"phase:P\d+:(entry|exit)", review_when):
                    phase_name, edge = review_when.split(":")[1:]
                    if phase_name not in phase_index or active_phase not in phase_index:
                        errors.append(f"{path}: review_when references unknown phase '{phase_name}'")
                    else:
                        due = edge == "entry" and phase_name == active_phase
                        due = due or (edge == "exit" and phase_index[active_phase] > phase_index[phase_name])
                elif re.fullmatch(r"event:[a-z0-9-]+", review_when):
                    pass
                else:
                    errors.append(f"{path}: invalid typed review_when '{review_when}'")
                if due:
                    infos.append(f"REVIEW-DUE: {object_id} ({review_when}) at {path}")
        except ControlPlaneError as exc:
            errors.append(str(exc))

    color: dict[str, int] = {}

    def visit(node: str, stack: list[str]) -> None:
        color[node] = 1
        for child in graph.get(node, []):
            if color.get(child, 0) == 1:
                errors.append("dependency cycle: " + " -> ".join(stack + [child]))
            elif color.get(child, 0) == 0:
                visit(child, stack + [child])
        color[node] = 2

    for node in graph:
        if color.get(node, 0) == 0:
            visit(node, [node])

    if writer_mode == "serial" and len(active_work) > 1:
        errors.append(f"serial writer_mode permits at most one active work item; found {sorted(active_work)}")
    if active_task and active_task != "none":
        if active_task not in objects:
            errors.append(f"STATUS active_task '{active_task}' has no object")
        elif str(objects[active_task][1].get("status", "")) != "active":
            errors.append(f"STATUS active_task '{active_task}' is not active")
        elif active_task not in active_work:
            errors.append(f"STATUS active_task '{active_task}' is not in active work {active_work}")
    elif active_work:
        errors.append(f"STATUS active_task is none while active work exists: {active_work}")

    claims: list[tuple[str, dict]] = []
    for path in snapshot.list("roadmap/claims", ".md"):
        if not re.fullmatch(r"roadmap/claims/CLAIM-[^/]+\.md", path):
            errors.append(f"{path}: claim Markdown must be named CLAIM-<agent>.md")
            continue
        try:
            claims.append((path, parse_frontmatter(snapshot.read_text(path), path, required=True)))
        except ControlPlaneError as exc:
            errors.append(str(exc))

    active_claims: list[tuple[str, dict, list]] = []
    agents: set[str] = set()
    tasks: set[str] = set()
    claim_ids: set[str] = set()
    branches: set[str] = set()
    worktrees: set[str] = set()
    for path, claim in claims:
        try:
            claim_status = scalar(claim, "status", path, required=True)
            if claim_status not in CLAIM_STATUSES:
                errors.append(f"{path}: invalid claim status '{claim_status}'")
            agent = scalar(claim, "agent", path, required=True)
            task = scalar(claim, "task", path, required=True)
            claim_id = scalar(claim, "claim_id", path, required=True)
            branch = scalar(claim, "branch", path, required=True)
            worktree = scalar(claim, "worktree_id", path, required=True)
            base = scalar(claim, "base_commit", path, required=True)
            generation = scalar(claim, "generation", path, required=True)
            integrator = scalar(claim, "integrator", path, required=True)
            if not AGENT_RE.fullmatch(agent):
                errors.append(f"{path}: invalid agent id '{agent}'")
            if os.path.basename(path) != f"CLAIM-{agent}.md":
                errors.append(f"{path}: agent '{agent}' does not match filename")
            if not UUID_RE.fullmatch(claim_id):
                errors.append(f"{path}: claim_id must be a lowercase UUID")
            if not generation.isdigit() or int(generation) < 1:
                errors.append(f"{path}: generation must be a positive integer")
            if integrator not in ("true", "false"):
                errors.append(f"{path}: integrator must be true or false")
            if writer_mode == "serial" and claim_status == "active" and integrator != "true":
                errors.append(f"{path}: active serial claim must set integrator:true")
            validate_lease(
                claim,
                path,
                now,
                active=claim_status == "active",
                check_live=args.check_live_leases,
            )
            if not FULL_SHA_RE.fullmatch(base):
                errors.append(f"{path}: base_commit must be a full 40-character lowercase SHA")
            elif not commit_exists(REPO, base):
                errors.append(f"{path}: base_commit does not exist: {base}")
            else:
                descendant = snapshot.commit or "HEAD"
                if not is_ancestor(REPO, base, descendant):
                    errors.append(f"{path}: base_commit {base} is not an ancestor of {descendant}")
            if task not in objects or str(objects[task][1].get("type", "")) not in WORKLIKE:
                errors.append(f"{path}: task '{task}' is not a work object")
                continue
            if claim_status == "active" and str(objects[task][1].get("status", "")) != "active":
                errors.append(f"{path}: task '{task}' is not active")
            task_scopes = [parse_scope(item, f"{objects[task][0]}:allowed_paths") for item in string_list(objects[task][1], "allowed_paths", objects[task][0])]
            claim_raw = string_list(claim, "allowed_paths", path)
            if claim_status != "active" and not claim_raw:
                errors.append(f"{path}: historical claim must preserve its explicit allowed_paths")
            effective = [parse_scope(item, f"{path}:allowed_paths") for item in claim_raw] if claim_raw else task_scopes
            if not effective:
                errors.append(f"{path}: claim/task has no allowed_paths")
            if len({item.raw.casefold() for item in effective}) != len(effective):
                errors.append(f"{path}: duplicate effective allowed_paths entries")
            recorded_scope_hash = scalar(claim, "scope_hash", path, required=True)
            calculated_scope_hash = scope_hash(effective)
            if recorded_scope_hash != calculated_scope_hash:
                errors.append(
                    f"{path}: scope_hash mismatch "
                    f"({recorded_scope_hash or 'missing'} != {calculated_scope_hash})"
                )
            for claimed in effective:
                if claim_status == "active" and not any(scope_contains(parent, claimed) for parent in task_scopes):
                    errors.append(f"{path}: scope '{claimed.raw}' is not contained by task '{task}'")
            if claim_status == "active":
                if claim_id in claim_ids or agent in agents or task in tasks or branch in branches or worktree in worktrees:
                    errors.append(f"{path}: active claim identity/task/branch/worktree is not unique")
                claim_ids.add(claim_id)
                agents.add(agent)
                tasks.add(task)
                branches.add(branch)
                worktrees.add(worktree)
                active_claims.append((path, claim, effective))
        except ControlPlaneError as exc:
            errors.append(str(exc))

    if writer_mode == "serial" and len(active_claims) > 1:
        errors.append(f"serial writer_mode permits at most one active claim; found {len(active_claims)}")
    if project_state == "complete":
        if active_task != "none":
            errors.append("complete project requires STATUS active_task:none")
        if active_work:
            errors.append(f"complete project may not have active work: {sorted(active_work)}")
        if active_claims:
            errors.append("complete project may not have active claims")
    for index, (left_path, left, left_scopes) in enumerate(active_claims):
        for right_path, right, right_scopes in active_claims[index + 1:]:
            for left_scope in left_scopes:
                for right_scope in right_scopes:
                    if scopes_overlap(left_scope, right_scope):
                        errors.append(
                            f"{left_path} and {right_path}: effective scopes overlap "
                            f"('{left_scope.raw}' vs '{right_scope.raw}')"
                        )
    claimed_tasks = [str(claim.get("task", "")) for _, claim, _ in active_claims]
    for work_id in active_work:
        count = claimed_tasks.count(work_id)
        if count != 1:
            errors.append(f"active work item '{work_id}' has {count} active claims; exactly one is required")

    roadmap_files = snapshot.list("roadmap")
    infos.append(f"snapshot={args.snapshot}; roadmap files={len(roadmap_files)}; objects={len(objects)}")
    print(f"control-plane doctor: active_phase={active_phase or 'unknown'} writer_mode={writer_mode or 'unknown'}")
    for message in infos:
        print("  INFO: ", message)
    for message in warnings:
        print("  WARN: ", message)
    for message in errors:
        print("  ERROR:", message)
    print(f"\n{'FAIL' if errors else 'OK'} -- {len(errors)} error(s), {len(warnings)} warning(s), {len(infos)} info")
    return 1 if errors else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ControlPlaneError as exc:
        print(f"control-plane doctor: FAIL -- {exc}")
        sys.exit(1)
