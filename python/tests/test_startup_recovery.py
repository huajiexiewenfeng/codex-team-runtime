from __future__ import annotations

import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from codex_team_context.core import ContextError
from codex_team_context.startup import StartupLedger
from codex_team_context.team_registry import TeamRegistry, initialize_registry
from test_registry_cutover import NODE, ROOT, adoption_request


def node(script: str) -> bytes:
    return subprocess.run([NODE, "--input-type=module", "-e", script],
                          capture_output=True, check=True).stdout


@pytest.fixture
def startup(tmp_path):
    registry_path, state_path = tmp_path / "registry.json", tmp_path / "state.json"
    initialize_registry(registry_path)
    raw = node(f"""
import {{createState}} from {json.dumps((ROOT / 'src/runtime.mjs').as_uri())};
const s=createState({{teamId:'team',name:'Team',source:{{kind:'fixture',ref:'startup'}},members:[
 {{id:'manager',name:'Manager',role:'Manager',lifecycle:'active',binding:{{status:'bound',hostId:'local',threadId:'manager-thread'}}}},
 {{id:'liaison',name:'Liaison',role:'Liaison',lifecycle:'active',binding:{{status:'unbound'}}}}
]}},'2026-01-01T00:00:00.000Z');
s.session={{invitation:null}};process.stdout.write(JSON.stringify(s));
""")
    state_path.write_bytes(raw)
    registry = TeamRegistry(registry_path=registry_path, node_executable=NODE, runtime_root=ROOT)
    ledger = StartupLedger(registry)
    return ledger, registry, registry_path, state_path


def prepare(ledger, state_path, role="Worker"):
    request = {"action": "prepare", "operation_id": f"create-{role.lower()}",
               "team_id": "team", "member_id": role.lower(), "role": role,
               "target_host_id": "local", "state_path": str(state_path.resolve()),
               "authorization_ref": "user:minimum-team"}
    return ledger.handle("local", "manager-thread", request), request


def manager(ledger, action, **fields):
    return ledger.handle("local", "manager-thread", {
        "action": action, "operation_id": "create-worker", **fields})


def receipt(ledger, thread="worker-thread", slot_role="Worker", **fields):
    return ledger.handle("local", thread, {
        "action": "receipt", "operation_id": f"create-{slot_role.lower()}",
        "team_id": "team", "member_id": slot_role.lower(), "role": slot_role,
        "evidence_ref": "native:self-read", **fields})


def error(code, call):
    with pytest.raises(ContextError) as caught:
        call()
    assert caught.value.code == code


def claimed(startup):
    ledger, _, _, state = startup
    prepare(ledger, state)
    assert manager(ledger, "claim")["claimed"] is True
    return ledger


def test_missing_listing_recovers_child_receipt_after_restart_without_registering(startup):
    ledger, registry, registry_path, state_path = startup
    original = registry_path.read_bytes(), state_path.read_bytes()
    prepared, _ = prepare(ledger, state_path)
    assert prepared["stage"] == "prepared"
    assert manager(ledger, "claim")["claimed"] is True
    manager(ledger, "record_creation", result={"hostId": "local", "clientThreadId": "client-new-thread:abc"},
            evidence_ref="native:create")
    published = receipt(ledger)
    reopened = StartupLedger(TeamRegistry(registry_path=registry_path, node_executable=NODE, runtime_root=ROOT))
    plan = manager(reopened, "plan")
    assert plan["stage"] == "verify_identity"
    assert plan["candidates"][0]["threadId"] == "worker-thread"
    assert plan["candidates"][0]["receiptId"] == published["receiptId"]
    assert plan["creation"]["result"]["clientThreadId"] == "client-new-thread:abc"
    assert plan["dispatchAllowed"] is False
    assert registry.read("local", "worker-thread") is None
    assert (registry_path.read_bytes(), state_path.read_bytes()) == original
    discovered = reopened.handle("local", "manager-thread", {"action": "plan"})
    assert [x["operationId"] for x in discovered["operations"]] == ["create-worker"]


def test_one_shot_claim_and_unknown_outcome_cannot_reset_or_duplicate(startup):
    ledger, _, _, state = startup
    _, request = prepare(ledger, state)
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: manager(ledger, "claim")["claimed"], range(2)))
    assert sorted(outcomes) == [False, True]
    assert ledger.handle("local", "manager-thread", request)["stage"] == "waiting_receipt"
    assert manager(ledger, "plan")["nextAction"] == "reconcile_original_creation"
    error("SLOT_CONFLICT", lambda: ledger.handle("local", "manager-thread", dict(request, operation_id="replacement")))
    error("OPERATION_CONFLICT", lambda: ledger.handle("local", "manager-thread", dict(request, member_id="other")))


def test_child_can_arrive_before_creation_result_and_replays_are_idempotent(startup):
    ledger = claimed(startup)
    first = receipt(ledger)
    assert receipt(ledger) == first
    args = {"result": {"hostId": "local", "threadId": "worker-thread"}, "evidence_ref": "native:create"}
    assert manager(ledger, "record_creation", **args) == manager(ledger, "record_creation", **args)
    manager(ledger, "verify", receipt_id=first["receiptId"], evidence_ref="native:independent-read")
    assert manager(ledger, "plan")["stage"] == "register_member"
    error("OPERATION_CONFLICT", lambda: manager(ledger, "record_creation",
          result={"hostId": "local", "threadId": "different"}, evidence_ref="native:create"))


def test_multiple_candidate_receipts_do_not_take_over_slot(startup):
    ledger = claimed(startup)
    wrong, correct = receipt(ledger, "unrelated-thread"), receipt(ledger)
    assert manager(ledger, "plan")["stage"] == "verify_identity"
    assert len(manager(ledger, "plan")["candidates"]) == 2
    manager(ledger, "verify", receipt_id=correct["receiptId"], evidence_ref="native:checked-real-worker")
    assert manager(ledger, "plan")["verified"]["receiptId"] == correct["receiptId"]
    error("IDENTITY_CONFLICT", lambda: manager(ledger, "verify", receipt_id=wrong["receiptId"], evidence_ref="other"))
    error("IDENTITY_CONFLICT", lambda: receipt(ledger, "third-thread"))


@pytest.mark.parametrize("fields", [{"team_id": "wrong"}, {"member_id": "manager"}, {"role": "Manager"}])
def test_receipt_cannot_choose_team_slot_or_role(startup, fields):
    ledger = claimed(startup)
    error("SLOT_MISMATCH", lambda: receipt(ledger, **fields))


@pytest.mark.parametrize("thread", ["client-new-thread:abc", "pending:abc", "manager-thread"])
def test_receipt_rejects_temporary_ids_and_manager_identity(startup, thread):
    ledger = claimed(startup)
    with pytest.raises(ContextError):
        receipt(ledger, thread)
    assert manager(ledger, "plan")["candidates"] == []


def test_nonmanager_cannot_prepare_claim_verify_or_read_another_slot(startup):
    ledger, _, _, state = startup
    _, request = prepare(ledger, state)
    error("MANAGER_REQUIRED", lambda: ledger.handle("local", "worker-thread", dict(request, operation_id="bad")))
    for action in ("claim", "plan"):
        error("MANAGER_REQUIRED", lambda: ledger.handle("local", "worker-thread", {"action": action, "operation_id": "create-worker"}))
    error("CREATION_NOT_CLAIMED", lambda: receipt(ledger))
    manager(ledger, "claim")
    candidate = receipt(ledger)
    error("MANAGER_REQUIRED", lambda: ledger.handle("local", "worker-thread", {
        "action": "verify", "operation_id": "create-worker", "receipt_id": candidate["receiptId"], "evidence_ref": "fake"}))


def test_formal_creation_identity_must_match_selected_candidate(startup):
    ledger = claimed(startup)
    wrong = receipt(ledger, "wrong-thread")
    manager(ledger, "record_creation", result={"hostId": "local", "threadId": "worker-thread"}, evidence_ref="native:create")
    error("IDENTITY_CONFLICT", lambda: manager(ledger, "verify", receipt_id=wrong["receiptId"], evidence_ref="native:read"))


def test_plan_is_nonmutating_and_missing_ledger_is_not_initialized(startup):
    ledger, _, registry_path, state_path = startup
    assert ledger.handle("local", "manager-thread", {"action": "plan"}) == {"operations": []}
    assert not Path(f"{registry_path}.startup.json").exists()
    prepare(ledger, state_path)
    paths = [registry_path, state_path, Path(f"{registry_path}.startup.json")]
    before = [p.read_bytes() for p in paths]
    manager(ledger, "plan")
    assert [p.read_bytes() for p in paths] == before


def test_corrupt_registry_or_ledger_never_becomes_empty(startup):
    ledger, _, registry_path, state_path = startup
    prepare(ledger, state_path)
    sidecar = Path(f"{registry_path}.startup.json")
    original = registry_path.read_bytes()
    registry_path.write_text("{", encoding="utf-8")
    error("REGISTRY_CORRUPT", lambda: manager(ledger, "plan"))
    registry_path.write_bytes(original)
    sidecar.write_text("{", encoding="utf-8")
    error("REGISTRY_CORRUPT", lambda: manager(ledger, "claim"))
    assert sidecar.read_text() == "{"


def test_failed_claim_write_grants_no_creation_and_conservatively_consumes_claim(startup, monkeypatch):
    ledger, _, _, state = startup
    prepare(ledger, state)
    with monkeypatch.context() as patch:
        patch.setattr(ledger._store, "_replace", lambda _: (_ for _ in ()).throw(ContextError("REGISTRY_WRITE_FAILED", "injected")))
        error("REGISTRY_WRITE_FAILED", lambda: manager(ledger, "claim"))
    assert manager(ledger, "plan")["stage"] == "waiting_receipt"
    assert manager(ledger, "claim")["claimed"] is False


def test_missing_ledger_after_claim_cannot_initialize_or_grant_again(startup):
    ledger, _, registry_path, state = startup
    _, original = prepare(ledger, state)
    manager(ledger, "claim")
    Path(f"{registry_path}.startup.json").unlink()
    for request in ({"action": "plan"}, original, dict(original, operation_id="replacement")):
        error("STARTUP_LEDGER_MISSING", lambda: ledger.handle("local", "manager-thread", request))
    assert not Path(f"{registry_path}.startup.json").exists()


def test_valid_preclaim_snapshot_never_restores_creation_grant(startup):
    ledger, _, registry_path, state = startup
    prepare(ledger, state)
    path = Path(f"{registry_path}.startup.json")
    before_claim = path.read_bytes()
    manager(ledger, "claim")
    path.write_bytes(before_claim)
    assert manager(ledger, "plan")["stage"] == "waiting_receipt"
    assert manager(ledger, "claim")["claimed"] is False


def test_rolled_back_ledger_missing_original_operation_is_rejected(startup):
    ledger, registry, registry_path, state = startup
    prepare(ledger, state)
    manager(ledger, "claim")
    path = Path(f"{registry_path}.startup.json")
    value = json.loads(path.read_bytes())
    value["operations"] = []
    path.write_text(json.dumps(value), encoding="utf-8")
    error("STARTUP_LEDGER_MISMATCH", lambda: ledger.handle("local", "manager-thread", {"action": "plan"}))


def test_missing_creation_guard_is_not_recreated(startup):
    ledger = claimed(startup)
    guard_dir = Path(f"{startup[2]}.startup-claims")
    guards = list(guard_dir.glob("*.json"))
    assert len(guards) == 1
    guards[0].unlink()
    error("STARTUP_GUARD_MISSING", lambda: manager(ledger, "claim"))


def test_wrong_host_oversized_or_extra_receipt_data_leaves_slot_unchanged(startup):
    ledger = claimed(startup)
    for fields in ({"evidence_ref": "x" * 2049}, {"unexpected": "instructions"}):
        error("INVALID_REQUEST", lambda: receipt(ledger, **fields))
    error("SLOT_MISMATCH", lambda: ledger.handle("other-host", "worker-thread", {
        "action": "receipt", "operation_id": "create-worker", "team_id": "team",
        "member_id": "worker", "role": "Worker", "evidence_ref": "self:read"}))
    assert manager(ledger, "plan")["candidates"] == []


def test_changed_manager_or_state_source_blocks_receipt(startup):
    ledger = claimed(startup)
    state_path = startup[3]
    state = json.loads(state_path.read_bytes())
    state["members"][0]["binding"]["threadId"] = "replacement-manager"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    error("MANAGER_REQUIRED", lambda: receipt(ledger))


def test_pairing_one_member_does_not_skip_other_recorded_creation_slots(startup):
    ledger, _, _, state_path = startup
    prepare(ledger, state_path, "Worker")
    prepare(ledger, state_path, "Liaison")
    manager(ledger, "claim", operation_id="create-liaison")
    received = receipt(ledger, "liaison-thread", "Liaison")
    manager(ledger, "verify", operation_id="create-liaison", receipt_id=received["receiptId"], evidence_ref="native:read")
    node(f"""
import {{attach}} from {json.dumps((ROOT / 'src/session.mjs').as_uri())};
const p={json.dumps(str(state_path))},source={{kind:'fixture',ref:'startup'}};
await attach(p,{{mode:'invite',id:'invite',caller:{{hostId:'local',threadId:'manager-thread'}},target:{{hostId:'local',threadId:'liaison-thread'}},at:'2026-01-01T00:00:01.000Z',expiresAt:'2026-01-01T00:10:00.000Z',source}},0);
await attach(p,{{mode:'confirm',id:'confirm',caller:{{hostId:'local',threadId:'liaison-thread'}},invitationId:'invite',invitationVersion:1,at:'2026-01-01T00:00:02.000Z',source}},1);
""")
    assert manager(ledger, "plan", operation_id="create-liaison")["stage"] == "complete_team"


def test_planner_follows_real_pairing_adoption_and_each_members_readiness(startup):
    ledger, registry, _, state_path = startup
    for role in ("Worker", "Liaison"):
        _, request = prepare(ledger, state_path, role)
        common = {"operation_id": request["operation_id"]}
        manager(ledger, "claim", **common)
        received = receipt(ledger, f"{role.lower()}-thread", role)
        manager(ledger, "verify", **common, receipt_id=received["receiptId"], evidence_ref="native:verified")
    assert manager(ledger, "plan", operation_id="create-liaison")["stage"] == "pair_liaison"
    script = f"""
import {{attach,registerWorker}} from {json.dumps((ROOT / 'src/session.mjs').as_uri())};
const p={json.dumps(str(state_path))}, caller={{hostId:'local',threadId:'manager-thread'}},source={{kind:'fixture',ref:'startup'}};
await attach(p,{{mode:'invite',id:'invite',caller,target:{{hostId:'local',threadId:'liaison-thread'}},at:'2026-01-01T00:00:01.000Z',expiresAt:'2026-01-01T00:10:00.000Z',source}},0);
await attach(p,{{mode:'confirm',id:'confirm',caller:{{hostId:'local',threadId:'liaison-thread'}},invitationId:'invite',invitationVersion:1,at:'2026-01-01T00:00:02.000Z',source}},1);
await registerWorker(p,{{id:'register',caller,memberId:'worker',name:'Worker',binding:{{hostId:'local',threadId:'worker-thread'}},at:'2026-01-01T00:00:03.000Z',source}},2);
"""
    node(script)
    assert manager(ledger, "plan")["stage"] == "adopt_legacy"
    request = adoption_request(state_path, state_path.read_bytes())
    registry.manage("local", "manager-thread", request)
    assert manager(ledger, "plan")["stage"] == "confirm_readiness"
    for member in ("manager", "worker", "liaison"):
        own = registry.read("local", f"{member}-thread")
        registry.manage("local", "manager-thread", {
            "action": "confirm_ready", "operation_id": f"ready-{member}", "team_id": "team",
            "expected_revision": own["team"]["revision"], "member_id": member,
            "receipt": own["onboardingReceipt"], "evidence_ref": f"native:own-reply-{member}"})
    plan = manager(ledger, "plan")
    assert plan["stage"] == "ready_for_admission"
    assert plan["dispatchAllowed"] is False
    assert json.loads(state_path.read_bytes())["tasks"] == []
    own = registry.read("local", "worker-thread")
    registry.manage("local", "manager-thread", {
        "action": "exit_member", "operation_id": "exit", "team_id": "team",
        "expected_revision": own["team"]["revision"], "member_id": "worker", "authorization_ref": "user:exit"})
    assert manager(ledger, "plan")["stage"] == "member_inactive"
    error("MEMBER_INACTIVE", lambda: receipt(ledger))
