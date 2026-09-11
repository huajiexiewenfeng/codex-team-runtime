"""Durable candidate identities, never a membership or native creation service."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .core import ContextError
from .registry_store import RegistryStore
from .runtime_link import canonical_absolute, invoke_adapter, read_state, state_locked
from .team_registry import TeamRegistry, _caller, _fail, _identifier, _text, copy_json


_FIELDS = {
    "prepare": {"team_id", "member_id", "role", "target_host_id", "state_path", "authorization_ref"},
    "claim": set(),
    "record_creation": {"result", "evidence_ref"},
    "receipt": {"team_id", "member_id", "role", "evidence_ref"},
    "verify": {"receipt_id", "evidence_ref"},
    "plan": set(),
}


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    allow_nan=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _identity(value: dict) -> tuple[str, str]:
    return value["hostId"], value["threadId"]


def _request(value: Any) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("action"), str):
        _fail("INVALID_REQUEST", "startup request must contain an action")
    action = value["action"]
    if value == {"action": "plan"}:
        return action
    if action not in _FIELDS or set(value) != _FIELDS[action] | {"action", "operation_id"}:
        _fail("INVALID_REQUEST", "startup action fields must match its exact schema")
    _identifier(value["operation_id"], "operation_id", "INVALID_REQUEST")
    for field in ("team_id", "member_id", "target_host_id"):
        if field in value:
            _identifier(value[field], field, "INVALID_REQUEST")
    if "role" in value and value["role"] not in ("Worker", "Liaison"):
        _fail("SLOT_MISMATCH", "Startup slots may only be Worker or Liaison")
    for field in ("authorization_ref", "evidence_ref"):
        if field in value:
            _text(value[field], field, maximum=2048, code="INVALID_REQUEST")
    if action == "prepare":
        _text(value["state_path"], "state_path", maximum=4096, code="INVALID_REQUEST")
        canonical_absolute(value["state_path"], "state_path")
    if action == "verify":
        digest = value["receipt_id"]
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            _fail("INVALID_REQUEST", "receipt_id must be a SHA-256 identity reference")
    if action == "record_creation":
        result = value["result"]
        if not isinstance(result, dict) or set(result) not in (
            {"hostId", "threadId"}, {"hostId", "clientThreadId"}
        ):
            _fail("INVALID_REQUEST", "Preserve one exact native formal or pending creation identity")
        _identifier(result["hostId"], "hostId", "INVALID_REQUEST")
        if "threadId" in result:
            _caller(result["hostId"], result["threadId"])
        else:
            _text(result["clientThreadId"], "clientThreadId", maximum=256, code="INVALID_REQUEST")
            if not result["clientThreadId"].startswith("client-new-thread:"):
                _fail("INVALID_REQUEST", "Unsupported pending native creation identity")
    return action


class StartupLedger:
    """Fixed Registry-side journal. All callers/evidence remain externally verified.

    Lock order is Registry -> startup journal -> original state. The existing
    Registry mutations also lock Registry first, so roster checks and writes do
    not race. No startup action writes Registry or Node business state.
    """

    def __init__(self, registry: TeamRegistry):
        self.registry = registry
        self._store = RegistryStore(Path(f"{registry.registry_path}.startup.json"))
        self._claims_path = Path(f"{registry.registry_path}.startup-claims")

    @staticmethod
    def _guard(registry: dict, op: dict) -> dict:
        return {"registryId": registry["registryId"], "request": op["request"],
                "manager": op["manager"], "teamDigest": op["teamDigest"], "sourceVersion": op["sourceVersion"]}

    @staticmethod
    def _guard_name(value: dict) -> str:
        return _digest([value["registryId"], value["request"]["team_id"], value["request"]["member_id"]]) + ".json"

    def _guards(self, registry: dict) -> dict:
        """Inspect only this service's fixed, write-once claim directory."""
        try:
            entries = list(self._claims_path.iterdir())
        except FileNotFoundError:
            return {}
        except OSError as exc:
            _fail("STARTUP_GUARD_CORRUPT", f"Cannot inspect creation guards: {exc}")
        guards = {}
        try:
            for path in entries:
                value = json.loads(path.read_text(encoding="utf-8"))
                if (not isinstance(value, dict) or set(value) != {"registryId", "request", "manager", "teamDigest", "sourceVersion"}
                    or value["registryId"] != registry["registryId"] or _request(value["request"]) != "prepare"
                    or path.name != self._guard_name(value)):
                    raise ValueError("creation guard scope/filename mismatch")
                operation_id = value["request"]["operation_id"]
                if operation_id in guards:
                    raise ValueError("duplicate guarded operation")
                guards[operation_id] = value
        except (OSError, UnicodeError, ValueError, TypeError, KeyError, ContextError) as exc:
            _fail("STARTUP_GUARD_CORRUPT", f"Invalid creation guard: {exc}")
        return guards

    def _claim_guard(self, registry: dict, op: dict) -> bool:
        value = self._guard(registry, op)
        path = self._claims_path / self._guard_name(value)
        try:
            self._claims_path.mkdir(exist_ok=True)
            # Exclusive creation is intentional. A partial file on crash is
            # retained and fails closed; it is never overwritten or cleaned up.
            with path.open("x", encoding="utf-8", newline="\n") as stream:
                json.dump(value, stream, ensure_ascii=False, allow_nan=False, sort_keys=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            return True
        except FileExistsError:
            guards = self._guards(registry)
            if guards.get(op["request"]["operation_id"]) != value:
                _fail("STARTUP_LEDGER_MISMATCH", "Existing claim belongs to another original operation")
            return False
        except (OSError, UnicodeError, ValueError, TypeError) as exc:
            _fail("STARTUP_GUARD_WRITE_FAILED", f"Cannot persist creation guard: {exc}")

    def _load(self, registry: dict, *, allow_missing: bool) -> dict:
        guards = self._guards(registry)
        try:
            value = self._store.read()
        except ContextError as exc:
            if exc.code == "REGISTRY_MISSING" and guards:
                _fail("STARTUP_LEDGER_MISSING", "Creation guards exist; recover the original startup ledger")
            if exc.code != "REGISTRY_MISSING" or not allow_missing:
                raise
            return {"schemaVersion": 1, "registryId": registry["registryId"], "operations": []}
        try:
            if (set(value) != {"schemaVersion", "registryId", "operations"}
                or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
                or value["registryId"] != registry["registryId"] or not isinstance(value["operations"], list)):
                raise ValueError("startup root or Registry identity mismatch")
            ids, slots = set(), set()
            for op in value["operations"]:
                if set(op) != {"request", "manager", "teamDigest", "sourceVersion", "claimed", "creation", "candidates", "verified"}:
                    raise ValueError("startup operation fields mismatch")
                req = op["request"]
                if _request(req) != "prepare":
                    raise ValueError("missing original prepare request")
                key = req["team_id"], req["member_id"]
                if req["operation_id"] in ids or key in slots:
                    raise ValueError("duplicate operation or member slot")
                ids.add(req["operation_id"])
                slots.add(key)
                if set(op["manager"]) != {"memberId", "hostId", "threadId"}:
                    raise ValueError("invalid Manager reference")
                _caller(*_identity(op["manager"]))
                _identifier(op["manager"]["memberId"], "memberId", "INVALID_REQUEST")
                if (type(op["claimed"]) is not bool or type(op["sourceVersion"]) is not int
                    or op["sourceVersion"] < 0 or not isinstance(op["teamDigest"], str) or len(op["teamDigest"]) != 64):
                    raise ValueError("invalid creation claim/source reference")
                creation = op["creation"]
                if creation is not None:
                    _request({"action": "record_creation", "operation_id": req["operation_id"], **creation})
                    if not op["claimed"] or creation["result"]["hostId"] != req["target_host_id"]:
                        raise ValueError("creation does not match claimed slot")
                if not isinstance(op["candidates"], list) or len(op["candidates"]) > 16:
                    raise ValueError("invalid candidate list")
                seen = set()
                for candidate in op["candidates"]:
                    if set(candidate) != {"receiptId", "operationId", "teamId", "memberId", "role", "hostId", "threadId", "evidenceRef"}:
                        raise ValueError("invalid candidate fields")
                    _caller(*_identity(candidate))
                    _text(candidate["evidenceRef"], "evidenceRef", maximum=2048, code="INVALID_REQUEST")
                    expected = self._candidate(op, *_identity(candidate), candidate["evidenceRef"])
                    if candidate != expected or candidate["receiptId"] in seen or not op["claimed"]:
                        raise ValueError("invalid candidate scope or duplicate receipt")
                    seen.add(candidate["receiptId"])
                if op["verified"] is not None:
                    selected = op["verified"]
                    if set(selected) != {"receiptId", "evidenceRef"} or selected["receiptId"] not in seen:
                        raise ValueError("verification has no matching candidate")
                    _text(selected["evidenceRef"], "evidenceRef", maximum=2048, code="INVALID_REQUEST")
                    candidate = next(c for c in op["candidates"] if c["receiptId"] == selected["receiptId"])
                    if creation is not None and "threadId" in creation["result"] and _identity(candidate) != _identity(creation["result"]):
                        raise ValueError("verified candidate conflicts with native creation record")
        except (ContextError, TypeError, KeyError, ValueError) as exc:
            _fail("REGISTRY_CORRUPT", f"Invalid startup ledger: {exc}")
        operations = {op["request"]["operation_id"]: op for op in value["operations"]}
        for operation_id, guard in guards.items():
            op = operations.get(operation_id)
            if op is None or guard != self._guard(registry, op):
                _fail("STARTUP_LEDGER_MISMATCH", "Startup ledger lost or changed a guarded original operation")
            # An older valid pre-claim sidecar cannot restore a creation grant.
            # This is an in-memory projection; a plan does not rewrite the file.
            op["claimed"] = True
        if any(op["claimed"] and key not in guards for key, op in operations.items()):
            _fail("STARTUP_GUARD_MISSING", "Claimed operation has lost its original creation guard")
        return value

    def _source(self, registry: dict, request: dict, actor: tuple[str, str], op: dict | None = None):
        node, root = self.registry._trusted_runtime()
        path = canonical_absolute(request["state_path"], "state_path")
        _, state = read_state(path)
        invoke_adapter(node, root, {"action": "inspect", "state": state})
        if state["team"]["id"] != request["team_id"]:
            _fail("SLOT_MISMATCH", "Original state has another team identity")
        if op is not None and (_digest(state["team"]) != op["teamDigest"] or state["version"] < op["sourceVersion"]):
            _fail("SOURCE_MISMATCH", "Original team reference or minimum state version changed")
        team = next((t for t in registry["teams"] if t["id"] == request["team_id"]), None)
        if team is not None:
            runtime = team.get("runtime")
            if runtime is None or Path(runtime["statePath"]).resolve() != path:
                _fail("RUNTIME_LINK_MISMATCH", "Registered team is not linked to this original state")
            self.registry._validate_link_state(registry, team, state)
            manager = self.registry._require_manager(team, *actor)
            members = team["members"]
        else:
            if self.registry._member_by_identity(registry, *actor) is not None:
                _fail("MANAGER_REQUIRED", "Manager identity already belongs to another Registry team")
            if state["schemaVersion"] == 2:
                link = state["registry"]
                if (link["phase"] != "prepared" or link["registryId"] != registry["registryId"]
                    or Path(link["registryPath"]).resolve() != self.registry.registry_path):
                    _fail("RUNTIME_LINK_MISMATCH", "Missing or conflicting linked Registry authority")
            members = state["members"]
            manager = next((m for m in members if m["role"] == "Manager"), None)
            if (manager is None or manager["lifecycle"] != "active"
                or manager["binding"].get("status") != "bound" or _identity(manager["binding"]) != actor):
                _fail("MANAGER_REQUIRED", "Exact original active Manager is required")
        leader = {"memberId": manager["id"], "hostId": actor[0], "threadId": actor[1]}
        if op is not None and op["manager"] != leader:
            _fail("MANAGER_REQUIRED", "Original startup leader has changed")
        return state, team, members, leader

    @staticmethod
    def _candidate(op: dict, host: str, thread: str, evidence: str) -> dict:
        req = op["request"]
        if host != req["target_host_id"]:
            _fail("SLOT_MISMATCH", "Candidate is on another host")
        value = {"operationId": req["operation_id"], "teamId": req["team_id"],
                 "memberId": req["member_id"], "role": req["role"], "hostId": host, "threadId": thread}
        return {"receiptId": _digest(value), **value, "evidenceRef": evidence}

    @staticmethod
    def _member(op: dict, members: list) -> dict | None:
        member = next((m for m in members if m["id"] == op["request"]["member_id"]), None)
        if member is not None and member["role"] != op["request"]["role"]:
            _fail("SLOT_MISMATCH", "Formal member role conflicts with startup slot")
        return member

    def _plan(self, op: dict, registry: dict, state: dict, team: dict | None, members: list, operations: list) -> dict:
        member = self._member(op, members)
        selected = next((c for c in op["candidates"] if op["verified"] and c["receiptId"] == op["verified"]["receiptId"]), None)
        stage, next_action = "prepared", "claim_creation"
        if member is not None and member["lifecycle"] != "active":
            stage = next_action = "member_inactive"
        elif state.get("registry", {}).get("phase") == "prepared":
            stage, next_action = "migration_pending", "resume_original_adoption"
        elif not op["claimed"]:
            if member is not None and "threadId" in member["binding"]:
                stage, next_action = "identity_conflict", "reconcile_existing_member"
        elif selected is None:
            stage = "verify_identity" if op["candidates"] else "waiting_receipt"
            next_action = "read_exact_native_candidate" if op["candidates"] else "reconcile_original_creation"
        elif member is not None and "threadId" in member["binding"] and _identity(member["binding"]) != _identity(selected):
            stage, next_action = "identity_conflict", "reconcile_existing_member"
        elif member is None or "threadId" not in member["binding"]:
            stage = "pair_liaison" if op["request"]["role"] == "Liaison" and team is None else "register_member"
            next_action = "real_two_sided_attach" if stage == "pair_liaison" else "manager_register_verified_member"
        elif team is None:
            invitation = state.get("session", {}).get("invitation")
            liaison = next((m for m in members if m["role"] == "Liaison" and m["lifecycle"] == "active"), None)
            paired = (liaison is not None and "threadId" in liaison["binding"] and invitation is not None
                      and invitation.get("confirmedAt") is not None and _identity(invitation["target"]) == _identity(liaison["binding"]))
            pending_slots = []
            for other in operations:
                if other["request"]["state_path"] != op["request"]["state_path"]:
                    continue
                target = self._member(other, members)
                verified = next((c for c in other["candidates"] if other["verified"] and c["receiptId"] == other["verified"]["receiptId"]), None)
                if (target is None or target["lifecycle"] != "active" or "threadId" not in target["binding"]
                    or verified is None or _identity(target["binding"]) != _identity(verified)):
                    pending_slots.append(other["request"]["member_id"])
            if pending_slots:
                stage, next_action = "complete_team", "finish_all_original_startup_slots"
            elif not paired or any("threadId" not in m["binding"] for m in members):
                stage, next_action = "complete_pairing", "finish_original_roster_and_consent"
            else:
                stage, next_action = "adopt_legacy", "adopt_original_state_with_current_evidence"
        else:
            leader = self.registry._member(team, team["leaderMemberId"])
            pending = [m["id"] for m in members if m["lifecycle"] == "active"
                       and self.registry._effective_onboarding_status(registry, team, m, leader) != "ready"]
            stage = "confirm_readiness" if pending else "ready_for_admission"
            next_action = "own_reads_then_manager_confirm" if pending else "check_normal_dispatch_gates"
        return copy_json({"operationId": op["request"]["operation_id"], "teamId": op["request"]["team_id"],
                          "memberId": op["request"]["member_id"], "role": op["request"]["role"],
                          "statePath": op["request"]["state_path"], "manager": op["manager"],
                          "stage": stage, "nextAction": next_action, "stateVersion": state["version"],
                          "creation": op["creation"], "candidates": op["candidates"], "verified": op["verified"],
                          "identityAssurance": "caller-declared", "dispatchAllowed": False})

    def handle(self, host_id: str, thread_id: str, request: dict) -> dict:
        actor, action = _caller(host_id, thread_id), _request(request)
        self.registry._trusted_runtime()
        with self.registry._store.locked(), self._store.locked():
            registry = self.registry._validated(self.registry._store.read())
            ledger = self._load(registry, allow_missing=action in {"prepare", "plan"})
            if request == {"action": "plan"}:
                plans = []
                for op in ledger["operations"]:
                    if _identity(op["manager"]) == actor:
                        with state_locked(Path(op["request"]["state_path"])):
                            state, team, members, _ = self._source(registry, op["request"], actor, op)
                            plans.append(self._plan(op, registry, state, team, members, ledger["operations"]))
                return {"operations": plans}
            op = next((x for x in ledger["operations"] if x["request"]["operation_id"] == request["operation_id"]), None)
            if op is None and action != "prepare":
                _fail("OPERATION_NOT_FOUND", "Startup operation is not recorded; do not recreate it")
            if op is not None and action != "receipt" and _identity(op["manager"]) != actor:
                _fail("MANAGER_REQUIRED", "Only the original Manager may maintain or inspect startup")
            if op is not None and action == "prepare" and op["request"] != request:
                _fail("OPERATION_CONFLICT", "Original startup request is immutable")
            original = request if op is None else op["request"]
            owner = actor if op is None else _identity(op["manager"])
            with state_locked(Path(original["state_path"])):
                state, team, members, leader = self._source(registry, original, owner, op)
                if op is None:
                    if any(x["request"]["team_id"] == request["team_id"] and x["request"]["member_id"] == request["member_id"] for x in ledger["operations"]):
                        _fail("SLOT_CONFLICT", "Member already has an original startup operation")
                    for t in registry["teams"]:
                        if any(m["id"] == request["member_id"] for m in t["members"]):
                            _fail("MEMBER_CONFLICT", "Reuse existing registered member; do not create it again")
                    for m in members:
                        if (m["id"] == request["member_id"] and (m["role"] != request["role"] or m["lifecycle"] != "active" or "threadId" in m["binding"])):
                            _fail("MEMBER_CONFLICT", "Reuse/reconcile the existing member")
                        if request["role"] == "Liaison" and m["role"] == "Liaison" and m["id"] != request["member_id"]:
                            _fail("SLOT_CONFLICT", "Original Liaison slot already exists")
                    op = {"request": copy_json(request), "manager": leader, "teamDigest": _digest(state["team"]),
                          "sourceVersion": state["version"], "claimed": False, "creation": None, "candidates": [], "verified": None}
                    ledger["operations"].append(op)
                    self._store._replace(ledger)
                plan = self._plan(op, registry, state, team, members, ledger["operations"])
                if action in {"prepare", "plan"}:
                    return plan
                if plan["stage"] in {"member_inactive", "migration_pending", "identity_conflict"}:
                    _fail(plan["stage"].upper(), "Reconcile current authority before changing startup records")
                changed, result = False, None
                if action == "claim":
                    granted = False
                    if not op["claimed"]:
                        granted = self._claim_guard(registry, op)
                        op["claimed"], changed = True, True
                    result = {"operationId": original["operation_id"], "claimed": granted}
                else:
                    if not op["claimed"]:
                        _fail("CREATION_NOT_CLAIMED", "Record the one-shot claim before native creation")
                    if action == "record_creation":
                        incoming = {"result": request["result"], "evidence_ref": request["evidence_ref"]}
                        if incoming["result"]["hostId"] != original["target_host_id"]:
                            _fail("SLOT_MISMATCH", "Creation host differs from original slot")
                        if op["creation"] is not None and op["creation"] != incoming:
                            _fail("OPERATION_CONFLICT", "Original native creation result is immutable")
                        if op["verified"] is not None and "threadId" in incoming["result"]:
                            selected = next(c for c in op["candidates"] if c["receiptId"] == op["verified"]["receiptId"])
                            if _identity(selected) != _identity(incoming["result"]):
                                _fail("IDENTITY_CONFLICT", "Native result differs from verified receipt")
                        if op["creation"] is None:
                            op["creation"], changed = copy_json(incoming), True
                    elif action == "receipt":
                        if any(request[k] != original[k] for k in ("team_id", "member_id", "role")):
                            _fail("SLOT_MISMATCH", "Receipt must match original team/member/role")
                        candidate = self._candidate(op, *actor, request["evidence_ref"])
                        for m in members:
                            if "threadId" in m["binding"] and _identity(m["binding"]) == actor and m["id"] != original["member_id"]:
                                _fail("IDENTITY_CONFLICT", "Identity already belongs to another member")
                        existing = self.registry._member_by_identity(registry, *actor)
                        if existing is not None and (existing[0]["id"] != original["team_id"] or existing[1]["id"] != original["member_id"]):
                            _fail("IDENTITY_CONFLICT", "Identity already belongs to another Registry member")
                        if op["verified"] and op["verified"]["receiptId"] != candidate["receiptId"]:
                            _fail("IDENTITY_CONFLICT", "A different identity has already been verified")
                        previous = next((c for c in op["candidates"] if c["receiptId"] == candidate["receiptId"]), None)
                        if previous is not None and previous != candidate:
                            _fail("OPERATION_CONFLICT", "Original own receipt evidence is immutable")
                        if previous is None:
                            if len(op["candidates"]) >= 16:
                                _fail("RECEIPT_LIMIT", "Startup slot candidate limit reached; Manager reconciliation required")
                            op["candidates"].append(candidate)
                            changed = True
                        result = {"receiptId": candidate["receiptId"], "operationId": original["operation_id"],
                                  "outcome": "candidate_recorded", "registered": False, "identityAssurance": "caller-declared"}
                    elif action == "verify":
                        candidate = next((c for c in op["candidates"] if c["receiptId"] == request["receipt_id"]), None)
                        if candidate is None:
                            _fail("RECEIPT_NOT_FOUND", "Selected own startup receipt is missing")
                        incoming = {"receiptId": candidate["receiptId"], "evidenceRef": request["evidence_ref"]}
                        if op["verified"] is not None and op["verified"] != incoming:
                            _fail("IDENTITY_CONFLICT", "Verified identity/evidence cannot be replaced")
                        if op["creation"] is not None and "threadId" in op["creation"]["result"]:
                            if _identity(candidate) != _identity(op["creation"]["result"]):
                                _fail("IDENTITY_CONFLICT", "Selected receipt differs from native creation result")
                        member = self._member(op, members)
                        if member is not None and "threadId" in member["binding"] and _identity(member["binding"]) != _identity(candidate):
                            _fail("IDENTITY_CONFLICT", "Selected receipt differs from formal binding")
                        if op["verified"] is None:
                            op["verified"], changed = incoming, True
                if changed:
                    self._store._replace(ledger)
                return result if result is not None else self._plan(op, registry, state, team, members, ledger["operations"])
