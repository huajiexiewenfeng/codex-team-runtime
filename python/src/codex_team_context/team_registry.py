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
    def __init__(self, *, registry_path: str | os.PathLike[str]) -> None:
        self.registry_path = Path(registry_path)
        self._store = RegistryStore(self.registry_path)

    def read(self, host_id: str, thread_id: str) -> dict[str, Any] | None:
        host_id, thread_id = _caller(host_id, thread_id)
        registry = self._validated(self._store.read())
        located = self._member_by_identity(registry, host_id, thread_id)
        if located is None:
            return None
        team, member = located
        return self._capsule(registry, team, member)

    def manage(
        self, actor_host_id: str, actor_thread_id: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        actor_host_id, actor_thread_id = _caller(actor_host_id, actor_thread_id)
        action, operation_id = self._request_header(request)
        # Validate all revision-independent structure and scalar types before
        # replay comparison.  In particular, JSON booleans/floats must not be
        # accepted as the integer in a historical request by Python equality.
        self._validate_request(request, action)

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

        return self._store.transact(mutation)

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
        self, registry: dict[str, Any], team: dict[str, Any], member: dict[str, Any]
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
            "registrySchemaVersion": REGISTRY_SCHEMA_VERSION,
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
            _fail("REGISTRY_CORRUPT", "Registry root fields do not match schema v2")
        if value["schemaVersion"] != REGISTRY_SCHEMA_VERSION or isinstance(value["schemaVersion"], bool):
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
            self._validate_team(team, team_ids, member_ids, bindings)
        operation_ids: set[str] = set()
        for operation in value["operations"]:
            self._validate_operation(operation, operation_ids)
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
    ) -> None:
        if not isinstance(team, dict) or set(team) != {
            "id", "name", "revision", "leaderMemberId", "members"
        }:
            _fail("REGISTRY_CORRUPT", "Invalid team record shape")
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
            or result["outcome"] not in {"bootstrapped", "registered", "ready", "exited"}
        ):
            _fail("REGISTRY_CORRUPT", "Invalid stored operation result")
        expected_outcome = {
            "bootstrap": "bootstrapped",
            "register_member": "registered",
            "confirm_ready": "ready",
            "exit_member": "exited",
        }[request["action"]]
        if (
            result["teamId"] != request["team_id"]
            or result["memberId"] != request["member_id"]
            or result["outcome"] != expected_outcome
        ):
            _fail("REGISTRY_CORRUPT", "Stored request and result relationships disagree")


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
