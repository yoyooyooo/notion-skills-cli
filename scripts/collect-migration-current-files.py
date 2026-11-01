#!/usr/bin/env python3
"""Read an exact, frozen three-record pilot through public CLI commands only.

No migration input is rewritten. No Source, approval or ownership is inferred.
This script uses the existing pin verifier's JSON/hash and Router format helpers.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import sys
import time


_spec = importlib.util.spec_from_file_location(
    "migration_pin_helpers", Path(__file__).with_name("verify-migration-pin-retention.py"))
_helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helpers)
EvidenceError, require = _helpers.EvidenceError, _helpers.require
digest, load_json, valid_hash = _helpers.digest, _helpers.load_json, _helpers.valid_hash


def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def write_json(path, value):
    write_new(path, (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode())


def regular_bytes(path):
    require(path.is_file() and not path.is_symlink(), "INPUT_NOT_REGULAR", "Read only regular files.")
    return path.read_bytes()


def content_path(value):
    require(isinstance(value, str) and value and "\\" not in value and "\0" not in value
            and not value.startswith("/") and str(PurePosixPath(value)) == value
            and ".." not in PurePosixPath(value).parts,
            "PATH_INVALID", "The public file path is not a normalized relative path.")
    return value


def load_config(path):
    config_bytes = regular_bytes(path)
    config = load_json(config_bytes)
    require(config.get("version") == 1 and config.get("format") == "ah498-migration-current-files",
            "CONFIG_INVALID", "Expected the read-only pilot config format.")
    require(isinstance(config.get("cliCommand"), list) and config["cliCommand"]
            and all(isinstance(x, str) and x for x in config["cliCommand"])
            and Path(config["cliCommand"][0]).is_absolute()
            and Path(config["cliCommand"][0]).is_file(), "CONFIG_INVALID", "Supply an existing CLI executable argv.")
    require(Path(config["cwd"]).is_absolute() and Path(config["cwd"]).is_dir(),
            "CONFIG_INVALID", "Supply the CLI's existing absolute working directory.")
    output = Path(config["output"])
    require(output.is_absolute() and not output.exists() and not output.is_symlink()
            and output.parent.is_dir(), "OUTPUT_NOT_FRESH", "Output must be a new directory.")
    timeout = config.get("timeoutSeconds", 600)
    require(type(timeout) is int and 1 <= timeout <= 1800, "CONFIG_INVALID", "Invalid command deadline.")
    if "notionBinary" in config:
        require(Path(config["notionBinary"]).is_absolute() and Path(config["notionBinary"]).is_file(),
                "CONFIG_INVALID", "Supply an existing official ntn executable or reviewed read-only wrapper.")
    sources, bindings = {}, {"config": {"path": str(path), "sha256": digest(config_bytes)}}
    for key in ("subset", "metadata", "pins"):
        item = config[key]
        source = Path(item["path"])
        require(source.is_absolute() and valid_hash(item.get("sha256")), "CONFIG_INVALID", "Frozen input needs an absolute path and SHA-256.")
        data = regular_bytes(source)
        require(digest(data) == item["sha256"], "INPUT_CHANGED", "A frozen input changed.")
        require(not source.resolve().is_relative_to(output.resolve()), "OUTPUT_OVERLAPS_INPUT", "The output contains an input.")
        sources[key], bindings[key] = load_json(data), {"path": str(source), "sha256": digest(data)}
    subset = sources["subset"]
    entries = subset.get("entries")
    require(subset.get("approved_legacy_ids") == [] and isinstance(entries, list) and len(entries) == 3
            and len({entry["legacy_id"] for entry in entries}) == 3,
            "PILOT_SCOPE_INVALID", "This proposal reads exactly three frozen, unapproved records.")
    require(valid_hash(subset.get("scope")), "PILOT_SCOPE_INVALID", "The frozen authentication scope is missing.")
    for entry in entries:
        record = entry["record"]
        locator = record["locator"]
        family = locator.get("type")
        native_id = locator.get("subscription_id" if family == "notion_subscription" else "page_id")
        require(family in ("notion_subscription", "notion_page")
                and record.get("id") == entry["legacy_id"] == family + ":" + str(native_id)
                and isinstance(record.get("ref"), str) and record["ref"].startswith("skill://")
                and record.get("entrypoint") in ("SKILL.md", "ROUTER.md"),
                "PILOT_SCOPE_INVALID", "An original record lacks its exact supported identity.")
        matches = [value for value in sources["metadata"]["entries"] if value["legacy_id"] == entry["legacy_id"]]
        require(len(matches) == 1 and matches[0].get("status") == "verified",
                "METADATA_MISSING", "The selected record needs its exact retained metadata observation.")
    bindings["helper"] = {"path": str(Path(_helpers.__file__).resolve()),
                          "sha256": digest(regular_bytes(Path(_helpers.__file__)))}
    bindings["collector"] = {"path": str(Path(__file__).resolve()),
                             "sha256": digest(regular_bytes(Path(__file__)))}
    return config, sources, bindings


def assert_inputs_unchanged(bindings):
    for item in bindings.values():
        require(digest(regular_bytes(Path(item["path"]))) == item["sha256"],
                "INPUT_CHANGED", "An original input or collector helper changed during collection.")


def compare_indexes(current, retained):
    before = {row["path"]: row for row in retained}
    after = {row["path"]: row for row in current}
    return {"added_paths": sorted(after.keys() - before.keys()),
            "absent_paths": sorted(before.keys() - after.keys()),
            "different_hash_paths": sorted(path for path in before.keys() & after.keys()
                                           if before[path]["sha256"] != after[path]["sha256"]),
            "equal_hash_paths": sorted(path for path in before.keys() & after.keys()
                                       if before[path]["sha256"] == after[path]["sha256"])}


class Collector:
    def __init__(self, config, sources, bindings):
        self.config, self.sources, self.bindings = config, sources, bindings
        self.output = Path(config["output"])
        self.sequence = 0
        self.env = dict(os.environ)
        for key, folder in (("NTN_SKILLS_CONFIG_HOME", "config"), ("NTN_SKILLS_HOME", "state"),
                            ("NTN_SKILLS_CACHE_HOME", "cache"), ("NTN_SKILLS_DATA_HOME", "data")):
            self.env[key] = str(self.output / "runtime" / folder)
        if config.get("notionBinary"):
            self.env["NTN_SKILLS_NTN_BIN"] = config["notionBinary"]

    def command(self, label, args):
        require(args[0] in ("read", "files", "export"), "COMMAND_INVALID", "Only public read commands are allowed.")
        self.sequence += 1
        folder = self.output / "commands" / (str(self.sequence).zfill(3) + "-" + label)
        folder.mkdir(parents=True, mode=0o700)
        argv = self.config["cliCommand"] + args
        write_json(folder / "request.json", {"argv": argv, "started_at_unix": time.time()})
        print(json.dumps({"stage": label, "command": args[0], "sequence": self.sequence}), flush=True)
        started = time.monotonic()
        child = subprocess.Popen(argv, cwd=self.config["cwd"], env=self.env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        timed_out = False
        try:
            stdout, stderr = child.communicate(timeout=self.config.get("timeoutSeconds", 600))
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGTERM)
            try:
                stdout, stderr = child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                stdout, stderr = child.communicate(timeout=5)
        code = child.returncode
        write_new(folder / "stdout.json", stdout)
        write_json(folder / "completion.json", {"exit_code": code, "timed_out": timed_out,
                   "elapsed_seconds": time.monotonic() - started, "stdout_sha256": digest(stdout),
                   "stderr_sha256": digest(stderr), "stderr_bytes": len(stderr), "stderr_retained": False})
        require(not timed_out and code == 0, "CLI_READ_FAILED", "The public read failed; its original output is retained. No retry is performed.")
        value = load_json(stdout)
        require(isinstance(value, dict) and value.get("ok") is True, "CLI_READ_FAILED", "The public read did not return ok=true.")
        return value

    def identity(self, value, original, pinned=None):
        record = value.get("record", {})
        require(record.get("id") == original["id"] and record.get("locator") == original["locator"]
                and record.get("kind") == original["kind"] and record.get("ref") == original["ref"]
                and value.get("entrypoint") == record.get("entrypoint") == original["entrypoint"]
                and value.get("scope") == self.sources["subset"]["scope"],
                "PUBLIC_IDENTITY_MISMATCH", "The public result differs from the exact original record/scope.")
        require(isinstance(value.get("snapshot_id"), str) and re.fullmatch(r"s_[a-f0-9]{64}", value["snapshot_id"])
                and isinstance(value.get("version_id"), str) and value["version_id"]
                and isinstance(value.get("ref"), str) and value["ref"] != original["ref"],
                "PUBLIC_PIN_MISSING", "The public result has no fixed snapshot identity.")
        require(value["ref"] == original["ref"] + "?snapshot=" + value["snapshot_id"],
                "PUBLIC_PIN_MISMATCH", "The returned main ref does not bind the original ref to this exact snapshot.")
        if pinned is not None:
            require(all(value.get(key) == pinned.get(key) for key in ("snapshot_id", "version_id", "ref", "record")),
                    "PUBLIC_PIN_MISMATCH", "Offline results must retain the exact captured snapshot and metadata.")
            require(value.get("source") == "local_snapshot" and value.get("freshness", {}).get("policy") == "pinned",
                    "PUBLIC_PIN_MISMATCH", "The subsequent result is not an immutable local snapshot.")

    def capture(self, number, entry):
        record = entry["record"]
        folder = self.output / "entries" / str(number).zfill(2)
        folder.mkdir(parents=True, mode=0o700)
        main = folder / "main.bin"
        locator = record["locator"]
        database = locator["target_database_id"] if locator["type"] == "notion_subscription" else locator["database_id"]
        read = self.command(str(number) + "-read", ["read", record["ref"], "--database", database,
                            "--refresh", "--output", str(main), "--metrics"])
        self.identity(read, record)
        require(read.get("source") == "notion" and read.get("freshness", {}).get("policy") == "refresh"
                and read.get("freshness", {}).get("validation") != "metadata",
                "CURRENT_READ_REQUIRED", "The first observation must be a complete online refresh.")
        main_bytes = regular_bytes(main)
        require(read.get("path") == record["entrypoint"] and read.get("bytes") == len(main_bytes),
                "MAIN_OUTPUT_MISMATCH", "The full main output differs from its read receipt.")
        files = self.command(str(number) + "-files", ["files", read["snapshot_id"], "--offline", "--metrics"])
        self.identity(files, record, read)
        exported = self.command(str(number) + "-export", ["export", read["snapshot_id"], "--offline",
                                "--projection", "snapshot", "--format", "directory", "--output", str(folder / "snapshot")])
        self.identity(exported, record, read)
        require(exported.get("operation") == "export" and exported.get("projection") == "snapshot"
                and exported.get("format") == "directory", "EXPORT_MISMATCH", "Expected the complete snapshot projection.")
        declared = exported.get("files", [])
        require(isinstance(declared, list) and declared, "EXPORT_MISMATCH", "The export has no complete file index.")
        index = {}
        for row in declared:
            path = content_path(row["path"])
            require(path not in index and valid_hash(row.get("hash")) and type(row.get("bytes")) is int,
                    "EXPORT_MISMATCH", "A declared file is duplicated or lacks its exact hash/size.")
            index[path] = row
        tree = []
        require((folder / "snapshot").is_dir() and not (folder / "snapshot").is_symlink(),
                "EXPORT_MISMATCH", "The snapshot export must be a real directory.")
        for path in sorted((folder / "snapshot").rglob("*")):
            require(not path.is_symlink(), "EXPORT_MISMATCH", "Export may not contain a symlink.")
            if path.is_dir():
                continue
            rel = path.relative_to(folder / "snapshot").as_posix()
            data = regular_bytes(path)
            row = index.get(rel)
            require(row is not None and row["bytes"] == len(data) and row["hash"] == digest(data),
                    "EXPORT_MISMATCH", "Exported bytes differ from the public complete index.")
            tree.append({"path": rel, "bytes": len(data), "sha256": digest(data), "role": row["role"],
                         "retention_ref": str(path.relative_to(self.output))})
        require(set(index) == {row["path"] for row in tree} and ".ntn-skills.json" in index,
                "EXPORT_MISMATCH", "The exported tree is incomplete.")
        current = [row for row in tree if row["path"] != ".ntn-skills.json"]
        listed = files.get("files", [])
        require(isinstance(listed, list) and len(listed) == len(current)
                and {row["path"]: row["bytes"] for row in listed} == {row["path"]: row["bytes"] for row in current}
                and len({row["path"] for row in listed}) == len(listed),
                "EXPORT_MISMATCH", "files and export do not contain the same complete snapshot tree.")
        require(regular_bytes(folder / "snapshot" / record["entrypoint"]) == main_bytes,
                "MAIN_OUTPUT_MISMATCH", "The exported main differs byte-for-byte from read --output.")
        manifest = load_json(regular_bytes(folder / "snapshot" / ".ntn-skills.json"))
        require(manifest.get("format") == "ntn-skills" and manifest.get("version") == 2
                and manifest.get("main") == read["entrypoint"] and manifest.get("kind") == read["record"]["kind"]
                and all(manifest.get(key) == read["record"].get(key) for key in ("name", "description")),
                "EXPORT_MISMATCH", "The portable manifest differs from the captured public metadata.")
        retained = self.sources["pins"]["selected"].get(entry["legacy_id"], [])
        comparisons = [{"snapshot_id": pin["legacy_id"], "manifest_sha256": pin["manifest_sha256"],
                        "retained_status": pin["status"], "retained_bytes_rehashed": False,
                        **compare_indexes(current, pin["files"])} for pin in retained]
        result = {"legacy_id": entry["legacy_id"], "status": "captured", "view": "public_snapshot",
                  "record": read["record"], "scope": read["scope"], "snapshot_id": read["snapshot_id"],
                  "version_id": read["version_id"], "ref": read["ref"], "freshness": read["freshness"],
                  "files": current, "portable_manifest": next(row for row in tree if row["path"] == ".ntn-skills.json"),
                  "metadata_changed_from_inventory": read["record"] != record,
                  "retained_pin_index_comparisons": comparisons,
                  "current_native_preimage": "not_asserted", "classification": "unchanged",
                  "request_metrics": {"read": read.get("request_metrics"), "files": files.get("request_metrics"),
                                      "export": "not_exposed_by_command", "http_attachment_requests": "not_separately_measured"}}
        if locator["type"] == "notion_subscription":
            try:
                result["observed_router_members"] = _helpers.legacy_subscription_router_members(
                    {"record": read["record"], "entrypoint": read["entrypoint"], "files": current}, main_bytes.decode("utf-8"))
                result["router_members_observation"] = "parsed_existing_exact_format"
            except (EvidenceError, UnicodeDecodeError) as error:
                # Complete file bytes do not depend on recognizing a derived
                # Members display format. An unfamiliar format stays explicit.
                result["router_members_observation"] = "unparsed"
                result["router_members_code"] = getattr(error, "code", "ROUTER_TEXT_UNPARSED")
        write_json(folder / "observation.json", result)
        return result

    def run(self):
        self.output.mkdir(mode=0o700)
        write_json(self.output / "input-bindings.json", self.bindings)
        for path in (self.output / "runtime" / key for key in ("config", "state", "cache", "data")):
            path.mkdir(parents=True, mode=0o700)
        results = []
        for number, entry in enumerate(self.sources["subset"]["entries"], 1):
            try:
                results.append(self.capture(number, entry))
            except (EvidenceError, OSError, ValueError, KeyError, TypeError) as error:
                result = {"legacy_id": entry["legacy_id"], "status": "stopped",
                          "code": getattr(error, "code", "OBSERVATION_FAILED"),
                          "message": "This entry stopped; original output and partial local artifacts are retained. No retry or operation recovery."}
                write_json(self.output / "entries" / str(number).zfill(2) / "stopped.json", result)
                results.append(result)
        assert_inputs_unchanged(self.bindings)
        summary = {"version": 1, "mode": "read_only_current_file_pilot", "status": "complete" if all(x["status"] == "captured" for x in results) else "partial",
                   "entries": results, "cli_invocations": self.sequence,
                   "input_unchanged": True, "approved_legacy_ids": [], "production_mutations_requested": 0,
                   "migration_executed": False, "operation_recovery_requested": False,
                   "classification_changed": False, "atomic_snapshot": False,
                   "limitations": ["snapshot bytes are the public materialized files, not asserted raw native Markdown or current selected Source",
                                   "retained pin indices are collection-order samples, not asserted chronological latest or current bytes",
                                   "CLI request metrics are not a complete count of attachment downloads"]}
        write_json(self.output / "summary.json", summary)
        return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()
    config, sources, bindings = load_config(args.config.resolve())
    if args.check_config:
        print(json.dumps({"ok": True, "mode": "config_only", "records": len(sources["subset"]["entries"]),
                          "network_requests": 0, "input_unchanged": True, "output_created": False}))
        return 0
    result = Collector(config, sources, bindings).run()
    print(json.dumps({"ok": result["status"] == "complete", "status": result["status"],
                      "summary": str(Path(config["output"]) / "summary.json")}))
    return 0 if result["status"] == "complete" else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (EvidenceError, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"ok": False, "code": getattr(error, "code", "COLLECTION_FAILED"),
                          "message": "The frozen read-only pilot could not complete; existing evidence is retained."}))
        sys.exit(1)
