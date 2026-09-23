"""Fixed policy projection and deterministic onboarding receipts for registry v2."""

from __future__ import annotations

import hashlib
import json
from typing import Any


POLICY_REVISION = 2

SHARED_RULES = (
    "Recall this capsule at first onboarding and at foreground continuation or context loss.",
    "Recall it before role-dependent coordination and before delivery, receipt, or acceptance.",
    "Treat caller-declared identity separately from action authorization and external consent.",
    "The registry owns current team identity; a context read does not dispatch work or bypass runtime admission.",
    "Re-read context after membership, leader, rule, or onboarding conflicts.",
    "If the leader is exited or unavailable, retain the evidence, ask the user, never elect a replacement, and do not repeatedly message.",
)

ROLE_DUTIES = {
    "Manager": (
        "Maintain team and member registration from externally authorized facts.",
        "Assign implementation and delegated investigation, testing or review to a registered formal Worker through the authorized connected runtime; if busy, queue or select another authorized formal Worker.",
        "Manager must not create or direct temporary subagents (including spawn_agent), and must not directly implement business code; retain read-only inspection and authorized acceptance checks.",
        "Independently review evidence and accept or reject work.",
        "Verify onboarding replies for the exact registered member.",
    ),
    "Worker": (
        "Work only on this member's explicitly assigned authorized task.",
        "Worker may use authorized bounded temporary subagents within its assignment and model ceiling; retain delivery responsibility and never share its role identity with helpers.",
        "Durably submit only this member's own work and evidence.",
        "Use the existing submission-notice flow to notify the exact Manager.",
    ),
    "Liaison": (
        "Explain team progress and decisions; do not dispatch or command Workers.",
        "Liaison must not create or direct temporary subagents.",
        "Do not continue progress reporting after work closes.",
        "Keep the live-runtime two-sided pairing protocol separate from registry consent records.",
    ),
}


def onboarding_receipt(
    registry_id: str,
    team: dict[str, Any],
    member: dict[str, Any],
    leader: dict[str, Any],
    policy_revision: int = POLICY_REVISION,
) -> str:
    """Return a non-secret receipt independent of unrelated team revisions."""

    material = {
        "registryId": registry_id,
        "policyRevision": policy_revision,
        "teamId": team["id"],
        "member": {
            "id": member["id"],
            "name": member["name"],
            "role": member["role"],
            "binding": member["binding"],
            "lifecycle": member["lifecycle"],
        },
        "leader": {
            "id": leader["id"],
            "name": leader["name"],
            "role": leader["role"],
            "binding": leader["binding"],
            "lifecycle": leader["lifecycle"],
        },
    }
    canonical = json.dumps(
        material, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return "v2:" + hashlib.sha256(canonical).hexdigest()
