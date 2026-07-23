#!/usr/bin/env python3
"""Create a collision-resistant typed capture object.

Usage: python roadmap/tools/new.py <idea|insight|decision|risk> "title"
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import uuid

from _control_plane import ControlPlaneError, repo_root, safe_worktree_path


TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = repo_root(TOOLS)
TYPES = {
    "idea": ("ideas", "IDEA", "inbox"),
    "insight": ("insights", "INS", "candidate"),
    "decision": ("decisions", "D", "proposed"),
    "risk": ("risks", "R", "open"),
}


def slugify(title: str) -> str:
    slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", title.casefold())).strip("-")
    return slug[:48] or "capture"


def render(kind: str, object_id: str, title: str, today: dt.date) -> str:
    _, _, status = TYPES[kind]
    lines = [
        "---",
        f"id: {object_id}",
        f"type: {kind}",
        f"title: {json.dumps(title, ensure_ascii=False)}",
        f"status: {status}",
    ]
    if kind == "decision":
        lines.extend([f"date: {today.isoformat()}", "supersedes: []"])
    else:
        review = today + dt.timedelta(days=14)
        lines.extend(["informs: []", f"review_when: date:{review.isoformat()}"])
    lines.extend(
        [
            f"updated: {today.isoformat()}",
            "---",
            "",
            f"# {object_id} — {title}",
            "",
            "[context / evidence / consequence — fill in now]",
            "",
        ]
    )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] not in TYPES:
        print(__doc__.strip())
        return 2
    kind = argv[0]
    title = " ".join(argv[1:]).strip()
    if not title or any(ord(char) < 32 or ord(char) == 127 for char in title):
        raise ControlPlaneError("title must be one non-empty line without control characters")
    subdirectory, prefix, _ = TYPES[kind]
    unique = uuid.uuid4()
    object_id = f"{prefix}-{unique}"
    relative = f"roadmap/{subdirectory}/{object_id}-{slugify(title)}.md"
    target = safe_worktree_path(REPO, relative, "capture target")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(render(kind, object_id, title, dt.datetime.now(dt.timezone.utc).date()))
        stream.flush()
        os.fsync(stream.fileno())
    print(target.relative_to(REPO).as_posix())
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (ControlPlaneError, OSError) as exc:
        print(f"capture: FAIL -- {exc}")
        sys.exit(1)
