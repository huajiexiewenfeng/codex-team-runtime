"""Optional bounded per-call observation files for registered team identities."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, TypeVar

from .core import ContextError


REASONS = (
    "onboarding", "resume", "post_compaction", "before_dispatch", "before_delivery",
    "before_review", "identity_conflict", "manual", "unknown",
)
_TOOLS = {"team_context.read", "team_context.manage", "team_context.startup"}
_OUTCOMES = {"matched", "inactive", "unmatched", "success", "error", "unexpected_error"}
_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
T = TypeVar("T")


def _fail(message: str) -> None:
    raise ContextError("INVALID_OBSERVATION_CONFIG", message)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _warn(code: str) -> None:
    try:
        print(code, file=sys.stderr)
    except Exception:
        pass


def configure_observations(
    *, root: str | os.PathLike[str] | None, observed_teams: list[str] | None,
    runtime_revision: str | None, registry_mode: bool,
) -> ObservationRecorder | None:
    configured = root is not None or observed_teams is not None or runtime_revision is not None
    if not configured:
        return None
    if not registry_mode:
        _fail("Observation collection requires --registry mode")
    if root is None or observed_teams is None or not observed_teams:
        _fail("observation_root and a nonempty observed_teams list must be configured together")
    target = Path(root)
    if not target.is_absolute():
        _fail("observation_root must be an absolute operator path")
    if any(not isinstance(team, str) or _ID.fullmatch(team) is None for team in observed_teams):
        _fail("observed_teams must contain valid exact team identifiers")
    if runtime_revision is not None and (
        not isinstance(runtime_revision, str) or not runtime_revision.strip()
        or len(runtime_revision) > 512
        or any(ord(character) < 32 or 0xD800 <= ord(character) <= 0xDFFF for character in runtime_revision)
    ):
        _fail("runtime_revision must be a bounded JSON-safe operator declaration")
    return ObservationRecorder(target, observed_teams, runtime_revision=runtime_revision)


class ObservationRecorder:
    def __init__(
        self, root: str | os.PathLike[str], observed_teams: list[str],
        runtime_revision: str | None = None,
    ) -> None:
        self.root = Path(root)
        self.observed_teams = frozenset(observed_teams)
        self.runtime_revision = runtime_revision

    @staticmethod
    def begin() -> tuple[str, int]:
        return _utc_now(), time.monotonic_ns()

    def record(
        self, started: tuple[str, int], identity: dict[str, Any], tool: str, reason: str,
        outcome: str, error_code: str | None,
    ) -> None:
        try:
            if identity["teamId"] not in self.observed_teams:
                return
            completed_at = _utc_now()
            event_id = str(uuid.uuid4())
            safe_error = (
                error_code if error_code is None or (
                    isinstance(error_code, str) and _ERROR_CODE.fullmatch(error_code)
                ) else "UNKNOWN_ERROR"
            )
            event = {
                "schemaVersion": 1,
                "eventId": event_id,
                "startedAt": started[0],
                "completedAt": completed_at,
                "durationMs": max(0, (time.monotonic_ns() - started[1]) // 1_000_000),
                "tool": tool,
                "registryId": identity["registryId"],
                "teamId": identity["teamId"],
                "memberId": identity["memberId"],
                "role": identity["role"],
                "hostId": identity["hostId"],
                "threadId": identity["threadId"],
                "memberStatus": identity["memberStatus"],
                "identitySource": identity["identitySource"],
                "reason": reason,
                "reasonSource": "unknown" if reason == "unknown" else "agent-declared",
                "outcome": outcome,
                "errorCode": safe_error,
                "policyRevision": identity["policyRevision"],
                "runtimeRevision": self.runtime_revision,
                "runtimeRevisionSource": "unknown" if self.runtime_revision is None else "operator-declared",
            }
            self._publish(event)
        except Exception:
            _warn("OBSERVATION_WRITE_FAILED")

    def _publish(self, event: dict[str, Any]) -> None:
        day = self.root / event["completedAt"][:10]
        day.mkdir(parents=True, exist_ok=True)
        target = day / f"{event['eventId']}.json"
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", dir=day,
                prefix=f".{event['eventId']}.", suffix=".tmp", delete=False,
            ) as stream:
                temporary = Path(stream.name)
                json.dump(event, stream, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.link(temporary, target)
        finally:
            if temporary is not None:
                try:
                    temporary.unlink()
                except (FileNotFoundError, OSError):
                    pass


def observed_call(
    recorder: ObservationRecorder | None,
    identity_provider: Callable[[], dict[str, Any] | None],
    tool: str,
    reason: str,
    operation: Callable[[], T],
    classify: Callable[[T], str],
) -> T:
    if recorder is None:
        return operation()
    if tool not in _TOOLS or reason not in REASONS:
        raise ContextError("INVALID_REQUEST", "Invalid observation tool or reason")
    try:
        started = recorder.begin()
    except Exception:
        _warn("OBSERVATION_WRITE_FAILED")
        return operation()
    try:
        identity = identity_provider()
    except Exception:
        _warn("OBSERVATION_IDENTITY_UNAVAILABLE")
        identity = None

    def safe_record(outcome: str, error_code: str | None) -> None:
        if identity is None:
            return
        try:
            recorder.record(started, identity, tool, reason, outcome, error_code)
        except Exception:
            _warn("OBSERVATION_WRITE_FAILED")

    try:
        result = operation()
    except ContextError as exc:
        safe_record("error", exc.code)
        raise
    except Exception:
        safe_record("unexpected_error", None)
        raise
    if identity is not None:
        try:
            outcome = classify(result)
            if outcome not in _OUTCOMES:
                raise ValueError("Invalid internal observation outcome")
            recorder.record(started, identity, tool, reason, outcome, None)
        except Exception:
            _warn("OBSERVATION_WRITE_FAILED")
    return result
