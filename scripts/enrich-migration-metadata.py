#!/usr/bin/env python3
"""Join retained native metadata observations to an existing migration catalog.

This tool has no network transport. It changes only per-entry metadata_complete,
retains every original input value otherwise, and writes separately hashed native
evidence and receipts. File access URL coordinates never establish body identity.
"""

import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qsl, urlsplit


sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("_router_metadata", Path(__file__).with_name("collect-migration-router-metadata.py"))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("The installed Router observation helpers are unavailable")
native = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native)
EvidenceError, require = native.EvidenceError, native.require
digest, encoded, load_json, page_id = native.digest, native.encoded, native.load_json, native.page_id
AUTH_QUERY_FIELDS = frozenset(("X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-Signature", "X-Amz-Security-Token"))
NATIVE_FILES_PROPERTY_ID = "notion%3A%2F%2Fskills%2Ffiles_property"


def exact(left, right):
    return encoded(left) == encoded(right)


def access_coordinate(url):
    require(isinstance(url, str) and url == url.strip() and not any(ord(char) <= 32 or ord(char) == 127 for char in url)
            and re.search(r"%(?![0-9a-fA-F]{2})", url) is None,
            "FILE_ACCESS_URL_UNSUPPORTED", "The native file URL has whitespace, controls or malformed encoding.")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise EvidenceError("FILE_ACCESS_URL_UNSUPPORTED", "The native file URL is malformed.") from None
    hostname = parsed.hostname or ""
    notion_host = re.fullmatch(r"prod-files-secure\.s3\.[a-z0-9-]+\.amazonaws\.com", hostname)
    legacy_host = re.fullmatch(r"s3\.[a-z0-9-]+\.amazonaws\.com", hostname) and parsed.path.startswith("/secure.notion-static.com/")
    require(parsed.scheme == "https" and parsed.username is None and parsed.password is None and port is None
            and (notion_host or legacy_host) and parsed.path.startswith("/") and parsed.fragment == "",
            "FILE_ACCESS_URL_UNSUPPORTED", "The changed URL is not a recognized native Notion file access URL.")
    try:
        pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True, encoding="utf-8", errors="strict")
    except (ValueError, UnicodeError):
        raise EvidenceError("FILE_ACCESS_URL_UNSUPPORTED", "The signed file query is malformed.") from None
    query = dict(pairs)
    require(len(query) == len(pairs) and query.get("X-Amz-Algorithm") == "AWS4-HMAC-SHA256"
            and isinstance(query.get("X-Amz-Credential"), str) and query["X-Amz-Credential"] != ""
            and re.fullmatch(r"\d{8}T\d{6}Z", query.get("X-Amz-Date", "")) is not None
            and re.fullmatch(r"[1-9]\d*", query.get("X-Amz-Expires", "")) is not None
            and query.get("X-Amz-SignedHeaders") == "host"
            and re.fullmatch(r"[0-9a-fA-F]{64}", query.get("X-Amz-Signature", "")) is not None,
            "FILE_ACCESS_URL_UNSUPPORTED", "The changed URL lacks the recognized signed-access fields.")
    return {"scheme": parsed.scheme, "host": parsed.netloc, "path": parsed.path,
            "non_auth_query_raw": [segment for segment in parsed.query.split("&") if segment.partition("=")[0] not in AUTH_QUERY_FIELDS]}


def expiry(value):
    require(isinstance(value, str), "FILE_EXPIRY_INVALID", "The native file expiry is not an explicit timestamp.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.tzinfo is not None, "FILE_EXPIRY_INVALID", "The native file expiry has no timezone.")
    except ValueError:
        raise EvidenceError("FILE_EXPIRY_INVALID", "The native file expiry timestamp is invalid.") from None


def compare_properties(left, right):
    """Normalize only proven signed URL renewal; keep every other field exact."""
    before, after, renewals = deepcopy(left), deepcopy(right), []
    for name in sorted(before.keys() & after.keys()):
        a, b = before[name], after[name]
        if not isinstance(a, dict) or not isinstance(b, dict) or a.get("type") != "files" or b.get("type") != "files" \
                or a.get("id") != NATIVE_FILES_PROPERTY_ID or b.get("id") != NATIVE_FILES_PROPERTY_ID:
            continue
        if not isinstance(a.get("files"), list) or not isinstance(b.get("files"), list) or len(a["files"]) != len(b["files"]):
            continue
        for index, (original_a, original_b) in enumerate(zip(a["files"], b["files"])):
            if exact(original_a, original_b):
                continue
            if not isinstance(original_a, dict) or not isinstance(original_b, dict) or original_a.get("type") != "file" or original_b.get("type") != "file":
                continue
            fa, fb = original_a.get("file"), original_b.get("file")
            if not isinstance(fa, dict) or not isinstance(fb, dict) or not all(key in fa and key in fb for key in ("url", "expiry_time")):
                continue
            aa, bb = deepcopy(original_a), deepcopy(original_b)
            for value in (aa, bb):
                value["file"].pop("url")
                value["file"].pop("expiry_time")
            require(exact(aa, bb), "FILE_DESCRIPTOR_CHANGED", "A native file descriptor changed beyond access URL or expiry.")
            ca, cb = access_coordinate(fa["url"]), access_coordinate(fb["url"])
            require(exact(ca, cb), "FILE_COORDINATE_CHANGED", "The native file coordinate or non-signing query changed.")
            expiry(fa["expiry_time"])
            expiry(fb["expiry_time"])
            renewals.append({"property": name, "property_id": a.get("id"), "index": index,
                             "coordinate": ca, "coordinate_sha256": digest(encoded(ca)),
                             "before": {"url": fa["url"], "expiry_time": fa["expiry_time"]},
                             "after": {"url": fb["url"], "expiry_time": fb["expiry_time"]},
                             "content_identity_verified": False})
            for value in (original_a, original_b):
                value["file"]["url"] = {"observed_access_coordinate": ca}
                value["file"]["expiry_time"] = {"observed_access_expiry": True}
    return before, after, renewals


def checked_page(raw, target):
    native.check_page(raw, target)
    parent = raw["parent"]
    require(page_id(parent.get("database_id")) == target["database_id"], "METADATA_PARENT_MISMATCH",
            "The native page lacks the original database parent.")
    require(raw.get("in_trash") is not True and raw.get("is_archived") is not True and raw.get("archived") is not True,
            "METADATA_PAGE_REMOVED", "The original catalog page is now archived or in trash.")


def target_from(entry):
    record = entry.get("record")
    locator = record.get("locator") if isinstance(record, dict) else None
    require(isinstance(locator, dict) and locator.get("type") in ("notion_page", "notion_subscription")
            and record.get("id") == entry.get("legacy_id"), "CATALOG_IDENTITY_INVALID",
            "The catalog entry lacks one exact original native identity.")
    family = locator["type"]
    identity = locator.get("page_id" if family == "notion_page" else "subscription_id")
    require(entry["legacy_id"] == family + ":" + str(identity), "CATALOG_IDENTITY_INVALID",
            "The catalog identity differs from its retained native locator.")
    return {"family": family, "page_id": page_id(identity), "database_id": page_id(locator.get("database_id")),
            "data_source_id": page_id(locator.get("data_source_id"))}


class NoAdditionalReads:
    def read(self, path, role):
        raise EvidenceError("METADATA_PAGINATION_MISSING", "The retained page requires property evidence that is not available.")


def property_value(name, properties, expected_type, required=True):
    item = properties.get(name)
    if item is None and not required:
        return None
    require(isinstance(item, dict) and item.get("type") == expected_type, "METADATA_FIELD_INVALID",
            "A necessary metadata field is absent or has another native type.")
    return item["value"]


def plain_text(values):
    require(isinstance(values, list) and all(isinstance(item, dict) and isinstance(item.get("plain_text"), str) for item in values),
            "METADATA_TEXT_INCOMPLETE", "A necessary metadata field lacks complete native text.")
    return "".join(item["plain_text"] for item in values)


def metadata_fields(properties, target):
    raw_properties = {name: value["raw_inline"] for name, value in properties.items()}
    if target["family"] == "notion_subscription":
        result = {name: native.field_value(name, properties[name]) for name in native.SUBSCRIPTION_FIELDS if name in properties}
        require(set(result) == set(native.SUBSCRIPTION_FIELDS), "METADATA_FIELD_MISSING", "A subscription metadata field is missing.")
        context = result["Default Context"]["value"]
        require(type(context) is bool, "METADATA_FIELD_INVALID", "Default Context is not a native boolean.")
        status = result["Status"]["value"]
        require(isinstance(status, dict) and status.get("name") in ("verified", "partial", "disabled"),
                "METADATA_FIELD_INVALID", "The subscription status is not an original recognized status.")
        return {"name": result["Name"]["text"], "description": result["Description"]["text"], "default_context": context,
                "kind": "router", "target_database_id": page_id(result["Target Database ID"]["text"])}
    bindings = native.field_bindings(raw_properties, "notion_page")
    title, description = bindings["Name"], bindings["Description"]
    require(title is not None and description is not None, "METADATA_FIELD_MISSING", "Native title or Description is missing.")
    context = property_value("Default Context", properties, "checkbox", required=False)
    require("Default Context" not in properties or type(context) is bool, "METADATA_FIELD_INVALID", "Default Context is not a native boolean.")
    kind = property_value("Kind", properties, "select", required=False)
    require(kind is None or (isinstance(kind, dict) and kind.get("name") in ("skill", "router", "prompt")),
            "METADATA_FIELD_INVALID", "The native content kind is not recognized.")
    return {"name": plain_text(property_value(title, properties, "title")),
            "description": plain_text(property_value(description, properties, "rich_text")),
            "default_context": context is True, "kind": "skill" if kind is None else kind["name"]}


def verified_record(record, observed, target):
    fields = ("name", "description", "default_context", "kind")
    require(all(key in record for key in fields) and exact({key: record[key] for key in fields}, {key: observed[key] for key in fields}),
            "CATALOG_METADATA_CHANGED", "Current native metadata differs from the frozen catalog record.")
    require(record.get("entrypoint") == {"skill": "SKILL.md", "router": "ROUTER.md", "prompt": "PROMPT.md"}[observed["kind"]],
            "CATALOG_ENTRYPOINT_MISMATCH", "The retained entrypoint differs from its original content kind.")
    if target["family"] == "notion_subscription":
        require(page_id(record["locator"].get("target_database_id")) == observed["target_database_id"],
                "CATALOG_TARGET_CHANGED", "The current subscription target differs from the frozen catalog locator.")
    return list(fields) + ["entrypoint", "locator"]


def json_lines(data):
    return [load_json(line) for line in data.splitlines() if line.strip()]


class RetainedRequests:
    """Replay exact retained responses through the existing observer, offline."""

    def __init__(self, rows, responses):
        self.rows, self.responses, self.requests = rows, responses, []

    def read(self, path, role):
        index = len(self.requests)
        require(index < len(self.rows), "ROUTER_REQUEST_MISSING", "A retained Router request is missing.")
        row = self.rows[index]
        self.requests.append(row)
        require(row.get("method") == "GET" and row.get("path") == path and row.get("role") == role,
                "ROUTER_REQUEST_MISMATCH", "The retained Router request differs from its exact observation plan.")
        require(row.get("status") == "observed" and row["request"] in self.responses,
                "ROUTER_REQUEST_FAILED", "The retained Router read was not successful.")
        return load_json(self.responses[row["request"]]), row["request"]


def load_router_evidence(directory):
    summary_bytes = (directory / "summary.json").read_bytes()
    summary = load_json(summary_bytes)
    require(isinstance(summary, dict) and summary.get("mode") == "read_only_router_metadata_observation",
            "ROUTER_RECEIPT_INVALID", "The supplied directory has no Router observation receipt.")
    artifacts = {}
    for name in ("router-evidence.jsonl", "router-receipts.jsonl", "requests.jsonl"):
        data = (directory / name).read_bytes()
        expected = summary.get("output", {}).get(name, {})
        require(digest(data) == expected.get("sha256") and len(data) == expected.get("bytes"),
                "ROUTER_ARTIFACT_HASH_MISMATCH", "A retained Router artifact differs from its summary.")
        artifacts[name] = data
    observations = json_lines(artifacts["router-evidence.jsonl"])
    receipts = json_lines(artifacts["router-receipts.jsonl"])
    requests = json_lines(artifacts["requests.jsonl"])
    require(len(observations) == len(receipts) == summary.get("counts", {}).get("routers")
            and len(requests) == summary.get("counts", {}).get("metadata_get_requests"),
            "ROUTER_RECEIPT_INVALID", "The Router artifact counts differ from their original receipt.")
    responses, raw_hashes = {}, {}
    for number, row in enumerate(requests, 1):
        require(isinstance(row, dict) and row.get("request") == number and row.get("method") == "GET",
                "ROUTER_REQUEST_INVALID", "Router request identities or methods are invalid.")
        response = row.get("response")
        if response is None:
            continue
        name = "raw/" + str(number).zfill(6) + ".json"
        require(isinstance(response, dict) and response.get("file") == name,
                "ROUTER_RESPONSE_PATH_INVALID", "A retained response is not its numbered raw file.")
        data = (directory / name).read_bytes()
        require(digest(data) == response.get("sha256") and len(data) == response.get("bytes"),
                "ROUTER_RESPONSE_HASH_MISMATCH", "A retained raw Router response differs from its receipt.")
        responses[number] = data
        raw_hashes[name] = digest(data)
    replay = RetainedRequests(requests, responses)
    result = {}
    for number, (observation, receipt) in enumerate(zip(observations, receipts), 1):
        require(isinstance(observation, dict) and isinstance(receipt, dict) and observation.get("legacy_id") == receipt.get("legacy_id")
                and receipt.get("evidence") == {"file": "router-evidence.jsonl", "line": number, "sha256": digest(encoded(observation))},
                "ROUTER_EVIDENCE_MISMATCH", "A Router receipt does not identify its exact retained evidence line.")
        original = observation.get("original_item")
        require(isinstance(original, dict) and original.get("legacy_id") == observation.get("legacy_id"),
                "ROUTER_ORIGINAL_ITEM_INVALID", "The Router evidence lacks its original retained inventory item.")
        repeated = native.collect_router(original, replay)
        require(exact(repeated, observation) and receipt.get("status") == observation.get("status"),
                "ROUTER_REPLAY_MISMATCH", "Retained Router raw responses do not reproduce their claimed observation.")
        legacy_id = observation["legacy_id"]
        require(legacy_id not in result, "ROUTER_IDENTITY_REPEATED", "The Router evidence repeats an original identity.")
        result[legacy_id] = {"observation": observation, "line": number, "sha256": digest(encoded(observation))}
    require(len(replay.requests) == len(requests), "ROUTER_REQUEST_UNCONSUMED", "The Router receipt retains unexplained requests.")
    return result, {"summary.json": digest(summary_bytes),
                    **{name: digest(data) for name, data in artifacts.items()}, **raw_hashes}


def materialize_properties(raw, target, router=None):
    result = {}
    ids = Counter(value.get("id") for value in raw["properties"].values() if isinstance(value, dict) and isinstance(value.get("id"), str))
    for name, prop in raw["properties"].items():
        require(isinstance(prop, dict) and isinstance(prop.get("id"), str) and ids[prop["id"]] == 1,
                "METADATA_PROPERTY_ID_INVALID", "A native property identity is absent or repeated.")
        require("has_more" not in prop or type(prop["has_more"]) is bool, "METADATA_PAGINATION_MISMATCH",
                "A native property has a malformed pagination flag.")
        expanded = router.get("properties", {}).get(name) if router is not None else None
        if expanded is None or not expanded.get("pagination", {}).get("needed"):
            result[name] = native.complete_property(NoAdditionalReads(), target["page_id"], name, prop)
            continue
        require(expanded.get("property_id") == prop.get("id") and expanded.get("type") == prop.get("type")
                and expanded.get("pagination", {}).get("exhausted") is True,
                "METADATA_PAGINATION_MISMATCH", "The complete property evidence belongs to another native field.")
        kind = prop["type"]
        if kind != "relation":
            require(kind in ("rich_text", "title", "people") and exact(prop, expanded.get("raw_inline")),
                    "METADATA_PAGINATION_MISMATCH", "The truncated query field differs from the retained property observation.")
            result[name] = {**expanded, "raw_inline": prop}
            continue
        inline, complete = prop.get(kind), expanded.get("value")
        require(isinstance(inline, list) and isinstance(complete, list), "METADATA_PAGINATION_MISMATCH", "The relation has no complete retained array.")
        inline_ids, full_ids = native.relation_ids(inline), native.relation_ids(complete)
        full = dict(zip(full_ids, complete))
        require(all(identity in full and exact(value, full[identity]) for identity, value in zip(inline_ids, inline))
                and (prop.get("has_more") is not False or len(inline) == len(complete))
                and (prop.get("has_more") is not True or len(inline) < len(complete)),
                "METADATA_RELATION_CHANGED", "The query relation contradicts the retained complete membership.")
        result[name] = {"property_id": prop["id"], "type": kind, "raw_inline": prop, "value": complete,
                        "pagination": expanded["pagination"]}
    return result


def comparable_page(raw, observed_properties):
    result = {key: raw[key] for key in native.STABILITY_FIELDS if key in raw}
    properties = deepcopy(raw["properties"])
    for name, observed in observed_properties.items():
        if observed["pagination"].get("needed"):
            properties[name][observed["type"]] = observed["value"]
            properties[name]["has_more"] = False
    result["properties"] = properties
    return result


def compare_pages(before, after):
    a, b = deepcopy(before), deepcopy(after)
    a["properties"], b["properties"], renewals = compare_properties(a["properties"], b["properties"])
    require(exact(a, b), "METADATA_CHANGED", "The complete managed metadata changed between retained observations.")
    return {"managed_metadata_sha256": digest(encoded(a)), "file_access_renewals": renewals,
            "atomic_snapshot": False, "body_identity_verified": False}


def observation_index(observations):
    require(isinstance(observations, dict) and all(isinstance(observations.get(phase), dict) for phase in ("initial", "confirm")),
            "OBSERVATIONS_INVALID", "Supply both retained query observation rounds grouped by data source.")
    result, counts = {}, {}
    for phase in ("initial", "confirm"):
        result[phase], counts[phase] = {}, {}
        for data_source, rows in observations[phase].items():
            require(isinstance(rows, list), "OBSERVATIONS_INVALID", "A retained data-source observation is not an array.")
            ds = page_id(data_source)
            counts[phase][ds] = len(rows)
            for index, raw in enumerate(rows):
                if not isinstance(raw, dict):
                    continue
                try:
                    identity = page_id(raw.get("id"))
                except EvidenceError:
                    continue
                result[phase].setdefault(identity, []).append({"data_source_id": ds, "index": index, "raw": raw})
    return result, counts


def observe_entry(entry, index, router_rows, preserved_routers):
    result = {"version": 1, "legacy_id": entry["legacy_id"], "status": "unverified", "original_record": entry.get("record"),
              "original_metadata_present": "metadata" in entry, "original_metadata": entry.get("metadata"),
              "original_metadata_complete": entry.get("metadata_complete"), "issues": []}
    try:
        target = target_from(entry)
        result["target"] = target
        pages, locations = {}, {}
        for phase in ("initial", "confirm"):
            matches = index[phase].get(target["page_id"], [])
            require(len(matches) == 1, "QUERY_PAGE_AMBIGUOUS", "The exact page is missing or duplicated in one retained query round.")
            match = matches[0]
            require(match["data_source_id"] == target["data_source_id"], "QUERY_PARENT_MISMATCH", "The page was observed under another data source.")
            pages[phase] = match["raw"]
            locations[phase] = {"data_source_id": match["data_source_id"], "array_index": match["index"],
                                "raw_sha256": digest(encoded(match["raw"]))}
            result["raw_" + phase] = match["raw"]
            checked_page(match["raw"], target)
        result["query_locations"] = locations
        router = None
        if entry["record"].get("kind") == "router":
            retained = router_rows.get(entry["legacy_id"])
            original = preserved_routers.get(entry["legacy_id"])
            require(retained is not None and original is not None, "ROUTER_EVIDENCE_MISSING", "The Router has no exact retained pagination observation.")
            router = retained["observation"]
            require(exact(router.get("original_item"), original) and exact(original.get("raw"), entry["record"])
                    and exact(router.get("target"), target), "ROUTER_CATALOG_MISMATCH", "Router evidence differs from its frozen catalog identity.")
            issues = router.get("issues", [])
            require(router.get("status") in ("stable", "changed") and all(issue.get("code") == "PAGE_CHANGED_DURING_OBSERVATION" for issue in issues),
                    "ROUTER_OBSERVATION_INCOMPLETE", "The retained Router has unresolved observation errors.")
            result["router_evidence"] = {"line": retained["line"], "sha256": retained["sha256"], "original_status": router["status"]}
        properties = {phase: materialize_properties(raw, target, router) for phase, raw in pages.items()}
        comparable = {phase: comparable_page(raw, properties[phase]) for phase, raw in pages.items()}
        result["query_comparison"] = compare_pages(comparable["initial"], comparable["confirm"])
        if router is not None:
            for phase in ("before", "after"):
                raw = router["raw_page_" + phase]
                checked_page(raw, target)
                expanded = materialize_properties(raw, target, router)
                result["router_" + phase + "_comparison"] = compare_pages(comparable["confirm"], comparable_page(raw, expanded))
        fields = metadata_fields(properties["confirm"], target)
        result["verified_record_fields"] = verified_record(entry["record"], fields, target)
        if entry["record"].get("kind") == "router" and target["family"] == "notion_page":
            property_value("Members", properties["confirm"], "relation")
            property_value("References", properties["confirm"], "rich_text")
        if "enabled" in entry["record"]:
            enabled = property_value("Enabled", properties["confirm"], "checkbox")
            require(type(enabled) is bool and exact(enabled, entry["record"]["enabled"]),
                    "CATALOG_METADATA_CHANGED", "The retained Enabled value differs from current native metadata.")
            result["verified_record_fields"].append("enabled")
        require("metadata" in entry, "ORIGINAL_METADATA_MISSING",
                "The original entry has no metadata slot; preserve its absence instead of silently replacing its model.")
        result.update(status="verified", observed_fields=fields, observed_complete_properties=properties["confirm"])
    except (EvidenceError, ValueError, UnicodeError, TypeError) as error:
        result["issues"].append({"code": error.code if isinstance(error, EvidenceError) else "METADATA_UNREADABLE"})
    return result


def enrich(*, input_path, input_summary_path, observations_path, observations_summary_path, router_directory, output_path):
    inputs = {"inventory": input_path, "inventory_summary": input_summary_path,
              "observations": observations_path, "observations_summary": observations_summary_path}
    source_bytes = {key: path.read_bytes() for key, path in inputs.items()}
    original, prior = load_json(source_bytes["inventory"]), load_json(source_bytes["inventory_summary"])
    observations, query_summary = load_json(source_bytes["observations"]), load_json(source_bytes["observations_summary"])
    require(isinstance(original, dict) and original.get("version") == 1 and isinstance(prior, dict) and isinstance(query_summary, dict),
            "INPUT_INVALID", "Supply the frozen input and retained observation artifacts with their summaries.")
    require(digest(source_bytes["inventory"]) == native.input_hash(prior), "INPUT_HASH_MISMATCH", "The migration input differs from its preceding receipt.")
    require(not output_path.exists(), "OUTPUT_EXISTS", "Choose a new evidence directory; existing output is never overwritten.")
    entries = original.get("catalog", {}).get("entries")
    require(isinstance(entries, list) and all(isinstance(entry, dict) and isinstance(entry.get("legacy_id"), str)
            and type(entry.get("metadata_complete")) is bool for entry in entries), "CATALOG_INVALID", "The original catalog is not an exact typed entry list.")
    entry_counts = Counter(entry["legacy_id"] for entry in entries)
    index, query_counts = observation_index(observations)
    router_rows, router_hashes = load_router_evidence(router_directory)
    router_items = original.get("preservation", {}).get("routers", {}).get("items")
    require(isinstance(router_items, list) and all(isinstance(item, dict) and isinstance(item.get("legacy_id"), str) for item in router_items),
            "ROUTER_INVENTORY_INVALID", "The frozen Router preservation inventory is invalid.")
    router_counts = Counter(item["legacy_id"] for item in router_items)
    preserved_routers = {item["legacy_id"]: item for item in router_items if router_counts[item["legacy_id"]] == 1}
    updated, evidence = deepcopy(original), []
    for entry, replacement in zip(entries, updated["catalog"]["entries"]):
        if entry_counts[entry["legacy_id"]] != 1:
            row = {"version": 1, "legacy_id": entry["legacy_id"], "status": "unverified", "issues": [{"code": "CATALOG_IDENTITY_REPEATED"}]}
        else:
            row = observe_entry(entry, index, router_rows, preserved_routers)
        replacement["metadata_complete"] = row["status"] == "verified"
        evidence.append(row)
    restored = deepcopy(updated)
    for old, new in zip(entries, restored["catalog"]["entries"]):
        new["metadata_complete"] = old["metadata_complete"]
    require(exact(restored, original), "ENRICHMENT_SCOPE_CHANGED", "An unrelated original migration value changed; no output was written.")
    require(all(path.read_bytes() == source_bytes[key] for key, path in inputs.items()),
            "INPUT_CHANGED", "An input artifact changed during offline observation; no output was written.")
    require(all(digest((router_directory / name).read_bytes()) == expected for name, expected in router_hashes.items()),
            "ROUTER_EVIDENCE_CHANGED", "A retained Router artifact changed during offline observation; no output was written.")
    input_bytes = encoded(updated)
    lines = [encoded(row) for row in evidence]
    receipts = [{"version": 1, "legacy_id": row["legacy_id"], "status": row["status"], "metadata_complete": row["status"] == "verified",
                 "evidence": {"file": "metadata-evidence.jsonl", "line": number, "sha256": digest(data)}, "issues": row["issues"]}
                for number, (row, data) in enumerate(zip(evidence, lines), 1)]
    artifacts = {"input.json": input_bytes, "metadata-evidence.jsonl": b"".join(lines),
                 "metadata-receipts.jsonl": b"".join(encoded(row) for row in receipts)}
    verified = [row for row in evidence if row["status"] == "verified"]
    result = {"version": 1, "mode": "read_only_metadata_enrichment",
              "inputs": {key: {"file": path.resolve().as_uri(), "sha256": digest(source_bytes[key])} for key, path in inputs.items()},
              "router_evidence": {"directory": router_directory.resolve().as_uri(), "hashes": router_hashes},
              "counts": {"catalog_entries": len(entries), "metadata_verified": len(verified), "unverified": len(entries) - len(verified),
                         "query_pages": query_counts,
                         "entries_with_file_access_renewal": sum(bool(row["query_comparison"]["file_access_renewals"]) for row in verified)},
              "failures": dict(sorted(Counter(issue["code"] for row in evidence for issue in row["issues"]).items())),
              "output": {"input_sha256": digest(input_bytes), **{name: {"sha256": digest(data), "bytes": len(data)} for name, data in artifacts.items()}},
              "safeguards": {"network_requests": 0, "production_writes": 0, "original_inputs_unchanged": True,
                             "original_records_unchanged": True, "original_metadata_unchanged": True, "raw_values_unchanged": True,
                             "body_and_ownership_unchanged": True, "source_semantics_unchanged": True, "approved_scope_unchanged": True,
                             "terminal_outcomes_unchanged": True, "overall_complete_flags_unchanged": True,
                             "atomic_snapshot": False, "body_identity_verified": False, "apply_allowed": False}}
    output_path.mkdir(parents=True, mode=0o700, exist_ok=False)
    for name, data in artifacts.items():
        native.write_new(output_path / name, data)
    native.write_new(output_path / "summary.json", encoded(result))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "input-summary", "observations", "observations-summary", "router-evidence", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    try:
        result = enrich(input_path=args.input, input_summary_path=args.input_summary,
                        observations_path=args.observations, observations_summary_path=args.observations_summary,
                        router_directory=args.router_evidence, output_path=args.output)
    except (EvidenceError, ValueError, UnicodeError, OSError, TypeError) as error:
        print(json.dumps({"ok": False, "code": error.code if isinstance(error, EvidenceError) else "EVIDENCE_UNREADABLE"}), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, "counts": result["counts"], "failures": result["failures"], "output": result["output"]}, ensure_ascii=False))
    return 0 if result["counts"]["unverified"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())

