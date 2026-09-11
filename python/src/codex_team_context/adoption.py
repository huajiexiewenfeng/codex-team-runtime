"""Explicit legacy-state adoption and forward-only recovery."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from .core import ContextError
from .runtime_link import invoke_adapter, read_state, replace_json, state_locked


_SAFE_OPERATION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _fail(code: str, message: str) -> None:
    raise ContextError(code, message)


def _same_file(left: Path, right: Path) -> bool:
    if left.resolve() == right.resolve():
        return True
    try:
        return left.exists() and right.exists() and os.path.samefile(left, right)
    except OSError:
        return False


def _publish_backup(path: Path, raw: bytes) -> None:
    temporary: Path | None = None
    if path.exists():
        try:
            existing = path.read_bytes()
        except OSError as exc:
            _fail("BACKUP_FAILED", f"Cannot read adoption backup: {exc}")
        if existing != raw:
            _fail("BACKUP_CONFLICT", "Existing adoption backup does not match source bytes")
        return
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    except FileExistsError:
        try:
            if path.read_bytes() != raw:
                _fail("BACKUP_CONFLICT", "Existing adoption backup does not match source bytes")
        except OSError as exc:
            _fail("BACKUP_FAILED", f"Cannot verify adoption backup: {exc}")
    except OSError as exc:
        _fail("BACKUP_FAILED", f"Cannot publish adoption backup: {exc}")
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def _source_from_backup(path: Path, request: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    try:
        raw = path.read_bytes()
        state = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError) as exc:
        _fail("BACKUP_INVALID", f"Adoption backup is unavailable or invalid: {exc}")
    if hashlib.sha256(raw).hexdigest() != request["expected_state_sha256"]:
        _fail("BACKUP_INVALID", "Adoption backup digest does not match the request")
    if not isinstance(state, dict) or state.get("schemaVersion") != 1:
        _fail("BACKUP_INVALID", "Adoption backup is not the original schema-1 state")
    return raw, state


def _check_source(registry: Any, state: dict[str, Any], raw: bytes, request: dict[str, Any], actor: dict[str, str]) -> None:
    if hashlib.sha256(raw).hexdigest() != request["expected_state_sha256"]:
        _fail("SOURCE_MISMATCH", "Source state byte digest changed")
    if state.get("schemaVersion") != 1 or state.get("version") != request["expected_state_version"]:
        _fail("SOURCE_MISMATCH", "Source state schema or version changed")
    team = state.get("team")
    if not isinstance(team, dict) or team.get("id") != request["team_id"] or team.get("name") != request["team_name"]:
        _fail("SOURCE_MISMATCH", "Source team identity does not match the request")
    if state.get("members") != request["members"]:
        _fail("SOURCE_MISMATCH", "Source member roster does not match the request")
    for member in request["members"]:
        binding = member.get("binding") if isinstance(member, dict) else None
        if not isinstance(binding, dict) or binding.get("status") != "bound":
            _fail("SOURCE_MISMATCH", "Every adopted member must have a bound identity")
    manager = next((m for m in request["members"] if m.get("id") == request["member_id"]), None)
    if (
        manager is None or manager.get("role") != "Manager" or manager.get("lifecycle") != "active"
        or manager["binding"].get("hostId") != actor["hostId"]
        or manager["binding"].get("threadId") != actor["threadId"]
    ):
        _fail("MANAGER_REQUIRED", "Exact active source Manager identity is required")
    liaison = next((m for m in request["members"] if m.get("role") == "Liaison"), None)
    invitation = state.get("session", {}).get("invitation") if isinstance(state.get("session"), dict) else None
    if (
        liaison is None or not isinstance(invitation, dict)
        or invitation.get("liaisonId") != liaison.get("id")
        or invitation.get("confirmedAt") is None
        or invitation.get("confirmationId") is None
        or invitation.get("target") != {
            "hostId": liaison["binding"].get("hostId"),
            "threadId": liaison["binding"].get("threadId"),
        }
    ):
        _fail("CONSENT_REQUIRED", "Exact Liaison invitation must be confirmed")
    del registry


def _import_member(member: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    binding = member["binding"]
    return {
        "id": member["id"], "name": member["name"], "role": member["role"],
        "binding": {"hostId": binding["hostId"], "threadId": binding["threadId"], "revision": 1},
        "lifecycle": member["lifecycle"],
        "onboarding": {"status": "pending", "evidenceRef": None, "confirmedReceipt": None},
        "authorizationRef": request["authorization_ref"],
        "consentRef": request["consent_ref"] if member["role"] == "Liaison" else None,
    }


def _prepared_link(
    registry_id: str, registry_path: Path, request: dict[str, Any]
) -> dict[str, Any]:
    return {
        "registryId": registry_id, "registryPath": str(registry_path),
        "teamId": request["team_id"], "migrationId": request["operation_id"],
        "sourceSha256": request["expected_state_sha256"],
        "sourceVersion": request["expected_state_version"], "phase": "prepared",
        "teamRevision": 0, "readyMemberIds": [],
    }


def _expected_prepared(
    node: Path, root: Path, source: dict[str, Any], registry_id: str,
    registry_path: Path, request: dict[str, Any],
) -> dict[str, Any]:
    return invoke_adapter(node, root, {
        "action": "prepare", "state": source,
        "registry": _prepared_link(registry_id, registry_path, request),
    })


def _verify_expected_prepared(
    node: Path, root: Path, current: dict[str, Any], source: dict[str, Any],
    registry: dict[str, Any], registry_path: Path, request: dict[str, Any],
) -> None:
    # Full validation must precede any Registry commit. Metadata equality alone
    # cannot establish that preserved business state still matches the backup.
    invoke_adapter(node, root, {"action": "inspect", "state": current})
    _verify_prepared(current, registry, request, registry_path)
    expected = _expected_prepared(
        node, root, source, registry["registryId"], registry_path, request
    )
    if current != expected:
        _fail(
            "RECOVERY_CONFLICT",
            "Prepared state business content does not match the verified backup",
        )


def build_candidate(owner: Any, registry: dict[str, Any], request: dict[str, Any], actor: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    for source_member in request["members"]:
        binding = source_member["binding"]
        owner._require_unique_member(
            registry, source_member["id"], binding["hostId"], binding["threadId"]
        )
    candidate = json.loads(json.dumps(registry, ensure_ascii=False, allow_nan=False))
    candidate["schemaVersion"] = 3
    candidate["policyRevision"] = owner.policy_revision
    runtime = {
        "statePath": request["state_path"], "migrationId": request["operation_id"],
        "sourceVersion": request["expected_state_version"],
        "sourceSha256": request["expected_state_sha256"],
    }
    team = {
        "id": request["team_id"], "name": request["team_name"], "revision": 1,
        "leaderMemberId": request["member_id"],
        "members": [_import_member(member, request) for member in request["members"]],
        "runtime": runtime,
    }
    candidate["teams"].append(team)
    receipt = {
        "operationId": request["operation_id"], "teamId": request["team_id"],
        "teamRevision": 1, "memberId": request["member_id"], "outcome": "adopted",
    }
    candidate["operations"].append({
        "operationId": request["operation_id"], "actor": actor,
        "request": json.loads(json.dumps(request, ensure_ascii=False, allow_nan=False)),
        "result": receipt.copy(),
    })
    owner._validated(candidate)
    return candidate, receipt


def adopt(owner: Any, actor: dict[str, str], request: dict[str, Any]) -> dict[str, Any]:
    operation_id = request["operation_id"]
    if _SAFE_OPERATION.fullmatch(operation_id) is None:
        _fail("INVALID_REQUEST", "adopt_legacy operation_id is not filename-safe")
    state_path = Path(request["state_path"])
    if not state_path.is_absolute() or state_path != state_path.resolve():
        _fail("INVALID_REQUEST", "state_path must be an absolute canonical path")
    registry_path = owner.registry_path.resolve()
    if _same_file(state_path, registry_path):
        _fail("INVALID_REQUEST", "Registry and state files must be separate")
    backup_path = Path(f"{state_path}.{operation_id}.before-registry.json")
    if _same_file(backup_path, state_path) or _same_file(backup_path, registry_path):
        _fail("INVALID_REQUEST", "Backup must not alias Registry or state")

    node, root = owner._trusted_runtime()
    with owner._store.locked():
        registry = owner._validated(owner._store.read())
        previous = next((op for op in registry["operations"] if op["operationId"] == operation_id), None)
        if previous is not None and (previous["actor"] != actor or previous["request"] != request):
            _fail("OPERATION_CONFLICT", "operation_id is already bound to another operation")
        with state_locked(state_path):
            current_raw, current_state = read_state(state_path)
            if previous is None:
                if registry["schemaVersion"] not in {2, 3}:
                    _fail("REGISTRY_CONFLICT", "New adoption requires a supported Registry")
                if any(team["id"] == request["team_id"] for team in registry["teams"]):
                    _fail("TEAM_CONFLICT", "team_id already exists")
                for team in registry["teams"]:
                    runtime = team.get("runtime")
                    if runtime is not None and _same_file(
                        Path(runtime["statePath"]), state_path
                    ):
                        _fail("RUNTIME_CONFLICT", "state_path is already linked to another team")
                if current_state.get("schemaVersion") == 1:
                    source_raw, source = current_raw, current_state
                else:
                    source_raw, source = _source_from_backup(backup_path, request)
                invoke_adapter(node, root, {"action": "inspect", "state": source})
                _check_source(registry, source, source_raw, request, actor)
                candidate, receipt = build_candidate(owner, registry, request, actor)
                _publish_backup(backup_path, source_raw)
                expected_prepared = _expected_prepared(
                    node, root, source, candidate["registryId"], registry_path, request
                )
                if current_state.get("schemaVersion") == 1:
                    replace_json(state_path, expected_prepared)
                    current_state = expected_prepared
                else:
                    _verify_expected_prepared(
                        node, root, current_state, source, candidate,
                        registry_path, request,
                    )
                owner._store._replace(candidate)
                registry = candidate
            else:
                receipt = previous["result"].copy()
                _, source = _source_from_backup(backup_path, request)
                invoke_adapter(node, root, {"action": "inspect", "state": source})
                invoke_adapter(node, root, {"action": "inspect", "state": current_state})
                _verify_prepared(current_state, registry, request, registry_path, active_ok=True)

                if current_state["registry"]["phase"] == "prepared":
                    _verify_expected_prepared(
                        node, root, current_state, source, registry,
                        registry_path, request,
                    )

            if current_state["registry"]["phase"] == "active":
                return receipt
            projection = owner._export_from_validated(registry, request["team_id"])
            if Path(projection["statePath"]).resolve() != state_path:
                _fail("RUNTIME_REJECTED", "Registry export state path mismatch")
            active = invoke_adapter(node, root, {
                "action": "activate", "state": current_state, "projection": projection,
            })
            if Path(active["registry"]["registryPath"]).resolve() != registry_path:
                _fail("RUNTIME_REJECTED", "Activated state Registry path mismatch")
            replace_json(state_path, active)
            return receipt


def _verify_prepared(
    state: dict[str, Any], registry: dict[str, Any], request: dict[str, Any],
    registry_path: Path, *, active_ok: bool = False,
) -> None:
    link = state.get("registry")
    allowed = {"prepared", "active"} if active_ok else {"prepared"}
    if (
        state.get("schemaVersion") != 2 or not isinstance(link, dict)
        or link.get("phase") not in allowed
        or Path(link.get("registryPath", "")).resolve() != registry_path
        or link.get("teamId") != request["team_id"]
        or link.get("migrationId") != request["operation_id"]
        or link.get("sourceVersion") != request["expected_state_version"]
        or link.get("sourceSha256") != request["expected_state_sha256"]
        or link.get("registryId") != registry["registryId"]
    ):
        _fail("RECOVERY_CONFLICT", "Prepared/active state metadata does not match adoption")
