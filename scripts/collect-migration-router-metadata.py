#!/usr/bin/env python3
"""Observe legacy Router native metadata without changing a migration inventory.

Reads only exact pages selected by a frozen inventory and their property items.
Retains original response bytes and unknown fields in a new evidence directory.
Repeated page reads check observed stability; they are not an atomic snapshot.
No scope, completeness, terminal outcome or approval fields are promoted.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import urlencode
from uuid import UUID


class EvidenceError(ValueError):
    def __init__(self, code, message, raw=None):
        super().__init__(message)
        self.code, self.raw = code, raw


def require(condition, code, message):
    if not condition:
        raise EvidenceError(code, message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("utf-8")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY", "The response repeats a JSON key.")
        result[key] = value
    return result


def load_json(data):
    return json.loads(data, object_pairs_hook=unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(
                          EvidenceError("INVALID_JSON_NUMBER", "The response contains a non-finite number.")))


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def write_new(path, data):
    with path.open("xb") as stream:
        stream.write(data)
    path.chmod(0o600)


UUID_PATTERN = r"(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
PROPERTY_PATTERN = r"(?:[A-Za-z0-9._~-]|%[0-9a-fA-F]{2})+"
SUBSCRIPTION_FIELDS = {
    "Name": ("title",), "Description": ("rich_text",), "Default Context": ("checkbox",),
    "Status": ("select", "status"), "Source": ("rich_text",),
    "Published Members": ("rich_text",), "Target Database ID": ("rich_text",),
}
NATIVE_FIELDS = {"Name": ("title",), "Description": ("rich_text",), "Default Context": ("checkbox",),
                 "Kind": ("select",), "Members": ("relation",), "References": ("rich_text",)}
FIELD_TYPES = {**SUBSCRIPTION_FIELDS, **NATIVE_FIELDS}
STABILITY_FIELDS = ("object", "id", "parent", "last_edited_time", "last_edited_by", "archived",
                    "is_archived", "in_trash", "is_locked", "properties")


def page_id(value):
    require(isinstance(value, str) and re.fullmatch(UUID_PATTERN, value) is not None,
            "PAGE_ID_INVALID", "An exact native page identity is required.")
    return str(UUID(value))


def property_path(page, property_id, cursor=None):
    # IDs returned by Notion are already URL encoded. Do not quote them again.
    require(isinstance(property_id, str) and property_id not in (".", "..")
            and re.fullmatch(PROPERTY_PATTERN, property_id) is not None,
            "PROPERTY_ID_INVALID", "A property ID is not one exact URL-encoded path segment.")
    query = {"page_size": "100"}
    if cursor is not None:
        query["start_cursor"] = cursor
    return "v1/pages/" + page_id(page) + "/properties/" + property_id + "?" + urlencode(query)


class NtnReader:
    """The sole transport is a sequential, shell-free, GET-only ntn invocation."""

    def __init__(self, executable="ntn", version="2026-03-11", timeout=45, interval=0.4):
        require(0 < timeout <= 60 and 0 <= interval <= 5, "READ_LIMIT_INVALID",
                "The request timeout must be at most 60 seconds and interval at most 5 seconds.")
        self.executable, self.version, self.timeout, self.interval = executable, version, timeout, interval
        self.next_request = 0.0

    def __call__(self, path):
        require(re.fullmatch("v1/pages/" + UUID_PATTERN +
                             r"(?:/properties/" + PROPERTY_PATTERN + r"\?page_size=100(?:&start_cursor=[^#\s]*)?)?", path) is not None,
                "READ_PATH_INVALID", "Only exact page and property metadata GET paths are allowed.")
        time.sleep(max(0.0, self.next_request - time.monotonic()))
        self.next_request = time.monotonic() + self.interval
        try:
            result = subprocess.run([self.executable, "api", path, "--notion-version", self.version, "-X", "GET"],
                                    stdin=subprocess.DEVNULL, capture_output=True, timeout=self.timeout, check=False)
        except subprocess.TimeoutExpired as error:
            raise EvidenceError("READ_TIMEOUT", "The metadata GET did not finish within its bounded timeout.", error.stdout) from None
        except OSError:
            raise EvidenceError("NTN_UNAVAILABLE", "The configured ntn executable could not be run.") from None
        require(len(result.stdout) <= 16 * 1024 * 1024, "RESPONSE_TOO_LARGE", "The metadata response exceeded 16 MiB.")
        if result.returncode != 0:
            # CLI diagnostics may contain sensitive context. Retain stdout only;
            # never echo or persist credentials, environment or raw stderr.
            raise EvidenceError("METADATA_READ_FAILED", "The ntn metadata GET returned a failure.", result.stdout)
        return result.stdout


class Recorder:
    def __init__(self, output, reader):
        self.output, self.reader, self.requests = output, reader, []

    def read(self, path, role):
        number = len(self.requests) + 1
        receipt = {"request": number, "method": "GET", "path": path, "role": role, "started_at": timestamp()}
        raw = None
        try:
            raw = self.reader(path)
            require(isinstance(raw, bytes), "RESPONSE_BYTES_REQUIRED", "The reader must return original response bytes.")
            value = load_json(raw)
            require(isinstance(value, dict) and value.get("object") != "error", "METADATA_READ_FAILED",
                    "The metadata GET did not return a native metadata object.")
            receipt["status"] = "observed"
            return value, number
        except (EvidenceError, ValueError, UnicodeError) as error:
            if isinstance(error, EvidenceError) and error.raw is not None:
                raw = error.raw
            code = error.code if isinstance(error, EvidenceError) else "INVALID_JSON_RESPONSE"
            receipt.update(status="failed", code=code)
            raise EvidenceError(code, "The metadata response could not be observed.") from None
        finally:
            receipt["finished_at"] = timestamp()
            if isinstance(raw, bytes):
                name = "raw/" + str(number).zfill(6) + ".json"
                write_new(self.output / name, raw)
                receipt["response"] = {"file": name, "sha256": digest(raw), "bytes": len(raw)}
            self.requests.append(receipt)


def input_hash(summary):
    if summary.get("mode") == "read_only_inventory":
        return summary.get("input", {}).get("sha256")
    if summary.get("mode") in ("read_only_pin_retention_verification", "read_only_operation_origins"):
        return summary.get("output", {}).get("input_sha256")
    raise EvidenceError("INPUT_RECEIPT_UNSUPPORTED", "Supply the frozen inventory receipt or its retention/origin receipt.")


def target_from(item):
    raw = item.get("raw")
    locator = raw.get("locator") if isinstance(raw, dict) else None
    require(isinstance(locator, dict) and raw.get("kind") == "router"
            and locator.get("type") in ("notion_subscription", "notion_page"),
            "ROUTER_IDENTITY_INVALID", "The retained Router does not identify one supported native page family.")
    identity = locator.get("subscription_id" if locator["type"] == "notion_subscription" else "page_id")
    require(raw.get("id") == item.get("legacy_id") == locator["type"] + ":" + str(identity),
            "ROUTER_IDENTITY_INVALID", "The retained Router identity differs from its exact native page locator.")
    return {"family": locator["type"], "page_id": page_id(identity), "database_id": page_id(locator.get("database_id")),
            "data_source_id": page_id(locator.get("data_source_id"))}


def check_page(raw, target):
    parent = raw.get("parent")
    require(raw.get("object") == "page" and page_id(raw.get("id")) == target["page_id"]
            and isinstance(parent, dict) and page_id(parent.get("data_source_id")) == target["data_source_id"]
            and ("database_id" not in parent or page_id(parent["database_id"]) == target["database_id"]),
            "ROUTER_PAGE_MISMATCH", "The native page identity or data-source parent differs from the retained Router.")
    require(isinstance(raw.get("properties"), dict) and isinstance(raw.get("last_edited_time"), str)
            and raw["last_edited_time"] != "", "ROUTER_PAGE_INCOMPLETE", "The native page lacks properties or its edit marker.")


def field_bindings(properties, family):
    fields = SUBSCRIPTION_FIELDS if family == "notion_subscription" else NATIVE_FIELDS
    result = {name: name if name in properties else None for name in fields}
    if family == "notion_page":
        # The original native Skill reader takes the title by native identity,
        # and prefers Notion's built-in Description property over its label.
        for name, identity in (("Name", "title"), ("Description", "notion%3A%2F%2Fskills%2Fdescription_property")):
            matches = [label for label, value in properties.items() if isinstance(value, dict) and value.get("id") == identity]
            if len(matches) == 1:
                result[name] = matches[0]
            elif name == "Name":
                result[name] = None
    return result


def requires_pagination(prop):
    kind = prop["type"]
    if kind == "relation":
        return prop.get("has_more") is not False
    if kind in ("title", "rich_text"):
        return prop.get("has_more") is True or any(
            not isinstance(value, dict) or value.get("type") not in ("text", "equation") for value in prop[kind])
    if kind == "people":
        return prop.get("has_more") is True or len(prop[kind]) >= 25
    return False


def relation_ids(values):
    result = [page_id(value.get("id")) if isinstance(value, dict) else page_id(None) for value in values]
    require(len(set(result)) == len(result), "RELATION_REPEATED", "The native relation repeats a page identity.")
    return result


def complete_property(recorder, page, name, prop):
    kind, property_id = prop.get("type"), prop.get("id")
    require(isinstance(kind, str) and isinstance(property_id, str) and kind in prop,
            "PROPERTY_SHAPE_INVALID", "A native property lacks its identity, type or value.")
    require("has_more" not in prop or type(prop["has_more"]) is bool,
            "PROPERTY_SHAPE_INVALID", "A native property has a malformed pagination flag.")
    result = {"property_id": property_id, "type": kind, "raw_inline": prop, "value": prop[kind],
              "pagination": {"needed": False, "exhausted": None, "requests": []}}
    if kind not in ("title", "rich_text", "people", "relation"):
        require(prop.get("has_more") is not True, "PROPERTY_PAGINATION_UNSUPPORTED",
                "An additional native property requires unsupported pagination; its raw value is retained.")
        return result
    require(isinstance(prop[kind], list), "PROPERTY_SHAPE_INVALID", "A native list property has no inline list.")
    if kind == "relation":
        relation_ids(prop[kind])
    if not requires_pagination(prop):
        return result
    result["pagination"].update(needed=True, exhausted=False)
    values, cursors, cursor = [], set(), None
    for _ in range(1000):
        response, request = recorder.read(property_path(page, property_id, cursor), "property:" + name)
        result["pagination"]["requests"].append(request)
        metadata = response.get("property_item")
        require(response.get("object") == "list" and response.get("type") == "property_item"
                and isinstance(metadata, dict) and metadata.get("id") == property_id and metadata.get("type") == kind
                and isinstance(response.get("results"), list) and type(response.get("has_more")) is bool
                and "next_cursor" in response and "next_url" in metadata,
                "PROPERTY_PAGE_MISMATCH", "A property page is incomplete or belongs to another property.")
        status = response.get("request_status")
        require(status is None or (isinstance(status, dict) and status.get("type") == "complete"
                                   and status.get("incomplete_reason") is None),
                "PROPERTY_PAGE_INCOMPLETE", "Notion marked a property response incomplete.")
        for item in response["results"]:
            require(isinstance(item, dict) and item.get("object") == "property_item" and item.get("id") == property_id
                    and item.get("type") == kind and kind in item,
                    "PROPERTY_ITEM_MISMATCH", "A property item belongs to another property or lacks its value.")
            values.append(item[kind])
        next_cursor = response.get("next_cursor")
        if not response["has_more"]:
            require(next_cursor is None and metadata.get("next_url") is None,
                    "PROPERTY_CURSOR_INVALID", "The final property page retains a next cursor or URL.")
            if kind == "relation":
                full_ids, inline_ids = relation_ids(values), relation_ids(prop[kind])
                require(set(inline_ids).issubset(full_ids) and (prop.get("has_more") is not True or len(full_ids) > len(inline_ids)),
                        "RELATION_CHANGED", "The full relation contradicts the initial inline membership.")
            result["value"], result["pagination"]["exhausted"] = values, True
            return result
        require(isinstance(next_cursor, str) and next_cursor != "" and next_cursor not in cursors
                and isinstance(metadata.get("next_url"), str) and metadata["next_url"] != "",
                "PROPERTY_CURSOR_INVALID", "Property pagination did not advance with a complete cursor.")
        cursors.add(next_cursor)
        cursor = next_cursor  # Never follow an arbitrary returned next_url.
    raise EvidenceError("PROPERTY_PAGE_LIMIT", "The property exceeded the bounded observation page limit.")


def field_value(name, observed):
    result = {key: observed[key] for key in ("property_id", "type", "value")}
    require(observed["type"] in FIELD_TYPES[name], "ROUTER_FIELD_TYPE_CHANGED",
            "A requested Router field no longer has its original metadata type.")
    if observed["type"] in ("title", "rich_text"):
        require(all(isinstance(value, dict) and isinstance(value.get("plain_text"), str) for value in observed["value"]),
                "ROUTER_TEXT_INCOMPLETE", "A requested native text field lacks complete plain text.")
        result["text"] = "".join(value["plain_text"] for value in observed["value"])
        if name in ("Source", "Published Members"):
            try:
                result["parsed_json"] = load_json(result["text"])
                result["json_status"] = "parsed"
            except (EvidenceError, ValueError, UnicodeError):
                result["json_status"] = "empty" if result["text"] == "" else "invalid"
            # Parsing is observation only. Unsupported Source fields and invalid
            # Published Members remain raw facts, not silently repaired input.
    return result


def collect_router(item, recorder, duplicate=False):
    result = {"version": 1, "legacy_id": item["legacy_id"], "original_item": item, "target": None,
              "raw_page_before": None, "raw_page_after": None, "properties": {}, "fields": {}, "issues": [],
              "page_stability": {"checked": False, "unchanged": None, "atomic_snapshot": False,
                                 "compared_fields": list(STABILITY_FIELDS)}}
    first_request = len(recorder.requests) + 1

    def issue(error, field=None):
        result["issues"].append({"code": error.code, **({"field": field} if field is not None else {})})

    try:
        require(not duplicate, "ROUTER_IDENTITY_REPEATED", "The input repeats a Router identity.")
        target = target_from(item)
        result["target"] = target
        required_fields = SUBSCRIPTION_FIELDS if target["family"] == "notion_subscription" else NATIVE_FIELDS
        result["required_fields"] = sorted(required_fields)
        before, request = recorder.read("v1/pages/" + target["page_id"], "page_before")
        result["raw_page_before"], result["before_request"] = before, request
        try:
            check_page(before, target)
            properties = before["properties"]
            bindings = field_bindings(properties, target["family"])
            result["field_bindings"] = bindings
            ids = Counter(prop.get("id") for prop in properties.values() if isinstance(prop, dict) and isinstance(prop.get("id"), str))
            for name, prop in properties.items():
                try:
                    require(isinstance(prop, dict) and isinstance(prop.get("id"), str) and ids[prop["id"]] == 1,
                            "PROPERTY_IDENTITY_INVALID", "A native property identity is absent or duplicated.")
                    observed = complete_property(recorder, target["page_id"], name, prop)
                    result["properties"][name] = observed
                except EvidenceError as error:
                    issue(error, name)
            for name, label in bindings.items():
                if label is None:
                    issue(EvidenceError("ROUTER_FIELD_MISSING", "A requested native Router field is absent."), name)
                elif label in result["properties"]:
                    try:
                        result["fields"][name] = {"native_name": label, **field_value(name, result["properties"][label])}
                    except EvidenceError as error:
                        issue(error, name)
        except EvidenceError as error:
            issue(error)
        finally:
            # Even a malformed initial page or failed property chain is reread.
            try:
                after, request = recorder.read("v1/pages/" + target["page_id"], "page_after")
                result["raw_page_after"], result["after_request"] = after, request
                check_page(after, target)
                left = {key: before.get(key) for key in STABILITY_FIELDS}
                right = {key: after.get(key) for key in STABILITY_FIELDS}
                result["page_stability"].update(checked=True, unchanged=encoded(left) == encoded(right),
                                               before_sha256=digest(encoded(left)), after_sha256=digest(encoded(right)))
                if not result["page_stability"]["unchanged"]:
                    issue(EvidenceError("PAGE_CHANGED_DURING_OBSERVATION", "The repeated page metadata changed."))
            except EvidenceError as error:
                issue(error)
    except EvidenceError as error:
        issue(error)
    result["requests"] = list(range(first_request, len(recorder.requests) + 1))
    if result["raw_page_before"] is None:
        result["status"] = "unavailable"
    elif result["page_stability"]["unchanged"] is False:
        result["status"] = "changed"
    elif result["issues"] or not result["page_stability"]["checked"]:
        result["status"] = "incomplete"
    else:
        result["status"] = "stable"
    return result


def collect(*, input_path, summary_path, output_path, reader):
    input_bytes, prior_bytes = input_path.read_bytes(), summary_path.read_bytes()
    original, prior = load_json(input_bytes), load_json(prior_bytes)
    require(isinstance(original, dict) and original.get("version") == 1 and isinstance(prior, dict),
            "INVENTORY_INVALID", "Supply the frozen version-1 inventory and its receipt.")
    require(digest(input_bytes) == input_hash(prior), "INPUT_HASH_MISMATCH", "The inventory differs from its frozen receipt.")
    items = original.get("preservation", {}).get("routers", {}).get("items")
    require(isinstance(items, list) and all(isinstance(item, dict) and isinstance(item.get("legacy_id"), str) for item in items),
            "ROUTER_INVENTORY_INVALID", "The inventory lacks an exact retained Router list.")
    require(not output_path.exists(), "OUTPUT_EXISTS", "Choose a new evidence directory; existing output is never overwritten.")
    output_path.mkdir(parents=True, mode=0o700, exist_ok=False)
    (output_path / "raw").mkdir(mode=0o700)
    recorder = Recorder(output_path, reader)
    counts = Counter(item["legacy_id"] for item in items)
    observations = [collect_router(item, recorder, counts[item["legacy_id"]] != 1) for item in items]
    require(input_path.read_bytes() == input_bytes and summary_path.read_bytes() == prior_bytes,
            "INPUT_CHANGED", "The frozen inventory or receipt changed during collection; retained raw evidence is partial.")
    observation_lines = [encoded(value) for value in observations]
    receipts = [{"version": 1, "legacy_id": value["legacy_id"], "status": value["status"],
                 "evidence": {"file": "router-evidence.jsonl", "line": number, "sha256": digest(data)},
                 "requests": value["requests"], "page_stability": value["page_stability"],
                 "observed_fields": sorted(value["fields"]), "issues": value["issues"]}
                for number, (value, data) in enumerate(zip(observations, observation_lines), 1)]
    outputs = {"router-evidence.jsonl": b"".join(observation_lines),
               "router-receipts.jsonl": b"".join(encoded(value) for value in receipts),
               "requests.jsonl": b"".join(encoded(value) for value in recorder.requests)}
    status_counts = Counter(value["status"] for value in observations)
    result = {"version": 1, "mode": "read_only_router_metadata_observation",
              "inputs": {"inventory_sha256": digest(input_bytes), "summary_sha256": digest(prior_bytes)},
              "selection": {"inventory_domain": "preservation.routers.items", "other_subscriptions_enumerated": False},
              "transport": {"method": "GET", "notion_version": reader.version if isinstance(reader, NtnReader) else None,
                            "response_bytes": "original_reader_stdout"},
              "counts": {"routers": len(items), "stable": status_counts["stable"], "changed": status_counts["changed"],
                         "incomplete": status_counts["incomplete"], "unavailable": status_counts["unavailable"],
                         "metadata_get_requests": len(recorder.requests)},
              "issues": dict(sorted(Counter(issue["code"] for value in observations for issue in value["issues"]).items())),
              "output": {name: {"sha256": digest(data), "bytes": len(data)} for name, data in outputs.items()},
              "safeguards": {"production_writes": 0, "body_requests": 0, "automatic_replay": False,
                             "input_unchanged": True, "approved_scope_unchanged": True, "complete_flags_unchanged": True,
                             "terminal_outcomes_unchanged": True, "atomic_snapshot": False,
                             "source_semantics_approved": False, "migration_input_produced": False, "apply_allowed": False}}
    for name, data in outputs.items():
        write_new(output_path / name, data)
    write_new(output_path / "summary.json", encoded(result))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "input-summary", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--ntn-bin", default="ntn")
    parser.add_argument("--notion-version", default="2026-03-11")
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--interval", type=float, default=0.4)
    args = parser.parse_args()
    try:
        result = collect(input_path=args.input, summary_path=args.input_summary, output_path=args.output,
                         reader=NtnReader(args.ntn_bin, args.notion_version, args.timeout, args.interval))
    except (EvidenceError, ValueError, UnicodeError, OSError) as error:
        print(json.dumps({"ok": False, "code": error.code if isinstance(error, EvidenceError) else "EVIDENCE_UNREADABLE"}), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0 if result["counts"]["stable"] == result["counts"]["routers"] else 2


if __name__ == "__main__":
    sys.exit(main())
