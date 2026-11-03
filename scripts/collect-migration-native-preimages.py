#!/usr/bin/env python3
"""Retain 51 exact native Markdown GET responses for two frozen migration snapshots.

This is a bounded observation, not an authorization or an atomic tree snapshot.
The retained snapshot references are materialized text, never original wire data.
"""

import importlib.util
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys


_helper_path = Path(__file__).with_name("collect-migration-router-metadata.py")
_spec = importlib.util.spec_from_file_location("native_preimage_metadata_helpers", _helper_path)
if _spec is None or _spec.loader is None:
    raise RuntimeError("Cannot load the existing read-only evidence helpers")
evidence = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(evidence)
EvidenceError, require = evidence.EvidenceError, evidence.require
digest, encoded, load_json = evidence.digest, evidence.encoded, evidence.load_json
API_VERSION = "2026-03-11"
HASH = re.compile(r"^[0-9a-f]{64}$")


def regular_bytes(path):
    require(stat.S_ISREG(path.lstat().st_mode), "INPUT_FILE_INVALID", "A frozen input must be a regular file.")
    return path.read_bytes()


def sync_file(path):
    with path.open("rb") as stream:
        os.fsync(stream.fileno())
    sync_directory(path.parent)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_new(path, data):
    evidence.write_new(path, data)
    sync_file(path)


def content_path(value):
    require(isinstance(value, str) and value and "\\" not in value and all(ord(char) >= 32 and ord(char) != 127 for char in value)
            and not value.startswith("/") and str(PurePosixPath(value)) == value
            and all(part not in (".", "..") for part in value.split("/")),
            "SNAPSHOT_PATH_INVALID", "A native reference must identify one exact relative file path.")
    return value


def prepare(snapshots):
    require(len(snapshots) == 2, "SNAPSHOT_SCOPE_INVALID", "Supply exactly the two frozen snapshots.")
    inputs, targets, all_ids, counts = [], [], set(), []
    for number, (filename, expected_hash) in enumerate(snapshots, 1):
        path = Path(filename)
        raw = regular_bytes(path)
        require(isinstance(expected_hash, str) and HASH.fullmatch(expected_hash) is not None
                and digest(raw) == expected_hash, "INPUT_CHANGED", "The snapshot differs from its frozen SHA256.")
        snapshot = load_json(raw)
        require(isinstance(snapshot, dict), "SNAPSHOT_INVALID", "A snapshot must be a JSON object.")
        record, refs, files = snapshot.get("record"), snapshot.get("references"), snapshot.get("files")
        require(isinstance(record, dict) and record.get("kind") == "skill" and isinstance(record.get("locator"), dict)
                and isinstance(refs, list) and isinstance(files, list),
                "SNAPSHOT_SCOPE_INVALID", "Only the retained native Skill snapshots are supported.")
        locator = record["locator"]
        require(locator.get("type") == "notion_page", "SNAPSHOT_SCOPE_INVALID", "A subscription is not a native body preimage.")
        main_id = evidence.page_id(locator.get("page_id"))
        require(record.get("id") == "notion_page:" + main_id
                and snapshot.get("entrypoint") == record.get("entrypoint") == "SKILL.md"
                and isinstance(snapshot.get("snapshot_id"), str)
                and re.fullmatch(r"s_[a-f0-9]{64}", snapshot["snapshot_id"]) is not None,
                "SNAPSHOT_IDENTITY_INVALID", "The original record, main page and snapshot identity must agree.")
        by_path = {}
        for file in files:
            require(isinstance(file, dict), "SNAPSHOT_FILE_INVALID", "A file descriptor is required.")
            name = content_path(file.get("path"))
            require(name not in by_path and isinstance(file.get("sha256"), str)
                    and HASH.fullmatch(file["sha256"]) is not None and type(file.get("bytes")) is int and file["bytes"] >= 0,
                    "SNAPSHOT_FILE_INVALID", "File descriptors must be unique and have an exact hash and byte count.")
            by_path[name] = file
        seen_paths = set()
        for ref in refs:
            require(isinstance(ref, dict) and isinstance(ref.get("markdown"), str),
                    "SNAPSHOT_REFERENCE_INVALID", "A materialized reference and page identity are required.")
            identity, name = evidence.page_id(ref.get("id")), content_path(ref.get("path"))
            require(identity == ref["id"] and identity not in all_ids and name not in seen_paths and name in by_path
                    and (identity == main_id) == (name == "SKILL.md"),
                    "SNAPSHOT_REFERENCE_INVALID", "The exact 51 page-to-path mappings must be unique and match the original main.")
            all_ids.add(identity)
            seen_paths.add(name)
            materialized = ref["markdown"].encode("utf-8")
            targets.append({"snapshot_input": number, "snapshot_id": snapshot["snapshot_id"], "record_id": record["id"],
                            "page_id": identity, "path": name, "request_path": "v1/pages/" + identity + "/markdown",
                            "original_reference": {"sha256": digest(materialized), "bytes": len(materialized),
                                                   "representation": "materialized_reference_not_wire"},
                            "original_file": by_path[name]})
        require("SKILL.md" in seen_paths and set(by_path) - seen_paths == {"ntn-skills-source.zip"},
                "SNAPSHOT_SCOPE_INVALID", "Only the separately retained Source ZIP may lack a native page.")
        counts.append(len(refs))
        inputs.append({"path": str(path.resolve()), "sha256": expected_hash, "bytes": len(raw),
                       "snapshot_id": snapshot["snapshot_id"], "references": len(refs),
                       "retained_file": "inputs/" + str(number).zfill(2) + "-snapshot.json", "raw": raw})
    require(sorted(counts) == [7, 44] and len(targets) == 51, "SNAPSHOT_SCOPE_INVALID",
            "This collector is bounded to the original 44 plus 7 native pages.")
    return inputs, targets



def observed(target, value, raw, response, output):
    try:
        wire = raw.decode("utf-8")
        require(not wire.startswith("\ufeff"), "NATIVE_RESPONSE_UTF8_INVALID", "The original response must be plain UTF-8 JSON.")
        body = value.get("markdown")
        require(value.get("object") == "page_markdown" and value.get("id") == target["page_id"]
                and isinstance(body, str) and value.get("truncated") is False
                and value.get("unknown_block_ids") == []
                and ("warnings" not in value or value["warnings"] == []),
                "NATIVE_RESPONSE_INCOMPLETE", "The exact native page Markdown response is incomplete or has another identity.")
        require(re.search(r"<unknown(?:[\s\ufeff]|/?>)", body, re.IGNORECASE) is None,
                "NATIVE_RESPONSE_INCOMPLETE", "The native Markdown contains an unsupported-content marker.")
        body_bytes = body.encode("utf-8")
        normalized = body.replace("\r\n", "\n").encode("utf-8")
    except UnicodeError:
        raise EvidenceError("NATIVE_RESPONSE_UTF8_INVALID", "Retain a valid UTF-8 response and native body.") from None
    return {**target, "native_preimage": {"kind": "notion_page_markdown", "page_id": target["page_id"],
                "api_version": API_VERSION, "markdown_version": "default", "request_path": target["request_path"],
                "retention_ref": str((output / response["file"]).resolve()), "response_sha256": response["sha256"],
                "response_bytes": response["bytes"], "body_sha256": digest(normalized)},
            "comparison": {"raw_markdown_sha256": digest(body_bytes), "normalization_version": 1,
                           "raw_markdown_equals_materialized_reference": digest(body_bytes) == target["original_reference"]["sha256"],
                           "normalized_body_equals_canonical_file": digest(normalized) == target["original_file"]["sha256"],
                           "equality_does_not_establish_historical_wire_or_ownership": True}}


def collect(*, snapshots, output_path, reader=None, check_only=False):
    inputs, targets = prepare(snapshots)
    output = Path(output_path)
    require(not output.exists() and not output.is_symlink(), "OUTPUT_EXISTS", "Use a new evidence directory; never resume or overwrite a run.")
    if check_only:
        return {"ok": True, "mode": "config_only", "native_pages": 51, "snapshot_reference_counts": [item["references"] for item in inputs],
                "api_version": API_VERSION, "markdown_version": "default", "network_requests": 0, "output_created": False}
    if reader is None:
        raise EvidenceError("COLLECTOR_RETIRED", evidence.RETIRED_MESSAGE)
    output.mkdir(mode=0o700)
    sync_directory(output.parent)
    for name in ("raw", "requests", "inputs", "preimages"):
        (output / name).mkdir(mode=0o700)
    for item in inputs:
        write_new(output / item["retained_file"], item["raw"])
    write_new(output / "input-bindings.json", encoded({"snapshots": [{key: value for key, value in item.items() if key != "raw"} for item in inputs],
                "collector_sha256": digest(regular_bytes(Path(__file__))), "helper_sha256": digest(regular_bytes(_helper_path)),
                "targets": targets, "api_version": API_VERSION, "markdown_version": "default"}))
    recorder, completed, attempted = evidence.Recorder(output, reader), [], 0
    try:
        with (output / "requests.jsonl").open("xb") as journal:
            os.chmod(output / "requests.jsonl", 0o600)
            for number, target in enumerate(targets, 1):
                stem = str(number).zfill(6)
                request = {"request": number, "method": "GET", "path": target["request_path"],
                           "page_id": target["page_id"], "snapshot_input": target["snapshot_input"],
                           "api_version": API_VERSION, "markdown_version": "default", "started_at": evidence.timestamp()}
                write_new(output / "requests" / (stem + ".request.json"), encoded(request))
                failure, item = None, None
                try:
                    attempted = number
                    value, _ = recorder.read(target["request_path"], "native_markdown_preimage")
                    response = recorder.requests[-1]["response"]
                    item = observed(target, value, (output / response["file"]).read_bytes(), response, output)
                except (EvidenceError, OSError, ValueError, UnicodeError) as error:
                    failure = error if isinstance(error, EvidenceError) else EvidenceError(
                        "EVIDENCE_IO_FAILED" if isinstance(error, OSError) else "INVALID_JSON_RESPONSE", "The native response could not be retained and observed.")
                finally:
                    raw_receipt = recorder.requests[-1] if len(recorder.requests) == number else {
                        **request, "status": "failed", "finished_at": evidence.timestamp(), "response_retention_failed": True}
                    receipt = {**raw_receipt, "request_sha256": digest(encoded(request)),
                               "api_version": API_VERSION, "markdown_version": "default"}
                    if "response" in receipt:
                        sync_file(output / receipt["response"]["file"])
                    if getattr(reader, "last_completion", None) is not None:
                        receipt["completion"] = reader.last_completion
                    receipt["raw_response_status"] = receipt["status"]
                    receipt["status"] = "observed" if failure is None else "failed"
                    receipt["validation"] = {"status": "observed"} if failure is None else {"status": "failed", "code": failure.code}
                    write_new(output / "requests" / (stem + ".receipt.json"), encoded(receipt))
                    journal.write(encoded(receipt))
                    journal.flush()
                    os.fsync(journal.fileno())
                if failure is not None:
                    raise failure
                write_new(output / "preimages" / (stem + ".json"), encoded(item))
                completed.append({"file": "preimages/" + stem + ".json", "sha256": digest(encoded(item)), "page_id": target["page_id"]})
        summary = {"version": 1, "mode": "read_only_native_preimages", "status": "observed", "native_pages": len(completed),
                   "get_requests": len(recorder.requests), "preimages": completed, "notion_write_requests": 0,
                   "scope_discovery_requests": 0, "atomic_snapshot": False, "original_references_are_wire_responses": False,
                   "migration_input_written": False, "ownership_or_approval_changed": False, "operation_outcomes_changed": False}
        write_new(output / "summary.json", encoded(summary))
        return summary
    except (EvidenceError, OSError) as error:
        stopped = {"version": 1, "mode": "read_only_native_preimages", "status": "stopped",
                   "code": error.code if isinstance(error, EvidenceError) else "EVIDENCE_IO_FAILED",
                   "get_requests": attempted, "native_pages_observed": len(completed),
                   "notion_write_requests": 0, "retry_permitted": False, "finished_at": evidence.timestamp()}
        write_new(output / "stopped.json", encoded(stopped))
        raise


def main():
    return evidence.retired_entrypoint()


if __name__ == "__main__":
    sys.exit(main())
