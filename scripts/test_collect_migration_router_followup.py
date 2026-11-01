import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


fixtures = module("pilot_fixture", "test_collect_migration_current_files.py")
followup = module("router_followup", "collect-migration-router-followup.py")


def prepare_fixture(bootstrap_failure=True):
    root = fixtures.fixture(Router={"fail_read": True})
    original = json.loads((root / "config.json").read_text())
    subset = json.loads((root / "subset.json").read_text())
    metadata = json.loads((root / "metadata.json").read_text())
    for item, entry in zip(metadata["entries"], subset["entries"]):
        item["target"] = {"database_id": entry["record"]["locator"]["database_id"]}
    fixtures.write_json(root / "metadata.json", metadata)
    original["metadata"]["sha256"] = hashlib.sha256((root / "metadata.json").read_bytes()).hexdigest()
    fixtures.write_json(root / "config.json", original)
    if bootstrap_failure:
        fake = (root / "fake-cli.py").read_text().replace("import hashlib,json,sys", "import hashlib,json,sys,os")
        fake = fake.replace("if action=='read' and record.get('fail_read'):",
                            "if action=='read' and record.get('fail_read') and not (Path(os.environ['NTN_SKILLS_CONFIG_HOME'])/'config.json').is_file():")
        fake = fake.replace("PUBLICATION_INCOMPLETE", "UPSTREAM_NOT_CONFIGURED")
        fake = fake.replace("'details':{'operation_id':'original-unknown-operation'}", "'details':{}")
        (root / "fake-cli.py").write_text(fake)
    original_result, _ = fixtures.run(root)
    config = {**original, "output": str(root / "router-followup"), "previousRun": {
        "path": original["output"],
        "summary_sha256": hashlib.sha256((Path(original["output"]) / "summary.json").read_bytes()).hexdigest()}}
    fixtures.write_json(root / "followup.json", config)
    return root, subset, original_result


def hashes(directory):
    return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in directory.rglob("*") if path.is_file()}


class RouterFollowupTests(unittest.TestCase):
    def test_only_failed_router_uses_minimal_new_bootstrap_and_old_run_stays_unchanged(self):
        root, subset, old = prepare_fixture()
        self.assertEqual([item["status"] for item in old["entries"]], ["stopped", "captured", "captured"])
        before = hashes(root / "output")
        check = followup.run(root / "followup.json", check_only=True)
        self.assertTrue(check["ok"])
        self.assertFalse((root / "router-followup").exists())
        result = followup.run(root / "followup.json")
        self.assertTrue(result["ok"])
        self.assertEqual(hashes(root / "output"), before)
        config = json.loads((root / "router-followup/runtime/config/config.json").read_text())
        self.assertEqual(config, {"upstream_database": subset["entries"][0]["record"]["locator"]["database_id"]})
        summary = json.loads((root / "router-followup/summary.json").read_text())
        self.assertEqual(summary["cli_invocations"], 3)
        self.assertFalse(summary["other_entries_reread"])
        self.assertTrue(summary["previous_failure_preserved"])
        self.assertEqual(summary["approved_legacy_ids"], [])
        commands = [json.loads(path.read_text())["argv"] for path in sorted((root / "router-followup/commands").glob("*/request.json"))]
        self.assertEqual([args[3] for args in commands], ["read", "files", "export"])
        self.assertEqual(commands[0][4], subset["entries"][0]["record"]["ref"])

    def test_publication_failure_cannot_be_relabelled_as_missing_bootstrap(self):
        root, _, _ = prepare_fixture(bootstrap_failure=False)
        before = (root / "trace.jsonl").read_bytes()
        with self.assertRaises(followup.pilot.EvidenceError) as caught:
            followup.run(root / "followup.json")
        self.assertEqual(caught.exception.code, "FOLLOWUP_ORIGIN_INVALID")
        self.assertFalse((root / "router-followup").exists())
        self.assertEqual((root / "trace.jsonl").read_bytes(), before)

    def test_original_final_summary_is_required_before_any_followup_call(self):
        root, _, _ = prepare_fixture()
        config = json.loads((root / "followup.json").read_text())
        (root / "still-running").mkdir()
        config["previousRun"]["path"] = str(root / "still-running")
        fixtures.write_json(root / "followup.json", config)
        before = (root / "trace.jsonl").read_bytes()
        with self.assertRaises((followup.pilot.EvidenceError, OSError)):
            followup.run(root / "followup.json")
        self.assertFalse((root / "router-followup").exists())
        self.assertEqual((root / "trace.jsonl").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
