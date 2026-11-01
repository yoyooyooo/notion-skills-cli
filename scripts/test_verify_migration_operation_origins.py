"""Synthetic original-operation provenance tests; temporary fixtures are retained."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sqlite3
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


class OperationOriginTests(unittest.TestCase):
    def test_three_original_families_are_bound_without_mutating_payloads_or_promoting_local_completion(self):
        fixture = Fixture()
        before = deepcopy(fixture.data)
        source_bytes = {path: path.read_bytes() for path in (fixture.input, fixture.summary, fixture.index, fixture.backup)}
        result = fixture.run()
        self.assertEqual(result["counts"]["origins_verified"], 3)
        self.assertEqual(result["counts"]["unsettled_operations_unchanged"], 3)
        self.assertEqual(result["backup_enumeration"]["upstream_commands"], {"backup_rows": 2, "indexed_rows": 1})
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


if __name__ == "__main__":
    unittest.main()
