"""Fixed bridge to the pure Node Registry adapter and linked-state primitives."""

from __future__ import annotations

import argparse
import errno
import json
import os
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Sequence

from .core import ContextError


def _fail(code: str, message: str) -> None:
    raise ContextError(code, message)


def canonical_absolute(value: str | os.PathLike[str], field: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path != path.resolve():
        _fail("INVALID_REQUEST", f"{field} must be an absolute canonical path")
    return path


def trusted_paths(
    node_executable: str | os.PathLike[str] | None,
    runtime_root: str | os.PathLike[str] | None,
) -> tuple[Path, Path]:
    if node_executable is None or runtime_root is None:
        _fail("RUNTIME_UNAVAILABLE", "Linked operations require trusted Node and runtime paths")
    node = canonical_absolute(node_executable, "node_executable")
    root = canonical_absolute(runtime_root, "runtime_root")
    if not node.is_file() or not root.is_dir():
        _fail("RUNTIME_UNAVAILABLE", "Trusted Node executable or runtime root is unavailable")
    adapter = root / "src" / "registry-adapter.mjs"
    if not adapter.is_file():
        _fail("RUNTIME_UNAVAILABLE", f"Registry adapter is unavailable: {adapter}")
    return node, root


def invoke_adapter(node: Path, root: Path, request: dict[str, Any]) -> Any:
    adapter = root / "src" / "registry-adapter.mjs"
    try:
        completed = subprocess.run(
            [str(node), str(adapter)],
            input=json.dumps(request, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
            text=True,
            encoding="utf-8",
            errors="strict",
            capture_output=True,
            timeout=10,
            check=False,
            shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError) as exc:
        _fail("RUNTIME_FAILED", f"Registry adapter could not run: {exc}")
    if len(completed.stdout.encode("utf-8")) > 4 * 1024 * 1024:
        _fail("RUNTIME_FAILED", "Registry adapter output exceeded 4 MiB")
    if completed.returncode != 0:
        message = completed.stderr.strip() or "Registry adapter rejected the request"
        _fail("RUNTIME_REJECTED", message[:4000])
    try:
        return json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError) as exc:
        _fail("RUNTIME_FAILED", f"Registry adapter returned invalid JSON: {exc}")


def read_state(path: Path) -> tuple[bytes, dict[str, Any]]:
    try:
        raw = path.read_bytes()
        value = json.loads(raw)
    except FileNotFoundError:
        _fail("STATE_MISSING", f"Linked state is missing: {path}")
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError) as exc:
        _fail("STATE_CORRUPT", f"Cannot read linked state {path}: {exc}")
    if not isinstance(value, dict):
        _fail("STATE_CORRUPT", "Linked state must be a JSON object")
    return raw, value


@contextmanager
def state_locked(path: Path):
    lock_path = Path(f"{path}.lock")
    descriptor: int | None = None
    deadline = time.monotonic() + 5.0
    while descriptor is None:
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.monotonic() >= deadline:
                _fail("STATE_BUSY", f"State lock is busy: {lock_path}")
            time.sleep(0.01)
        except PermissionError as exc:
            if exc.errno == errno.EACCES and time.monotonic() < deadline:
                time.sleep(0.01)
                continue
            _fail("STATE_LOCK_FAILED", f"Cannot lock state {path}: {exc}")
        except OSError as exc:
            _fail("STATE_LOCK_FAILED", f"Cannot lock state {path}: {exc}")
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        yield
    finally:
        os.close(descriptor)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def replace_json(path: Path, value: Any) -> None:
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    except (OSError, TypeError, ValueError) as exc:
        _fail("STATE_WRITE_FAILED", f"Cannot atomically write linked state {path}: {exc}")
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def export_registry(registry_path: str | os.PathLike[str], team_id: str) -> dict[str, Any]:
    from .team_registry import TeamRegistry

    registry = TeamRegistry(registry_path=registry_path)
    value = registry._validated(registry._store.read())
    team = registry._team(value, team_id)
    runtime = team.get("runtime")
    if runtime is None:
        _fail("TEAM_NOT_LINKED", "Team has no linked runtime")
    leader = registry._member(team, team["leaderMemberId"])
    members = [
        {
            "id": member["id"], "name": member["name"], "role": member["role"],
            "lifecycle": member["lifecycle"],
            "binding": {
                "status": "bound", "hostId": member["binding"]["hostId"],
                "threadId": member["binding"]["threadId"],
            },
        }
        for member in team["members"]
    ]
    ready = [
        member["id"] for member in team["members"]
        if member["lifecycle"] == "active"
        and registry._effective_onboarding_status(value, team, member, leader) == "ready"
    ]
    return {
        "registryId": value["registryId"], "teamId": team["id"],
        "teamRevision": team["revision"], "migrationId": runtime["migrationId"],
        "statePath": runtime["statePath"], "members": members, "readyMemberIds": ready,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="codex-team-context-runtime-link")
    subcommands = parser.add_subparsers(dest="command", required=True)
    export = subcommands.add_parser("export")
    export.add_argument("--registry", required=True)
    export.add_argument("--team", required=True)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(export_registry(args.registry, args.team), ensure_ascii=False, separators=(",", ":")))
        return 0
    except ContextError as exc:
        print(json.dumps(exc.as_dict(), ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
