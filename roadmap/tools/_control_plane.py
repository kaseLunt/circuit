#!/usr/bin/env python3
"""Shared strict primitives for the repo-native control plane.

Keep parsing, Git error handling, snapshot reads, and path policy identical across every
gate. This module intentionally uses only the Python standard library.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


class ControlPlaneError(RuntimeError):
    """A malformed control-plane input or failed authority check."""


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def run_git(
    repo: str,
    *args: str,
    input_text: str | None = None,
    allowed_codes: tuple[int, ...] = (0,),
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=repo,
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
        )
    except (OSError, UnicodeError) as exc:
        raise ControlPlaneError(f"git {' '.join(args)} could not run: {exc}") from exc
    if result.returncode not in allowed_codes:
        detail = (result.stderr or result.stdout or "no diagnostic").strip()
        raise ControlPlaneError(
            f"git {' '.join(args)} failed with exit {result.returncode}: {detail}"
        )
    return result


def repo_root(start: str) -> str:
    return run_git(start, "rev-parse", "--show-toplevel").stdout.strip()


def git_common_dir(repo: str) -> str:
    raw = run_git(repo, "rev-parse", "--git-common-dir").stdout.strip()
    return os.path.abspath(os.path.join(repo, raw)) if not os.path.isabs(raw) else raw


def current_branch(repo: str) -> str:
    branch = run_git(repo, "symbolic-ref", "--quiet", "--short", "HEAD").stdout.strip()
    if not branch:
        raise ControlPlaneError("detached HEAD is not a valid writer lane")
    return branch


def full_head(repo: str) -> str:
    return run_git(repo, "rev-parse", "HEAD").stdout.strip()


def commit_exists(repo: str, commit: str) -> bool:
    result = run_git(repo, "cat-file", "-e", f"{commit}^{{commit}}", allowed_codes=(0, 1, 128))
    return result.returncode == 0


def is_ancestor(repo: str, ancestor: str, descendant: str) -> bool:
    result = run_git(
        repo,
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
        allowed_codes=(0, 1),
    )
    return result.returncode == 0


def _strip_comment(value: str) -> str:
    quote: str | None = None
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\" and quote:
            escaped = True
            continue
        if char in "\"'":
            quote = None if quote == char else (quote or char)
        elif char == "#" and quote is None and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    if quote:
        raise ControlPlaneError("unterminated quote in frontmatter")
    return value.strip()


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ControlPlaneError(f"invalid quoted scalar: {value}") from exc
        if not isinstance(decoded, str):
            raise ControlPlaneError(f"quoted scalar is not a string: {value}")
        return decoded
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def _inline_list(value: str) -> list[str]:
    inner = value[1:-1].strip()
    if not inner:
        return []
    try:
        row = next(csv.reader([inner], skipinitialspace=True))
    except (csv.Error, StopIteration) as exc:
        raise ControlPlaneError(f"invalid inline list: {value}") from exc
    if any(not item.strip() for item in row):
        raise ControlPlaneError(f"empty inline-list item is forbidden: {value}")
    return [_unquote(item.strip()) for item in row]


def parse_frontmatter(text: str, path: str = "<memory>", required: bool = False) -> dict:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines or lines[0] != "---":
        if required:
            raise ControlPlaneError(f"{path}: missing opening frontmatter marker")
        return {}
    try:
        end = lines.index("---", 1)
    except ValueError as exc:
        raise ControlPlaneError(f"{path}: missing closing frontmatter marker") from exc

    result: dict[str, str | list[str]] = {}
    index = 1
    key_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
    while index < end:
        line = lines[index]
        if not line.strip() or line.lstrip().startswith("#"):
            index += 1
            continue
        if line[:1].isspace() or ":" not in line:
            raise ControlPlaneError(f"{path}:{index + 1}: malformed flat frontmatter line")
        key, raw = line.split(":", 1)
        key = key.strip()
        if not key_re.fullmatch(key):
            raise ControlPlaneError(f"{path}:{index + 1}: invalid frontmatter key '{key}'")
        if key in result:
            raise ControlPlaneError(f"{path}:{index + 1}: duplicate frontmatter key '{key}'")
        raw = _strip_comment(raw.strip())
        if raw:
            result[key] = _inline_list(raw) if raw.startswith("[") and raw.endswith("]") else _unquote(raw)
            index += 1
            continue

        values: list[str] = []
        index += 1
        while index < end and lines[index].startswith("  - "):
            item = _unquote(_strip_comment(lines[index][4:].strip()))
            if not item:
                raise ControlPlaneError(f"{path}:{index + 1}: empty list item")
            values.append(item)
            index += 1
        result[key] = values
    return result


def scalar(data: dict, key: str, path: str, required: bool = False) -> str:
    value = data.get(key)
    if value is None or value == "":
        if required:
            raise ControlPlaneError(f"{path}: missing required field '{key}'")
        return ""
    if isinstance(value, list):
        raise ControlPlaneError(f"{path}: field '{key}' must be a scalar")
    return str(value)


def string_list(data: dict, key: str, path: str) -> list[str]:
    value = data.get(key, [])
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ControlPlaneError(f"{path}: field '{key}' must be a list")
    return [str(item) for item in value]


def parse_utc(value: str, label: str) -> dt.datetime:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        raise ControlPlaneError(f"{label}: expected strict UTC YYYY-MM-DDTHH:MM:SSZ")
    try:
        parsed = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise ControlPlaneError(f"{label}: invalid calendar timestamp '{value}'") from exc
    return parsed.replace(tzinfo=dt.timezone.utc)


def validate_lease(
    data: dict,
    path: str,
    now: dt.datetime,
    *,
    active: bool,
    check_live: bool,
    max_hours: int = 24,
) -> tuple[dt.datetime, dt.datetime, dt.datetime]:
    issued = parse_utc(scalar(data, "issued_at", path, required=True), f"{path}:issued_at")
    updated = parse_utc(scalar(data, "updated_at", path, required=True), f"{path}:updated_at")
    expires = parse_utc(
        scalar(data, "lease_expires", path, required=True), f"{path}:lease_expires"
    )
    if issued > updated:
        raise ControlPlaneError(f"{path}: issued_at must not follow updated_at")
    if issued > now or updated > now:
        raise ControlPlaneError(f"{path}: issued_at/updated_at may not be in the future")
    if expires <= issued:
        raise ControlPlaneError(f"{path}: lease_expires must follow issued_at")
    if expires > updated + dt.timedelta(hours=max_hours):
        raise ControlPlaneError(
            f"{path}: lease window exceeds {max_hours} hours from updated_at"
        )
    if active:
        if expires <= updated:
            raise ControlPlaneError(f"{path}: active lease_expires must follow updated_at")
        if check_live and expires <= now:
            raise ControlPlaneError(f"{path}: active lease expired at {expires.isoformat()}")
    return issued, updated, expires


def parse_iso_date(value: str, label: str) -> dt.date:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ControlPlaneError(f"{label}: expected strict calendar date YYYY-MM-DD")
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ControlPlaneError(f"{label}: invalid calendar date '{value}'") from exc


def normalize_repo_path(value: str, label: str = "path") -> str:
    value = value.replace("\\", "/")
    if value != value.strip():
        raise ControlPlaneError(f"{label}: leading or trailing whitespace is forbidden")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ControlPlaneError(f"{label}: control characters are forbidden")
    if not value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise ControlPlaneError(f"{label}: must be a non-empty repo-relative path")
    if value.startswith("./") or "//" in value:
        raise ControlPlaneError(f"{label}: path must already be normalized: '{value}'")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ControlPlaneError(f"{label}: traversal or empty segment is forbidden: '{value}'")
    return value


def safe_worktree_path(repo: str, value: str, label: str = "path") -> Path:
    """Resolve a repo-relative destination without traversing a symlink."""
    normalized = normalize_repo_path(value, label)
    root = Path(repo).resolve()
    current = root
    for part in normalized.split("/"):
        current = current / part
        is_junction = getattr(current, "is_junction", lambda: False)
        if current.is_symlink() or is_junction():
            raise ControlPlaneError(f"{label}: symlink destination or parent is forbidden")
    resolved = current.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ControlPlaneError(f"{label}: destination escapes repository root") from exc
    return current


@dataclass(frozen=True)
class Scope:
    raw: str
    prefix: str
    subtree: bool


def parse_scope(value: str, label: str = "scope") -> Scope:
    value = value.replace("\\", "/")
    subtree = value.endswith("/**")
    base = value[:-3] if subtree else value
    if any(char in base for char in "*?["):
        raise ControlPlaneError(
            f"{label}: unsupported wildcard in '{value}'; use an exact path or directory/**"
        )
    base = normalize_repo_path(base, label)
    return Scope(raw=base + ("/**" if subtree else ""), prefix=base, subtree=subtree)


def scope_matches(spec: Scope, path: str) -> bool:
    # Git repository paths are case-sensitive even when the checkout filesystem is
    # not. The doctor separately rejects case-colliding tracked paths.
    candidate = normalize_repo_path(path)
    return candidate == spec.prefix or (spec.subtree and candidate.startswith(spec.prefix + "/"))


def scope_contains(parent: Scope, child: Scope) -> bool:
    if not parent.subtree:
        return not child.subtree and parent.prefix == child.prefix
    return child.prefix == parent.prefix or child.prefix.startswith(parent.prefix + "/")


def scopes_overlap(left: Scope, right: Scope) -> bool:
    if not left.subtree and not right.subtree:
        return left.prefix == right.prefix
    if left.subtree and right.subtree:
        return (
            left.prefix == right.prefix
            or left.prefix.startswith(right.prefix + "/")
            or right.prefix.startswith(left.prefix + "/")
        )
    tree, exact = (left, right) if left.subtree else (right, left)
    return exact.prefix == tree.prefix or exact.prefix.startswith(tree.prefix + "/")


def scope_hash(scopes: Iterable[Scope]) -> str:
    digest = hashlib.sha256()
    for raw in sorted(scope.raw for scope in scopes):
        encoded = raw.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return "sha256:" + digest.hexdigest()


class Snapshot:
    """One coherent source of repository bytes: worktree, staged index, or commit/ref."""

    def __init__(self, repo: str, source: str):
        self.repo = repo
        self.source = source
        self._treeish: str | None = None
        self.commit: str | None = None
        self._modes: dict[str, str] = {}
        self._oids: dict[str, str] = {}
        if source.startswith("-"):
            raise ControlPlaneError("snapshot names beginning with '-' are forbidden")
        if source == "index":
            # Freeze the index as an immutable tree before any reads. This prevents a
            # concurrent index edit from producing a mixed authorization snapshot.
            self._treeish = run_git(repo, "write-tree").stdout.strip()
        elif source != "worktree":
            result = run_git(
                repo,
                "rev-parse",
                "--verify",
                f"{source}^{{commit}}",
                allowed_codes=(0, 1, 128),
            )
            if result.returncode != 0:
                raise ControlPlaneError(f"snapshot commit/ref '{source}' is unavailable")
            self._treeish = result.stdout.strip()
            self.commit = self._treeish
        self._files = self._load_files()

    @property
    def treeish(self) -> str:
        """Immutable tree/commit identifier backing an index or commit snapshot."""
        if self._treeish is None:
            raise ControlPlaneError("worktree snapshots do not have an immutable treeish")
        return self._treeish

    def _load_files(self) -> set[str]:
        if self.source == "worktree":
            output = run_git(
                self.repo,
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ).stdout
            candidates = {normalize_repo_path(path) for path in output.split("\0") if path}
            # The cached listing also contains tracked paths deleted from the worktree.
            # Filter against the filesystem so this remains a coherent worktree view.
            files = {
                path
                for path in candidates
                if os.path.lexists(os.path.join(self.repo, *path.split("/")))
            }
            staged_entries: dict[str, tuple[str, str]] = {}
            stage_output = run_git(self.repo, "ls-files", "--stage", "-z").stdout
            for record in stage_output.split("\0"):
                if not record:
                    continue
                try:
                    metadata, raw_path = record.split("\t", 1)
                    mode, oid, stage = metadata.split(" ", 2)
                except ValueError as exc:
                    raise ControlPlaneError("git ls-files --stage returned a malformed record") from exc
                if stage == "0":
                    staged_entries[normalize_repo_path(raw_path)] = (mode, oid)
            for path in files:
                target = Path(self.repo, *path.split("/"))
                tracked = staged_entries.get(path)
                if tracked and tracked[0] == "160000":
                    self._modes[path] = "160000"
                    self._oids[path] = tracked[1]
                elif target.is_symlink():
                    self._modes[path] = "120000"
                elif target.is_file():
                    executable = os.name != "nt" and bool(target.stat().st_mode & 0o111)
                    self._modes[path] = "100755" if executable else "100644"
                else:
                    self._modes[path] = "040000"
            return files

        assert self._treeish is not None
        output = run_git(
            self.repo, "ls-tree", "-r", "--full-tree", "-z", self._treeish
        ).stdout
        files: set[str] = set()
        for record in output.split("\0"):
            if not record:
                continue
            try:
                metadata, raw_path = record.split("\t", 1)
                mode, _object_type, oid = metadata.split(" ", 2)
            except ValueError as exc:
                raise ControlPlaneError("git ls-tree returned a malformed record") from exc
            path = normalize_repo_path(raw_path)
            files.add(path)
            self._modes[path] = mode
            self._oids[path] = oid
        return files

    @property
    def files(self) -> set[str]:
        return set(self._files)

    def list(self, prefix: str = "", suffix: str = "") -> list[str]:
        normalized = prefix.replace("\\", "/").rstrip("/")
        stem = normalized + "/" if normalized else ""
        return sorted(path for path in self._files if path.startswith(stem) and path.endswith(suffix))

    def exists(self, path: str) -> bool:
        return normalize_repo_path(path) in self._files

    def mode(self, path: str) -> str:
        path = normalize_repo_path(path)
        if path not in self._files:
            raise ControlPlaneError(f"{self.source}: missing '{path}'")
        return self._modes[path]

    def read_bytes(self, path: str) -> bytes:
        path = normalize_repo_path(path)
        if path not in self._files:
            raise ControlPlaneError(f"{self.source}: missing '{path}'")
        if self.source == "worktree":
            target = Path(self.repo, *path.split("/"))
            if self._modes[path] == "160000":
                return ("gitlink:" + self._oids[path]).encode("ascii")
            if target.is_symlink():
                return os.fsencode(os.readlink(target))
            try:
                return target.read_bytes()
            except OSError as exc:
                raise ControlPlaneError(f"cannot read '{path}': {exc}") from exc
        oid = self._oids[path]
        if self._modes[path] == "160000":
            return ("gitlink:" + oid).encode("ascii")
        result = subprocess.run(
            ["git", "cat-file", "blob", oid], cwd=self.repo, capture_output=True, check=False
        )
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", "replace").strip()
            raise ControlPlaneError(f"git cat-file blob {oid} failed: {detail}")
        return result.stdout

    def read_text(self, path: str) -> str:
        try:
            return self.read_bytes(path).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ControlPlaneError(f"{path}: expected UTF-8 text") from exc


def snapshot_fingerprint(snapshot: Snapshot, specs: Iterable[str], exclude: str = "") -> str:
    parsed = [parse_scope(spec, "invalidated_by") for spec in specs]
    excluded = normalize_repo_path(exclude) if exclude else ""
    digest = hashlib.sha256()
    digest.update(b"control-plane-evidence-v2\0")
    for spec in sorted(parsed, key=lambda item: item.raw):
        encoded_scope = spec.raw.encode("utf-8")
        digest.update(len(encoded_scope).to_bytes(8, "big"))
        digest.update(encoded_scope)
    for path in sorted(snapshot.files):
        if path == excluded or not any(scope_matches(spec, path) for spec in parsed):
            continue
        encoded_path = path.encode("utf-8")
        encoded_mode = snapshot.mode(path).encode("ascii")
        content_digest = hashlib.sha256(snapshot.read_bytes(path)).digest()
        digest.update(len(encoded_path).to_bytes(8, "big"))
        digest.update(encoded_path)
        digest.update(encoded_mode)
        digest.update(content_digest)
    return "sha256:" + digest.hexdigest()


configure_stdio()
