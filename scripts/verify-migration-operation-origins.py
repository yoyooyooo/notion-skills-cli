#!/usr/bin/env python3
"""Bind retained migration operations to their exact original backup SQL family.

No remote calls or recovery actions. Original payloads, references, completeness,
scope and terminal outcome fields remain unchanged. Only original row provenance
and verified payload retention evidence are added to a new frozen input.
"""

import argparse
from collections import Counter
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys

# Reuse the existing local verifier's byte/JSON evidence helpers, never retained input code.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("_migration_evidence", Path(__file__).with_name("verify-migration-pin-retention.py"))
if spec is None or spec.loader is None:
    raise RuntimeError("The installed pin-retention evidence helpers are unavailable")
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)
EvidenceError, require = evidence.EvidenceError, evidence.require
digest, file_digest, load_json, encoded = evidence.digest, evidence.file_digest, evidence.load_json, evidence.encoded
TABLES = ("upstream_commands", "upstream_operations", "integrity_operations")


def input_identity(summary):
    if summary.get("mode") == "read_only_inventory":
        require(summary.get("backup", {}).get("database_verified") is True,
                "BACKUP_UNVERIFIED", "The original inventory did not verify its backup.")
        return summary.get("input", {}).get("sha256"), summary["backup"].get("database_sha256")
    if summary.get("mode") == "read_only_pin_retention_verification":
        require(summary.get("safeguards", {}).get("backup_unchanged") is True,
                "BACKUP_UNVERIFIED", "The preceding retention verifier did not bind an unchanged backup.")
        return summary.get("output", {}).get("input_sha256"), summary.get("inputs", {}).get("database_sha256")
    raise EvidenceError("INPUT_RECEIPT_UNSUPPORTED", "Supply the original inventory summary or its pin-retention output summary.")


def verify_row(item, index, database, database_sha):
    table, key = index.get("table"), index.get("key")
    operation_id = item["legacy_id"]
    require(table in TABLES and key == {"operation_id": operation_id} and index.get("legacy_id") == operation_id,
            "OPERATION_ROW_MISMATCH", "The index does not identify one exact supported original operation row.")
    row = database.execute("SELECT * FROM " + table + " WHERE operation_id=?", (operation_id,)).fetchone()
    require(row is not None and isinstance(row["payload"], str), "OPERATION_ROW_MISSING",
            "The exact original operation payload is absent from the supplied backup.")
    payload = row["payload"].encode("utf-8")
    require(digest(payload) == index.get("payload_sha256") and len(payload) == index.get("payload_bytes"),
            "OPERATION_PAYLOAD_MISMATCH", "The retained payload bytes differ from the original row index.")
    raw = load_json(payload)
    require(isinstance(raw, dict) and encoded(raw) == encoded(item.get("raw")) and raw.get("operation_id") == operation_id,
            "OPERATION_PAYLOAD_MISMATCH", "The complete original payload differs from the frozen migration item.")
    metadata = {column: row[column] for column in row.keys() if column != "payload"}
    require(metadata == index.get("row_metadata"), "OPERATION_ROW_METADATA_MISMATCH",
            "Original SQL identity columns differ from the frozen row index.")
    require(isinstance(item.get("retention_ref"), str) and item["retention_ref"] != ""
            and item["retention_ref"] == index.get("retention_ref"), "OPERATION_RETENTION_REFERENCE_MISMATCH",
            "The frozen item and original index do not retain the same exact backup-row reference.")
    if table == "upstream_operations":
        require(raw.get("plan_id") == row["plan_id"] and raw.get("state") == row["state"],
                "OPERATION_IDENTITY_MISMATCH", "The batch payload differs from its original SQL plan or state.")
    if table == "integrity_operations":
        marker = raw.get("marker")
        require(isinstance(marker, dict) and marker.get("operation_id") == operation_id
                and row["publication_operation_id"] == operation_id
                and marker.get("intended_hash") == raw.get("intended_hash") == row["intended_hash"]
                and marker.get("state") == row["state"] and raw.get("page_id") == row["page_id"],
                "OPERATION_IDENTITY_MISMATCH", "The integrity marker differs from its original row identity or state.")
    return {"version": 1, "table": table, "row_key": operation_id, "database_sha256": database_sha,
            "payload_sha256": digest(payload), "payload_bytes": len(payload), "row_metadata": metadata,
            "verified": True}


def verify_operations(*, input_path, summary_path, index_path, backup_path, output_path):
    input_bytes, summary_bytes, index_bytes = input_path.read_bytes(), summary_path.read_bytes(), index_path.read_bytes()
    original, prior, index = load_json(input_bytes), load_json(summary_bytes), load_json(index_bytes)
    require(isinstance(original, dict) and original.get("version") == 1 and isinstance(prior, dict),
            "INVENTORY_INVALID", "Use an exact version-1 migration inventory and its receipt.")
    input_sha, expected_database_sha = input_identity(prior)
    require(digest(input_bytes) == input_sha, "INPUT_HASH_MISMATCH", "The input differs from its exact preceding receipt.")
    require(not output_path.exists(), "OUTPUT_EXISTS", "Choose a new evidence directory; existing output is never overwritten.")
    require(isinstance(index, list) and all(isinstance(row, dict) and isinstance(row.get("legacy_id"), str) for row in index),
            "OPERATION_INDEX_INVALID", "The original operation row index is invalid.")
    items = original.get("preservation", {}).get("operations", {}).get("items")
    require(isinstance(items, list) and all(isinstance(item, dict) and isinstance(item.get("legacy_id"), str) for item in items),
            "OPERATION_INVENTORY_INVALID", "The input has no exact operation inventory.")
    counts, index_counts = Counter(item["legacy_id"] for item in items), Counter(row["legacy_id"] for row in index)
    by_id = {row["legacy_id"]: row for row in index}
    database_sha = file_digest(backup_path)
    require(database_sha == expected_database_sha, "BACKUP_HASH_MISMATCH", "The supplied backup differs from its original retained identity.")
    updated, receipts = deepcopy(original), []
    database = sqlite3.connect(backup_path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    database.row_factory = sqlite3.Row
    try:
        database.execute("PRAGMA query_only=ON")
        coverage = {table: {"backup_rows": database.execute("SELECT COUNT(*) FROM " + table).fetchone()[0],
                            "indexed_rows": sum(row.get("table") == table for row in index)} for table in TABLES}
        for number, (item, replacement) in enumerate(zip(items, updated["preservation"]["operations"]["items"]), 1):
            try:
                operation_id = item["legacy_id"]
                require(operation_id != "" and counts[operation_id] == 1 and index_counts[operation_id] == 1,
                        "OPERATION_IDENTITY_CONFLICT", "An operation identity is empty, repeated, or absent from its original index.")
                require("operation_origin" not in item, "OPERATION_ORIGIN_EXISTS", "Start from the frozen input before operation-origin enrichment.")
                origin = verify_row(item, by_id[operation_id], database, database_sha)
                receipt = {"version": 1, "legacy_id": operation_id, "status": "verified", "origin": origin,
                           "original_terminal_verified": item.get("terminal_verified"),
                           "current_terminal_outcome_verified": False, "automatic_replay": False}
                replacement["retention_verified"] = True
                replacement["operation_origin"] = {**origin,
                    "receipt_ref": output_path.resolve().joinpath("operation-origins.jsonl").as_uri()
                    + f"#line={number}&sha256={digest(encoded(receipt))}"}
            except (EvidenceError, json.JSONDecodeError, UnicodeError, OSError) as error:
                replacement["retention_verified"] = False
                receipt = {"version": 1, "legacy_id": item["legacy_id"], "status": "unverified",
                           "code": error.code if isinstance(error, EvidenceError) else "EVIDENCE_UNREADABLE", "message": str(error)}
            receipts.append(receipt)
    finally:
        database.close()
    require(file_digest(backup_path) == database_sha, "BACKUP_CHANGED", "The backup changed during observation; no output was written.")
    output_bytes, receipt_bytes = encoded(updated), b"".join(encoded(row) for row in receipts)
    verified = [row for row in receipts if row["status"] == "verified"]
    result = {"version": 1, "mode": "read_only_operation_origins",
              "inputs": {"inventory_sha256": digest(input_bytes), "summary_sha256": digest(summary_bytes),
                         "operation_index_sha256": digest(index_bytes), "database_sha256": database_sha},
              "counts": {"operations": len(items), "origins_verified": len(verified), "unverified": len(items) - len(verified),
                         "by_table": dict(sorted(Counter(row["origin"]["table"] for row in verified).items())),
                         "unsettled_operations_unchanged": sum(not item.get("terminal_verified") or not item.get("terminal_evidence") for item in items)},
              "backup_enumeration": coverage,
              "failures": dict(sorted(Counter(row["code"] for row in receipts if row["status"] != "verified").items())),
              "output": {"input": "input.json", "input_sha256": digest(output_bytes),
                         "receipts": "operation-origins.jsonl", "receipts_sha256": digest(receipt_bytes)},
              "safeguards": {"apply_allowed": False, "production_writes": 0, "network_requests": 0,
                             "backup_unchanged": True, "raw_payloads_unchanged": True, "references_unchanged": True,
                             "complete_flags_unchanged": True, "terminal_outcomes_unchanged": True, "approved_scope_unchanged": True}}
    output_path.mkdir(parents=True, exist_ok=False)
    for name, data in (("operation-origins.jsonl", receipt_bytes), ("input.json", output_bytes), ("summary.json", encoded(result))):
        with (output_path / name).open("xb") as stream:
            stream.write(data)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "input-summary", "index", "backup", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    try:
        result = verify_operations(input_path=args.input, summary_path=args.input_summary, index_path=args.index,
                                   backup_path=args.backup, output_path=args.output)
    except (EvidenceError, sqlite3.Error, json.JSONDecodeError, UnicodeError, OSError) as error:
        print(json.dumps({"ok": False, "code": error.code if isinstance(error, EvidenceError) else "EVIDENCE_UNREADABLE", "message": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0 if result["counts"]["unverified"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
