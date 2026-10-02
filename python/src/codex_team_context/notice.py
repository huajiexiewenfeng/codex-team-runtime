"""E03 admission and fixed bridge. Never invokes native messaging tools."""
from __future__ import annotations

import json
import os
import re
import sys
import uuid
from pathlib import Path
from typing import Any

from .core import ContextError
from .runtime_link import canonical_absolute
from .team_registry import TeamRegistry
from .notice_process import invoke_notice_process

MAX_BYTES = 1024 * 1024
COMMON = {"actor_host_id", "actor_thread_id", "team_id", "task_id", "submission_id", "reason"}
ADDITIONAL = {"prepare": {"operation_id", "baseline"}, "result": {"operation_id", "attempt_id", "result"}, "status": {"prepare_operation_id", "attempt_id", "include_content"}}
REQUIRED = {"prepare": {"operation_id"}, "result": {"operation_id", "attempt_id", "result"}, "status": set()}
REASONS = {"onboarding", "resume", "post_compaction", "before_dispatch", "before_delivery", "before_review", "identity_conflict", "manual", "unknown"}

def _fail(code: str, message: str) -> None:
    raise ContextError(code, message)

def strict_json(raw: str) -> Any:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid number")))

def validate_request(request: Any) -> bytes:
    if not isinstance(request, dict) or request.get("action") not in ADDITIONAL:
        _fail("INVALID_REQUEST", "Unknown notice action")
    action = request["action"]
    if not COMMON | REQUIRED[action] <= request.keys() or not request.keys() <= COMMON | ADDITIONAL[action] | {"action"}:
        _fail("INVALID_REQUEST", "Notice fields do not match action schema")
    for field in COMMON | ({"attempt_id"} & request.keys()):
        value = request[field]
        if not isinstance(value, str) or not value.strip() or len(value) > 256:
            _fail("INVALID_REQUEST", f"Invalid {field}")
    for field in {"operation_id", "prepare_operation_id"} & request.keys():
        value = request[field]
        if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is None:
            _fail("INVALID_REQUEST", f"Invalid {field}")
    if request["reason"] not in REASONS:
        _fail("INVALID_REQUEST", "Invalid reason")
    if "include_content" in request and type(request["include_content"]) is not bool:
        _fail("INVALID_REQUEST", "include_content must be boolean")
    for field in {"baseline", "result"} & request.keys():
        value = request[field]
        if not isinstance(value, dict) or set(value) != {"outcome", "evidence"}:
            _fail("INVALID_REQUEST", f"Invalid {field}")
    try:
        payload = json.dumps(request, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8", errors="strict")
    except (ValueError, TypeError, UnicodeError):
        _fail("INVALID_REQUEST", "Request must contain valid JSON and Unicode")
    if len(payload) > MAX_BYTES:
        _fail("PAYLOAD_TOO_LARGE", "E03 request exceeds 1 MiB")
    return payload

class NoticeService:
    def __init__(self, registry: TeamRegistry, runtime_revision: str | None = None):
        self.registry = registry
        self.runtime_revision = runtime_revision or "unversioned"

    def handle(self, request: dict) -> dict:
        validate_request(request)
        # No Registry lock spans the subprocess. Node revalidates under its guard.
        value = self.registry._validated(self.registry._store.read())
        located = self.registry._member_by_identity(value, request["actor_host_id"], request["actor_thread_id"])
        if located is None:
            _fail("UNREGISTERED", "Caller is not registered")
        team, member = located
        if team["id"] != request["team_id"] or member["lifecycle"] != "active":
            _fail("IDENTITY_CONFLICT", "Caller/team membership mismatch")
        if member["role"] not in ({"Worker"} if request["action"] == "prepare" else {"Worker", "Manager"}):
            _fail("IDENTITY_CONFLICT", "Caller role cannot perform this action")
        leader = self.registry._member(team, team["leaderMemberId"])
        if self.registry._effective_onboarding_status(value, team, member, leader) != "ready":
            _fail("TEAM_NOT_CONNECTED", "Caller onboarding is not current")
        runtime = team.get("runtime")
        if not runtime:
            _fail("TEAM_NOT_CONNECTED", "Team has no linked runtime")
        node, root = self.registry._trusted_runtime()
        state = canonical_absolute(runtime["statePath"], "statePath")
        adapter = root / "src" / "notice-adapter.mjs"
        if not adapter.is_file():
            _fail("RUNTIME_UNAVAILABLE", "E03 adapter is not installed in the configured runtime")
        token = uuid.uuid4().hex
        envelope = {"statePath": str(state), "registryPath": str(self.registry.registry_path), "request": request,
                    "runtimeRevision": self.runtime_revision, "executionToken": token}
        payload = json.dumps(envelope, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_BYTES:
            _fail("PAYLOAD_TOO_LARGE", "Wrapped bridge request exceeds 1 MiB")
        env = os.environ.copy()
        env["CODEX_TEAM_CONTEXT_PYTHON"] = str(Path(sys.executable).resolve())
        paths = {str(self.registry.registry_path) + ".lock", str(state) + ".lock", str(state) + ".submission-notices.json.lock"}
        return invoke_notice_process([str(node), str(adapter)], payload, env, token, paths, read_only=request["action"] == "status")
