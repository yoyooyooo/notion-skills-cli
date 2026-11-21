#!/usr/bin/env python3
"""One-time AH-513 read: complete truncated relations before current conversion.

This is not a product reader or cleanup entry. Remove after the live cutover.
Uses the already authenticated ntn CLI; never sends a remote mutation.
"""

import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path
from urllib.parse import unquote


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def read_response(arguments):
    result = subprocess.run(
        ["ntn", "api", *arguments], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=45
    )
    if result.returncode:
        raise RuntimeError(
            f"ntn read failed, exit={result.returncode}, "
            f"stderr_sha256={hashlib.sha256(result.stderr.encode()).hexdigest()}"
        )
    return json.loads(result.stdout), len(result.stdout.encode())


def capture(input_root, output, max_requests):
    if output.exists():
        raise ValueError("Output must be a new directory; original captures are preserved.")
    selected = {}
    counts = {}
    for table in ("skills", "files", "records", "sources"):
        rows = json.loads((input_root / f"{table}.json").read_text())
        if not isinstance(rows, list):
            raise ValueError(f"Expected complete page array for {table}.")
        counts[table] = len(rows)
        for row in rows:
            properties = {
                name: prop
                for name, prop in row["properties"].items()
                if prop.get("type") == "relation" and prop.get("has_more")
            }
            if properties:
                if row["id"] in selected:
                    raise ValueError("Duplicate physical page in the input tables.")
                selected[row["id"]] = (table, row, properties)
    output.mkdir(mode=0o700)
    summary = {
        "purpose": "AH-513 complete current relation values before in-place conversion",
        "input_rows": counts,
        "selected_pages": len(selected),
        "selected_properties": sum(len(item[2]) for item in selected.values()),
        "max_requests": max_requests,
        "ntn_calls": 0,
        "response_bytes": 0,
        "http_attempts": "not_observed",
        "semantic_writes": 0,
        "complete": False,
        "pages": [],
        "failures": [],
    }
    start = time.monotonic()

    def request(arguments):
        if summary["ntn_calls"] >= max_requests:
            raise RuntimeError("Explicit request budget exhausted.")
        summary["ntn_calls"] += 1
        result, size = read_response(arguments)
        summary["response_bytes"] += size
        return result

    def checkpoint():
        summary["elapsed_ms"] = round((time.monotonic() - start) * 1000)
        write_json(output / "summary.json", summary)

    checkpoint()
    for page_id, (table, old_page, properties) in selected.items():
        try:
            current = request([f"v1/pages/{page_id}"])
            if current.get("id") != page_id or current.get("in_trash") or current.get("archived") or current.get("is_archived"):
                raise ValueError("Selected page is unavailable or no longer active.")
            complete = {}
            for name, old_property in properties.items():
                property_id = old_property["id"]
                present = [
                    value for value in current["properties"].values()
                    if unquote(value["id"]) == unquote(property_id)
                ]
                if len(present) != 1 or present[0].get("type") != "relation":
                    raise ValueError("Relation property identity or type changed.")
                relations = []
                cursor = None
                cursors = set()
                while True:
                    arguments = [f"v1/pages/{page_id}/properties/{property_id}", "page_size==100"]
                    if cursor:
                        arguments.append("start_cursor==" + cursor)
                    response = request(arguments)
                    if response.get("object") != "list" or not isinstance(response.get("has_more"), bool):
                        raise ValueError("Relation response is not a complete page contract.")
                    for item in response["results"]:
                        if item.get("type") != "relation" or unquote(item.get("id", "")) != unquote(property_id):
                            raise ValueError("Unexpected relation property item.")
                        relations.append(item["relation"]["id"])
                    if not response["has_more"]:
                        if response.get("next_cursor"):
                            raise ValueError("Terminal relation page retains a cursor.")
                        break
                    cursor = response.get("next_cursor")
                    if not cursor or cursor in cursors:
                        raise ValueError("Missing or repeated relation cursor.")
                    cursors.add(cursor)
                if len(set(relations)) != len(relations):
                    raise ValueError("Duplicate relation target across pages.")
                complete[property_id] = {"name": name, "targets": relations, "complete": True}
            after = request([f"v1/pages/{page_id}"])
            before_relations = {p["id"]: p for p in current["properties"].values() if p.get("type") == "relation"}
            after_relations = {p["id"]: p for p in after.get("properties", {}).values() if p.get("type") == "relation"}
            if after.get("last_edited_time") != current.get("last_edited_time") or before_relations != after_relations:
                raise ValueError("Page changed during relation collection.")
            record = {
                "page_id": page_id,
                "table": table,
                "changed_since_inventory": current.get("last_edited_time") != old_page.get("last_edited_time"),
                "page": current,
                "relations": complete,
            }
            write_json(output / f"{page_id}.json", record)
            summary["pages"].append({
                "page_id": page_id,
                "properties": {key: len(value["targets"]) for key, value in complete.items()},
                "changed_since_inventory": record["changed_since_inventory"],
            })
        except (RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
            summary["failures"].append({"page_id": page_id, "message": str(error)})
            checkpoint()
            break
        checkpoint()
        print(json.dumps({"captured_pages": len(summary["pages"]), "selected_pages": len(selected), "ntn_calls": summary["ntn_calls"]}), flush=True)
    summary["complete"] = len(summary["pages"]) == len(selected) and not summary["failures"]
    checkpoint()
    print(json.dumps({key: value for key, value in summary.items() if key != "pages"}), flush=True)
    return 0 if summary["complete"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-requests", type=int, required=True)
    args = parser.parse_args()
    if not args.input.is_absolute() or not args.output.is_absolute() or args.max_requests <= 0:
        parser.error("Use absolute input/output paths and a positive explicit request budget.")
    raise SystemExit(capture(args.input, args.output, args.max_requests))
