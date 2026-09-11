from __future__ import annotations

import json
import subprocess
import sys

from codex_team_context.runtime_link import export_registry
from test_registry_cutover import NODE, ROOT, adoption_request, linked


def test_fresh_session_activates_with_unique_ids_beside_existing_team(linked) -> None:
    registry, registry_path, existing_path, _, existing_request = linked
    registry.manage("fixture-host", "fixture-manager", existing_request)
    existing_bytes = existing_path.read_bytes()
    existing_team = json.loads(registry_path.read_text(encoding="utf-8"))["teams"][0]
    assert [member["id"] for member in existing_team["members"]] == [
        "manager", "liaison", "worker"
    ]

    state_path = existing_path.with_name("fresh-state.json")
    session = (ROOT / "src" / "session.mjs").as_uri()
    script = f"""
import {{start,attach,registerWorker}} from {json.dumps(session)};
const path={json.dumps(str(state_path))};
const source={{kind:'fixture',ref:'fresh-team-activation'}};
const manager={{hostId:'fresh-host',threadId:'fresh-manager-thread'}};
const liaison={{hostId:'fresh-host',threadId:'fresh-liaison-thread'}};
let state=await start(path,{{teamId:'fresh-team',name:'Fresh team',caller:manager,source,
 managerMemberId:'fresh-manager',liaisonMemberId:'fresh-liaison'}},'2026-01-01T00:00:00.000Z');
state=await attach(path,{{mode:'invite',id:'fresh-invite',caller:manager,target:liaison,
 at:'2026-01-01T00:00:01.000Z',expiresAt:'2026-01-01T00:10:00.000Z',source}},state.version);
state=await attach(path,{{mode:'confirm',id:'fresh-confirm',caller:liaison,
 invitationId:'fresh-invite',invitationVersion:state.version,
 at:'2026-01-01T00:00:02.000Z',source}},state.version);
state=await registerWorker(path,{{id:'fresh-register',caller:manager,memberId:'fresh-worker',
 name:'Fresh Worker',binding:{{hostId:'fresh-host',threadId:'fresh-worker-thread'}},
 at:'2026-01-01T00:00:03.000Z',source}},state.version);
process.stdout.write(JSON.stringify(state));
"""
    created = subprocess.run(
        [NODE, "--input-type=module", "-e", script],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    assert created.returncode == 0, created.stderr
    before = json.loads(created.stdout)
    raw = state_path.read_bytes()
    assert json.loads(raw) == before
    assert before["version"] == 3
    assert [event["type"] for event in before["events"]] == [
        "attachInvite", "attachConfirm", "registerWorker"
    ]
    assert before["session"]["invitation"]["confirmationId"] == "fresh-confirm"
    assert before["rounds"] == before["tasks"] == []

    request = adoption_request(state_path, raw)
    request["operation_id"] = "fresh-adoption"
    assert registry.manage("fresh-host", "fresh-manager-thread", request)["outcome"] == "adopted"
    for role in ("manager", "liaison", "worker"):
        member_id = f"fresh-{role}"
        capsule = registry.read("fresh-host", f"fresh-{role}-thread")
        assert capsule["member"]["memberId"] == member_id
        assert capsule["executionIntegration"] == "connected"
        assert capsule["onboarding"]["status"] == "pending"
        result = registry.manage("fresh-host", "fresh-manager-thread", {
            "action": "confirm_ready", "operation_id": f"ready-{member_id}",
            "team_id": "fresh-team", "expected_revision": capsule["team"]["revision"],
            "member_id": member_id, "receipt": capsule["onboardingReceipt"],
            "evidence_ref": f"fixture-reply:{member_id}",
        })
        assert result["outcome"] == "ready"

    for role in ("manager", "liaison", "worker"):
        capsule = registry.read("fresh-host", f"fresh-{role}-thread")
        assert capsule["executionIntegration"] == "connected"
        assert capsule["onboarding"]["status"] == "ready"
        assert capsule["identityAssurance"] == "caller-declared"
        assert capsule["dispatchAllowed"] is False
    assert export_registry(registry_path, "fresh-team")["readyMemberIds"] == [
        "fresh-manager", "fresh-liaison", "fresh-worker"
    ]

    store = (ROOT / "src" / "store.mjs").as_uri()
    projected = subprocess.run(
        [NODE, "--input-type=module", "-e", f"""
import {{readState}} from {json.dumps(store)};
const state=await readState({json.dumps(str(state_path))},{{python:{json.dumps(sys.executable)}}});
process.stdout.write(JSON.stringify(state));
"""], capture_output=True, text=True, encoding="utf-8", check=False,
    )
    assert projected.returncode == 0, projected.stderr
    state = json.loads(projected.stdout)
    assert state["registry"]["phase"] == "active"
    assert state["registry"]["readyMemberIds"] == [
        "fresh-manager", "fresh-liaison", "fresh-worker"
    ]
    assert state["rounds"] == state["tasks"] == []
    assert state["events"] == before["events"]
    assert existing_path.read_bytes() == existing_bytes
    stored = json.loads(registry_path.read_text(encoding="utf-8"))
    assert [team["id"] for team in stored["teams"]] == ["legacy-team", "fresh-team"]
    assert stored["teams"][0] == existing_team
    assert all(operation["request"]["action"] != "bootstrap" for operation in stored["operations"])
