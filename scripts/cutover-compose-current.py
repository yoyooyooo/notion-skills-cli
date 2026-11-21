#!/usr/bin/env python3
"""AH-513 only: compose frozen current inputs without network or Notion writes.

This is a reviewable conversion candidate, not a migration reader or apply tool.
Native byte identities describe authored header + captured body before the current
reader projects native links. Source/resource bytes remain exact original bytes.
"""

import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


ENTRYPOINT = {"skill": "SKILL.md", "router": "ROUTER.md", "prompt": "PROMPT.md"}
RECEIPT = ("40c5636c-236e-81d6-bc9e-e11a07a7271c", "create-receipt.json")
RECEIPT_PAGE = "40c5636c-236e-813c-96d0-eb875fcdc696"
HEADER = re.compile(r"^\ufeff?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)(?:\r?\n)*")

CORE_HELPER = r"""
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const { canonicalMain } = await import(new URL('packages/core/src/portable.ts', input.repo));
const { parseYaml } = await import(new URL('packages/core/src/yaml.ts', input.repo));
const { planSharedFiles } = await import(new URL('packages/core/src/shared-composition.ts', input.repo));
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const result = { headers: {}, main_metadata: {}, trees: {} };
for (const job of input.headers) {
  try {
    const canonical = canonicalMain(job.name, job.description, '', {
      path: job.path, bytes: encoder.encode(job.previous), mode: job.mode,
    });
    const before = decoder.decode(canonical.bytes);
    // The retired canonicalMain deleted this field. Current canonicalMain does not.
    const header = before.replace(/^"notion_page_id":.*\n/gm, '');
    result.headers[job.id] = { header, removed_notion_page_id: header !== before };
  } catch (error) { result.headers[job.id] = { error: String(error.message) }; }
}
for (const job of input.main_metadata) {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(job.text.replace(/^\uFEFF/, ''));
    const raw = match ? parseYaml(match[1]) : {};
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    result.main_metadata[job.id] = {
      has_header: Boolean(match),
      name: value.name ?? null, description: value.description ?? null,
      name_matches_display: value.name === job.name,
      description_matches_display: value.description === job.description,
    };
  } catch (error) { result.main_metadata[job.id] = { error: String(error.message) }; }
}
for (const job of input.trees) {
  try {
    const plan = planSharedFiles({ base: job.paths.map(path => ({ path })),
      mounts: [], overrides: [], entrypoint: job.entrypoint });
    result.trees[job.id] = { paths: plan.paths };
  } catch (error) { result.trees[job.id] = { error: String(error.message) }; }
}
process.stdout.write(JSON.stringify(result));
"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def rich(prop):
    kind = prop.get("type")
    value = prop.get(kind)
    if kind in ("title", "rich_text"):
        return "".join(x.get("plain_text", x.get("text", {}).get("content", "")) for x in value)
    if kind == "relation":
        return [x["id"] for x in value]
    if kind == "select":
        return value.get("name") if value else None
    return value


def canonical_path(path):
    if not isinstance(path, str) or not path or "\\" in path or re.search(r"[\x00-\x1f\x7f]", path):
        raise ValueError(f"Invalid path: {path!r}")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path) or any(p in ("", ".", "..") for p in path.split("/")):
        raise ValueError(f"Noncanonical path: {path!r}")
    return path


def header_of(raw):
    text = raw.decode("utf-8-sig")
    match = HEADER.match(text)
    return match.group() if match else ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--decoder-root", type=Path, required=True)
    parser.add_argument("--metadata-root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.input_root.resolve()
    out = (args.output or root / "current-tree-candidate").resolve()
    if out != root / "current-tree-candidate":
        raise ValueError("AH-513 output is restricted to INPUT_ROOT/current-tree-candidate")
    repo = Path(__file__).resolve().parents[1]
    inputs = {}

    def load(path):
        raw = path.read_bytes()
        inputs[str(path)] = digest(raw)
        return json.loads(raw)

    def table(name):
        rows = load(root / "current-metadata" / f"{name}.json")
        by_page = {r["id"]: {k: rich(v) for k, v in r["properties"].items()} for r in rows}
        if len(by_page) != len(rows):
            raise ValueError(f"The current {name} inventory repeats a page ID")
        return by_page

    skills = table("skills")
    files = table("files")
    sources = table("sources")
    verification = load(root / "current-metadata/verification.json")
    manifests = load(root / "selected-source-manifests.json")
    decoder = load(args.decoder_root / "resolved-current-files.json")
    closure = load(args.decoder_root / "missing-current-closure.json")
    metadata = load(args.metadata_root / "metadata-convergence.json")
    resources = load(args.decoder_root / "resource-originals.json")
    repairs = load(root / "identity-repair-result.json")
    capture = load(root / "native-pages/index.json")
    local = load(root / "selected-git-local-export/local-check-with-inventory.json")
    recovery = load(root / "fixed-git-recovery/result.json")
    relation_summary = load(root / "relations-current-final/summary.json")
    if not (repairs["complete"] and capture["complete"] and recovery["complete"] and relation_summary["complete"]):
        raise ValueError("The frozen body, identity, relation and exact-Git inputs must be complete")
    if recovery["failed"] or len(capture["captured"]) != capture["expected"]:
        raise ValueError("The captured input denominator is incomplete")
    if decoder["unresolved"] or any(closure[k] for k in ("missing", "unavailable", "unresolved")):
        raise ValueError("Current event/resource closure has unresolved inputs")
    if not (verification["complete_current_physical_page_capture"]
            and verification["row_membership_unchanged"]
            and verification["changes_exactly_identity_repairs"]):
        raise ValueError("Fresh metadata does not confirm the captured current input")
    if (verification["invalid_local_hashes"] or verification["pages_edited_after_capture"]
            or verification["captured_pages"] != capture["expected"]):
        raise ValueError("Current pages changed after capture or failed local verification")
    changes = verification["metadata_changed_since_previous_census"]
    if (set(changes["skills"]) != {x["page_id"] for x in repairs["items"]}
            or changes["files"] or changes["sources"]):
        raise ValueError("Fresh metadata changes differ from the verified identity repairs")
    for path in sorted((root / "relations-current-final").glob("*.json")):
        if path.name == "summary.json":
            continue
        patch = load(path)
        target = skills if patch["table"] == "skills" else sources
        for value in patch["relations"].values():
            target[patch["page_id"]][value["name"]] = value["targets"]
    for item in repairs["items"]:
        if item["state"] != "verified" or not item["body_preserved"]:
            raise ValueError("Identity repair was not verified")
        owner = skills[item["page_id"]]
        if (owner["Main File ID"] != item["main_file_id"] or owner["Skill ID"] != item["skill_id"]
                or owner["Enabled"] != item["enabled"]):
            raise ValueError("Fresh current identity differs from the verified repair")

    observed = {x["page_id"]: x for x in capture["captured"]}
    resource_by_path = {(x["owner_page_id"], x["path"]): x for x in resources}
    originals = {(x["skill_page_id"], x["path"]): x for x in local["hits"] + recovery["fetched"]}
    no_events = {(x["binding"]["owner_page_id"], x["binding"]["page_id"]): x for x in metadata["no_events"]}
    states = {(x["binding"]["owner_page_id"], x["binding"]["page_id"]): x["result"] for x in decoder["results"]}
    if len(states) != len(decoder["results"]):
        raise ValueError("The decoder repeats a physical owner/page binding")
    for item in decoder["results"]:
        state = item["result"]
        if state.get("placement") is not None:
            raise ValueError("This one-time input did not admit moved/suppressed placements")
        if state["kind"] != "resolved" and state.get("reason") != "NO_EVENTS":
            raise ValueError("Only explicit NO_EVENTS may use current-page migration interpretation")
    byte_cache = {}
    unresolved = []
    excluded = []
    decisions = []
    headers = []
    main_metadata = []
    trees = []
    owners = []
    candidate_delta = []

    def verified(path, expected_sha, expected_size, git_oid=None):
        path = Path(path)
        if path not in byte_cache:
            byte_cache[path] = path.read_bytes()
        raw = byte_cache[path]
        actual = digest(raw)
        if len(raw) != expected_size or expected_sha is not None and actual != expected_sha:
            raise ValueError(f"Byte identity mismatch: {path}")
        if git_oid is not None:
            actual_oid = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
            if actual_oid != git_oid:
                raise ValueError(f"Git blob identity mismatch: {path}")
        return raw, actual

    def body(page):
        identity = observed[page]
        path = root / "native-pages" / f"{page}.md"
        raw, sha = verified(path, identity["sha256"], identity["bytes"])
        raw.decode("utf-8")
        return raw, {"page_id": page, "local_path": str(path), "sha256": sha,
                     "bytes": len(raw), "observed_at": identity["observed_at"]}

    def binding(owner, path, row=None):
        if row is not None:
            return {"kind": "existing", "page_id": row["page_id"], "file_id": row["file_id"]}
        identity = json.dumps(["AH-513/current-file", manifests["library_id"], owner, path], separators=(",", ":"))
        return {"kind": "new_files_candidate", "page_id": None, "file_id": "file-" + digest(identity.encode())}

    selected = {}
    for kind, key in (("git", "git"), ("bundle", "bundles")):
        for item in manifests[key]:
            owner = item["skill_page_id"]
            if owner in selected:
                raise ValueError("An owner has more than one selected content manifest")
            selected[owner] = (kind, item)

    bindings = collections.defaultdict(list)
    for owner, skill in skills.items():
        bindings[owner].append({"page_id": owner, "file_id": skill["Main File ID"],
                                "path": ENTRYPOINT[skill["Kind"]], "main": True})
    for page, file in files.items():
        if len(file["Skill"]) != 1 or file["Skill"][0] not in skills:
            raise ValueError(f"A physical File lacks one active owner: {page}")
        owner = file["Skill"][0]
        if page not in skills[owner]["Supporting Files"]:
            raise ValueError(f"The complete supporting relation disagrees with File ownership: {page}")
        bindings[owner].append({"page_id": page, "file_id": file["File ID"], "path": file["Path"], "main": False})
    actual_bindings = {(owner, row["page_id"]): row for owner, rows in bindings.items() for row in rows}
    repair_pages = {item["page_id"] for item in repairs["items"]}
    for item in decoder["results"]:
        old = item["binding"]
        current = actual_bindings[(old["owner_page_id"], old["page_id"])]
        if current["file_id"] != old["file_id"] or (not old["main"] and current["path"] != old["path"]):
            raise ValueError("Decoder identity differs from current physical metadata")
    if {page for owner, page in set(actual_bindings) - set(states)} != repair_pages:
        raise ValueError("The physical-to-decoder difference is not exactly the verified main identity repairs")

    for owner, skill in sorted(skills.items()):
        entrypoint = ENTRYPOINT[skill["Kind"]]
        base = {}
        chosen = selected.get(owner)
        if chosen is not None:
            kind, record = chosen
            container = record["source"] if kind == "git" else record["bundle"]
            for original in container["files"]:
                path = canonical_path(original["path"])
                if path in base:
                    raise ValueError(f"Duplicate selected path: {owner}/{path}")
                if kind == "git":
                    saved = originals[(owner, path)]
                    local_path = saved["export_object_path"]
                    raw, sha = verified(local_path, original.get("sha256"), original["bytes"], original["git_oid"])
                    origins = skill["Origin"]
                    if len(origins) != 1 or origins[0] not in sources:
                        raise ValueError(f"Selected Git owner lacks one current Origin: {owner}")
                    source_page = origins[0]
                    origin = {"kind": "git", "source_page_id": source_page,
                              "source_id": sources[source_page]["Source ID"],
                              "source_path": canonical_path(original["source_path"]),
                              "commit": container["commit"], "git_oid": original["git_oid"],
                              "repository_url": container["url"], "root": container["root"],
                              "selected_record_page_id": record["record_page_id"],
                              "legacy_source_carrier_id": record["source_id"]}
                    authority = "source"
                else:
                    local_path = str(root / "selected-bundles-export" / owner / "tree" / path)
                    raw, sha = verified(local_path, original["sha256"], original["bytes"])
                    origin = {"kind": "bundle", "selected_record_page_id": record["record_page_id"],
                              "bundle_id": skill["Selected Version"], "path": path}
                    authority = "resource"
                mode = original.get("mode") or "100644"
                if mode not in ("100644", "100755"):
                    raise ValueError(f"Invalid selected mode: {owner}/{path}")
                base[path] = {"path": path, "authority": authority, "sha256": sha, "bytes": len(raw),
                              "mode": mode, "local_bytes_path": local_path, "origin": origin,
                              "byte_scope": "exact_selected_original", "mode_evidence": "selected_manifest" if original.get("mode") else "explicit_regular_file_normalization"}
                if authority == "source":
                    base[path]["source"] = dict(origin)
                else:
                    base[path]["resource"] = {"legacy_object_id": None, "preparation": "prepare_current_resource_from_exact_bytes"}

        physical = {canonical_path(x["path"]): x for x in bindings[owner]}
        if len(physical) != len(bindings[owner]):
            raise ValueError(f"Physical paths collide after current Kind correction: {owner}")
        effective = dict(base)
        for path, row in sorted(physical.items()):
            state = states.get((owner, row["page_id"]))
            ownership = state.get("ownership", {}) if state else {}
            old_kind = ownership.get("kind")
            exact = base.get(path)
            if old_kind == "tombstone":
                retained = resource_by_path[(owner, path)]
                verified(retained["local_path"], retained["sha256"], retained["bytes"])
                effective.pop(path, None)
                excluded.append({"owner_page_id": owner, "path": path, "binding": binding(owner, path, row),
                                 "reason": "explicit_tombstone", "retained_original": retained})
                continue
            if (owner, path) == RECEIPT:
                raw, observed_body = body(row["page_id"])
                if row["page_id"] != RECEIPT_PAGE or raw != b"" or exact is None or exact["bytes"] != 0:
                    raise ValueError("The authorized receipt exclusion no longer matches the verified empty receipt")
                effective.pop(path, None)
                excluded.append({"owner_page_id": owner, "path": path, "binding": binding(owner, path, row),
                                 "reason": "authorized_empty_receipt_retirement", "current_body": observed_body,
                                 "selected_original": exact})
                continue
            eventless = no_events.get((owner, row["page_id"]))
            git_only = eventless is not None and eventless["projection_category"] == "git_only_marker"
            follows = old_kind in ("following", "resource_following") or git_only
            if follows:
                if exact is None:
                    raise ValueError(f"A following file has no exact selected original: {owner}/{path}")
                value = dict(exact)
                value["binding"] = binding(owner, path, row)
                value["ownership_evidence"] = old_kind or "git_only_marker"
                if old_kind != "resource_following":
                    raw, observed_body = body(row["page_id"])
                    expected = hashlib.sha256(b"").hexdigest() if git_only else ownership["projection"]["sha256"]
                    if observed_body["sha256"] != expected:
                        raise ValueError(f"Following current page differs from its exact projection: {owner}/{path}")
                    value["current_projection"] = observed_body
                else:
                    value["retained_projection_object"] = resource_by_path[(owner, path)]
                if chosen[0] == "bundle":
                    decisions.append({"owner_page_id": owner, "path": path, "rule": "bundle_following_to_exact_resource"})
                effective[path] = value
                continue
            if old_kind == "custom" and ownership.get("content", {}).get("kind") == "resource":
                original = resource_by_path[(owner, path)]
                raw, sha = verified(original["local_path"], original["sha256"], original["bytes"])
                value = {"path": path, "authority": "resource", "sha256": sha, "bytes": len(raw),
                         "mode": original["mode"], "local_bytes_path": original["local_path"],
                         "binding": binding(owner, path, row), "byte_scope": "exact_current_resource",
                         "origin": {"kind": "current_resource", "object_id": original["object_id"]},
                         "resource": {"legacy_object_id": original["object_id"], "preparation": "prepare_current_resource_from_exact_bytes"},
                         "ownership_evidence": "resolved_custom_resource"}
                if exact is not None:
                    value["replaces_selected_original"] = exact["origin"]
                effective[path] = value
                continue
            if state is not None and state["kind"] == "resolved" and old_kind != "custom":
                raise ValueError(f"Unrecognized current ownership: {owner}/{path}/{old_kind}")
            raw, observed_body = body(row["page_id"])
            current_meta = state.get("metadata", {}) if state else {}
            mode = current_meta.get("mode") or "100644"
            known_header = current_meta.get("frontmatter")
            native = {"body": observed_body, "original_known_frontmatter": known_header,
                      "frontmatter": None, "frontmatter_evidence": None}
            value = {"path": path, "authority": "native", "sha256": None, "bytes": None,
                     "mode": mode, "local_bytes_path": None, "binding": binding(owner, path, row),
                     "byte_scope": "authored_header_plus_current_body_before_consumer_projection", "native": native,
                     "origin": {"kind": "current_native_page", "page_id": row["page_id"]},
                     "ownership_evidence": "resolved_custom_native" if old_kind == "custom" else "current_page_without_event",
                     "mode_evidence": "current_event" if current_meta.get("mode") else "explicit_regular_file_normalization"}
            if exact is not None:
                value["replaces_selected_original"] = exact["origin"]
            if row["main"]:
                if HEADER.match(raw.decode("utf-8-sig")):
                    raise ValueError(f"Current native main unexpectedly contains an authored YAML header: {owner}")
                previous = known_header
                evidence = "known_current_header"
                if previous is None:
                    previous = header_of(byte_cache[Path(exact["local_bytes_path"])]) if exact else ""
                    evidence = "exact_selected_main_header" if exact else "current_display_metadata_only"
                native["frontmatter_evidence"] = evidence
                headers.append({"id": owner, "name": skill["Name"], "description": skill["Description"],
                                "path": path, "mode": mode, "previous": previous})
            elif known_header is not None:
                native.update(frontmatter=known_header, frontmatter_evidence="known_current_header")
            elif eventless is not None and eventless["projection_category"] == "fingerprint" and exact is not None:
                if eventless["projection"]["source_revision"] != skill["Selected Version"]:
                    raise ValueError(f"Eventless projected header lacks an exact selected revision: {owner}/{path}")
                native.update(frontmatter=header_of(byte_cache[Path(exact["local_bytes_path"])]),
                              frontmatter_evidence="exact_selected_projection_header")
            else:
                native.update(frontmatter="", frontmatter_evidence="explicit_empty_unknown_native_supporting_header")
            effective[path] = value

        for path, value in sorted(effective.items()):
            if path not in physical:
                value["binding"] = binding(owner, path)
                candidate_delta.append({"owner_page_id": owner, "path": path, "authority": value["authority"],
                                        "origin_kind": value["origin"]["kind"], "file_id": value["binding"]["file_id"]})
            value["main"] = path == entrypoint
            if value["main"] and value["authority"] != "native":
                main_metadata.append({"id": owner, "text": byte_cache[Path(value["local_bytes_path"])].decode("utf-8-sig"),
                                      "name": skill["Name"], "description": skill["Description"]})
        if entrypoint not in effective:
            raise ValueError(f"Composed owner has no current entrypoint: {owner}")
        trees.append({"id": owner, "entrypoint": entrypoint, "paths": sorted(effective)})
        owners.append({"owner_page_id": owner, "skill_id": skill["Skill ID"], "name": skill["Name"],
                       "description": skill["Description"], "kind": skill["Kind"], "entrypoint": entrypoint,
                       "enabled": skill["Enabled"], "default_context": skill["Default Context"],
                       "relations": {"origin": skill["Origin"], "members": skill["Members"], "requires": skill["Requires"]},
                       "files": [effective[path] for path in sorted(effective)]})

    helper_input = {"repo": repo.as_uri() + "/", "headers": headers, "main_metadata": main_metadata, "trees": trees}
    helper = subprocess.run(["node", "--input-type=module", "-e", CORE_HELPER],
                            input=json.dumps(helper_input, ensure_ascii=False), capture_output=True, text=True, cwd=repo)
    if helper.returncode:
        raise ValueError("Current core parser/plan helper failed: " + helper.stderr[:1500])
    core = json.loads(helper.stdout)
    out.mkdir(parents=True, exist_ok=True)
    (out / "objects").mkdir(exist_ok=True)
    for owner in owners:
        page = owner["owner_page_id"]
        check = core["trees"][page]
        if "error" in check:
            unresolved.append({"owner_page_id": page, "kind": "current_tree_validation", "error": check["error"]})
        elif sorted(check["paths"]) != [f["path"] for f in owner["files"]]:
            raise ValueError("Actual core composition disagrees with the candidate path set")
        for file in owner["files"]:
            if file["authority"] != "native":
                if file["main"]:
                    file["display_metadata_comparison"] = core["main_metadata"][page]
                continue
            native = file["native"]
            if file["main"]:
                result = core["headers"][page]
                if "error" in result:
                    unresolved.append({"owner_page_id": page, "path": file["path"], "kind": "native_main_header", "error": result["error"]})
                    continue
                native["frontmatter"] = result["header"]
                native["explicit_notion_page_id_removal"] = result["removed_notion_page_id"]
                native["main_header_normalization"] = "current_canonicalMain_name_description_and_sorted_keys_plus_explicit_old_notion_page_id_removal"
            authored = native["frontmatter"].encode() + byte_cache[Path(native["body"]["local_path"])]
            sha = digest(authored)
            local_path = out / "objects" / sha
            if not local_path.exists() or local_path.read_bytes() != authored:
                local_path.write_bytes(authored)
            file.update(sha256=sha, bytes=len(authored), local_bytes_path=str(local_path))
            file["content_candidate"] = {"kind": "native", "mode": file["mode"], "frontmatter": native["frontmatter"]}

    all_files = [f for owner in owners for f in owner["files"]]
    by_authority = collections.Counter(f["authority"] for f in all_files)
    by_new_authority = collections.Counter(x["authority"] for x in candidate_delta)
    physical_count = sum(len(x) for x in bindings.values())
    expected = physical_count - len(excluded) + len(candidate_delta)
    if expected != len(all_files):
        raise ValueError("Physical plus inherited minus excluded accounting does not close")
    identity_keys = [(o["owner_page_id"], f["binding"]["file_id"]) for o in owners for f in o["files"]]
    if len(identity_keys) != len(set(identity_keys)):
        raise ValueError("One owner's file identities collide")
    summary = {"owners": len(owners), "physical_bindings_after_repairs": physical_count,
               "selected_manifest_unbound_candidates": len(candidate_delta), "new_file_authorities": dict(by_new_authority),
               "excluded": len(excluded), "effective_files": len(all_files), "effective_supporting_files": len(all_files) - len(owners),
               "authorities": dict(by_authority), "unresolved": len(unresolved),
               "source_plan_preparation_required": by_authority["source"], "current_resource_preparation_required": by_authority["resource"],
               "accounting": f"{physical_count} physical + {len(candidate_delta)} inherited - {len(excluded)} exclusions = {len(all_files)} effective"}
    report = {"version": 1, "scope": "AH-513 one-time read-only current tree composition", "library_id": manifests["library_id"],
              "composition_complete": not unresolved, "apply_ready": False, "summary": summary,
              "input_sha256": inputs, "script_sha256": digest(Path(__file__).read_bytes()),
              "rules": ["Native bodies remain captured current page bytes; only their header descriptor is constructed.",
                        "Native main header uses the actual current canonicalMain parser/serializer, with explicit retired notion_page_id deletion.",
                        "Resource/source main bytes stay exact; differing display metadata is reported independently.",
                        "Known supporting headers remain exact; unknown custom supporting headers become explicit empty strings.",
                        "Eventless exact bundle projections can retain selected header metadata without replacing current body.",
                        "Omitted modes explicitly normalize to regular non-executable 100644.",
                        "Resolved following uses exact selected content; bundle following becomes resource, Git following remains source.",
                        "Only the exact tombstone and verified authorized empty receipt are excluded.",
                        "Current Kind supplies entrypoint; complete current relations and verified identity repairs are overlaid first.",
                        "Each final path set is validated by the existing core planSharedFiles implementation."],
              "preparation_boundaries": {"source": "Join SourcePlan revision and exact source_path from cutover-compose-sources output before forming current Content.",
                                         "resource": "Prepare current resource records from local_bytes_path; legacy object IDs are provenance, not fabricated current descriptors.",
                                         "native": "content_candidate is complete; local byte hash is before consumer native-link projection.",
                                         "new_files": "file_id is deterministic candidate identity; page_id remains null until authorized creation."},
              "owners": owners, "new_files_candidates": candidate_delta, "excluded": excluded,
              "decisions": decisions, "unresolved": unresolved}
    for name, value in (("manifest.json", report), ("summary.json", summary)):
        (out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"manifest": str(out / "manifest.json"), **summary}, ensure_ascii=False))
    return 1 if unresolved else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyError, ValueError, OSError) as error:
        print(f"AH-513 composition stopped: {error}", file=sys.stderr)
        sys.exit(2)
