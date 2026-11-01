#!/usr/bin/env python3
"""One explicit Router observation after a completed pilot lacked its local database bootstrap."""

import argparse
import importlib.util
import json
from pathlib import Path
import sys


_spec = importlib.util.spec_from_file_location(
    "current_files_pilot", Path(__file__).with_name("collect-migration-current-files.py"))
pilot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pilot)


def has_operation_id(value):
    if isinstance(value, dict):
        return any((key.endswith("operation_id") and item not in (None, "")) or has_operation_id(item)
                   for key, item in value.items())
    return isinstance(value, list) and any(has_operation_id(item) for item in value)


def prepare(path):
    config, sources, bindings = pilot.load_config(path)
    previous = config["previousRun"]
    prior_root, output = Path(previous["path"]), Path(config["output"])
    pilot.require(prior_root.is_absolute() and prior_root.is_dir()
                  and not output.resolve().is_relative_to(prior_root.resolve())
                  and not prior_root.resolve().is_relative_to(output.resolve()),
                  "FOLLOWUP_SCOPE_INVALID", "The new output must be separate from the completed original run.")
    pilot.require(pilot.valid_hash(previous.get("summary_sha256")),
                  "FOLLOWUP_SUMMARY_REQUIRED", "Bind the final original summary before starting a follow-up.")

    def retain(key, file, expected=None):
        data = pilot.regular_bytes(file)
        sha = pilot.digest(data)
        pilot.require(expected is None or sha == expected, "INPUT_CHANGED", "Original evidence changed.")
        bindings[key] = {"path": str(file), "sha256": sha}
        return pilot.load_json(data)

    summary = retain("previous_summary", prior_root / "summary.json", previous["summary_sha256"])
    prior_bindings = retain("previous_input_bindings", prior_root / "input-bindings.json")
    for key in ("subset", "metadata", "pins"):
        pilot.require(prior_bindings[key]["sha256"] == bindings[key]["sha256"],
                      "FOLLOWUP_SCOPE_INVALID", "The follow-up must retain the original exact three inputs.")
    pilot.assert_inputs_unchanged(prior_bindings)
    bindings.update({"previous_input_" + key: value for key, value in prior_bindings.items()})
    entries = sources["subset"]["entries"]
    routers = [(number, entry) for number, entry in enumerate(entries, 1)
               if entry["record"]["locator"]["type"] == "notion_subscription"]
    pilot.require(len(routers) == 1, "FOLLOWUP_SCOPE_INVALID", "Select the sole original subscription Router.")
    number, router = routers[0]
    prior_entries = summary.get("entries", [])
    pilot.require(summary.get("mode") == "read_only_current_file_pilot" and summary.get("status") == "partial"
                  and summary.get("input_unchanged") is True and summary.get("approved_legacy_ids") == []
                  and len(prior_entries) == 3
                  and {item["legacy_id"] for item in prior_entries} == {item["legacy_id"] for item in entries}
                  and all(item.get("status") in ("captured", "stopped") for item in prior_entries),
                  "FOLLOWUP_SUMMARY_REQUIRED", "The original three-entry run has not finished with a bound final summary.")
    prior_router = next(item for item in prior_entries if item["legacy_id"] == router["legacy_id"])
    pilot.require(prior_router.get("status") == "stopped", "FOLLOWUP_NOT_NEEDED", "The original Router was not a failed observation.")
    record, locator = router["record"], router["record"]["locator"]
    tail = ["read", record["ref"], "--database", locator["target_database_id"], "--refresh", "--output",
            str(prior_root / "entries" / str(number).zfill(2) / "main.bin"), "--metrics"]
    requests = []
    for file in sorted((prior_root / "commands").glob("*/request.json")):
        request = pilot.load_json(pilot.regular_bytes(file))
        if request.get("argv") == config["cliCommand"] + tail:
            requests.append(file)
    pilot.require(len(requests) == 1, "FOLLOWUP_ORIGIN_INVALID", "Require the single exact original Router read request.")
    request_file = requests[0]
    retain("previous_router_request", request_file)
    receipt = retain("previous_router_stdout", request_file.with_name("stdout.json"))
    completion = retain("previous_router_completion", request_file.with_name("completion.json"))
    pilot.require(receipt.get("ok") is False and receipt.get("error", {}).get("code") == "UPSTREAM_NOT_CONFIGURED"
                  and not has_operation_id(receipt) and type(completion.get("exit_code")) is int
                  and completion["exit_code"] != 0 and completion.get("timed_out") is False
                  and completion.get("stdout_sha256") == bindings["previous_router_stdout"]["sha256"],
                  "FOLLOWUP_ORIGIN_INVALID", "Only the proven no-operation local bootstrap failure permits this bounded observation.")
    metadata = next(item for item in sources["metadata"]["entries"] if item["legacy_id"] == router["legacy_id"])
    pilot.require(metadata.get("target", {}).get("database_id") == locator["database_id"],
                  "FOLLOWUP_SCOPE_INVALID", "The retained metadata must agree on the exact original subscription database.")
    bindings["followup_collector"] = {"path": str(Path(__file__).resolve()),
                                       "sha256": pilot.digest(pilot.regular_bytes(Path(__file__)))}
    pilot.assert_inputs_unchanged(bindings)
    return config, sources, bindings, number, router, summary


def run(path, check_only=False):
    config, sources, bindings, number, router, previous_summary = prepare(path)
    if check_only:
        return {"ok": True, "mode": "config_only", "network_requests": 0, "output_created": False,
                "selected_records": 1, "bootstrap_keys": ["upstream_database"]}
    collector = pilot.Collector(config, sources, bindings)
    output = collector.output
    output.mkdir(mode=0o700)
    pilot.write_json(output / "input-bindings.json", bindings)
    for name in ("config", "state", "cache", "data"):
        (output / "runtime" / name).mkdir(parents=True, mode=0o700)
    bootstrap = output / "runtime" / "config" / "config.json"
    pilot.write_json(bootstrap, {"upstream_database": router["record"]["locator"]["database_id"]})
    bootstrap_sha = pilot.digest(pilot.regular_bytes(bootstrap))
    try:
        result = collector.capture(number, router)
    except (pilot.EvidenceError, OSError, ValueError, KeyError, TypeError) as error:
        result = {"legacy_id": router["legacy_id"], "status": "stopped",
                  "code": getattr(error, "code", "OBSERVATION_FAILED"),
                  "message": "The Router follow-up stopped; original responses are retained. No automatic retry or recovery."}
        pilot.write_json(output / "entries" / str(number).zfill(2) / "stopped.json", result)
    pilot.assert_inputs_unchanged(bindings)
    pilot.require(pilot.digest(pilot.regular_bytes(bootstrap)) == bootstrap_sha,
                  "BOOTSTRAP_CHANGED", "The explicitly limited local configuration changed during observation.")
    summary = {"version": 1, "mode": "read_only_router_bootstrap_followup", "status": result["status"],
               "previous_summary": bindings["previous_summary"], "previous_router_failure": bindings["previous_router_stdout"],
               "previous_failure_preserved": True, "bootstrap": {"keys": ["upstream_database"], "sha256": bootstrap_sha},
               "entry": result, "cli_invocations": collector.sequence,
               "other_entries_observed_in_previous_run": [
                   {key: item[key] for key in ("legacy_id", "status", "snapshot_id", "version_id", "ref") if key in item}
                   for item in previous_summary["entries"] if item["legacy_id"] != router["legacy_id"]],
               "other_entries_reread": False, "input_unchanged": True, "approved_legacy_ids": [],
               "classification_changed": False, "production_mutations_requested": 0, "operation_recovery_requested": False,
               "migration_executed": False, "atomic_snapshot": False,
               "limitation": "One public Router snapshot observation; no native preimage, Source ownership or migration completion is asserted."}
    pilot.write_json(output / "summary.json", summary)
    return {"ok": result["status"] == "captured", "status": result["status"], "summary": str(output / "summary.json")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()
    result = run(args.config.resolve(), args.check_config)
    print(json.dumps(result))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (pilot.EvidenceError, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"ok": False, "code": getattr(error, "code", "FOLLOWUP_FAILED"),
                          "message": "The bounded Router follow-up could not start or finish; existing evidence is retained."}))
        sys.exit(1)
