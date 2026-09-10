"""Fixed policy projection and deterministic onboarding receipts for registry v2."""

from __future__ import annotations

import hashlib
import json
from typing import Any


POLICY_REVISION = 1

SHARED_RULES = (
    "Recall this capsule at first onboarding and at foreground continuation or context loss.",
    "Recall it before role-dependent coordination and before delivery, receipt, or acceptance.",
    "Treat caller-declared identity separately from action authorization and external consent.",
    "The registry is context-only; it does not dispatch work or bypass connected runtime gates.",
    "Re-read context after membership, leader, rule, or onboarding conflicts.",
    "If the leader is exited or unavailable, retain the evidence, ask the user, never elect a replacement, and do not repeatedly message.",
)

ROLE_DUTIES = {
    "Manager": (
        "Maintain team and member registration from externally authorized facts.",
        "Delegate and coordinate only through an authorized connected runtime.",
        "Independently review evidence and accept or reject work.",
        "Verify onboarding replies for the exact registered member.",
    ),
    "Worker": (
        "Work only on this member's explicitly assigned authorized task.",
        "Durably submit only this member's own work and evidence.",
        "Use the existing submission-notice flow to notify the exact Manager.",
    ),
    "Liaison": (
        "Explain team progress and decisions; do not dispatch or command Workers.",
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
