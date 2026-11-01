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
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import quote

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
STORAGE_TABLES = (*TABLES, "operation_reviews")
COMMAND_DOMAINS = ("subscription_add", "subscription_update", "subscription_remove", "upstream_fork", "upstream_track")


def storage_payload(payload):
    def invalid_constant(_value):
        raise ValueError("Non-JSON constant")
    try:
        raw, valid = json.loads(payload, parse_constant=invalid_constant), True
    except (json.JSONDecodeError, ValueError):
        raw, valid = payload, False
    kind = ("invalid" if not valid else "null" if raw is None else "object" if isinstance(raw, dict)
            else "array" if isinstance(raw, list) else "boolean" if isinstance(raw, bool)
            else "number" if isinstance(raw, (int, float)) else "string")
    return raw, valid, kind


def storage_family(table, key, raw, valid):
    """Match the collector's observed family, never infer impact or completion."""
    if table == "upstream_operations":
        return "upstream_batch", "plan_operation"
    if table == "integrity_operations":
        return "publication_integrity", "plan_operation"
    value = raw if isinstance(raw, dict) else {}
    if table == "operation_reviews":
        return ("operation_review", "review") if valid and value.get("kind") == "review" and isinstance(value.get("operation_id"), str) else ("unrecognized_review", "unclassified")
    if not valid:
        return "invalid_json", "unclassified"
    if value.get("domain") in COMMAND_DOMAINS:
        return "command:" + value["domain"], "plan_operation"
    if (key.startswith("materialized:") and sorted(value) == ["content_hash", "portable", "revision"]
            and isinstance(value.get("content_hash"), str) and re.fullmatch(r"[a-f0-9]{64}", value["content_hash"])
            and isinstance(value.get("revision"), str) and isinstance(value.get("portable"), dict)):
        return "materialized", "cache"
    prefixes = (
        ("content-adoption:member:", "content_adoption_member", "support", ("plan_id",)),
        ("content-adoption:publication:", "content_adoption_publication", "support", ("plan_id",)),
        ("content-adoption:plan:", "content_adoption_plan", "durable_history", ("plan", "state")),
        ("file-acceptance:", "file_acceptance", "durable_history", ("operation_id", "state")),
        ("map-checkpoint-adoption:plan:", "map_checkpoint_adoption_plan", "durable_history", ("domain", "plan_id")),
        ("map-checkpoint-adoption:receipt:", "map_checkpoint_adoption_receipt", "durable_history", ("domain", "operation_id")),
        ("markdown-files:member:", "markdown_files_member", "support", ("plan_id", "original_operation_id", "original_publication_id")),
        ("publication-body-completion:plan:", "publication_body_completion_plan", "durable_history", ("domain", "plan_id", "operation_id")),
        ("publication-supersede:new:", "publication_supersede_new", "support", ("plan_id", "old_operation_id")),
        ("publication-supersede:original:", "publication_supersede_original", "durable_history", ("plan_id", "state")),
        ("publication-supersede:plan:", "publication_supersede_plan", "durable_history", ("plan", "state")),
        ("source-rich-text-repair:member:", "source_rich_text_repair", "durable_history", ("domain", "phase", "plan")),
        ("source-root-completion:member:", "source_root_completion", "durable_history", ("domain", "phase", "plan")),
        ("source-root-fidelity:member:", "source_root_fidelity", "durable_history", ("domain", "phase", "plan")),
        ("upstream-observation:", "upstream_observation", "support", ("subscription", "members")),
        ("upstream-rebuild:", "upstream_rebuild", "durable_history", ("operation_id", "state")),
    )
    for prefix, family, role, fields in prefixes:
        if key.startswith(prefix) and all(field in value for field in fields):
            return family, role
    if re.fullmatch(r"uo_[a-f0-9]+:projections", key) and all(field in value for field in ("entries", "operation_id")):
        return "upstream_projections", "support"
    if re.fullmatch(r"up_[a-f0-9]+:accepted-config", key) and isinstance(raw, str):
        return "accepted_config", "support"
    if re.fullmatch(r"up_[a-f0-9]+:subscription-map:checkpoint", key) and all(field in value for field in ("published", "subscription_id", "version")):
        return "subscription_map_checkpoint", "support"
    if re.fullmatch(r"up_[a-f0-9]+:subscription-map(?::intended)?", key) and ("unpublished" in value or all(field in value for field in ("members", "plan_hash", "publisher_subscription_id", "revision", "source_manifest", "version"))):
        return ("subscription_map_intended" if key.endswith(":intended") else "subscription_map"), "support"
    return "unrecognized", "unclassified"


def verify_storage_index(database, database_sha, original_index, prior, summary_path, inventory_summary_path):
    # Read only fixed sibling filenames, never arbitrary paths from JSON payloads.
    receipt_path = inventory_summary_path or summary_path
    receipt_bytes = receipt_path.read_bytes()
    receipt = load_json(receipt_bytes)
    require(isinstance(receipt, dict), "OPERATION_STORAGE_RECEIPT_INVALID", "The original inventory receipt must be an object.")
    if inventory_summary_path is not None:
        require(receipt.get("mode") == "read_only_inventory", "OPERATION_STORAGE_RECEIPT_INVALID", "The storage receipt must be the original inventory summary.")
        if prior.get("mode") == "read_only_pin_retention_verification":
            require(prior.get("inputs", {}).get("summary_sha256") == digest(receipt_bytes)
                    and prior.get("inputs", {}).get("inventory_sha256") == receipt.get("input", {}).get("sha256"),
                    "OPERATION_STORAGE_RECEIPT_MISMATCH", "The storage receipt is not the original inventory bound by pin verification.")
        else:
            require(receipt_bytes == summary_path.read_bytes(), "OPERATION_STORAGE_RECEIPT_MISMATCH", "Use the exact original inventory receipt.")
    storage = receipt.get("operation_storage")
    if storage is None:
        return {"status": "not_observed", "reason": "No bound storage sidecar was supplied; selected origins do not prove full inventory."}, []
    require(isinstance(storage, dict) and encoded(storage.get("version")) == encoded(1),
            "OPERATION_STORAGE_RECEIPT_INVALID", "The storage receipt must use the supported schema.")
    require(receipt.get("mode") == "read_only_inventory" and receipt.get("backup", {}).get("database_sha256") == database_sha,
            "OPERATION_STORAGE_RECEIPT_MISMATCH", "The storage receipt belongs to another backup.")
    loaded, retained = {}, []
    for field, name in (("index", "operation-storage-index.json"), ("reviews", "operation-reviews.json"), ("source_fingerprints", "source-fingerprints.json")):
        data = receipt_path.parent.joinpath(name).read_bytes()
        binding = storage.get(field)
        require(isinstance(binding, dict) and digest(data) == binding.get("sha256"), "OPERATION_STORAGE_HASH_MISMATCH", "A storage sidecar differs from its original summary.")
        loaded[field] = load_json(data)
        retained.append((name, data))
    index, reviews, fingerprints = loaded["index"], loaded["reviews"], loaded["source_fingerprints"]
    require(all(isinstance(value, dict) for value in loaded.values())
            and isinstance(fingerprints.get("database"), dict) and isinstance(fingerprints.get("collector"), dict),
            "OPERATION_STORAGE_IDENTITY_MISMATCH", "The storage sidecars must be objects with explicit source identities.")
    require(encoded(index.get("version")) == encoded(1) and index.get("kind") == "operation_storage_index"
            and encoded(reviews.get("version")) == encoded(1) and reviews.get("kind") == "retained_operation_reviews"
            and index.get("database_sha256") == reviews.get("database_sha256") == fingerprints.get("database", {}).get("sha256") == database_sha
            and index.get("collector_sha256") == fingerprints.get("collector", {}).get("sha256")
            and isinstance(index.get("collector_sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", index["collector_sha256"])
            and index.get("selected_command_domains") == fingerprints.get("selected_command_domains") == list(COMMAND_DOMAINS),
            "OPERATION_STORAGE_IDENTITY_MISMATCH", "The storage schema, collector or backup identities disagree.")
    original_database = fingerprints.get("database", {}).get("path")
    require(isinstance(original_database, str) and Path(original_database).is_absolute(), "OPERATION_STORAGE_IDENTITY_MISMATCH", "The exact original backup path is absent.")
    selected_commands = {row[0] for row in database.execute("SELECT operation_id FROM upstream_commands WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.domain') END IN (?,?,?,?,?)", COMMAND_DOMAINS)}
    actual, review_items, table_counts = [], [], {}
    for table in STORAGE_TABLES:
        if database.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name=?", (table,)).fetchone() is None:
            table_counts[table] = None
            continue
        column = "id" if table == "operation_reviews" else "operation_id"
        table_counts[table] = 0
        for row in database.execute("SELECT * FROM " + table + " ORDER BY " + column):
            table_counts[table] += 1
            key, payload = row[column], row["payload"]
            require(isinstance(key, str) and key != "" and isinstance(payload, str), "OPERATION_STORAGE_ROW_INVALID", "A retained SQL row lacks its exact text key or payload.")
            raw, valid, kind = storage_payload(payload)
            family, role = storage_family(table, key, raw, valid)
            payload_bytes = payload.encode("utf-8")
            pointer = "sqlite-backup:" + original_database + "#database_sha256=" + database_sha + "&table=" + table + "&operation_or_snapshot_id=" + quote(key, safe="~!*'()-._") + "&payload_sha256=" + digest(payload_bytes)
            item = {"table": table, "key": {column: key}, "payload_sha256": digest(payload_bytes), "payload_bytes": len(payload_bytes),
                    "valid_json": valid, "json_type": kind, "top_level_keys": sorted(raw, key=lambda key: key.encode("utf-16-be", "surrogatepass")) if isinstance(raw, dict) else [],
                    "family": family, "role": role, "selected_for_plan": table != "operation_reviews" and (table != "upstream_commands" or key in selected_commands),
                    "row_metadata": {name: row[name] for name in row.keys() if name != "payload"}, "retention_ref": pointer,
                    "references_complete": False, "current_terminal_outcome_verified": False}
            actual.append(item)
            if table == "operation_reviews":
                review_items.append({**item, "payload_json": payload, "interpretation_complete": False})
    require(encoded(index.get("rows")) == encoded(actual) and encoded(index.get("table_counts")) == encoded(table_counts)
            and encoded(storage.get("table_counts")) == encoded(table_counts) and encoded(storage.get("row_count")) == encoded(len(actual))
            and index.get("references_complete") is False and encoded(index.get("current_terminal_outcomes_verified")) == encoded(0)
            and storage.get("references_complete") is False and encoded(storage.get("current_terminal_outcomes_verified")) == encoded(0)
            and storage.get("selected_operations_unchanged") is True
            and encoded(storage.get("families")) == encoded(dict(Counter(row["family"] for row in actual))),
            "OPERATION_STORAGE_INCOMPLETE", "The storage index omits, duplicates, reclassifies or changes an original row.")
    require(encoded(reviews.get("items")) == encoded(review_items) and reviews.get("interpretation_complete") is False
            and reviews.get("table_present") is (table_counts["operation_reviews"] is not None),
            "OPERATION_REVIEW_RETENTION_MISMATCH", "The separate review archive differs from its complete original rows and exact JSON bytes.")
    selected = [row for row in actual if row["selected_for_plan"]]
    selected_keys = [(row["table"], row["key"]["operation_id"]) for row in selected]
    original_keys = [(row.get("table"), row.get("key", {}).get("operation_id")) for row in original_index]
    require(Counter(selected_keys) == Counter(original_keys), "OPERATION_STORAGE_SELECTION_MISMATCH", "The sidecar must preserve exactly the original selected operation set.")
    by_key = {(row["table"], row["key"]["operation_id"]): row for row in selected}
    for row in original_index:
        current = by_key[(row["table"], row["key"]["operation_id"])]
        require(all(encoded(row.get(field)) == encoded(current[field]) for field in ("payload_sha256", "payload_bytes", "valid_json", "row_metadata", "retention_ref")),
                "OPERATION_STORAGE_SELECTION_MISMATCH", "An original selected row differs from the complete storage index.")
    return {"status": "verified", "row_count": len(actual), "table_counts": table_counts,
            "selected_operation_rows": len(selected), "review_rows": len(review_items),
            "unclassified_rows": sum(row["role"] == "unclassified" for row in actual),
            "inventory_summary_sha256": digest(receipt_bytes), "collector_sha256": index["collector_sha256"],
            "sidecars": {name: digest(data) for name, data in retained},
            "references_complete": False, "current_terminal_outcomes_verified": 0}, retained


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


def verify_operations(*, input_path, summary_path, index_path, backup_path, output_path, inventory_summary_path=None):
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
        storage_inventory, storage_sidecars = verify_storage_index(database, database_sha, index, prior, summary_path, inventory_summary_path)
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
              "storage_inventory": storage_inventory,
              "software": {"verifier_sha256": file_digest(Path(__file__)),
                           "evidence_helper_sha256": file_digest(Path(__file__).with_name("verify-migration-pin-retention.py"))},
              "failures": dict(sorted(Counter(row["code"] for row in receipts if row["status"] != "verified").items())),
              "output": {"input": "input.json", "input_sha256": digest(output_bytes),
                         "receipts": "operation-origins.jsonl", "receipts_sha256": digest(receipt_bytes)},
              "safeguards": {"apply_allowed": False, "production_writes": 0, "network_requests": 0,
                             "backup_unchanged": True, "raw_payloads_unchanged": True, "references_unchanged": True,
                             "complete_flags_unchanged": True, "terminal_outcomes_unchanged": True, "approved_scope_unchanged": True,
                             "storage_rows_not_promoted_to_operations": True}}
    output_path.mkdir(parents=True, exist_ok=False, mode=0o700)
    for name, data in (("operation-origins.jsonl", receipt_bytes), ("input.json", output_bytes), ("summary.json", encoded(result)), *storage_sidecars):
        with os.fdopen(os.open(output_path / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
            stream.write(data)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "input-summary", "index", "backup", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--inventory-summary", type=Path, help="Original inventory summary for sidecar verification after pin enrichment; fixed sibling sidecars are hash-bound, never inferred from a count.")
    args = parser.parse_args()
    try:
        result = verify_operations(input_path=args.input, summary_path=args.input_summary, index_path=args.index,
                                   backup_path=args.backup, output_path=args.output, inventory_summary_path=args.inventory_summary)
    except (EvidenceError, sqlite3.Error, json.JSONDecodeError, UnicodeError, OSError) as error:
        print(json.dumps({"ok": False, "code": error.code if isinstance(error, EvidenceError) else "EVIDENCE_UNREADABLE", "message": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0 if result["counts"]["unverified"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
