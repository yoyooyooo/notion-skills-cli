"""Synthetic original-operation provenance tests; temporary fixtures are retained."""

from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("verify_operation_origins", Path(__file__).with_name("verify-migration-operation-origins.py"))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load the verifier under test")
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


class Fixture:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="migration-operation-origin-test-"))
        self.input, self.summary, self.index = self.root / "input.json", self.root / "summary.json", self.root / "operation-index.json"
        self.backup, self.output = self.root / "state.sqlite", self.root / "verified"
        sha = "a" * 64
        self.rows = [
            ("upstream_commands", {"operation_id": "command-fixture", "domain": "upstream_fork", "scope": "original-scope", "database_id": "original-library",
                "state": "verified", "page_id": "original-page", "subscription_id": "original-subscription", "member_key": "original-member", "expected_version": "original-version",
                "publication_required": True, "baseline_operation_ids": [], "baseline_before_ids": [], "publisher_subscription_id": "original-publisher",
                "retained_extra": {"external_assets": False}}),
            ("upstream_operations", {"operation_id": "batch-fixture", "plan_id": "original-plan", "subscription_id": "original-subscription", "state": "unknown", "items": []}),
            ("integrity_operations", {"version": 1, "operation_id": "integrity-fixture", "intended_hash": sha,
                "marker": {"version": 2, "operation_id": "integrity-fixture", "intended_hash": sha, "state": "committed", "revision": sha, "manifest_hash": sha, "ownership_hash": sha}}),
        ]
        database = sqlite3.connect(self.backup)
        try:
            database.execute("CREATE TABLE upstream_commands (operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
            database.execute("CREATE TABLE upstream_operations (operation_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL)")
            database.execute("CREATE TABLE integrity_operations (operation_id TEXT PRIMARY KEY,publication_operation_id TEXT NOT NULL,intended_hash TEXT NOT NULL,state TEXT NOT NULL,page_id TEXT,payload TEXT NOT NULL)")
            for table, raw in self.rows:
                payload = json.dumps(raw, ensure_ascii=False, indent=2)
                if table == "upstream_commands":
                    database.execute("INSERT INTO upstream_commands VALUES (?,?)", (raw["operation_id"], payload))
                elif table == "upstream_operations":
                    database.execute("INSERT INTO upstream_operations VALUES (?,?,?,?)", (raw["operation_id"], raw["plan_id"], raw["state"], payload))
                else:
                    database.execute("INSERT INTO integrity_operations VALUES (?,?,?,?,?,?)", (raw["operation_id"], raw["operation_id"], raw["intended_hash"], raw["marker"]["state"], None, payload))
            database.execute("INSERT INTO upstream_commands VALUES (?,?)", ("outside-selected-inventory", '{"retained":"outside selected operation domains"}'))
            database.commit()
        finally:
            database.close()
        self.data = {"version": 1, "scope": "inventory-scope", "approved_legacy_ids": [], "catalog": {"coverage": {"exhaustive": False}},
                     "preservation": {"pins": {"complete": False, "items": [{"complete": True, "raw": {"asserted_user_pin": False}}]},
                                      "operations": {"complete": False, "items": []}}, "backup": {"verified": True, "reference": "backup:fixture"}}
        self.index_rows = []
        self.refresh_index()

    def refresh_index(self):
        database = sqlite3.connect(self.backup)
        database.row_factory = sqlite3.Row
        try:
            for table, raw in self.rows:
                row = database.execute("SELECT * FROM " + table + " WHERE operation_id=?", (raw["operation_id"],)).fetchone()
                payload = row["payload"].encode()
                retention = "backup:fixture/" + table + "/" + raw["operation_id"]
                self.index_rows.append({"table": table, "legacy_id": raw["operation_id"], "key": {"operation_id": raw["operation_id"]},
                    "payload_sha256": verifier.digest(payload), "payload_bytes": len(payload), "valid_json": True,
                    "row_metadata": {key: row[key] for key in row.keys() if key != "payload"}, "retention_ref": retention,
                    "current_terminal_outcome_verified": False})
                self.data["preservation"]["operations"]["items"].append({"legacy_id": raw["operation_id"], "raw": deepcopy(raw), "complete": False,
                    "references": [], "retention_ref": retention, "retention_verified": False, "terminal_verified": False})
        finally:
            database.close()
        self.freeze()

    def freeze(self, original_receipt=False):
        self.input.write_bytes(verifier.encoded(self.data))
        self.index.write_bytes(verifier.encoded(self.index_rows))
        receipt = {"version": 1, "mode": "read_only_pin_retention_verification", "output": {"input_sha256": verifier.file_digest(self.input)},
                   "inputs": {"database_sha256": verifier.file_digest(self.backup)}, "safeguards": {"backup_unchanged": True}}
        if original_receipt:
            receipt = {"version": 1, "mode": "read_only_inventory", "input": {"sha256": verifier.file_digest(self.input)},
                       "backup": {"database_verified": True, "database_sha256": verifier.file_digest(self.backup)}}
        self.summary.write_bytes(verifier.encoded(receipt))

    def run(self):
        return verifier.verify_operations(input_path=self.input, summary_path=self.summary, index_path=self.index, backup_path=self.backup, output_path=self.output)

    def updated(self):
        return json.loads((self.output / "input.json").read_bytes())


class CollectorFixture(Fixture):
    """Exercise the real Node collector, not a Python-generated storage index."""
    def __init__(self, reviews=True):
        super().__init__()
        backup_root = self.root / "backup"
        backup_root.mkdir()
        (backup_root / "objects").mkdir()
        original_backup = self.backup
        self.backup = backup_root / "state.sqlite"
        original_backup.rename(self.backup)
        self.review_payload = '{\r\n "kind":"review", "operation_id":"original-review", "state":"unknown",\r\n "reason":"UNRESOLVED_NO_REPLAY", "refs":["历史页面"], "extra":false\r\n}\n'
        database = sqlite3.connect(self.backup)
        try:
            database.execute("CREATE TABLE snapshots(id TEXT PRIMARY KEY,scope TEXT,record_identity TEXT,version_id TEXT,manifest TEXT,locator TEXT)")
            database.executemany("INSERT INTO upstream_commands VALUES (?,?)", [
                ("materialized:exact", json.dumps({"content_hash": "c" * 64, "portable": {"files": []}, "revision": "original-ref"})),
                ("markdown-files:member:original", json.dumps({"plan_id": "original-plan", "original_operation_id": "batch-fixture", "original_publication_id": "integrity-fixture"})),
                ("up_ab:accepted-config", json.dumps("original config\n")),
                ("broken-json", '{"incomplete":'),
            ])
            if reviews:
                database.execute("CREATE TABLE operation_reviews(id TEXT PRIMARY KEY,operation_id TEXT,state TEXT,payload TEXT)")
                database.executemany("INSERT INTO operation_reviews VALUES (?,?,?,?)", [
                    ("review-row-key", "original-review", "unknown", self.review_payload),
                    ("unrecognized-review", "unknown-review", "unknown", '["retained", false, 0]'),
                ])
            database.commit()
        finally:
            database.close()
        catalog = self.root / "catalog.json"
        catalog.write_bytes(verifier.encoded({"ok": True, "scope": "synthetic-inventory-scope", "records": [],
            "coverage": {"method": "explicit_database", "exhaustive": False, "queried_data_sources": [], "failed_sources": [], "search_index_limited": False}}))
        self.collector = Path(__file__).resolve().parent.parent / ".cursor/skills/verify-ntn-skills/scripts/shared-migration-inventory.ts"
        self.inventory = self.root / "inventory"
        command = [os.environ.get("MIGRATION_INVENTORY_NODE", "node"), str(self.collector), "--catalog", str(catalog),
                   "--backup", str(backup_root), "--target-library", "synthetic-target", "--run", str(self.inventory)]
        process = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)
        (self.root / "collector-process.json").write_bytes(verifier.encoded({"args": command, "code": process.returncode, "stdout": process.stdout, "stderr": process.stderr}))
        if process.returncode != 0:
            raise RuntimeError("Actual Node 24 collector failed: " + process.stdout + process.stderr)
        self.input, self.summary, self.index = (self.inventory / name for name in ("input.json", "summary.json", "operation-index.json"))
        self.data, self.index_rows = json.loads(self.input.read_bytes()), json.loads(self.index.read_bytes())

    def change_sidecar(self, field, mutate):
        names = {"index": "operation-storage-index.json", "reviews": "operation-reviews.json", "source_fingerprints": "source-fingerprints.json"}
        path = self.inventory / names[field]
        value = json.loads(path.read_bytes())
        mutate(value)
        path.write_bytes(verifier.encoded(value))
        summary = json.loads(self.summary.read_bytes())
        summary["operation_storage"][field]["sha256"] = verifier.file_digest(path)
        self.summary.write_bytes(verifier.encoded(summary))

    def pin_summary(self):
        original_summary = self.summary
        preceding = self.root / "pin-summary.json"
        preceding.write_bytes(verifier.encoded({"mode": "read_only_pin_retention_verification",
            "inputs": {"summary_sha256": verifier.file_digest(original_summary), "inventory_sha256": verifier.file_digest(self.input), "database_sha256": verifier.file_digest(self.backup)},
            "output": {"input_sha256": verifier.file_digest(self.input)}, "safeguards": {"backup_unchanged": True}}))
        self.summary = preceding
        return original_summary

    def run(self, inventory_summary=None):
        return verifier.verify_operations(input_path=self.input, summary_path=self.summary, index_path=self.index,
            backup_path=self.backup, output_path=self.output, inventory_summary_path=inventory_summary)


class OperationOriginTests(unittest.TestCase):
    def test_three_original_families_are_bound_without_mutating_payloads_or_promoting_local_completion(self):
        fixture = Fixture()
        before = deepcopy(fixture.data)
        source_bytes = {path: path.read_bytes() for path in (fixture.input, fixture.summary, fixture.index, fixture.backup)}
        result = fixture.run()
        self.assertEqual(result["counts"]["origins_verified"], 3)
        self.assertEqual(result["counts"]["unsettled_operations_unchanged"], 3)
        self.assertEqual(result["backup_enumeration"]["upstream_commands"], {"backup_rows": 2, "indexed_rows": 1})
        self.assertEqual(result["storage_inventory"]["status"], "not_observed")
        updated = fixture.updated()
        for item, (table, _) in zip(updated["preservation"]["operations"]["items"], fixture.rows):
            self.assertEqual(item["operation_origin"]["table"], table)
            self.assertTrue(item["retention_verified"])
            self.assertFalse(item["complete"])
            self.assertFalse(item["terminal_verified"])
            item["retention_verified"] = False
            del item["operation_origin"]
        self.assertEqual(updated, before)
        self.assertEqual({path: path.read_bytes() for path in source_bytes}, source_bytes)

    def test_a_payload_hash_or_scope_difference_cannot_receive_verified_provenance(self):
        fixture = Fixture()
        fixture.index_rows[0]["payload_sha256"] = "b" * 64
        fixture.data["preservation"]["operations"]["items"][1]["raw"]["scope"] = "invented-scope"
        fixture.freeze()
        result = fixture.run()
        self.assertEqual(result["counts"]["origins_verified"], 1)
        self.assertEqual(result["failures"], {"OPERATION_PAYLOAD_MISMATCH": 2})
        self.assertTrue(all(not item["terminal_verified"] for item in fixture.updated()["preservation"]["operations"]["items"]))

    def test_original_sql_metadata_and_nested_marker_identity_must_agree(self):
        fixture = Fixture()
        fixture.index_rows[1]["row_metadata"]["plan_id"] = "another-plan"
        database = sqlite3.connect(fixture.backup)
        try:
            database.execute("UPDATE integrity_operations SET publication_operation_id=?", ("another-publication",))
            database.commit()
        finally:
            database.close()
        fixture.index_rows[2]["row_metadata"]["publication_operation_id"] = "another-publication"
        fixture.freeze()
        self.assertEqual(fixture.run()["failures"], {"OPERATION_IDENTITY_MISMATCH": 1, "OPERATION_ROW_METADATA_MISMATCH": 1})

    def test_duplicate_index_items_and_existing_output_preserve_every_original_item(self):
        fixture = Fixture()
        fixture.index_rows.append(deepcopy(fixture.index_rows[0]))
        fixture.freeze()
        result = fixture.run()
        self.assertEqual(result["counts"]["operations"], 3)
        self.assertEqual(result["failures"], {"OPERATION_IDENTITY_CONFLICT": 1})
        self.assertEqual(len(fixture.updated()["preservation"]["operations"]["items"]), 3)
        with self.assertRaises(verifier.EvidenceError) as error:
            fixture.run()
        self.assertEqual(error.exception.code, "OUTPUT_EXISTS")

    def test_changed_input_or_backup_receipts_stop_before_output(self):
        for changed in ("input", "backup"):
            with self.subTest(changed=changed):
                fixture = Fixture()
                path = getattr(fixture, changed)
                path.write_bytes(path.read_bytes() + b"\n")
                with self.assertRaises(verifier.EvidenceError) as error:
                    fixture.run()
                self.assertEqual(error.exception.code, "INPUT_HASH_MISMATCH" if changed == "input" else "BACKUP_HASH_MISMATCH")
                self.assertFalse(fixture.output.exists())

    def test_original_inventory_receipt_also_binds_without_assuming_pin_enrichment(self):
        fixture = Fixture()
        fixture.freeze(original_receipt=True)
        self.assertEqual(fixture.run()["counts"]["origins_verified"], 3)

    def test_false_and_zero_are_distinct_original_json_payload_values(self):
        fixture = Fixture()
        fixture.data["preservation"]["operations"]["items"][0]["raw"]["retained_extra"]["external_assets"] = 0
        fixture.freeze()
        self.assertEqual(fixture.run()["failures"], {"OPERATION_PAYLOAD_MISMATCH": 1})

    def test_actual_collector_sidecars_verify_all_rows_and_retain_review_bytes_without_promoting_them(self):
        fixture = CollectorFixture()
        before, backup_sha = deepcopy(fixture.data), verifier.file_digest(fixture.backup)
        result = fixture.run()
        self.assertEqual(result["counts"]["origins_verified"], 3)
        storage = result["storage_inventory"]
        self.assertEqual(storage["status"], "verified")
        self.assertEqual(storage["table_counts"], {"upstream_commands": 6, "upstream_operations": 1, "integrity_operations": 1, "operation_reviews": 2})
        self.assertEqual((storage["row_count"], storage["selected_operation_rows"], storage["review_rows"]), (10, 3, 2))
        self.assertFalse(storage["references_complete"])
        self.assertEqual(storage["current_terminal_outcomes_verified"], 0)
        self.assertEqual(storage["collector_sha256"], verifier.file_digest(fixture.collector))
        self.assertEqual(result["software"]["verifier_sha256"], verifier.file_digest(Path(verifier.__file__)))
        self.assertEqual(result["software"]["evidence_helper_sha256"], verifier.file_digest(Path(verifier.evidence.__file__)))
        reviews = json.loads((fixture.output / "operation-reviews.json").read_bytes())
        self.assertEqual(reviews["items"][0]["payload_json"], fixture.review_payload)
        self.assertEqual(reviews["items"][0]["payload_sha256"], verifier.digest(fixture.review_payload.encode()))
        self.assertTrue(all(row["selected_for_plan"] is False and row["interpretation_complete"] is False for row in reviews["items"]))
        updated = fixture.updated()
        for item in updated["preservation"]["operations"]["items"]:
            del item["operation_origin"]
        self.assertEqual(updated, before)
        self.assertEqual(verifier.file_digest(fixture.backup), backup_sha)
        self.assertEqual(fixture.output.stat().st_mode & 0o777, 0o700)
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in fixture.output.iterdir()))
        for name in ("operation-storage-index.json", "operation-reviews.json", "source-fingerprints.json"):
            self.assertEqual((fixture.output / name).read_bytes(), (fixture.inventory / name).read_bytes())

    def test_missing_duplicate_reclassified_or_type_changed_rows_fail_even_with_rehashed_sidecar(self):
        for mutation in ("missing", "duplicate", "reclassified", "false-as-zero"):
            with self.subTest(mutation=mutation):
                fixture = CollectorFixture()
                def change(value):
                    if mutation == "missing":
                        value["rows"].pop(0)
                    elif mutation == "duplicate":
                        value["rows"].append(deepcopy(value["rows"][0]))
                    elif mutation == "reclassified":
                        next(row for row in value["rows"] if row["role"] == "support")["role"] = "plan_operation"
                    else:
                        value["rows"][0]["references_complete"] = 0
                fixture.change_sidecar("index", change)
                with self.assertRaises(verifier.EvidenceError) as error:
                    fixture.run()
                self.assertEqual(error.exception.code, "OPERATION_STORAGE_INCOMPLETE")
                self.assertFalse(fixture.output.exists())

    def test_review_archive_cannot_drop_a_row_or_reencode_its_original_json_bytes(self):
        for mutation in ("missing", "reencoded"):
            with self.subTest(mutation=mutation):
                fixture = CollectorFixture()
                def change(value):
                    if mutation == "missing":
                        value["items"].pop()
                    else:
                        value["items"][0]["payload_json"] = json.dumps(json.loads(value["items"][0]["payload_json"]), ensure_ascii=False)
                fixture.change_sidecar("reviews", change)
                with self.assertRaises(verifier.EvidenceError) as error:
                    fixture.run()
                self.assertEqual(error.exception.code, "OPERATION_REVIEW_RETENTION_MISMATCH")
                self.assertFalse(fixture.output.exists())

    def test_selected_operation_index_must_remain_exactly_the_original_sql_selection(self):
        fixture = CollectorFixture()
        fixture.index_rows.pop()
        fixture.index.write_bytes(verifier.encoded(fixture.index_rows))
        with self.assertRaises(verifier.EvidenceError) as error:
            fixture.run()
        self.assertEqual(error.exception.code, "OPERATION_STORAGE_SELECTION_MISMATCH")
        self.assertFalse(fixture.output.exists())

    def test_sidecar_and_collector_source_fingerprint_hashes_are_bound(self):
        for mutation in ("sidecar-bytes", "collector-identity"):
            with self.subTest(mutation=mutation):
                fixture = CollectorFixture()
                if mutation == "sidecar-bytes":
                    path = fixture.inventory / "operation-storage-index.json"
                    path.write_bytes(path.read_bytes() + b"\n")
                else:
                    fixture.change_sidecar("source_fingerprints", lambda value: value["collector"].update(sha256="0" * 64))
                with self.assertRaises(verifier.EvidenceError) as error:
                    fixture.run()
                self.assertEqual(error.exception.code, "OPERATION_STORAGE_HASH_MISMATCH" if mutation == "sidecar-bytes" else "OPERATION_STORAGE_IDENTITY_MISMATCH")
                self.assertFalse(fixture.output.exists())

    def test_original_sidecars_can_follow_pin_enrichment_only_with_the_exact_original_receipt_chain(self):
        for valid in (True, False):
            with self.subTest(valid=valid):
                fixture = CollectorFixture()
                original_summary = fixture.pin_summary()
                if not valid:
                    summary = json.loads(fixture.summary.read_bytes())
                    summary["inputs"]["summary_sha256"] = "0" * 64
                    fixture.summary.write_bytes(verifier.encoded(summary))
                    with self.assertRaises(verifier.EvidenceError) as error:
                        fixture.run(original_summary)
                    self.assertEqual(error.exception.code, "OPERATION_STORAGE_RECEIPT_MISMATCH")
                    self.assertFalse(fixture.output.exists())
                else:
                    self.assertEqual(fixture.run(original_summary)["storage_inventory"]["status"], "verified")

    def test_an_absent_legacy_review_table_is_reported_as_absent_not_an_observed_empty_table(self):
        fixture = CollectorFixture(reviews=False)
        result = fixture.run()
        self.assertIsNone(result["storage_inventory"]["table_counts"]["operation_reviews"])
        self.assertEqual(result["storage_inventory"]["row_count"], 8)
        self.assertFalse(json.loads((fixture.output / "operation-reviews.json").read_bytes())["table_present"])


if __name__ == "__main__":
    unittest.main()
