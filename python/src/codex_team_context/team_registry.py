"""Strict schema-v2 team registry and bounded context projection."""

from __future__ import annotations

import hmac
import json
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

from .core import ContextError
from .registry_store import RegistryStore
from .team_policy import POLICY_REVISION, ROLE_DUTIES, SHARED_RULES, onboarding_receipt


REGISTRY_SCHEMA_VERSION = 2
LATEST_REGISTRY_SCHEMA_VERSION = 3
_ID_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")
_ROLES = {"Manager", "Worker", "Liaison"}
_ACTIVE_ROLES = {"Worker", "Liaison"}
_LIFECYCLES = {"active", "exited"}
_ONBOARDING = {"pending", "ready"}

_REQUEST_FIELDS = {
    "bootstrap": {
        "action", "operation_id", "team_id", "team_name", "member_id", "name",
        "authorization_ref",
    },
    "register_member": {
        "action", "operation_id", "team_id", "expected_revision", "member_id", "name",
        "role", "target_host_id", "target_thread_id", "authorization_ref",
    },
    "confirm_ready": {
        "action", "operation_id", "team_id", "expected_revision", "member_id", "receipt",
        "evidence_ref",
    },
    "exit_member": {
        "action", "operation_id", "team_id", "expected_revision", "member_id",
        "authorization_ref",
    },
    "adopt_legacy": {
        "action", "operation_id", "team_id", "team_name", "member_id", "state_path",
        "expected_state_version", "expected_state_sha256", "members",
        "authorization_ref", "consent_ref",
    },
}


def _fail(code: str, message: str) -> None:
    raise ContextError(code, message)


def _is_integer(value: Any, minimum: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _identifier(value: Any, field: str, code: str = "INVALID_IDENTITY") -> str:
    if not isinstance(value, str) or _ID_PATTERN.fullmatch(value) is None:
        _fail(code, f"{field} must be a valid explicit identifier")
    return value


def _text(value: Any, field: str, *, maximum: int = 512, code: str = "INVALID_REQUEST") -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > maximum
        or any(ord(character) < 32 or 0xD800 <= ord(character) <= 0xDFFF for character in value)
    ):
        _fail(code, f"{field} must be a nonempty bounded JSON-safe string")
    return value


def _caller(host_id: Any, thread_id: Any) -> tuple[str, str]:
    host = _identifier(host_id, "host_id")
    thread = _identifier(thread_id, "thread_id")
    if thread.startswith(("pending:", "client-new-thread:")):
        _fail("INVALID_IDENTITY", "thread_id must identify an existing task")
    return host, thread


def initialize_registry(path: str | os.PathLike[str]) -> None:
    """Create a new registry without creating parents or overwriting a file."""

    target = Path(path)
    if not target.parent.is_dir():
        _fail("REGISTRY_PARENT_MISSING", f"Registry parent directory is missing: {target.parent}")
    value = {
        "schemaVersion": REGISTRY_SCHEMA_VERSION,
        "registryId": str(uuid.uuid4()),
        "policyRevision": POLICY_REVISION,
        "teams": [],
        "operations": [],
    }
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=target.parent,
            prefix=f".{target.name}.",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, target)
    except FileExistsError:
        _fail("REGISTRY_EXISTS", f"Registry already exists: {target}")
    except (OSError, TypeError, ValueError) as exc:
        _fail("REGISTRY_WRITE_FAILED", f"Cannot initialize registry {target}: {exc}")
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass


class TeamRegistry:
    def __init__(
        self, *, registry_path: str | os.PathLike[str],
        node_executable: str | os.PathLike[str] | None = None,
        runtime_root: str | os.PathLike[str] | None = None,
    ) -> None:
        self._store = RegistryStore(registry_path)
        self.registry_path = self._store.path
        configured = node_executable is not None or runtime_root is not None
        if configured and (
            node_executable is None or runtime_root is None
            or not Path(node_executable).is_absolute()
            or not Path(runtime_root).is_absolute()
        ):
            _fail(
                "INVALID_RUNTIME_CONFIG",
                "node_executable and runtime_root must be paired absolute operator paths",
            )
        self.node_executable = node_executable
        self.runtime_root = runtime_root
        self.policy_revision = POLICY_REVISION

    def _trusted_runtime(self):
        from .runtime_link import trusted_paths
        return trusted_paths(self.node_executable, self.runtime_root)

    def read(self, host_id: str, thread_id: str) -> dict[str, Any] | None:
        host_id, thread_id = _caller(host_id, thread_id)
        registry = self._validated(self._store.read())
        located = self._member_by_identity(registry, host_id, thread_id)
        if located is None:
            return None
        team, member = located
        runtime_phase: str | None = None
        if "runtime" in team:
            from .runtime_link import invoke_adapter, read_state
            node, root = self._trusted_runtime()
            _, state = read_state(Path(team["runtime"]["statePath"]))
            invoke_adapter(node, root, {"action": "inspect", "state": state})
            self._validate_link_state(registry, team, state)
            runtime_phase = state["registry"]["phase"]
        return self._capsule(registry, team, member, runtime_phase=runtime_phase)

    def observation_identity(self, host_id: str, thread_id: str) -> dict[str, Any] | None:
        """Return a narrow caller-declared identity projection without runtime checks."""

        host_id, thread_id = _caller(host_id, thread_id)
        registry = self._validated(self._store.read())
        located = self._member_by_identity(registry, host_id, thread_id)
        if located is None:
            return None
        team, member = located
        return {
            "registryId": registry["registryId"],
            "teamId": team["id"],
            "memberId": member["id"],
            "role": member["role"],
            "hostId": host_id,
            "threadId": thread_id,
            "memberStatus": member["lifecycle"],
            "policyRevision": POLICY_REVISION,
            "identitySource": "registry-at-call-start",
        }

    def manage(
        self, actor_host_id: str, actor_thread_id: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        actor_host_id, actor_thread_id = _caller(actor_host_id, actor_thread_id)
        action, operation_id = self._request_header(request)
        # Validate all revision-independent structure and scalar types before
        # replay comparison.  In particular, JSON booleans/floats must not be
        # accepted as the integer in a historical request by Python equality.
        self._validate_request(request, action)

        if action == "adopt_legacy":
            from .adoption import adopt
            return adopt(
                self, {"hostId": actor_host_id, "threadId": actor_thread_id}, request
            )

        def mutation(registry: Any) -> tuple[dict[str, Any], bool]:
            registry = self._validated(registry)
            previous = next(
                (operation for operation in registry["operations"]
                 if operation["operationId"] == operation_id),
                None,
            )
            actor = {"hostId": actor_host_id, "threadId": actor_thread_id}
            if previous is not None:
                if previous["actor"] == actor and previous["request"] == request:
                    return copy_json(previous["result"]), False
                _fail("OPERATION_CONFLICT", "operation_id is already bound to another operation")

            if action == "bootstrap":
                result = self._bootstrap(registry, actor_host_id, actor_thread_id, request)
            else:
                team = self._team(registry, request["team_id"])
                manager = self._require_manager(team, actor_host_id, actor_thread_id)
                if request["expected_revision"] != team["revision"]:
                    _fail("REVISION_CONFLICT", "expected_revision does not match team revision")
                if action == "register_member":
                    result = self._register_member(registry, team, request)
                elif action == "confirm_ready":
                    result = self._confirm_ready(registry, team, request)
                else:
                    result = self._exit_member(team, manager, request)
            registry["operations"].append({
                "operationId": operation_id,
                "actor": actor,
                "request": copy_json(request),
                "result": copy_json(result),
            })
            return result, True

        from .runtime_link import invoke_adapter, read_state, state_locked

        with self._store.locked():
            registry = self._validated(self._store.read())
            linked_team = None if action == "bootstrap" else self._team(
                registry, request["team_id"]
            )
            runtime = linked_team.get("runtime") if linked_team is not None else None
            if runtime is None:
                result, changed = mutation(registry)
                if changed:
                    self._store._replace(registry)
                return result
            node, root = self._trusted_runtime()
            state_path = Path(runtime["statePath"])
            with state_locked(state_path):
                _, state = read_state(state_path)
                invoke_adapter(node, root, {"action": "inspect", "state": state})
                self._validate_link_state(registry, linked_team, state)
                if state["registry"]["phase"] != "active":
                    _fail("MIGRATION_PENDING", "Linked state is still prepared")
                if action == "exit_member":
                    invoke_adapter(node, root, {
                        "action": "check_exit", "state": state,
                        "memberId": request["member_id"],
                    })
                result, changed = mutation(registry)
                if changed:
                    self._store._replace(registry)
                return result

    @staticmethod
    def _request_header(request: Any) -> tuple[str, str]:
        if not isinstance(request, dict):
            _fail("INVALID_REQUEST", "request must be an object")
        action = request.get("action")
        if not isinstance(action, str) or action not in _REQUEST_FIELDS:
            _fail("INVALID_REQUEST", "action is unsupported")
        operation_id = _identifier(request.get("operation_id"), "operation_id", "INVALID_REQUEST")
        return action, operation_id

    @staticmethod
    def _validate_request(request: dict[str, Any], action: str, *, stored: bool = False) -> None:
        expected = set(_REQUEST_FIELDS[action])
        if action == "register_member" and request.get("role") == "Liaison":
            expected.add("consent_ref")
        if set(request) != expected:
            _fail("REGISTRY_CORRUPT" if stored else "INVALID_REQUEST",
                  f"{action} request fields must match the exact schema")
        code = "REGISTRY_CORRUPT" if stored else "INVALID_REQUEST"
        _identifier(request["operation_id"], "operation_id", code)
        _identifier(request["team_id"], "team_id", code)
        if action == "bootstrap":
            _text(request["team_name"], "team_name", code=code)
            _identifier(request["member_id"], "member_id", code)
            _text(request["name"], "name", code=code)
            _text(request["authorization_ref"], "authorization_ref", maximum=2048, code=code)
        elif action == "adopt_legacy":
            _text(request["team_name"], "team_name", code=code)
            _identifier(request["member_id"], "member_id", code)
            _text(request["state_path"], "state_path", maximum=4096, code=code)
            if not _is_integer(request["expected_state_version"], 0):
                _fail(code, "expected_state_version must be a nonnegative integer")
            digest = request["expected_state_sha256"]
            if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
                _fail(code, "expected_state_sha256 must be lowercase SHA-256")
            if not isinstance(request["members"], list) or not request["members"]:
                _fail(code, "members must be the complete nonempty source roster")
            seen_ids: set[str] = set()
            seen_bindings: set[tuple[str, str]] = set()
            managers = liaisons = 0
            for member in request["members"]:
                if not isinstance(member, dict) or set(member) != {
                    "id", "name", "role", "lifecycle", "binding"
                }:
                    _fail(code, "adopted member fields must match the Node roster schema")
                member_id = _identifier(member["id"], "members.id", code)
                _text(member["name"], "members.name", code=code)
                if member_id in seen_ids:
                    _fail(code, "adopted member ids must be unique")
                seen_ids.add(member_id)
                role = member["role"]
                if role not in _ROLES or member["lifecycle"] not in _LIFECYCLES:
                    _fail(code, "adopted member role or lifecycle is invalid")
                managers += role == "Manager"
                liaisons += role == "Liaison"
                binding = member["binding"]
                if not isinstance(binding, dict) or set(binding) != {"status", "hostId", "threadId"}:
                    _fail(code, "adopted members must have exact bound bindings")
                if binding["status"] != "bound":
                    _fail(code, "adopted members must all be bound")
                identity = _caller_stored(binding["hostId"], binding["threadId"], code)
                if identity in seen_bindings:
                    _fail(code, "adopted member bindings must be unique")
                seen_bindings.add(identity)
            if managers != 1 or liaisons != 1:
                _fail(code, "adopted roster requires exactly one Manager and Liaison")
            _text(request["authorization_ref"], "authorization_ref", maximum=2048, code=code)
            _text(request["consent_ref"], "consent_ref", maximum=2048, code=code)
        elif action == "register_member":
            if not _is_integer(request["expected_revision"], 1):
                _fail(code, "expected_revision must be a positive integer")
            _identifier(request["member_id"], "member_id", code)
            _text(request["name"], "name", code=code)
            if not isinstance(request["role"], str) or request["role"] not in _ACTIVE_ROLES:
                _fail(code, "role must be Worker or Liaison")
            _caller_stored(request["target_host_id"], request["target_thread_id"], code)
            _text(request["authorization_ref"], "authorization_ref", maximum=2048, code=code)
            if request["role"] == "Liaison":
                _text(request["consent_ref"], "consent_ref", maximum=2048, code=code)
        elif action == "confirm_ready":
            if not _is_integer(request["expected_revision"], 1):
                _fail(code, "expected_revision must be a positive integer")
            _identifier(request["member_id"], "member_id", code)
            receipt = _text(request["receipt"], "receipt", maximum=256, code=code)
            if re.fullmatch(r"v2:[0-9a-f]{64}", receipt) is None:
                _fail(code, "receipt has an invalid format")
            _text(request["evidence_ref"], "evidence_ref", maximum=2048, code=code)
        else:
            if not _is_integer(request["expected_revision"], 1):
                _fail(code, "expected_revision must be a positive integer")
            _identifier(request["member_id"], "member_id", code)
            _text(request["authorization_ref"], "authorization_ref", maximum=2048, code=code)

    def _bootstrap(
        self, registry: dict[str, Any], host_id: str, thread_id: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        if any(team["id"] == request["team_id"] for team in registry["teams"]):
            _fail("TEAM_CONFLICT", "team_id already exists")
        self._require_unique_member(registry, request["member_id"], host_id, thread_id)
        manager = {
            "id": request["member_id"],
            "name": request["name"],
            "role": "Manager",
            "binding": {"hostId": host_id, "threadId": thread_id, "revision": 1},
            "lifecycle": "active",
            "onboarding": {
                "status": "pending", "evidenceRef": None, "confirmedReceipt": None,
            },
            "authorizationRef": request["authorization_ref"],
            "consentRef": None,
        }
        registry["teams"].append({
            "id": request["team_id"],
            "name": request["team_name"],
            "revision": 1,
            "leaderMemberId": manager["id"],
            "members": [manager],
        })
        return _result(request, 1, "bootstrapped")

    def _register_member(
        self, registry: dict[str, Any], team: dict[str, Any], request: dict[str, Any]
    ) -> dict[str, Any]:
        if request["role"] == "Liaison" and any(
            member["role"] == "Liaison" for member in team["members"]
        ):
            _fail("ROLE_CONFLICT", "team already has a Liaison record")
        self._require_unique_member(
            registry, request["member_id"], request["target_host_id"], request["target_thread_id"]
        )
        team["members"].append({
            "id": request["member_id"],
            "name": request["name"],
            "role": request["role"],
            "binding": {
                "hostId": request["target_host_id"],
                "threadId": request["target_thread_id"],
                "revision": 1,
            },
            "lifecycle": "active",
            "onboarding": {
                "status": "pending", "evidenceRef": None, "confirmedReceipt": None,
            },
            "authorizationRef": request["authorization_ref"],
            "consentRef": request.get("consent_ref"),
        })
        team["revision"] += 1
        return _result(request, team["revision"], "registered")

    def _confirm_ready(
        self, registry: dict[str, Any], team: dict[str, Any], request: dict[str, Any]
    ) -> dict[str, Any]:
        member = self._member(team, request["member_id"])
        if member["lifecycle"] != "active":
            _fail("MEMBER_INACTIVE", "Cannot confirm an exited member")
        leader = self._member(team, team["leaderMemberId"])
        expected = onboarding_receipt(
            registry["registryId"], team, member, leader, POLICY_REVISION
        )
        if (
            member["onboarding"]["status"] == "ready"
            and member["onboarding"]["confirmedReceipt"] == expected
        ):
            _fail("MEMBER_CONFLICT", "Member onboarding is already ready for this policy")
        if not hmac.compare_digest(request["receipt"], expected):
            _fail("RECEIPT_MISMATCH", "onboarding receipt does not match current member context")
        member["onboarding"] = {
            "status": "ready",
            "evidenceRef": request["evidence_ref"],
            "confirmedReceipt": expected,
        }
        registry["policyRevision"] = POLICY_REVISION
        team["revision"] += 1
        return _result(request, team["revision"], "ready")

    def _exit_member(
        self, team: dict[str, Any], manager: dict[str, Any], request: dict[str, Any]
    ) -> dict[str, Any]:
        del manager
        member = self._member(team, request["member_id"])
        if member["lifecycle"] != "active":
            _fail("MEMBER_CONFLICT", "Member has already exited")
        member["lifecycle"] = "exited"
        team["revision"] += 1
        return _result(request, team["revision"], "exited")

    @staticmethod
    def _team(registry: dict[str, Any], team_id: str) -> dict[str, Any]:
        team = next((team for team in registry["teams"] if team["id"] == team_id), None)
        if team is None:
            _fail("TEAM_NOT_FOUND", "team_id is not registered")
        return team

    @staticmethod
    def _member(team: dict[str, Any], member_id: str) -> dict[str, Any]:
        member = next((member for member in team["members"] if member["id"] == member_id), None)
        if member is None:
            _fail("MEMBER_NOT_FOUND", "member_id is not registered in the team")
        return member

    def _require_manager(
        self, team: dict[str, Any], host_id: str, thread_id: str
    ) -> dict[str, Any]:
        member = next(
            (member for member in team["members"]
             if member["binding"]["hostId"] == host_id
             and member["binding"]["threadId"] == thread_id),
            None,
        )
        if (
            member is None
            or member["id"] != team["leaderMemberId"]
            or member["role"] != "Manager"
            or member["lifecycle"] != "active"
        ):
            _fail("MANAGER_REQUIRED", "Exact active team Manager identity is required")
        return member

    @staticmethod
    def _require_unique_member(
        registry: dict[str, Any], member_id: str, host_id: str, thread_id: str
    ) -> None:
        for team in registry["teams"]:
            for member in team["members"]:
                if member["id"] == member_id:
                    _fail("MEMBER_CONFLICT", "member_id is permanently registered")
                binding = member["binding"]
                if binding["hostId"] == host_id and binding["threadId"] == thread_id:
                    _fail("IDENTITY_CONFLICT", "host/thread identity is permanently registered")

    @staticmethod
    def _member_by_identity(
        registry: dict[str, Any], host_id: str, thread_id: str
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        for team in registry["teams"]:
            for member in team["members"]:
                binding = member["binding"]
                if binding["hostId"] == host_id and binding["threadId"] == thread_id:
                    return team, member
        return None

    def _capsule(
        self, registry: dict[str, Any], team: dict[str, Any], member: dict[str, Any],
        *, runtime_phase: str | None = None,
    ) -> dict[str, Any]:
        leader = self._member(team, team["leaderMemberId"])
        current_receipt = onboarding_receipt(
            registry["registryId"], team, member, leader, POLICY_REVISION
        )
        declared_onboarding = member["onboarding"]
        is_current_ready = (
            declared_onboarding["status"] == "ready"
            and isinstance(declared_onboarding["confirmedReceipt"], str)
            and hmac.compare_digest(declared_onboarding["confirmedReceipt"], current_receipt)
        )
        projected_onboarding = (
            {"status": "ready", "evidenceRef": declared_onboarding["evidenceRef"]}
            if is_current_ready
            else {"status": "pending", "evidenceRef": None}
        )
        capsule = {
            "status": "active" if member["lifecycle"] == "active" else "inactive",
            "registryId": registry["registryId"],
            "registrySchemaVersion": registry["schemaVersion"],
            "policyRevision": POLICY_REVISION,
            "team": {"id": team["id"], "name": team["name"], "revision": team["revision"]},
            "member": {
                "memberId": member["id"], "name": member["name"], "role": member["role"],
                "lifecycle": member["lifecycle"], "binding": copy_json(member["binding"]),
            },
            "leader": {
                "memberId": leader["id"], "name": leader["name"],
                "hostId": leader["binding"]["hostId"],
                "threadId": leader["binding"]["threadId"],
                "bindingRevision": leader["binding"]["revision"],
                "lifecycle": leader["lifecycle"],
            },
            "onboarding": projected_onboarding,
            "executionIntegration": "not-connected",
            "dispatchAllowed": False,
            "identityAssurance": "caller-declared",
        }
        runtime = team.get("runtime")
        if runtime is not None:
            capsule["runtime"] = {
                "statePath": runtime["statePath"], "migrationId": runtime["migrationId"],
                "phase": runtime_phase, "teamRevision": team["revision"],
                "runtimeRoot": str(Path(self.runtime_root).resolve()),
                "pythonExecutable": os.path.abspath(os.sys.executable),
            }
            capsule["executionIntegration"] = (
                "connected" if runtime_phase == "active" else "migration-pending"
            )
        if member["lifecycle"] == "active":
            capsule.update({
                "sharedRules": list(SHARED_RULES),
                "roleDuties": list(ROLE_DUTIES[member["role"]]),
                "onboardingReceipt": current_receipt,
            })
            if member["role"] == "Manager":
                capsule["teamMembers"] = [
                    {
                        "memberId": roster_member["id"],
                        "name": roster_member["name"],
                        "role": roster_member["role"],
                        "lifecycle": roster_member["lifecycle"],
                        "hostId": roster_member["binding"]["hostId"],
                        "threadId": roster_member["binding"]["threadId"],
                        "onboardingStatus": self._effective_onboarding_status(
                            registry, team, roster_member, leader
                        ),
                    }
                    for roster_member in team["members"]
                ]
        else:
            capsule["reason"] = "exited"
        return capsule

    @staticmethod
    def _effective_onboarding_status(
        registry: dict[str, Any],
        team: dict[str, Any],
        member: dict[str, Any],
        leader: dict[str, Any],
    ) -> str:
        expected = onboarding_receipt(
            registry["registryId"], team, member, leader, POLICY_REVISION
        )
        declaration = member["onboarding"]
        return (
            "ready"
            if declaration["status"] == "ready"
            and declaration["confirmedReceipt"] == expected
            else "pending"
        )

    def _validated(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict) or set(value) != {
            "schemaVersion", "registryId", "policyRevision", "teams", "operations"
        }:
            _fail("REGISTRY_CORRUPT", "Registry root fields do not match the schema")
        schema = value["schemaVersion"]
        if schema not in {REGISTRY_SCHEMA_VERSION, LATEST_REGISTRY_SCHEMA_VERSION} or isinstance(schema, bool):
            _fail("REGISTRY_CORRUPT", "Unsupported registry schemaVersion")
        _identifier(value["registryId"], "registryId", "REGISTRY_CORRUPT")
        if (
            not _is_integer(value["policyRevision"], 1)
            or value["policyRevision"] > POLICY_REVISION
        ):
            _fail("REGISTRY_CORRUPT", "Unsupported future or invalid policyRevision")
        if not isinstance(value["teams"], list) or not isinstance(value["operations"], list):
            _fail("REGISTRY_CORRUPT", "teams and operations must be arrays")

        team_ids: set[str] = set()
        member_ids: set[str] = set()
        bindings: set[tuple[str, str]] = set()
        for team in value["teams"]:
            self._validate_team(team, team_ids, member_ids, bindings, schema)
        operation_ids: set[str] = set()
        for operation in value["operations"]:
            self._validate_operation(operation, operation_ids)
            if schema == 2 and operation["request"]["action"] == "adopt_legacy":
                _fail("REGISTRY_CORRUPT", "Schema-2 Registry cannot contain adoption history")
        self._validate_history(value)
        return value

    def _validate_history(self, registry: dict[str, Any]) -> None:
        reconstructed: list[dict[str, Any]] = []
        teams: dict[str, dict[str, Any]] = {}
        member_ids: set[str] = set()
        bindings: set[tuple[str, str]] = set()

        for operation in registry["operations"]:
            actor = operation["actor"]
            request = operation["request"]
            result = operation["result"]
            action = request["action"]
            team_id = request["team_id"]

            if action == "bootstrap":
                binding = (actor["hostId"], actor["threadId"])
                if (
                    team_id in teams
                    or request["member_id"] in member_ids
                    or binding in bindings
                    or result["teamRevision"] != 1
                ):
                    _fail("REGISTRY_CORRUPT", "Invalid ordered bootstrap history")
                manager = {
                    "id": request["member_id"],
                    "name": request["name"],
                    "role": "Manager",
                    "binding": {
                        "hostId": actor["hostId"],
                        "threadId": actor["threadId"],
                        "revision": 1,
                    },
                    "lifecycle": "active",
                    "onboarding": {
                        "status": "pending", "evidenceRef": None,
                        "confirmedReceipt": None,
                    },
                    "authorizationRef": request["authorization_ref"],
                    "consentRef": None,
                }
                team = {
                    "id": team_id,
                    "name": request["team_name"],
                    "revision": 1,
                    "leaderMemberId": manager["id"],
                    "members": [manager],
                }
                reconstructed.append(team)
                teams[team_id] = team
                member_ids.add(manager["id"])
                bindings.add(binding)
                continue

            if action == "adopt_legacy":
                if team_id in teams or result["teamRevision"] != 1:
                    _fail("REGISTRY_CORRUPT", "Invalid ordered adoption history")
                source_manager = next(
                    (member for member in request["members"]
                     if member["id"] == request["member_id"]),
                    None,
                )
                if (
                    source_manager is None
                    or source_manager["role"] != "Manager"
                    or source_manager["lifecycle"] != "active"
                    or actor != {
                        "hostId": source_manager["binding"]["hostId"],
                        "threadId": source_manager["binding"]["threadId"],
                    }
                ):
                    _fail("REGISTRY_CORRUPT", "Stored adoption actor is not the source Manager")
                imported = []
                for source_member in request["members"]:
                    binding = source_member["binding"]
                    identity = (binding["hostId"], binding["threadId"])
                    if source_member["id"] in member_ids or identity in bindings:
                        _fail("REGISTRY_CORRUPT", "Stored adoption reuses an identity")
                    imported.append({
                        "id": source_member["id"], "name": source_member["name"],
                        "role": source_member["role"],
                        "binding": {"hostId": binding["hostId"], "threadId": binding["threadId"], "revision": 1},
                        "lifecycle": source_member["lifecycle"],
                        "onboarding": {"status": "pending", "evidenceRef": None, "confirmedReceipt": None},
                        "authorizationRef": request["authorization_ref"],
                        "consentRef": request["consent_ref"] if source_member["role"] == "Liaison" else None,
                    })
                    member_ids.add(source_member["id"])
                    bindings.add(identity)
                team = {
                    "id": team_id, "name": request["team_name"], "revision": 1,
                    "leaderMemberId": request["member_id"], "members": imported,
                    "runtime": {
                        "statePath": request["state_path"], "migrationId": request["operation_id"],
                        "sourceVersion": request["expected_state_version"],
                        "sourceSha256": request["expected_state_sha256"],
                    },
                }
                reconstructed.append(team)
                teams[team_id] = team
                continue

            team = teams.get(team_id)
            if team is None or request["expected_revision"] != team["revision"]:
                _fail("REGISTRY_CORRUPT", "Stored operation violates team revision history")
            leader = next(
                (member for member in team["members"]
                 if member["id"] == team["leaderMemberId"]),
                None,
            )
            if (
                leader is None
                or leader["role"] != "Manager"
                or leader["lifecycle"] != "active"
                or actor != {
                    "hostId": leader["binding"]["hostId"],
                    "threadId": leader["binding"]["threadId"],
                }
            ):
                _fail("REGISTRY_CORRUPT", "Stored operation actor is not the active Manager")

            if action == "register_member":
                binding = (request["target_host_id"], request["target_thread_id"])
                if request["member_id"] in member_ids or binding in bindings:
                    _fail("REGISTRY_CORRUPT", "Stored registration reuses an identity")
                member = {
                    "id": request["member_id"],
                    "name": request["name"],
                    "role": request["role"],
                    "binding": {
                        "hostId": request["target_host_id"],
                        "threadId": request["target_thread_id"],
                        "revision": 1,
                    },
                    "lifecycle": "active",
                    "onboarding": {
                        "status": "pending", "evidenceRef": None,
                        "confirmedReceipt": None,
                    },
                    "authorizationRef": request["authorization_ref"],
                    "consentRef": request.get("consent_ref"),
                }
                team["members"].append(member)
                member_ids.add(member["id"])
                bindings.add(binding)
            else:
                member = next(
                    (candidate for candidate in team["members"]
                     if candidate["id"] == request["member_id"]),
                    None,
                )
                if member is None or member["lifecycle"] != "active":
                    _fail("REGISTRY_CORRUPT", "Stored operation targets no active member")
                if action == "confirm_ready":
                    member["onboarding"] = {
                        "status": "ready",
                        "evidenceRef": request["evidence_ref"],
                        "confirmedReceipt": request["receipt"],
                    }
                else:
                    member["lifecycle"] = "exited"

            team["revision"] += 1
            if result["teamRevision"] != team["revision"]:
                _fail("REGISTRY_CORRUPT", "Stored result violates team revision history")

        if reconstructed != registry["teams"]:
            _fail("REGISTRY_CORRUPT", "Stored operations do not reconstruct persisted teams")

    def _validate_team(
        self,
        team: Any,
        team_ids: set[str],
        member_ids: set[str],
        bindings: set[tuple[str, str]],
        schema: int,
    ) -> None:
        fields = {"id", "name", "revision", "leaderMemberId", "members"}
        if schema == 3 and isinstance(team, dict) and "runtime" in team:
            fields.add("runtime")
        if not isinstance(team, dict) or set(team) != fields:
            _fail("REGISTRY_CORRUPT", "Invalid team record shape")
        if schema == 2 and "runtime" in team:
            _fail("REGISTRY_CORRUPT", "Schema-2 team cannot contain a runtime link")
        team_id = _identifier(team["id"], "team.id", "REGISTRY_CORRUPT")
        if team_id in team_ids:
            _fail("REGISTRY_CORRUPT", "Duplicate team id")
        team_ids.add(team_id)
        _text(team["name"], "team.name", code="REGISTRY_CORRUPT")
        if not _is_integer(team["revision"], 1) or not isinstance(team["members"], list):
            _fail("REGISTRY_CORRUPT", "Invalid team revision or members")
        leader_id = _identifier(team["leaderMemberId"], "leaderMemberId", "REGISTRY_CORRUPT")
        managers = 0
        liaisons = 0
        leader_found = False
        for member in team["members"]:
            if not isinstance(member, dict) or set(member) != {
                "id", "name", "role", "binding", "lifecycle", "onboarding",
                "authorizationRef", "consentRef",
            }:
                _fail("REGISTRY_CORRUPT", "Invalid member record shape")
            member_id = _identifier(member["id"], "member.id", "REGISTRY_CORRUPT")
            if member_id in member_ids:
                _fail("REGISTRY_CORRUPT", "Duplicate member id")
            member_ids.add(member_id)
            _text(member["name"], "member.name", code="REGISTRY_CORRUPT")
            if (
                not isinstance(member["role"], str)
                or member["role"] not in _ROLES
                or not isinstance(member["lifecycle"], str)
                or member["lifecycle"] not in _LIFECYCLES
            ):
                _fail("REGISTRY_CORRUPT", "Invalid member role or lifecycle")
            managers += member["role"] == "Manager"
            liaisons += member["role"] == "Liaison"
            if member_id == leader_id:
                leader_found = member["role"] == "Manager"
            binding = member["binding"]
            if not isinstance(binding, dict) or set(binding) != {"hostId", "threadId", "revision"}:
                _fail("REGISTRY_CORRUPT", "Invalid member binding shape")
            host, thread = _caller_stored(binding["hostId"], binding["threadId"], "REGISTRY_CORRUPT")
            if not _is_integer(binding["revision"], 1) or (host, thread) in bindings:
                _fail("REGISTRY_CORRUPT", "Invalid or duplicate member binding")
            bindings.add((host, thread))
            onboarding = member["onboarding"]
            if not isinstance(onboarding, dict) or set(onboarding) != {
                "status", "evidenceRef", "confirmedReceipt"
            }:
                _fail("REGISTRY_CORRUPT", "Invalid onboarding record shape")
            if not isinstance(onboarding["status"], str) or onboarding["status"] not in _ONBOARDING:
                _fail("REGISTRY_CORRUPT", "Invalid onboarding status")
            evidence = onboarding["evidenceRef"]
            confirmed_receipt = onboarding["confirmedReceipt"]
            if onboarding["status"] == "pending" and (
                evidence is not None or confirmed_receipt is not None
            ):
                _fail("REGISTRY_CORRUPT", "Pending onboarding cannot contain confirmation data")
            if onboarding["status"] == "ready":
                _text(evidence, "evidenceRef", maximum=2048, code="REGISTRY_CORRUPT")
                _text(confirmed_receipt, "confirmedReceipt", maximum=256,
                      code="REGISTRY_CORRUPT")
                if re.fullmatch(r"v2:[0-9a-f]{64}", confirmed_receipt) is None:
                    _fail("REGISTRY_CORRUPT", "confirmedReceipt has an invalid format")
            _text(member["authorizationRef"], "authorizationRef", maximum=2048,
                  code="REGISTRY_CORRUPT")
            consent = member["consentRef"]
            if member["role"] == "Liaison":
                _text(consent, "consentRef", maximum=2048, code="REGISTRY_CORRUPT")
            elif consent is not None:
                _fail("REGISTRY_CORRUPT", "Only Liaison records may contain consentRef")
        if managers != 1 or liaisons > 1 or not leader_found:
            _fail("REGISTRY_CORRUPT", "Team requires one exact Manager leader and at most one Liaison")
        if "runtime" in team:
            runtime = team["runtime"]
            if not isinstance(runtime, dict) or set(runtime) != {
                "statePath", "migrationId", "sourceVersion", "sourceSha256"
            }:
                _fail("REGISTRY_CORRUPT", "Invalid runtime link shape")
            path = runtime["statePath"]
            if not isinstance(path, str) or not Path(path).is_absolute() or Path(path) != Path(path).resolve():
                _fail("REGISTRY_CORRUPT", "Runtime statePath must be absolute and canonical")
            _identifier(runtime["migrationId"], "runtime.migrationId", "REGISTRY_CORRUPT")
            if not _is_integer(runtime["sourceVersion"], 0):
                _fail("REGISTRY_CORRUPT", "Invalid runtime sourceVersion")
            if not isinstance(runtime["sourceSha256"], str) or re.fullmatch(r"[0-9a-f]{64}", runtime["sourceSha256"]) is None:
                _fail("REGISTRY_CORRUPT", "Invalid runtime sourceSha256")

    def _validate_operation(self, operation: Any, seen: set[str]) -> None:
        if not isinstance(operation, dict) or set(operation) != {
            "operationId", "actor", "request", "result"
        }:
            _fail("REGISTRY_CORRUPT", "Invalid operation record shape")
        operation_id = _identifier(operation["operationId"], "operationId", "REGISTRY_CORRUPT")
        if operation_id in seen:
            _fail("REGISTRY_CORRUPT", "Duplicate operation id")
        seen.add(operation_id)
        actor = operation["actor"]
        if not isinstance(actor, dict) or set(actor) != {"hostId", "threadId"}:
            _fail("REGISTRY_CORRUPT", "Invalid operation actor shape")
        _caller_stored(actor["hostId"], actor["threadId"], "REGISTRY_CORRUPT")
        request = operation["request"]
        if (
            not isinstance(request, dict)
            or not isinstance(request.get("action"), str)
            or request["action"] not in _REQUEST_FIELDS
        ):
            _fail("REGISTRY_CORRUPT", "Invalid stored request")
        self._validate_request(request, request["action"], stored=True)
        if request["operation_id"] != operation_id:
            _fail("REGISTRY_CORRUPT", "Stored operation ids disagree")
        result = operation["result"]
        if not isinstance(result, dict) or set(result) != {
            "operationId", "teamId", "teamRevision", "memberId", "outcome"
        }:
            _fail("REGISTRY_CORRUPT", "Invalid operation result shape")
        if result["operationId"] != operation_id:
            _fail("REGISTRY_CORRUPT", "Stored result operation id disagrees")
        _identifier(result["teamId"], "result.teamId", "REGISTRY_CORRUPT")
        _identifier(result["memberId"], "result.memberId", "REGISTRY_CORRUPT")
        if (
            not _is_integer(result["teamRevision"], 1)
            or not isinstance(result["outcome"], str)
            or result["outcome"] not in {"bootstrapped", "registered", "ready", "exited", "adopted"}
        ):
            _fail("REGISTRY_CORRUPT", "Invalid stored operation result")
        expected_outcome = {
            "bootstrap": "bootstrapped",
            "register_member": "registered",
            "confirm_ready": "ready",
            "exit_member": "exited",
            "adopt_legacy": "adopted",
        }[request["action"]]
        if (
            result["teamId"] != request["team_id"]
            or result["memberId"] != request["member_id"]
            or result["outcome"] != expected_outcome
        ):
            _fail("REGISTRY_CORRUPT", "Stored request and result relationships disagree")

    def _export_from_validated(self, registry: dict[str, Any], team_id: str) -> dict[str, Any]:
        team = self._team(registry, team_id)
        runtime = team.get("runtime")
        if runtime is None:
            _fail("TEAM_NOT_LINKED", "Team has no linked runtime")
        leader = self._member(team, team["leaderMemberId"])
        members = [{
            "id": member["id"], "name": member["name"], "role": member["role"],
            "lifecycle": member["lifecycle"],
            "binding": {"status": "bound", "hostId": member["binding"]["hostId"],
                        "threadId": member["binding"]["threadId"]},
        } for member in team["members"]]
        ready = [member["id"] for member in team["members"]
                 if member["lifecycle"] == "active"
                 and self._effective_onboarding_status(registry, team, member, leader) == "ready"]
        return {"registryId": registry["registryId"], "teamId": team["id"],
                "teamRevision": team["revision"], "migrationId": runtime["migrationId"],
                "statePath": runtime["statePath"], "members": members,
                "readyMemberIds": ready}

    def _validate_link_state(
        self, registry: dict[str, Any], team: dict[str, Any], state: dict[str, Any]
    ) -> None:
        link = state.get("registry")
        runtime = team["runtime"]
        if (
            state.get("schemaVersion") != 2 or not isinstance(link, dict)
            or link.get("registryId") != registry["registryId"]
            or Path(link.get("registryPath", "")).resolve() != self.registry_path.resolve()
            or link.get("teamId") != team["id"]
            or link.get("migrationId") != runtime["migrationId"]
            or link.get("sourceVersion") != runtime["sourceVersion"]
            or link.get("sourceSha256") != runtime["sourceSha256"]
            or link.get("phase") not in {"prepared", "active"}
            or not _is_integer(link.get("teamRevision"), 0)
            or link["teamRevision"] > team["revision"]
        ):
            _fail("RUNTIME_LINK_MISMATCH", "Linked state does not match Registry authority")


def _caller_stored(host_id: Any, thread_id: Any, code: str) -> tuple[str, str]:
    host = _identifier(host_id, "hostId", code)
    thread = _identifier(thread_id, "threadId", code)
    if thread.startswith(("pending:", "client-new-thread:")):
        _fail(code, "Stored threadId must identify an existing task")
    return host, thread


def _result(request: dict[str, Any], revision: int, outcome: str) -> dict[str, Any]:
    return {
        "operationId": request["operation_id"],
        "teamId": request["team_id"],
        "teamRevision": revision,
        "memberId": request["member_id"],
        "outcome": outcome,
    }


def copy_json(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
