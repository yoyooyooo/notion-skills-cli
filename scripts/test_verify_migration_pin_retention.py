"""Synthetic, local-only tests. Temporary fixtures are intentionally retained."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("verify-migration-pin-retention.py")
SPEC = importlib.util.spec_from_file_location("verify_migration_pin_retention", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load the verifier under test")
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


class Fixture:
    def __init__(self, *, router=False):
        self.root = Path(tempfile.mkdtemp(prefix="migration-pin-retention-test-"))
        self.input = self.root / "input.json"
        self.summary = self.root / "summary.json"
        self.audit = self.root / "object-verification.jsonl"
        self.backup = self.root / "state.sqlite"
        self.objects = self.root / "objects"
        self.objects.mkdir()
        self.output = self.root / "verified"
        self.file_bytes = {"SKILL.md": b"# Retained original\n", "source.txt": b"import this_is_only_retained_data\n"}
        self.files = [{"path": path, "sha256": verifier.digest(data), "bytes": len(data)} for path, data in self.file_bytes.items()]
        for file in self.files:
            (self.objects / file["sha256"]).write_bytes(self.file_bytes[file["path"]])
        self.record = {"id": "notion_page:fixture-skill", "kind": "router" if router else "skill",
                       "locator": {"type": "notion_page", "page_id": "fixture-skill", "database_id": "fixture-library"}}
        self.manifest = {"snapshot_id": "s_fixture", "scope": "fixture-scope", "record": self.record,
                         "version_id": "fixture-version", "entrypoint": "SKILL.md", "created_at": 0,
                         "files": [self.files[0]], "source_files": [self.files[1]]}
        if router:
            self.manifest["router_members"] = [{"id": "notion_page:fixture-member", "ref": "notion://fixture-member", "metadata": {}}]
            self.manifest["references"] = [{"id": "fixture-native-resource-page", "path": "references/a.md", "markdown": "Retained inline resource"}]
        manifest_json = json.dumps(self.manifest, ensure_ascii=False)
        locator_json = json.dumps(self.record["locator"])
        database = sqlite3.connect(self.backup)
        try:
            database.execute("CREATE TABLE snapshots (id TEXT PRIMARY KEY,scope TEXT,record_identity TEXT,version_id TEXT,locator TEXT,manifest TEXT)")
            database.execute("INSERT INTO snapshots VALUES (?,?,?,?,?,?)", ("s_fixture", "fixture-scope", self.record["id"], "fixture-version", locator_json, manifest_json))
            database.commit()
        finally:
            database.close()
        database_sha = verifier.file_digest(self.backup)
        raw = {"evidence_kind": "cached_snapshot_candidate", "asserted_user_pin": False,
               "backup_row": {"database": str(self.backup), "database_sha256": database_sha, "table": "snapshots", "key": {"id": "s_fixture"},
                              "manifest_sha256": verifier.digest(manifest_json.encode()), "manifest_bytes": len(manifest_json.encode())},
               "scope": "fixture-scope", "record_identity": self.record["id"], "version_id": "fixture-version", "locator_serialized": locator_json,
               "manifest_identity": {"snapshot_id": "s_fixture", "scope": "fixture-scope", "record_id": self.record["id"], "version_id": "fixture-version"},
               "files": [{**self.files[0], "valid": True}], "source_files": [{**self.files[1], "valid": True}],
               "manifest_json_valid": True, "original_manifest_retained_in_backup": True, "interpretation_complete": False,
               "file_index_complete": True, "cached_bytes_verified": True, "files_with_unverified_bytes": 0, "source_files_with_unverified_bytes": 0}
        empty = {"complete": False, "items": []}
        self.data = {"version": 1, "scope": "fixture-scope", "target_library_id": "fixture-target", "approved_legacy_ids": [],
                     "backup": {"verified": True, "reference": "backup:fixture"}, "catalog": {"coverage": {"exhaustive": False}, "entries": []},
                     "preservation": {"sources": deepcopy(empty), "views": deepcopy(empty), "routers": deepcopy(empty),
                                      "pins": {"complete": False, "items": [{"legacy_id": "s_fixture", "complete": False, "references": [self.record["id"]],
                                                                           "retention_ref": "backup:fixture#snapshots/s_fixture", "retention_verified": False, "raw": raw}]},
                                      "operations": {"complete": False, "items": [{"legacy_id": "fixture-operation", "raw": {"state": "unknown"}, "terminal_verified": False}]}}}
        self.audit_rows = [{"sha256": file["sha256"], "path": str(self.objects / file["sha256"]), "verified": True,
                            "actual_sha256": file["sha256"], "bytes": file["bytes"]} for file in self.files]
        self.freeze()

    def freeze(self):
        self.input.write_bytes(verifier.encoded(self.data))
        self.audit.write_bytes(b"".join(verifier.encoded(row) for row in self.audit_rows))
        self.summary.write_bytes(verifier.encoded({"version": 1, "mode": "read_only_inventory",
            "input": {"sha256": verifier.file_digest(self.input)}, "objects": {"sha256": verifier.file_digest(self.audit), "verified": 2, "failed": 0},
            "backup": {"database_verified": True, "database_sha256": verifier.file_digest(self.backup)}}))

    def retain_changed_manifest(self):
        manifest_json = json.dumps(self.manifest, ensure_ascii=False)
        locator_json = json.dumps(self.record["locator"])
        database = sqlite3.connect(self.backup)
        try:
            database.execute("UPDATE snapshots SET record_identity=?,locator=?,manifest=? WHERE id=?",
                             (self.record["id"], locator_json, manifest_json, "s_fixture"))
            database.commit()
        finally:
            database.close()
        item = self.data["preservation"]["pins"]["items"][0]
        raw = item["raw"]
        raw["backup_row"].update({"database_sha256": verifier.file_digest(self.backup),
                                  "manifest_sha256": verifier.digest(manifest_json.encode()), "manifest_bytes": len(manifest_json.encode())})
        raw["record_identity"] = self.record["id"]
        raw["manifest_identity"]["record_id"] = self.record["id"]
        raw["locator_serialized"] = locator_json
        raw["files"] = [{**file, "valid": True} for file in self.manifest["files"]]
        raw["source_files"] = [{**file, "valid": True} for file in self.manifest.get("source_files", [])]
        item["references"] = [self.record["id"]]
        self.freeze()

    def subscription_router(self, member_count, transform=None):
        subscription = "00000000-0000-4000-8000-000000000001"
        self.record.clear()
        self.record.update({"id": "notion_subscription:" + subscription, "kind": "router", "name": "Fixture Router — 原始",
                            "description": "Retained historical subscription.", "entrypoint": "ROUTER.md",
                            "ref": "skill://upstream%3A" + subscription + "/ROUTER.md",
                            "locator": {"type": "notion_subscription", "subscription_id": subscription,
                                        "database_id": "fixture-source", "target_database_id": "fixture-target"}})
        members = [f"notion_page:00000000-0000-4000-8000-{index + 10:012d}" for index in range(member_count)]
        lines = [f"- [Member {index}](skill://{member.removeprefix('notion_page:')}/SKILL.md) — Original description {index}."
                 for index, member in enumerate(members)]
        header = '---\n"description": ' + json.dumps(self.record["description"], ensure_ascii=False) + '\n"name": ' + json.dumps(self.record["name"], ensure_ascii=False) + '\n---\n\n'
        body = self.record["description"] + "\n\n## Members\n\n" + "\n".join(lines)
        markdown = header + body.strip() + "\n"
        if transform is not None:
            markdown = transform(markdown)
        data = markdown.encode()
        main = {"path": "ROUTER.md", "sha256": verifier.digest(data), "bytes": len(data)}
        (self.objects / main["sha256"]).write_bytes(data)
        self.manifest["entrypoint"] = "ROUTER.md"
        self.manifest["files"] = [main]
        self.manifest["source_files"] = []
        self.audit_rows = [{"sha256": main["sha256"], "path": str(self.objects / main["sha256"]),
                            "verified": True, "actual_sha256": main["sha256"], "bytes": len(data)}]
        self.retain_changed_manifest()
        return members

    def run(self, *, complete_observation=False):
        return verifier.verify_inventory(input_path=self.input, summary_path=self.summary, audit_path=self.audit,
                                         backup_path=self.backup, objects_path=self.objects, output_path=self.output,
                                         complete_observation=complete_observation)

    def output_pin(self):
        return json.loads((self.output / "input.json").read_bytes())["preservation"]["pins"]["items"][0]


class RetentionTests(unittest.TestCase):
    def test_exact_original_manifest_and_all_objects_get_bound_receipts_without_other_gate_changes(self):
        fixture = Fixture()
        original_bytes = {path: path.read_bytes() for path in [fixture.input, fixture.summary, fixture.audit, fixture.backup, *fixture.objects.iterdir()]}
        result = fixture.run()
        self.assertEqual(result["counts"]["retention_verified"], 1)
        self.assertEqual(result["counts"]["file_references_verified"], 2)
        self.assertEqual(result["counts"]["unique_objects_rechecked"], 2)
        updated = json.loads((fixture.output / "input.json").read_bytes())
        pin = updated["preservation"]["pins"]["items"][0]
        self.assertTrue(pin["retention_verified"])
        receipt = (fixture.output / "pin-retention.jsonl").read_bytes()
        self.assertEqual(pin["raw"]["retention_verification"]["receipt_sha256"], verifier.digest(receipt))
        self.assertFalse(pin["raw"]["asserted_user_pin"])
        self.assertFalse(pin["raw"]["interpretation_complete"])
        self.assertFalse(pin["complete"])
        pin["retention_verified"] = False
        del pin["raw"]["retention_verification"]
        self.assertEqual(updated, fixture.data)
        self.assertEqual({path: path.read_bytes() for path in original_bytes}, original_bytes)

    def test_old_successful_audit_cannot_verify_changed_source_file_bytes(self):
        fixture = Fixture()
        source = fixture.files[1]
        (fixture.objects / source["sha256"]).write_bytes(b"x" * source["bytes"])
        result = fixture.run()
        self.assertEqual(result["failures"], {"OBJECT_BYTES_MISMATCH": 1})
        self.assertFalse(fixture.output_pin()["retention_verified"])
        self.assertFalse(fixture.output_pin()["complete"])

    def test_complete_object_totals_do_not_replace_a_missing_original_manifest_index_entry(self):
        fixture = Fixture()
        fixture.data["preservation"]["pins"]["items"][0]["raw"]["source_files"] = []
        fixture.freeze()
        result = fixture.run()
        self.assertEqual(result["failures"], {"MANIFEST_INDEX_MISMATCH": 1})
        self.assertFalse(fixture.output_pin()["retention_verified"])

    def test_different_scope_or_manifest_bytes_cannot_be_attached_to_the_original_identity(self):
        for field, value, code in [("scope", "different-scope", "MANIFEST_IDENTITY_MISMATCH"),
                                   ("backup_row", {"manifest_sha256": "0" * 64}, "MANIFEST_HASH_MISMATCH")]:
            with self.subTest(field=field):
                fixture = Fixture()
                raw = fixture.data["preservation"]["pins"]["items"][0]["raw"]
                if field == "backup_row":
                    raw[field].update(value)
                else:
                    raw[field] = value
                fixture.freeze()
                self.assertEqual(fixture.run()["failures"], {code: 1})

    def test_receipt_hash_mismatch_stops_before_writing_supplemented_evidence(self):
        for changed in ("input", "audit"):
            with self.subTest(changed=changed):
                fixture = Fixture()
                path = getattr(fixture, changed)
                path.write_bytes(path.read_bytes() + b"\n")
                with self.assertRaises(verifier.EvidenceError) as error:
                    fixture.run()
                self.assertEqual(error.exception.code, "INPUT_HASH_MISMATCH" if changed == "input" else "AUDIT_HASH_MISMATCH")
                self.assertFalse(fixture.output.exists())

    def test_missing_or_duplicated_audit_identity_is_not_silently_accepted(self):
        fixture = Fixture()
        fixture.audit_rows = fixture.audit_rows[:1]
        fixture.freeze()
        self.assertEqual(fixture.run()["failures"], {"OBJECT_AUDIT_MISMATCH": 1})
        duplicate = Fixture()
        duplicate.audit_rows.append(deepcopy(duplicate.audit_rows[0]))
        duplicate.freeze()
        with self.assertRaises(verifier.EvidenceError) as error:
            duplicate.run()
        self.assertEqual(error.exception.code, "AUDIT_DUPLICATE")
        self.assertFalse(duplicate.output.exists())

    def test_pin_designation_is_not_an_obligation_but_missing_router_references_are_reported(self):
        fixture = Fixture(router=True)
        result = fixture.run()
        self.assertEqual(result["counts"]["retention_verified"], 1)
        self.assertEqual(result["counts"]["candidates_with_missing_content_references"], 1)
        receipt = json.loads((fixture.output / "pin-retention.jsonl").read_bytes())
        assessment = receipt["reference_assessment"]
        self.assertEqual(assessment["missing_content_references"], ["notion_page:fixture-member"])
        self.assertEqual(assessment["retained_resource_page_ids"], ["fixture-native-resource-page"])
        self.assertFalse(assessment["user_pin_designation_required_for_retention"])
        self.assertFalse(fixture.output_pin()["complete"])
        self.assertFalse(fixture.output_pin()["raw"]["asserted_user_pin"])

    def test_existing_output_and_repeated_candidate_identities_never_overwrite_or_drop_evidence(self):
        fixture = Fixture()
        pins = fixture.data["preservation"]["pins"]["items"]
        pins.append(deepcopy(pins[0]))
        fixture.freeze()
        result = fixture.run()
        self.assertEqual(result["failures"], {"PIN_IDENTITY_CONFLICT": 2})
        receipt_bytes = (fixture.output / "pin-retention.jsonl").read_bytes()
        self.assertEqual(len(receipt_bytes.splitlines()), 2)
        with self.assertRaises(verifier.EvidenceError) as error:
            fixture.run()
        self.assertEqual(error.exception.code, "OUTPUT_EXISTS")
        self.assertEqual((fixture.output / "pin-retention.jsonl").read_bytes(), receipt_bytes)

    def test_backup_coverage_reports_unlisted_historical_payloads_without_claiming_complete_pin_inventory(self):
        fixture = Fixture()
        database = sqlite3.connect(fixture.backup)
        try:
            database.execute("CREATE TABLE historical_snapshot_mappings (historical_id TEXT PRIMARY KEY, record_identity TEXT, manifest TEXT)")
            database.execute("INSERT INTO historical_snapshot_mappings VALUES (?,?,?)", ("s_fixture", fixture.record["id"], "different original payload"))
            database.execute("INSERT INTO historical_snapshot_mappings VALUES (?,?,?)", ("s_historical_only", fixture.record["id"], "retained separate historical payload"))
            database.commit()
        finally:
            database.close()
        fixture.data["preservation"]["pins"]["items"][0]["raw"]["backup_row"]["database_sha256"] = verifier.file_digest(fixture.backup)
        fixture.freeze()
        result = fixture.run()
        self.assertEqual(result["counts"]["retention_verified"], 1)
        self.assertEqual(result["backup_enumeration"], {"snapshot_rows": 1, "snapshot_rows_missing_from_candidates": 0,
                         "historical_mapping_rows": 2, "historical_mapping_rows_outside_candidates": 1,
                         "historical_mapping_payloads_different_from_snapshot": 1})
        output = json.loads((fixture.output / "input.json").read_bytes())
        self.assertFalse(output["preservation"]["pins"]["complete"])

    def test_complete_observation_updates_only_the_exact_item_evidence_and_keeps_scope_and_outcomes(self):
        fixture = Fixture()
        original = deepcopy(fixture.data)
        result = fixture.run(complete_observation=True)
        self.assertEqual(result["counts"]["complete_original_observations"], 1)
        self.assertEqual(result["counts"]["item_complete_flags_updated"], 1)
        updated = json.loads((fixture.output / "input.json").read_bytes())
        pin = updated["preservation"]["pins"]["items"][0]
        self.assertTrue(pin["complete"])
        self.assertFalse(pin["raw"]["asserted_user_pin"])
        self.assertFalse(pin["raw"]["interpretation_complete"])
        self.assertFalse(updated["preservation"]["pins"]["complete"])
        pin["complete"] = False
        pin["retention_verified"] = False
        del pin["raw"]["retention_verification"]
        self.assertEqual(updated, original)

    def test_exact_historical_subscription_routers_with_zero_one_or_many_members_are_observed_without_current_reads(self):
        for count in (0, 1, 4):
            with self.subTest(member_count=count):
                fixture = Fixture()
                members = fixture.subscription_router(count)
                original_raw = deepcopy(fixture.data["preservation"]["pins"]["items"][0]["raw"])
                result = fixture.run(complete_observation=True)
                self.assertEqual(result["counts"]["complete_original_observations"], 1)
                self.assertEqual(result["counts"]["legacy_router_manifests_interpreted"], 1)
                self.assertEqual(result["counts"]["content_references_added"], count)
                pin = fixture.output_pin()
                self.assertTrue(pin["complete"])
                self.assertEqual(pin["references"], [fixture.record["id"], *members])
                del pin["raw"]["retention_verification"]
                self.assertEqual(pin["raw"], original_raw)

    def test_generated_router_recognition_cannot_accept_extra_text_duplicate_members_or_metadata_mismatch(self):
        transforms = [
            lambda text: text + "Unrecognized trailing instructions.\n",
            lambda text: text + text.splitlines(keepends=True)[-1],
            lambda text: text.replace('"name": "Fixture Router — 原始"', '"name": "Other name"'),
            lambda text: text.replace(" — Original description 0.", " — [nested](skill://00000000-0000-4000-8000-000000000099/SKILL.md) — ambiguous"),
        ]
        for transform in transforms:
            with self.subTest(transform=transforms.index(transform)):
                fixture = Fixture()
                fixture.subscription_router(1, transform)
                result = fixture.run(complete_observation=True)
                self.assertEqual(result["counts"]["retention_verified"], 1)
                self.assertEqual(result["counts"]["complete_original_observations"], 0)
                self.assertFalse(fixture.output_pin()["complete"])
                self.assertEqual(fixture.output_pin()["references"], [fixture.record["id"]])

    def test_complete_observation_adds_only_original_manifest_references_and_keeps_unknown_formats_incomplete(self):
        fixture = Fixture(router=True)
        result = fixture.run(complete_observation=True)
        self.assertEqual(result["counts"]["content_references_added"], 1)
        self.assertTrue(fixture.output_pin()["complete"])
        self.assertEqual(fixture.output_pin()["references"], [fixture.record["id"], "notion_page:fixture-member"])
        unknown = Fixture()
        unknown.manifest["unknown_reference_format"] = {"keep_original": True}
        unknown.retain_changed_manifest()
        result = unknown.run(complete_observation=True)
        self.assertEqual(result["counts"]["retention_verified"], 1)
        self.assertEqual(result["counts"]["complete_original_observations"], 0)
        self.assertFalse(unknown.output_pin()["complete"])


if __name__ == "__main__":
    unittest.main()
