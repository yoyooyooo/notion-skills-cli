#!/usr/bin/env python3
"""Assemble retained pilot review evidence offline; never execute a CLI or change approval/classification."""

import argparse
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import zipfile


class EvidenceError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise EvidenceError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def parse(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON property in retained evidence.")
            result[key] = value
        return result
    return json.loads(data.decode("utf-8"), object_pairs_hook=unique)


def relative(value):
    require(isinstance(value, str) and value and "\\" not in value and "\0" not in value,
            "Expected a normalized relative file path.")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts and str(path) == value,
            "Retained file path escapes its tree.")
    return value


def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(data)


class Inputs:
    def __init__(self, output=None):
        self.bindings = []
        self.output = output

    def bytes(self, item):
        path = Path(item["path"])
        require(path.is_absolute() and path.is_file() and not path.is_symlink(), "Read only an exact retained regular file.")
        require(self.output is None or not path.resolve().is_relative_to(self.output.resolve()), "An output cannot become original input evidence.")
        data = path.read_bytes()
        require(digest(data) == item["sha256"], "A frozen input changed: " + str(path))
        self.bindings.append({"path": str(path), "sha256": digest(data), "bytes": len(data)})
        return data

    def json(self, item):
        return parse(self.bytes(item))

    def unchanged(self):
        for item in self.bindings:
            require(digest(Path(item["path"]).read_bytes()) == item["sha256"], "An original input changed during assembly.")


def property_value(entry, name):
    value = entry["properties"].get(name, {})
    return value.get("text", value.get("value"))


def verified_source(raw, fixed):
    require(isinstance(fixed.get("files"), list), "The exact fixed Source file tree is missing.")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        names = [relative(item.filename) for item in infos]
        require(len(names) == len(set(names)) and len(names) <= 10_000 and sum(item.file_size for item in infos) <= 128 * 1024 * 1024,
                "Source ZIP has duplicate paths or exceeds the existing import bounds.")
        require(all(not item.is_dir() and not item.flag_bits & 1 and ((item.external_attr >> 16) & 0xf000) in (0, 0x8000) for item in infos),
                "Source ZIP must contain ordinary unencrypted files.")
        expected = {relative(item["path"]): item for item in fixed["files"]}
        require(len(expected) == len(fixed["files"]) and set(names) == set(expected) | {".ntn-skills.json"},
                "Source ZIP paths differ from the exact fixed tree plus its portable container manifest.")
        manifest = parse(archive.read(".ntn-skills.json"))
        require(manifest.get("format") == "ntn-skills" and manifest.get("version") == 2,
                "The retained Source container needs its existing portable v2 manifest.")
        result = {}
        for path, item in expected.items():
            data = archive.read(path)
            oid = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
            require(len(data) == item["bytes"] and oid == item["git_oid"] and item["source_path"] == fixed["root"] + "/" + path,
                    "Source bytes differ from the fixed Git path, size or blob OID.")
            result[path] = data
        return result


def native_items(config, inputs):
    if config is None:
        return {}
    summary = inputs.json(config["summary"])
    require(summary.get("mode") == "read_only_native_preimages" and summary.get("status") == "observed"
            and summary.get("native_pages") == 51 and summary.get("notion_write_requests") == 0,
            "Only the completed bounded 51-page read-only capture can supply these preimages.")
    root = Path(config["summary"]["path"]).parent
    found = {}
    for receipt in summary["preimages"]:
        item = inputs.json({"path": str(root / relative(receipt["file"])), "sha256": receipt["sha256"]})
        native = item["native_preimage"]
        raw_relative = "raw/" + Path(receipt["file"]).name
        require(native["retention_ref"] == str(Path(config["original_root"]) / raw_relative),
                "The original native retention reference changed; mirror location is not its identity.")
        raw = inputs.bytes({"path": str(root / raw_relative), "sha256": native["response_sha256"]})
        value = parse(raw)
        require(native.get("kind") == "notion_page_markdown" and native.get("api_version") == "2026-03-11"
                and native.get("markdown_version") == "default" and native.get("page_id") == item["page_id"]
                and native.get("request_path") == f"v1/pages/{item['page_id']}/markdown" and len(raw) == native["response_bytes"],
                "Native descriptor does not identify its exact original request/response.")
        require(value.get("object") == "page_markdown" and value.get("id") == item["page_id"]
                and isinstance(value.get("markdown"), str) and value.get("truncated") is False
                and value.get("unknown_block_ids") == [] and value.get("warnings", []) == [],
                "Native response is incomplete or has another exact identity.")
        require(digest(value["markdown"].replace("\r\n", "\n").encode()) == native["body_sha256"], "Native body checksum changed.")
        require(re.search(r"<unknown(?:\s|/?>)", value["markdown"], re.I) is None, "Native body contains unknown content.")
        key = (item["record_id"], item["snapshot_id"], relative(item["path"]))
        require(key not in found, "The native capture repeats one frozen record/path.")
        found[key] = (item, raw)
    require(len(found) == 51, "The native capture omitted a frozen path.")
    return found


def augment_entry(original, files, observation, facts):
    result = deepcopy(original)
    existing = {item["path"]: item for item in result["files"]}
    require(len(existing) == len(result["files"]), "Original managed file paths are ambiguous.")
    for file in files:
        before = existing.get(file["path"])
        if before is None:
            existing[file["path"]] = deepcopy(file)
            continue
        require(before["legacy_id"] == file["legacy_id"] and before.get("ownership") == file["ownership"],
                "Assembly cannot replace an original file identity or ownership.")
        if before.get("body") is not None:
            require(before["body"] == file["body"], "An existing frozen body needs separate review; it cannot be overwritten during assembly.")
        raw = deepcopy(before.get("raw", {}))
        require(isinstance(raw, dict), "Opaque original file raw evidence requires explicit integration.")
        require(all(key not in raw or raw[key] == value for key, value in file["raw"].items()),
                "A previous original raw fact cannot be overwritten by assembly.")
        raw.update(file["raw"])
        existing[file["path"]] = {**before, "body": file["body"], "raw": raw}
    result["files"] = sorted(existing.values(), key=lambda item: item["path"])
    metadata = deepcopy(result.get("metadata", {}))
    require(isinstance(metadata, dict) and "pilot_review_assembly" not in metadata,
            "Keep any previous assembly separately; do not overwrite its metadata evidence.")
    metadata["pilot_review_assembly"] = {"snapshot_id": observation["snapshot_id"], "ref": observation["ref"], **facts}
    result["metadata"] = metadata
    # These original values deliberately remain unchanged. This stage supplies
    # bytes and mappings, never an ownership/layout/activity or completeness decision.
    for key in ("record", "files_complete", "metadata_complete", "legacy_mode", "legacy_layout"):
        require(result.get(key) == original.get(key), "A semantic classification or completeness flag changed.")
    return result


def merge_full_input(base, proposals):
    draft = deepcopy(base)
    replacements = {entry["legacy_id"]: entry for entry in proposals}
    originals = [entry["legacy_id"] for entry in draft["catalog"]["entries"]]
    require(len(replacements) == len(proposals) and all(originals.count(key) == 1 for key in replacements),
            "Each proposal must update one exact original inventory identity.")
    draft["catalog"]["entries"] = [deepcopy(replacements.get(entry["legacy_id"], entry)) for entry in draft["catalog"]["entries"]]
    require(draft["approved_legacy_ids"] == base["approved_legacy_ids"] and draft["preservation"] == base["preservation"],
            "Approval or original preservation evidence changed.")
    return draft


def assemble(config, evidence_only=False):
    require(config.get("version") == 1 and config.get("format") == "migration-pilot-review-assembly",
            "Expected the bounded pilot assembly config.")
    output = Path(config["output"])
    require(output.is_absolute() and not output.exists() and not output.is_symlink(), "Output must be a new isolated directory.")
    inputs = Inputs(output)
    script_path = Path(__file__).resolve()
    inputs.bytes({"path": str(script_path), "sha256": digest(script_path.read_bytes())})
    subset, metadata = inputs.json(config["subset"]), inputs.json(config["metadata"])
    require(subset.get("approved_legacy_ids") == [] and len(subset.get("entries", [])) == 3, "Keep the exact three unapproved pilot entries.")
    entries = {item["legacy_id"]: item for item in subset["entries"]}
    base = None if evidence_only else inputs.json(config["base_input"])
    if base is not None:
        require(base.get("approved_legacy_ids") == [] and base.get("scope") == subset["scope"]
                and base.get("target_library_id") == subset["target_library_id"], "Original full input scope or approval changed.")
        original_entries = {item["legacy_id"]: item for item in base["catalog"]["entries"]}
        require(all(key in original_entries for key in entries), "The original full inventory does not contain every pilot.")
        entries = {key: original_entries[key] for key in entries}
    recovery = inputs.json(config["source_recovery_verification"])
    differences = inputs.json(config["doc_differences"])
    native = native_items(config.get("native_preimages"), inputs)
    require(len(config["pilots"]) == 3 and {item["legacy_id"] for item in config["pilots"]} == set(entries), "Do not expand the pilot scope.")
    for item in inputs.bindings:
        require(not Path(item["path"]).resolve().is_relative_to(output.resolve()), "Keep output separate from retained inputs.")
    output.mkdir(mode=0o700)
    proposals, reports = [], []
    for pilot in config["pilots"]:
        label = pilot["label"]
        require(re.fullmatch(r"[a-z][a-z0-9_-]*", label) is not None, "Invalid pilot output label.")
        original = entries[pilot["legacy_id"]]
        observed = inputs.json(pilot["observation"])
        require(observed.get("status") == "captured" and observed.get("legacy_id") == original["legacy_id"]
                and observed.get("scope") == subset["scope"] and observed.get("record", {}).get("id") == original["legacy_id"],
                "The current capture has another exact record/scope.")
        props = [item for item in metadata["entries"] if item["legacy_id"] == original["legacy_id"]]
        require(len(props) == 1 and props[0].get("status") == "verified", "Missing the retained complete metadata observation.")
        props = props[0]
        if original["record"]["locator"]["type"] == "notion_subscription":
            published = parse(property_value(props, "Published Members").encode())
            emitted = {item["member_key"] for item in published["members"]}
            declared = {item["member_key"] for item in published["source_manifest"]["members"]}
            report = {"label": label, "legacy_id": original["legacy_id"], "generated_body": True,
                      "current_snapshot_id": observed["snapshot_id"], "current_files": observed["files"],
                      "published_members": len(emitted), "source_manifest_members": len(declared),
                      "unpublished_source_members": sorted(declared - emitted),
                      "router_members_observation": observed.get("router_members_observation"),
                      "status_property": property_value(props, "Status"),
                      "blocked": ["generated_router_policy_required", "member_closure_incomplete", "new_member_page_bindings_unavailable"]}
            if pilot.get("current_directory"):
                for file in observed["files"]:
                    data = inputs.bytes({"path": str(Path(pilot["current_directory"]) / relative(file["path"])), "sha256": file["sha256"]})
                    require(len(data) == file["bytes"], "Generated Router bytes differ from the retained capture.")
                    write_new(output / label / "current-generated" / file["path"], data)
            proposals.append(deepcopy(original))
            reports.append(report)
            continue
        snapshot = inputs.json(pilot["snapshot"])
        require(snapshot["snapshot_id"] == observed["snapshot_id"] and snapshot["record"]["id"] == original["legacy_id"]
                and snapshot["version_id"] == observed["version_id"], "The retained snapshot differs from the public capture.")
        index = lambda items: {item["path"]: {"sha256": item["sha256"], "bytes": item["bytes"]} for item in items}
        require(index(snapshot["files"]) == index(observed["files"]), "The retained snapshot and observed file hashes differ.")
        references = {relative(item["path"]): item for item in snapshot["references"]}
        managed = {item["path"]: item for item in observed["files"] if item["role"] != "source_bundle"}
        require(len(references) == len(snapshot["references"]) and set(references) == set(managed), "The complete original page/path map differs from the captured logical tree.")
        inspected = inputs.json(pilot["fixed_source"])
        require(inspected.get("ok") is True and inspected.get("metadata_only") is True, "Fixed Source metadata did not succeed.")
        fixed = inspected["source"]
        zip_bytes = inputs.bytes(pilot["source_zip"])
        source = verified_source(zip_bytes, fixed)
        inventory = inputs.json(pilot["recovered_inventory"])
        require(set(inventory) == set(source) | {".ntn-skills.json"} and set(source) == set(managed), "Source recovery inventory has changed paths.")
        receipts = [item for item in recovery["items"] if item["snapshot_id"] == observed["snapshot_id"]]
        require(len(receipts) == 1 and receipts[0].get("identity_and_inventory_verified") is True
                and receipts[0]["inventory_sha256"] == pilot["recovered_inventory"]["sha256"]
                and receipts[0]["version_id"] == observed["version_id"],
                "Missing the exact prior public offline source-export verification.")
        write_new(output / label / "original-source.zip", zip_bytes)
        write_new(output / label / "fixed-source.json", encoded(fixed))
        old_files = {item["path"]: item for item in original["files"]}
        files, comparisons, missing_native = [], [], []
        for path in sorted(source):
            source_bytes, expected = source[path], inventory[path]
            if digest(source_bytes) == expected["sha256"] and len(source_bytes) == expected["bytes"]:
                data, derivation = source_bytes, "source_zip_bytes_equal_actual_source_export"
            else:
                override = Path(pilot["recovered_overrides_directory"]) / relative(path)
                data = inputs.bytes({"path": str(override), "sha256": expected["sha256"]})
                require(len(data) == expected["bytes"], "A retained differing authored export has another size.")
                derivation = "exact_retained_differing_source_export"
            write_new(output / label / "current-authored" / path, data)
            old = old_files.get(path)
            reference = references[path]
            raw = {"pilot_current_capture": {"snapshot_id": observed["snapshot_id"], "snapshot_manifest_sha256": pilot["snapshot"]["sha256"],
                   "page_id": reference["id"], "materialized_reference_sha256": digest(reference["markdown"].encode()),
                   "reference_representation": "materialized_reference_not_wire", "public_file": managed[path],
                   "authored_export_sha256": digest(data), "derivation": derivation}}
            pair = native.get((original["legacy_id"], observed["snapshot_id"], path))
            if pair is None:
                missing_native.append(path)
            else:
                item, wire = pair
                require(item["page_id"] == reference["id"] and item["original_file"]["sha256"] == managed[path]["sha256"]
                        and item["original_reference"]["sha256"] == digest(reference["markdown"].encode()),
                        "The new native capture is not bound to this exact frozen page/path/file.")
                raw["native_preimage"] = item["native_preimage"]
                write_new(output / label / "preimages" / (reference["id"] + ".default.json"), wire)
            body = {"complete": True, "sha256": digest(data), "bytes": len(data),
                    "retention_ref": str(output / label / "current-authored" / path), "retention_verified": True}
            text = data.decode("utf-8")
            if "\r\n" not in text and not re.search(r"<unknown(?:\s|/?>)", text, re.I):
                body["normalization_version"] = 1
            files.append({"legacy_id": old["legacy_id"] if old else f"reference-page-body:{reference['id']}:{path}",
                          "path": path, "ownership": old.get("ownership", "unknown") if old else "unknown", "body": body, "raw": raw})
            comparisons.append({"path": path, "source_sha256": digest(source_bytes), "current_authored_sha256": digest(data),
                                "exact_source_bytes": source_bytes == data, "ownership": files[-1]["ownership"],
                                "native_equals_saved_reference_bytes": None if pair is None else parse(pair[1])["markdown"] == reference["markdown"]})
        select = property_value(props, "Sync Mode")
        report = {"label": label, "legacy_id": original["legacy_id"], "snapshot_id": observed["snapshot_id"],
                  "managed_file_count": len(files), "native_preimages_available": len(files) - len(missing_native),
                  "native_equal_saved_reference_count": sum(item["native_equals_saved_reference_bytes"] is True for item in comparisons),
                  "missing_native_paths": missing_native, "source_exact_count": sum(item["exact_source_bytes"] for item in comparisons),
                  "comparisons": comparisons, "observed_sync_mode": select.get("name") if isinstance(select, dict) else select,
                  "source_type": property_value(props, "Source Type"), "upstream_revision": property_value(props, "Upstream Revision"),
                  "upstream_key": property_value(props, "Upstream Key"), "fixed_source": fixed,
                  "differences": [item for item in differences["items"] if item["path"] in source and digest(source[item["path"]]) == item["source_sha256"]],
                  "blocked": ["file_ownership_not_inferred_from_equal_bytes", "legacy_source_selector_conversion_required", "original_layout_and_complete_flags_retained", "legacy_active_page_evidence_required"]}
        if report["native_equal_saved_reference_count"] != len(files):
            report["blocked"].append("native_preimages_missing_or_different_from_frozen_snapshot")
        facts = {"source_exact_files": report["source_exact_count"], "managed_file_count": len(files),
                 "source_bytes_do_not_establish_ownership": True, "raw_preimages_available": len(files) - len(missing_native)}
        proposals.append(augment_entry(original, files, observed, facts))
        reports.append(report)
    if base is not None:
        draft = merge_full_input(base, proposals)
        write_new(output / "draft-input.json", encoded(draft))
    write_new(output / "entry-proposals.json", encoded(proposals))
    summary = {"version": 1, "mode": "offline_pilot_review_evidence_assembly", "status": "prepared_with_explicit_gaps",
               "approved_legacy_ids": [], "classification_changed": False, "complete_flags_changed": False,
               "remote_requests": 0, "cli_executed": False, "migration_executed": False,
               "full_input_retained": base is not None, "preservation_changed": False,
               "entries": reports, "native_capture_preserves_old_scope_only": True,
               "next": "Use only the exact public review command after resolving the reported policy/evidence gaps; this script never runs it."}
    inputs.unchanged()
    write_new(output / "input-bindings.json", encoded(inputs.bindings))
    write_new(output / "summary.json", encoded(summary))
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--evidence-only", action="store_true", help="Assemble retained evidence without reading or producing the full migration input")
    args = parser.parse_args()
    try:
        config_bytes = args.config.read_bytes()
        result = assemble(parse(config_bytes), args.evidence_only)
        require(args.config.read_bytes() == config_bytes, "The assembly config changed.")
        print(json.dumps({"ok": True, "status": result["status"], "remote_requests": 0, "entries": [{"label": item["label"], "managed_files": item.get("managed_file_count"), "source_exact": item.get("source_exact_count"), "native_preimages": item.get("native_preimages_available")} for item in result["entries"]]}))
    except (EvidenceError, OSError, ValueError, KeyError, UnicodeError, zipfile.BadZipFile) as error:
        print(json.dumps({"ok": False, "error": str(error), "remote_requests": 0, "partial_output_preserved": True}))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
