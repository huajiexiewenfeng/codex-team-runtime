"""Dependency-free regression for the role capsule delegation contract."""
import tempfile
import unittest
from pathlib import Path

from codex_team_context.team_registry import TeamRegistry, initialize_registry


class DelegationBoundaryTest(unittest.TestCase):
    def test_role_capsules_and_read_only_compatibility(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registry.json"
            initialize_registry(path)
            store = TeamRegistry(registry_path=path)
            store.manage("local", "manager", {
                "action": "bootstrap", "operation_id": "bootstrap", "team_id": "team",
                "team_name": "Test", "member_id": "manager", "name": "Manager",
                "authorization_ref": "fixture:user",
            })
            for revision, role in enumerate(("Worker", "Liaison"), 1):
                request = {
                    "action": "register_member", "operation_id": role.lower(),
                    "team_id": "team", "expected_revision": revision,
                    "member_id": role.lower(), "name": role, "role": role,
                    "target_host_id": "local", "target_thread_id": role.lower(),
                    "authorization_ref": "fixture:user",
                }
                if role == "Liaison":
                    request["consent_ref"] = "fixture:consent"
                store.manage("local", "manager", request)
            before = path.read_bytes()
            capsules = {role: store.read("local", role.lower()) for role in ("Manager", "Worker", "Liaison")}
            manager = " ".join(capsules["Manager"]["roleDuties"])
            self.assertIn("must not create or direct temporary subagents", manager)
            self.assertIn("formal Worker", manager)
            self.assertIn("must not directly implement business code", manager)
            self.assertIn("may use authorized bounded temporary subagents", " ".join(capsules["Worker"]["roleDuties"]))
            self.assertIn("must not create or direct temporary subagents", " ".join(capsules["Liaison"]["roleDuties"]))
            self.assertTrue(all(c["dispatchAllowed"] is False for c in capsules.values()))
            self.assertIsNone(store.read("local", "unknown"))
            self.assertEqual(before, path.read_bytes())


if __name__ == "__main__":
    unittest.main()
