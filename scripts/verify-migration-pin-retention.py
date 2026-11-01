#!/usr/bin/env python3
"""Verify cached snapshot retention from an existing, frozen migration inventory.

Reads only the supplied inventory, audit, SQLite backup and backup objects. Writes
a new evidence directory; never opens the active state database or uses Notion.
By default only per-item retention evidence changes. --complete-observation also
completes supported original payload/reference observations. User pin designations,
approval scope, inventory completeness and operation outcomes are preserved.
"""

import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys


class EvidenceError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise EvidenceError(code, message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY", "Evidence contains a duplicate JSON key.")
        result[key] = value
    return result


def load_json(data):
    return json.loads(data, object_pairs_hook=unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(
                          EvidenceError("INVALID_JSON_NUMBER", "Evidence contains a non-finite number.")))


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("utf-8")


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def file_index(value, inventory=False):
    require(isinstance(value, list), "MANIFEST_INDEX_INVALID", "A complete file index must be an array.")
    result = []
    for item in value:
        require(isinstance(item, dict) and isinstance(item.get("path"), str)
                and item["path"] != "" and valid_hash(item.get("sha256"))
                and type(item.get("bytes")) is int and item["bytes"] >= 0
                and (not inventory or item.get("valid") is True),
                "MANIFEST_INDEX_INVALID", "A file index entry lacks an exact path, hash or byte length.")
        result.append((item["path"], item["sha256"], item["bytes"]))
    return result


UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
JS_TRIM = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def legacy_subscription_router_members(manifest, markdown):
    """Recognize the exact historical openSubscription/canonicalMain output."""
    record = manifest["record"]
    locator = record.get("locator", {})
    subscription_id = locator.get("subscription_id") if isinstance(locator, dict) else None
    require(record.get("kind") == "router" and isinstance(locator, dict) and locator.get("type") == "notion_subscription"
            and isinstance(subscription_id, str) and re.fullmatch(UUID, subscription_id) is not None
            and record.get("id") == "notion_subscription:" + subscription_id
            and record.get("ref") == "skill://upstream%3A" + subscription_id + "/ROUTER.md"
            and manifest.get("entrypoint") == record.get("entrypoint") == "ROUTER.md"
            and len(manifest.get("files", [])) == 1 and manifest["files"][0].get("path") == "ROUTER.md"
            and manifest.get("source_files", []) == [] and manifest.get("references", []) == []
            and "router_members" not in manifest,
            "LEGACY_ROUTER_LAYOUT_UNSUPPORTED", "The snapshot is not the exact historical single-file subscription Router layout.")
    name, description = record.get("name"), record.get("description")
    require(isinstance(name, str) and isinstance(description, str), "LEGACY_ROUTER_METADATA_INVALID",
            "The original Router metadata is not complete.")
    frontmatter = '---\n"description": ' + json.dumps(description, ensure_ascii=False) + '\n"name": ' + json.dumps(name, ensure_ascii=False) + '\n---\n\n'
    require(markdown.startswith(frontmatter), "LEGACY_ROUTER_BODY_UNPARSED",
            "The retained Router frontmatter differs from the exact original metadata projection.")
    body = markdown[len(frontmatter):]
    heading = description + "\n\n## Members\n\n"
    if body == heading.strip(JS_TRIM) + "\n":
        return []
    prefix = heading.lstrip(JS_TRIM)
    require(body.startswith(prefix) and body.endswith("\n"), "LEGACY_ROUTER_BODY_UNPARSED",
            "The complete original Members section was not recognized.")
    lines = body[len(prefix):-1].split("\n")
    delimiter = re.compile(r"\]\(skill://(" + UUID + r")/SKILL\.md\) — ")
    pattern = re.compile(r"- \[([^\r\n]+)\]\(skill://(" + UUID + r")/SKILL\.md\) — ([^\r\n]*)")
    members = []
    for line in lines:
        match = pattern.fullmatch(line)
        require(match is not None and len(delimiter.findall(line)) == 1, "LEGACY_ROUTER_BODY_UNPARSED",
                "A retained Members line is incomplete, ambiguous or outside the original generated format.")
        members.append("notion_page:" + match.group(2))
    require(members == sorted(set(members)), "LEGACY_ROUTER_MEMBERS_CONFLICT",
            "The generated member identities are duplicated or differ from the original stable order.")
    require(markdown == frontmatter + (heading + "\n".join(lines)).strip(JS_TRIM) + "\n",
            "LEGACY_ROUTER_BODY_UNPARSED", "The complete retained Router body did not round-trip exactly.")
    return members


def reference_assessment(manifest, item, generated_router_body=None):
    """Distinguish content references from retained native resource page IDs."""
    record = manifest["record"]
    references = {record["id"]}
    incomplete = []
    derived_members = None
    members = manifest.get("router_members", [])
    if record.get("kind") == "router" and "router_members" not in manifest:
        incomplete.append("router_members:missing")
        if generated_router_body is not None:
            try:
                derived_members = legacy_subscription_router_members(manifest, generated_router_body)
                references.update(derived_members)
                incomplete.remove("router_members:missing")
            except EvidenceError as error:
                incomplete.append("legacy_subscription_router:" + error.code)
    if not isinstance(members, list):
        incomplete.append("router_members:not_array")
    else:
        for index, member in enumerate(members):
            if not isinstance(member, dict) or not isinstance(member.get("id"), str) or not member["id"]:
                incomplete.append(f"router_members[{index}].id:invalid")
            else:
                references.add(member["id"])
    resources = manifest.get("references", [])
    resource_ids = []
    if not isinstance(resources, list):
        incomplete.append("references:not_array")
    else:
        for index, resource in enumerate(resources):
            if (not isinstance(resource, dict) or not isinstance(resource.get("id"), str)
                    or not isinstance(resource.get("path"), str)
                    or not isinstance(resource.get("markdown"), str)):
                incomplete.append(f"references[{index}]:invalid")
            else:
                resource_ids.append(resource["id"])
    known_fields = {
        "snapshot_id", "historical_snapshot_id", "scope", "record", "entrypoint", "version_id",
        "created_at", "files", "source_files", "source_projection", "markdown_files", "router_members", "references",
    }
    return {
        "original_payload_observed": True,
        "content_references": sorted(references),
        "missing_content_references": sorted(references - set(item["references"])),
        "retained_resource_page_ids": resource_ids,
        "unparsed_reference_fields": incomplete,
        "additional_manifest_fields": sorted(set(manifest) - known_fields),
        "derived_router_members": None if derived_members is None else {
            "format": "legacy_subscription_router_v1", "member_ids": derived_members,
            "source_file_sha256": manifest["files"][0]["sha256"],
        },
        "complete_flag_changed": False,
        "user_pin_designation_required_for_retention": False,
    }


def verify_pin(item, database, database_sha, audit, objects, object_cache):
    raw = item.get("raw")
    require(isinstance(raw, dict) and raw.get("evidence_kind") == "cached_snapshot_candidate",
            "CANDIDATE_KIND_UNSUPPORTED", "This verifier only handles the original cached snapshot candidate shape.")
    provenance = raw.get("backup_row")
    require(isinstance(provenance, dict) and provenance.get("table") == "snapshots"
            and provenance.get("database_sha256") == database_sha
            and provenance.get("key") == {"id": item["legacy_id"]},
            "BACKUP_ROW_MISMATCH", "The candidate does not identify this exact backup snapshot row.")
    row = database.execute(
        "SELECT id,scope,record_identity,version_id,locator,manifest FROM snapshots WHERE id=?",
        (item["legacy_id"],),
    ).fetchone()
    require(row is not None, "BACKUP_ROW_MISSING", "The original snapshot row is absent from the supplied backup.")
    require(isinstance(row["manifest"], str), "MANIFEST_INVALID", "The original manifest is not retained as text.")
    manifest_bytes = row["manifest"].encode("utf-8")
    manifest_sha = digest(manifest_bytes)
    require(manifest_sha == provenance.get("manifest_sha256")
            and len(manifest_bytes) == provenance.get("manifest_bytes"),
            "MANIFEST_HASH_MISMATCH", "The exact original manifest bytes differ from the frozen inventory.")
    manifest = load_json(manifest_bytes)
    require(isinstance(manifest, dict) and isinstance(manifest.get("record"), dict),
            "MANIFEST_INVALID", "The original manifest has no content record.")
    identity = {"snapshot_id": manifest.get("snapshot_id"), "scope": manifest.get("scope"),
                "record_id": manifest["record"].get("id"), "version_id": manifest.get("version_id")}
    require(identity == raw.get("manifest_identity")
            and identity == {"snapshot_id": row["id"], "scope": row["scope"],
                             "record_id": row["record_identity"], "version_id": row["version_id"]}
            and raw.get("scope") == row["scope"] and raw.get("record_identity") == row["record_identity"]
            and raw.get("version_id") == row["version_id"]
            and raw.get("locator_serialized") == row["locator"],
            "MANIFEST_IDENTITY_MISMATCH", "Snapshot, scope, content identity, version or locator differs from its exact row.")
    require(isinstance(identity["record_id"], str) and identity["record_id"] != "",
            "MANIFEST_IDENTITY_MISMATCH", "The retained snapshot has no exact content identity.")
    if row["locator"] is not None:
        require(load_json(row["locator"]) == manifest["record"].get("locator"),
                "MANIFEST_IDENTITY_MISMATCH", "The manifest locator differs from its original row.")
    require(isinstance(item.get("retention_ref"), str) and item["retention_ref"] != "",
            "RETENTION_REFERENCE_MISSING", "Retain the original backup-row reference before verifying its bytes.")

    verified_files = {}
    for field in ("files", "source_files"):
        expected = file_index(manifest.get(field, []))
        observed = file_index(raw.get(field), inventory=True)
        require(Counter(expected) == Counter(observed), "MANIFEST_INDEX_MISMATCH",
                f"The frozen {field} index is not the complete exact original manifest index.")
        verified_files[field] = []
        for logical_path, sha, size in expected:
            evidence = audit.get(sha)
            require(evidence is not None and evidence["row"].get("verified") is True
                    and evidence["row"].get("actual_sha256") == sha
                    and type(evidence["row"].get("bytes")) is int and evidence["row"]["bytes"] == size,
                    "OBJECT_AUDIT_MISMATCH", "An exact manifest object has no matching verified original audit row.")
            if sha not in object_cache:
                location = objects / sha
                require(location.is_file() and not location.is_symlink(), "OBJECT_UNAVAILABLE",
                        "An exact object is absent from the supplied backup object directory.")
                object_cache[sha] = (file_digest(location), location.stat().st_size)
            actual_sha, actual_size = object_cache[sha]
            require(actual_sha == sha and actual_size == size, "OBJECT_BYTES_MISMATCH",
                    "An object differs from its original exact hash or size, despite the old audit.")
            verified_files[field].append({"path": logical_path, "sha256": sha, "bytes": size,
                                           "audit_line": evidence["line"]})
    generated_router_body = None
    locator = manifest["record"].get("locator")
    if (manifest["record"].get("kind") == "router" and "router_members" not in manifest
            and isinstance(locator, dict) and locator.get("type") == "notion_subscription"
            and len(verified_files["files"]) == 1 and verified_files["files"][0]["path"] == "ROUTER.md"):
        main = verified_files["files"][0]
        data = (objects / main["sha256"]).read_bytes()
        require(digest(data) == main["sha256"] and len(data) == main["bytes"], "OBJECT_BYTES_MISMATCH",
                "The retained Router object changed before its original references could be observed.")
        try:
            generated_router_body = data.decode("utf-8", errors="strict")
        except UnicodeError:
            pass
    return {
        "version": 1, "legacy_id": item["legacy_id"], "status": "verified",
        "database_sha256": database_sha, "table": "snapshots", "key": {"id": row["id"]},
        "manifest_sha256": manifest_sha, "manifest_bytes": len(manifest_bytes),
        **verified_files, "reference_assessment": reference_assessment(manifest, item, generated_router_body),
    }


def verify_inventory(*, input_path, summary_path, audit_path, backup_path, objects_path, output_path, complete_observation=False):
    input_bytes, summary_bytes, audit_bytes = input_path.read_bytes(), summary_path.read_bytes(), audit_path.read_bytes()
    original, prior = load_json(input_bytes), load_json(summary_bytes)
    require(isinstance(original, dict) and original.get("version") == 1
            and isinstance(prior, dict) and prior.get("mode") == "read_only_inventory",
            "INVENTORY_INVALID", "Use a version-1 frozen input and its original read-only inventory summary.")
    require(digest(input_bytes) == prior.get("input", {}).get("sha256"), "INPUT_HASH_MISMATCH",
            "The supplied input is not the exact input frozen by the original collector.")
    require(digest(audit_bytes) == prior.get("objects", {}).get("sha256"), "AUDIT_HASH_MISMATCH",
            "The supplied object audit differs from its original collector receipt.")
    require(not output_path.exists(), "OUTPUT_EXISTS", "Choose a new evidence directory; existing output is never overwritten.")
    require(prior.get("backup", {}).get("database_verified") is True, "BACKUP_UNVERIFIED",
            "The original collector did not verify this backup database.")
    database_sha = file_digest(backup_path)
    require(database_sha == prior["backup"].get("database_sha256"), "BACKUP_HASH_MISMATCH",
            "The supplied backup differs from the frozen original database.")
    audit = {}
    for line_number, line in enumerate(audit_bytes.splitlines(), 1):
        if not line.strip():
            continue
        row = load_json(line)
        require(isinstance(row, dict) and valid_hash(row.get("sha256")), "AUDIT_INVALID",
                "An object audit row lacks its exact content hash.")
        require(row["sha256"] not in audit, "AUDIT_DUPLICATE", "The audit repeats an object identity.")
        audit[row["sha256"]] = {"row": row, "line": line_number}
    pins = original.get("preservation", {}).get("pins", {}).get("items")
    require(isinstance(pins, list) and all(isinstance(pin, dict) and isinstance(pin.get("legacy_id"), str)
            and isinstance(pin.get("references"), list)
            and all(isinstance(ref, str) for ref in pin["references"]) for pin in pins),
            "PIN_INVENTORY_INVALID", "The input has no valid exact pin candidate inventory.")
    counts = Counter(pin["legacy_id"] for pin in pins)
    updated, receipts, object_cache = deepcopy(original), [], {}
    connection = sqlite3.connect(backup_path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        require(connection.execute("PRAGMA quick_check").fetchone()[0] == "ok", "BACKUP_INVALID",
                "The read-only backup failed SQLite quick_check.")
        snapshot_ids = {row[0] for row in connection.execute("SELECT id FROM snapshots")}
        coverage = {"snapshot_rows": len(snapshot_ids),
                    "snapshot_rows_missing_from_candidates": len(snapshot_ids - set(counts))}
        historical_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='historical_snapshot_mappings'"
        ).fetchone()
        if historical_table is not None:
            historical_ids = {row[0] for row in connection.execute("SELECT historical_id FROM historical_snapshot_mappings")}
            coverage.update({
                "historical_mapping_rows": len(historical_ids),
                "historical_mapping_rows_outside_candidates": len(historical_ids - set(counts)),
                "historical_mapping_payloads_different_from_snapshot": connection.execute(
                    "SELECT COUNT(*) FROM historical_snapshot_mappings AS h JOIN snapshots AS s ON s.id=h.historical_id WHERE h.manifest<>s.manifest"
                ).fetchone()[0],
            })
        for number, (item, replacement) in enumerate(zip(pins, updated["preservation"]["pins"]["items"]), 1):
            try:
                require(item["legacy_id"] != "" and counts[item["legacy_id"]] == 1,
                        "PIN_IDENTITY_CONFLICT", "The candidate identity is empty or duplicated; no row is discarded.")
                require(not isinstance(item.get("raw"), dict) or "retention_verification" not in item["raw"], "RETENTION_EVIDENCE_EXISTS",
                        "The input already contains retention verification; start from the frozen original inventory.")
                receipt = verify_pin(item, connection, database_sha, audit, objects_path, object_cache)
                replacement["retention_verified"] = True
                assessment = receipt["reference_assessment"]
                assessment["added_content_references"] = []
                if complete_observation:
                    if not assessment["unparsed_reference_fields"] and not assessment["additional_manifest_fields"]:
                        assessment["added_content_references"] = assessment["missing_content_references"]
                        replacement["references"].extend(assessment["added_content_references"])
                        assessment["missing_content_references"] = []
                        replacement["complete"] = True
                    else:
                        replacement["complete"] = False
                    assessment["complete_flag_changed"] = replacement["complete"] != item["complete"]
                receipt["observation_complete"] = not (assessment["unparsed_reference_fields"]
                    or assessment["additional_manifest_fields"] or assessment["missing_content_references"])
                replacement["raw"]["retention_verification"] = {
                    "version": 1, "kind": "exact_backup_snapshot_bytes",
                    "receipt_ref": output_path.resolve().joinpath("pin-retention.jsonl").as_uri() + f"#line={number}",
                    "receipt_sha256": digest(encoded(receipt)), "object_audit_sha256": digest(audit_bytes),
                    "database_sha256": database_sha,
                }
            except (EvidenceError, json.JSONDecodeError, UnicodeError, OSError) as error:
                replacement["retention_verified"] = False
                if complete_observation:
                    replacement["complete"] = False
                receipt = {"version": 1, "legacy_id": item["legacy_id"], "status": "unverified",
                           "code": error.code if isinstance(error, EvidenceError) else "EVIDENCE_UNREADABLE",
                           "message": str(error)}
            receipts.append(receipt)
    finally:
        connection.close()
    require(file_digest(backup_path) == database_sha, "BACKUP_CHANGED",
            "The backup changed during verification; no supplemented inventory was written.")
    receipt_bytes = b"".join(encoded(receipt) for receipt in receipts)
    output_bytes = encoded(updated)
    verified = [receipt for receipt in receipts if receipt["status"] == "verified"]
    result = {
        "version": 1, "mode": "read_only_pin_retention_verification",
        "complete_observation_requested": complete_observation,
        "inputs": {"inventory_sha256": digest(input_bytes), "summary_sha256": digest(summary_bytes),
                   "object_audit_sha256": digest(audit_bytes), "database_sha256": database_sha},
        "backup_enumeration": coverage,
        "counts": {"candidates": len(pins), "retention_verified": len(verified),
                   "unverified": len(receipts) - len(verified), "unique_objects_rechecked": len(object_cache),
                   "file_references_verified": sum(len(row["files"]) + len(row["source_files"]) for row in verified),
                   "complete_original_observations": sum(row["observation_complete"] for row in verified),
                   "item_complete_flags_updated": sum(row["reference_assessment"]["complete_flag_changed"] for row in verified),
                   "content_references_added": sum(len(row["reference_assessment"]["added_content_references"]) for row in verified),
                   "legacy_router_manifests_interpreted": sum(row["reference_assessment"]["derived_router_members"] is not None for row in verified),
                   "candidates_with_missing_content_references": sum(bool(row["reference_assessment"]["missing_content_references"]) for row in verified),
                   "candidates_with_unparsed_reference_fields": sum(bool(row["reference_assessment"]["unparsed_reference_fields"]) for row in verified),
                   "candidates_with_additional_manifest_fields": sum(bool(row["reference_assessment"]["additional_manifest_fields"]) for row in verified),
                   "candidates_with_complete_known_reference_index": sum(not row["reference_assessment"]["missing_content_references"]
                                                                         and not row["reference_assessment"]["unparsed_reference_fields"] for row in verified)},
        "failures": dict(sorted(Counter(row["code"] for row in receipts if row["status"] != "verified").items())),
        "output": {"input": "input.json", "input_sha256": digest(output_bytes),
                   "receipts": "pin-retention.jsonl", "receipts_sha256": digest(receipt_bytes)},
        "safeguards": {"apply_allowed": False, "network_requests": 0, "production_writes": 0,
                       "backup_unchanged": True, "complete_flags_unchanged": not complete_observation,
                       "inventory_complete_flags_unchanged": True,
                       "user_pin_designations_unchanged": True, "operation_outcomes_unchanged": True,
                       "approved_scope_unchanged": True},
    }
    output_path.mkdir(parents=True, exist_ok=False)
    for name, data in (("pin-retention.jsonl", receipt_bytes), ("input.json", output_bytes), ("summary.json", encoded(result))):
        with (output_path / name).open("xb") as stream:
            stream.write(data)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "summary", "audit", "backup", "objects", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--complete-observation", action="store_true",
                        help="Complete supported original pin payload/reference observations from exact retained evidence; preserve inventory scope and all other gates")
    args = parser.parse_args()
    try:
        result = verify_inventory(input_path=args.input, summary_path=args.summary, audit_path=args.audit,
                                  backup_path=args.backup, objects_path=args.objects, output_path=args.output,
                                  complete_observation=args.complete_observation)
    except (EvidenceError, sqlite3.Error, json.JSONDecodeError, UnicodeError, OSError) as error:
        print(json.dumps({"ok": False, "code": error.code if isinstance(error, EvidenceError) else "EVIDENCE_UNREADABLE",
                          "message": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    complete = result["counts"]["unverified"] == 0 and (not args.complete_observation
        or result["counts"]["complete_original_observations"] == result["counts"]["candidates"])
    return 0 if complete else 2


if __name__ == "__main__":
    sys.exit(main())
