"""Read a bounded role capsule from the canonical Node team state.

This module validates only the state fields required for safe role lookup.  The
Node runtime remains authoritative for the complete event and task state machine.
"""

from __future__ import annotations

import json
import errno
import os
import re
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any


INDEX_SCHEMA_VERSION = 1
POLICY_VERSION = 1
_ROLES = {"Manager", "Liaison", "Worker"}
_BINDING_STATUSES = {"bound", "unbound", "creating", "missing"}
_ID_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")
_BOUNDARIES = {
    "Manager": [
        "Delegate implementation; independently review and accept evidence.",
        "Coordinate the team; do not impersonate another member.",
        "Verify host identity and action authorization separately.",
    ],
    "Liaison": [
        "Explain team progress and decisions; do not command Workers.",
        "Verify host identity and action authorization separately.",
    ],
    "Worker": [
        "Work only on this member's explicitly assigned authorized task.",
        "Submit only this member's own work and evidence.",
        "Verify host identity and action authorization separately.",
    ],
}


class ContextError(Exception):
    """Stable, caller-visible failure from the context registry."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


def _fail(code: str, message: str) -> None:
    raise ContextError(code, message)


def _identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or _ID_PATTERN.fullmatch(value) is None:
        _fail("INVALID_IDENTITY", f"{field} must be a valid explicit identifier")
    return value


def _caller_identity(host_id: Any, thread_id: Any) -> tuple[str, str]:
    host = _identifier(host_id, "host_id")
    thread = _identifier(thread_id, "thread_id")
    if thread.startswith(("client-new-thread:", "pending:")):
        _fail("INVALID_IDENTITY", "thread_id must identify an existing task, not a pending task")
    return host, thread


def _integer(value: Any, *, minimum: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _load_json(path: Path, missing_code: str, corrupt_code: str) -> Any:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        _fail(missing_code, f"Required file is missing: {path}")
    except (OSError, UnicodeError) as exc:
        _fail(corrupt_code, f"Cannot read {path}: {exc}")
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        _fail(corrupt_code, f"Invalid JSON in {path}: {exc}")


def initialize_index(path: str | os.PathLike[str]) -> None:
    """Create a new empty registry; never creates parents or overwrites."""

    target = Path(path)
    if not target.parent.is_dir():
        _fail("INDEX_PARENT_MISSING", f"Index parent directory is missing: {target.parent}")
    try:
        with target.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump({"schemaVersion": INDEX_SCHEMA_VERSION, "entries": []}, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        _fail("INDEX_EXISTS", f"Index already exists: {target}")
    except OSError as exc:
        _fail("INDEX_WRITE_FAILED", f"Cannot initialize index {target}: {exc}")


class ContextRegistry:
    """Exact caller-declared identity registry backed by canonical state files."""

    def __init__(
        self,
        *,
        index_path: str | os.PathLike[str],
        state_roots: list[str | os.PathLike[str]],
    ) -> None:
        if not state_roots:
            _fail("STATE_ROOTS_REQUIRED", "At least one state root is required")
        self.index_path = Path(index_path)
        self.state_roots = tuple(Path(root).resolve() for root in state_roots)

    def read(self, host_id: str, thread_id: str) -> dict[str, Any] | None:
        host_id, thread_id = _caller_identity(host_id, thread_id)
        index = self._load_index()
        entry = next(
            (item for item in index["entries"]
             if item["hostId"] == host_id and item["threadId"] == thread_id),
            None,
        )
        if entry is None:
            return None
        state_path = self._allowed_path(entry["statePath"])
        state = self._load_state(state_path)
        if state["schemaVersion"] != entry["sourceSchemaVersion"]:
            _fail("STATE_SCHEMA_MISMATCH", "Registered source schema version changed")
        if state["team"]["id"] != entry["teamId"]:
            _fail("STATE_LOCATOR_MISMATCH", "Registered teamId no longer matches source state")
        member = next((m for m in state["members"] if m["id"] == entry["memberId"]), None)
        if member is None:
            _fail("REGISTERED_MEMBER_MISSING", "Registered member is missing from source state")
        return self._project(state, member, host_id, thread_id, state_path)

    def register(
        self,
        host_id: str,
        thread_id: str,
        state_path: str | os.PathLike[str],
        member_id: str,
    ) -> dict[str, Any]:
        host_id, thread_id = _caller_identity(host_id, thread_id)
        member_id = _identifier(member_id, "member_id")
        source = self._allowed_path(state_path)
        state = self._load_state(source)
        member = next((m for m in state["members"] if m["id"] == member_id), None)
        if member is None:
            _fail("MEMBER_NOT_FOUND", "member_id is not present in canonical state")
        capsule = self._project(state, member, host_id, thread_id, source)
        if capsule["status"] != "active":
            _fail("REGISTRATION_INACTIVE", "Cannot register an exited or unbound member")

        candidate = {
            "hostId": host_id,
            "threadId": thread_id,
            "statePath": str(source),
            "teamId": state["team"]["id"],
            "memberId": member_id,
            "sourceSchemaVersion": state["schemaVersion"],
        }
        with self._index_lock():
            index = self._load_index()
            existing = next(
                (item for item in index["entries"]
                 if item["hostId"] == host_id and item["threadId"] == thread_id),
                None,
            )
            if existing is not None:
                if existing != candidate:
                    _fail("REGISTRATION_CONFLICT", "Identity is already registered to another member")
                return capsule
            index["entries"].append(candidate)
            self._write_index(index)
        return capsule

    def _allowed_path(self, path: str | os.PathLike[str]) -> Path:
        try:
            resolved = Path(path).resolve()
        except (OSError, RuntimeError, TypeError, ValueError) as exc:
            _fail("STATE_OUTSIDE_ROOTS", f"Invalid state path: {exc}")
        if not any(resolved == root or resolved.is_relative_to(root) for root in self.state_roots):
            _fail("STATE_OUTSIDE_ROOTS", "state_path is outside configured state roots")
        return resolved

    def _load_index(self) -> dict[str, Any]:
        value = _load_json(self.index_path, "INDEX_MISSING", "INDEX_CORRUPT")
        if not isinstance(value, dict) or set(value) != {"schemaVersion", "entries"}:
            _fail("INDEX_CORRUPT", "Index must contain only schemaVersion and entries")
        if value["schemaVersion"] != INDEX_SCHEMA_VERSION or isinstance(value["schemaVersion"], bool):
            _fail("INDEX_CORRUPT", "Unsupported index schemaVersion")
        if not isinstance(value["entries"], list):
            _fail("INDEX_CORRUPT", "Index entries must be a list")
        seen: set[tuple[str, str]] = set()
        required = {"hostId", "threadId", "statePath", "teamId", "memberId", "sourceSchemaVersion"}
        for entry in value["entries"]:
            if not isinstance(entry, dict) or set(entry) != required:
                _fail("INDEX_CORRUPT", "Invalid index entry shape")
            try:
                host = _identifier(entry["hostId"], "hostId")
                thread = _identifier(entry["threadId"], "threadId")
                if not isinstance(entry["statePath"], str) or not entry["statePath"] or "\x00" in entry["statePath"]:
                    _fail("INVALID_IDENTITY", "statePath must be a non-empty string")
                _identifier(entry["teamId"], "teamId")
                _identifier(entry["memberId"], "memberId")
            except ContextError as exc:
                _fail("INDEX_CORRUPT", exc.message)
            if not _integer(entry["sourceSchemaVersion"], minimum=1):
                _fail("INDEX_CORRUPT", "Invalid sourceSchemaVersion")
            key = (host, thread)
            if key in seen:
                _fail("INDEX_CORRUPT", "Duplicate registered identity")
            seen.add(key)
        return value

    def _load_state(self, path: Path) -> dict[str, Any]:
        state = _load_json(path, "STATE_MISSING", "STATE_CORRUPT")
        if not isinstance(state, dict):
            _fail("STATE_CORRUPT", "Canonical state must be an object")
        if not _integer(state.get("schemaVersion"), minimum=1) or state["schemaVersion"] != 1:
            _fail("STATE_CORRUPT", "Unsupported canonical schemaVersion")
        if not _integer(state.get("version")):
            _fail("STATE_CORRUPT", "Invalid canonical state version")
        if not isinstance(state.get("events"), list) or len(state["events"]) != state["version"]:
            _fail("STATE_CORRUPT", "Canonical version/event count mismatch")
        event_ids: set[str] = set()
        for event in state["events"]:
            event_id = event.get("id") if isinstance(event, dict) else None
            if (not isinstance(event_id, str) or _ID_PATTERN.fullmatch(event_id) is None
                    or event_id in event_ids):
                _fail("STATE_CORRUPT", "Canonical event ids must be unique identifiers")
            event_ids.add(event_id)
        team = state.get("team")
        if (not isinstance(team, dict) or not isinstance(team.get("id"), str)
                or _ID_PATTERN.fullmatch(team["id"]) is None):
            _fail("STATE_CORRUPT", "Canonical team identity is invalid")
        members = state.get("members")
        if not isinstance(members, list):
            _fail("STATE_CORRUPT", "Canonical members must be a list")
        member_ids: set[str] = set()
        bindings: set[tuple[str, str]] = set()
        for member in members:
            if not isinstance(member, dict):
                _fail("STATE_CORRUPT", "Canonical member must be an object")
            member_id = member.get("id")
            if not isinstance(member_id, str) or _ID_PATTERN.fullmatch(member_id) is None or member_id in member_ids:
                _fail("STATE_CORRUPT", "Canonical member ids must be unique strings")
            member_ids.add(member_id)
            if member.get("role") not in _ROLES or member.get("lifecycle") not in {"active", "exited"}:
                _fail("STATE_CORRUPT", "Canonical member role or lifecycle is invalid")
            binding = member.get("binding")
            if not isinstance(binding, dict) or binding.get("status") not in _BINDING_STATUSES:
                _fail("STATE_CORRUPT", "Canonical member binding is invalid")
            status = binding["status"]
            if status in {"bound", "missing"}:
                host = binding.get("hostId")
                thread = binding.get("threadId")
                if (not isinstance(host, str) or _ID_PATTERN.fullmatch(host) is None
                        or not isinstance(thread, str) or _ID_PATTERN.fullmatch(thread) is None):
                    _fail("STATE_CORRUPT", "Resolved binding requires hostId and threadId")
                if "pendingId" in binding:
                    _fail("STATE_CORRUPT", "Resolved binding cannot contain pendingId")
                key = (host, thread)
                if key in bindings:
                    _fail("STATE_CORRUPT", "Duplicate canonical host/thread binding")
                bindings.add(key)
            else:
                if "hostId" in binding or "threadId" in binding:
                    _fail("STATE_CORRUPT", "Unresolved binding cannot contain thread identity")
                if status == "creating":
                    pending_id = binding.get("pendingId")
                    if not isinstance(pending_id, str) or _ID_PATTERN.fullmatch(pending_id) is None:
                        _fail("STATE_CORRUPT", "Creating binding requires a valid pendingId")
                elif "pendingId" in binding:
                    _fail("STATE_CORRUPT", "Unexpected pendingId")
        for required_role in ("Manager", "Liaison"):
            if sum(member["role"] == required_role for member in members) != 1:
                _fail("STATE_CORRUPT", f"Canonical state requires exactly one {required_role}")
        return state

    def _project(
        self,
        state: dict[str, Any],
        member: dict[str, Any],
        host_id: str,
        thread_id: str,
        state_path: Path,
    ) -> dict[str, Any]:
        base = {
            "role": member["role"], "memberId": member["id"], "teamId": state["team"]["id"],
            "sourceVersion": state["version"], "statePath": str(state_path),
            "policyVersion": POLICY_VERSION, "identityAssurance": "caller-declared",
        }
        if member["lifecycle"] == "exited":
            return {"status": "inactive", **base, "reason": "exited"}
        binding = member["binding"]
        if binding["status"] == "missing":
            _fail("IDENTITY_UNAVAILABLE", "Registered member binding is marked missing")
        if binding["status"] != "bound":
            return {"status": "inactive", **base, "reason": binding["status"]}
        if binding.get("hostId") != host_id or binding.get("threadId") != thread_id:
            _fail("IDENTITY_MISMATCH", "Caller identity does not match canonical member binding")
        if member["role"] == "Liaison":
            self._validate_liaison_pairing(state, member, host_id, thread_id)
        return {"status": "active", **base, "boundaries": list(_BOUNDARIES[member["role"]])}

    def _validate_liaison_pairing(
        self, state: dict[str, Any], member: dict[str, Any], host_id: str, thread_id: str
    ) -> None:
        invitation = state.get("session", {}).get("invitation") if isinstance(state.get("session"), dict) else None
        if not isinstance(invitation, dict):
            _fail("INVALID_PAIRING", "Liaison has no current confirmed invitation")
        target = invitation.get("target")
        manager = next((m for m in state["members"] if m["id"] == invitation.get("managerId")), None)
        confirmed_at = invitation.get("confirmedAt")
        confirmation_id = invitation.get("confirmationId")
        confirmation = next((e for e in state["events"] if isinstance(e, dict) and e.get("id") == confirmation_id), None)
        revoked_ids = {
            event.get("detachedInvitation", {}).get("id")
            for event in state["events"]
            if isinstance(event, dict) and event.get("type") == "detachLiaison"
            and isinstance(event.get("detachedInvitation"), dict)
        }
        issued_version = invitation.get("issuedVersion")
        invite = state["events"][issued_version - 1] if _integer(issued_version, minimum=1) and issued_version <= len(state["events"]) else None
        valid = (
            invitation.get("liaisonId") == member["id"]
            and isinstance(target, dict) and target.get("hostId") == host_id and target.get("threadId") == thread_id
            and isinstance(confirmed_at, str) and bool(confirmed_at)
            and isinstance(confirmation_id, str) and bool(confirmation_id)
            and invitation.get("id") not in revoked_ids
            and isinstance(manager, dict) and manager.get("role") == "Manager"
            and isinstance(invite, dict) and invite.get("id") == invitation.get("id")
            and invite.get("type") == "attachInvite" and invite.get("actor") == manager.get("id")
            and isinstance(confirmation, dict) and confirmation.get("type") == "attachConfirm"
            and confirmation.get("actor") == member["id"] and confirmation.get("at") == confirmed_at
            and self._confirmation_was_timely(invite, invitation)
        )
        if not valid:
            _fail("INVALID_PAIRING", "Liaison pairing is not bidirectionally confirmed")

    @staticmethod
    def _confirmation_was_timely(invite: dict[str, Any], invitation: dict[str, Any]) -> bool:
        def canonical(value: Any) -> datetime:
            if not isinstance(value, str):
                raise ValueError("timestamp is not a string")
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if (parsed.tzinfo is None or not value.endswith("Z")
                    or parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value):
                raise ValueError("timestamp is not canonical UTC ISO")
            return parsed
        try:
            invited_at = canonical(invite["at"])
            confirmed_at = canonical(invitation["confirmedAt"])
            expires_at = canonical(invitation["expiresAt"])
            return invited_at <= confirmed_at < expires_at
        except (KeyError, AttributeError, TypeError, ValueError):
            return False

    @contextmanager
    def _index_lock(self):
        lock_path = Path(f"{self.index_path}.lock")
        descriptor: int | None = None
        deadline = time.monotonic() + 5.0
        while descriptor is None:
            try:
                descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if time.monotonic() >= deadline:
                    _fail("INDEX_BUSY", f"Index lock is busy: {lock_path}")
                time.sleep(0.01)
            except PermissionError as exc:
                # Windows can report EACCES while another thread owns or is
                # deleting an exclusive-create lock. Retry only this exact
                # operation for the same finite deadline; persistent access
                # denial still becomes INDEX_LOCK_FAILED.
                if exc.errno == errno.EACCES and time.monotonic() < deadline:
                    time.sleep(0.01)
                    continue
                _fail("INDEX_LOCK_FAILED", f"Cannot lock index {self.index_path}: {exc}")
            except OSError as exc:
                _fail("INDEX_LOCK_FAILED", f"Cannot lock index {self.index_path}: {exc}")
        try:
            os.write(descriptor, str(os.getpid()).encode("ascii"))
            yield
        finally:
            os.close(descriptor)
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass

    def _write_index(self, index: dict[str, Any]) -> None:
        parent = self.index_path.parent
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", dir=parent,
                prefix=f".{self.index_path.name}.", suffix=".tmp", delete=False,
            ) as stream:
                temporary = Path(stream.name)
                json.dump(index, stream, ensure_ascii=False, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            for attempt in range(21):
                try:
                    os.replace(temporary, self.index_path)
                    break
                except PermissionError:
                    if attempt == 20:
                        raise
                    time.sleep(0.1)
        except OSError as exc:
            _fail("INDEX_WRITE_FAILED", f"Cannot update index {self.index_path}: {exc}")
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
