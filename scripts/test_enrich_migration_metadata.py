"""Offline metadata enrichment tests with synthetic retained observations."""

from collections import Counter
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("enrich_metadata", Path(__file__).with_name("enrich-migration-metadata.py"))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load metadata enrichment")
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)
native = verifier.native


def uid(number):
    return "00000000-0000-4000-8000-" + format(number, "012x")


def rich(identity, value, kind="rich_text"):
    return {"id": identity, "type": kind, kind: [{"type": "text", "plain_text": value, "text": {"content": value}}]}


def signed_url(signature="a", date="20260101T000000Z", path="retained.zip", extra=""):
    return "https://prod-files-secure.s3.us-west-2.amazonaws.com/synthetic-coordinate/" + path + \
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=synthetic-credential&X-Amz-Date=" + date + \
        "&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=" + signature * 64 + extra


def file_property():
    return {"id": "notion%3A%2F%2Fskills%2Ffiles_property", "type": "files", "files": [{"name": "retained.zip", "type": "file",
        "file": {"url": signed_url(), "expiry_time": "2026-01-01T01:00:00.000Z"}, "unknown_file_field": {"keep": True}}]}


def page(number, kind, subscription=False):
    fields = {"Description": rich("description", "Original description " + str(number)),
              "Default Context": {"id": "context", "type": "checkbox", "checkbox": False},
              "Unknown Property": {"id": "future", "type": "number", "number": 7, "unrecognized": {"retained": True}}}
    fields["Name" if subscription else "Skill name"] = rich("title", "Original title " + str(number), "title")
    if subscription:
        fields.update({"Status": {"id": "status", "type": "select", "select": {"name": "verified"}},
                       "Source": rich("source", json.dumps({"provider": {"type": "unknown-provider"}, "external_assets": True, "unknown_original": [False, 0]})),
                       "Published Members": rich("published", json.dumps({"version": 1, "revision": "retained-revision", "members": []})),
                       "Target Database ID": rich("target", uid(101))})
    else:
        fields["Description"]["id"] = "notion%3A%2F%2Fskills%2Fdescription_property"
        fields.update({"Kind": {"id": "kind", "type": "select", "select": {"name": kind}},
                       "Members": {"id": "mem%3Aroles", "type": "relation", "relation": [], "has_more": False},
                       "References": {"id": "references", "type": "rich_text", "rich_text": []},
                       "Files": file_property()})
    return {"object": "page", "id": uid(number), "parent": {"type": "data_source_id", "database_id": uid(100 if subscription else 101),
            "data_source_id": uid(200 if subscription else 201)}, "last_edited_time": "2026-01-01T00:00:00.000Z",
            "last_edited_by": {"object": "user", "id": uid(999)}, "in_trash": False, "is_archived": False,
            "is_locked": False, "properties": fields, "unknown_top_level": {"raw": True}}


def record(raw, kind, subscription=False):
    family = "notion_subscription" if subscription else "notion_page"
    locator = {"type": family, "subscription_id" if subscription else "page_id": raw["id"],
               "database_id": raw["parent"]["database_id"], "data_source_id": raw["parent"]["data_source_id"]}
    if subscription:
        locator["target_database_id"] = uid(101)
    name = raw["properties"]["Name" if subscription else "Skill name"]["title"][0]["plain_text"]
    entrypoint = "ROUTER.md" if kind == "router" else "SKILL.md"
    return {"id": family + ":" + raw["id"], "kind": kind, "locator": locator, "name": name,
            "alias": name.lower().replace(" ", "-"), "description": raw["properties"]["Description"]["rich_text"][0]["plain_text"],
            "default_context": False, "entrypoint": entrypoint,
            "ref": "skill://" + ("upstream%3A" if subscription else "") + raw["id"] + "/" + entrypoint}


class Fixture:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="migration-metadata-enrichment-test-"))
        self.input, self.input_summary = self.root / "input.json", self.root / "input-summary.json"
        self.observations, self.query_summary = self.root / "observations.json", self.root / "query-summary.json"
        self.router_output, self.output = self.root / "router-evidence", self.root / "metadata-evidence"
        self.pages = [page(1, "router", True), page(2, "router"), page(3, "skill")]
        entries, routers = [], []
        for number, raw in enumerate(self.pages):
            rec = record(raw, "skill" if number == 2 else "router", number == 0)
            entries.append({"legacy_id": rec["id"], "record": rec, "metadata": {"original_summary": {"name": rec["name"]}, "unknown_metadata": [False, 0]},
                            "metadata_complete": False, "files_complete": False, "legacy_mode": "unknown", "legacy_layout": "unknown",
                            "files": [{"legacy_id": "original-file-" + str(number), "path": rec["entrypoint"], "ownership": "unknown",
                                       "raw": {"retained": True}, "body": {"complete": False, "sha256": "c" * 64, "bytes": 12,
                                       "retention_ref": "retained:original", "retention_verified": False}}]})
            if number < 2:
                routers.append({"legacy_id": rec["id"], "raw": deepcopy(rec), "complete": False, "references": [],
                                "retention_ref": "catalog:synthetic", "retention_verified": True})
        self.data = {"version": 1, "scope": "frozen-original", "target_library_id": "not-yet-selected", "approved_legacy_ids": [],
                     "catalog": {"coverage": {"exhaustive": False}, "entries": entries},
                     "preservation": {"routers": {"complete": False, "items": routers},
                                      "sources": {"complete": False, "items": [{"source_semantics": "unknown", "raw": {"external_assets": True}}]},
                                      "views": {"complete": False, "items": []},
                                      "pins": {"complete": False, "items": [{"raw": {"asserted_user_pin": False}, "complete": True}]},
                                      "operations": {"complete": False, "items": [{"terminal_verified": False, "raw": {"state": "verified"}}]}},
                     "backup": {"verified": True, "reference": "backup:synthetic"}}
        grouped = {uid(200): [deepcopy(self.pages[0])], uid(201): deepcopy(self.pages[1:])}
        self.query = {"initial": deepcopy(grouped), "confirm": deepcopy(grouped)}
        self.router_pages = {raw["id"]: [deepcopy(raw), deepcopy(raw)] for raw in self.pages[:2]}
        self.property_routes = {}

    def freeze(self):
        self.input.write_bytes(verifier.encoded(self.data))
        self.input_summary.write_bytes(verifier.encoded({"mode": "read_only_operation_origins", "output": {"input_sha256": verifier.digest(self.input.read_bytes())}}))
        self.observations.write_bytes(verifier.encoded(self.query))
        self.query_summary.write_bytes(verifier.encoded({"counts": {"initial": 3, "confirm": 3}, "changed": [], "properties_requiring_pagination": []}))
        called = Counter()

        def reader(path):
            if path in self.property_routes:
                return verifier.encoded(self.property_routes[path])
            identity = path.rsplit("/", 1)[-1]
            index = called[identity]
            called[identity] += 1
            return verifier.encoded(self.router_pages[identity][index])

        native.collect(input_path=self.input, summary_path=self.input_summary, output_path=self.router_output, reader=reader)

    def run(self):
        return verifier.enrich(input_path=self.input, input_summary_path=self.input_summary,
                               observations_path=self.observations, observations_summary_path=self.query_summary,
                               router_directory=self.router_output, output_path=self.output)

    def read_output(self):
        return json.loads((self.output / "input.json").read_bytes())

    def evidence(self):
        return [json.loads(line) for line in (self.output / "metadata-evidence.jsonl").read_bytes().splitlines()]

    def expand_router(self):
        identity = "mem%3Aroles"
        complete = [{"id": uid(number)} for number in range(300, 330)]
        for raw in (self.query["initial"][uid(201)][0], self.query["confirm"][uid(201)][0], *self.router_pages[uid(2)]):
            raw["properties"]["Members"].update(relation=deepcopy(complete[:23]), has_more=True)
        self.property_routes[native.property_path(uid(2), identity)] = {
            "object": "list", "type": "property_item", "has_more": False, "next_cursor": None,
            "property_item": {"id": identity, "type": "relation", "relation": {}, "next_url": None},
            "results": [{"object": "property_item", "id": identity, "type": "relation", "relation": item} for item in complete]}
        return complete


class MetadataEnrichmentTests(unittest.TestCase):
    def test_only_metadata_complete_changes_while_original_records_metadata_raw_and_all_other_gates_remain(self):
        fixture = Fixture()
        fixture.freeze()
        before = fixture.input.read_bytes(), fixture.observations.read_bytes()
        with patch.object(native.NtnReader, "__call__", side_effect=AssertionError("No network is permitted")):
            result = fixture.run()
        self.assertEqual(result["counts"]["metadata_verified"], 3)
        updated = fixture.read_output()
        self.assertTrue(all(item["metadata_complete"] for item in updated["catalog"]["entries"]))
        for item in updated["catalog"]["entries"]:
            item["metadata_complete"] = False
        self.assertEqual(updated, fixture.data)
        self.assertEqual((fixture.input.read_bytes(), fixture.observations.read_bytes()), before)
        self.assertEqual(result["safeguards"]["network_requests"], 0)
        self.assertFalse(result["safeguards"]["apply_allowed"])
        self.assertFalse(result["safeguards"]["body_identity_verified"])

    def test_native_signed_access_renewal_retains_both_urls_and_requires_exact_same_coordinate(self):
        fixture = Fixture()
        file = fixture.query["confirm"][uid(201)][1]["properties"]["Files"]["files"][0]["file"]
        file.update(url=signed_url("b", "20260101T010000Z"), expiry_time="2026-01-01T02:00:00.000Z")
        fixture.freeze()
        result = fixture.run()
        self.assertEqual(result["counts"]["metadata_verified"], 3)
        self.assertEqual(result["counts"]["entries_with_file_access_renewal"], 1)
        renewal = fixture.evidence()[2]["query_comparison"]["file_access_renewals"][0]
        self.assertEqual(renewal["before"]["url"], signed_url())
        self.assertEqual(renewal["after"]["url"], file["url"])
        self.assertEqual(renewal["coordinate"]["path"], "/synthetic-coordinate/retained.zip")
        self.assertFalse(renewal["content_identity_verified"])

    def test_other_file_changes_remain_unverified_instead_of_becoming_url_renewal(self):
        for change in ("path", "name", "unknown", "external", "non_signing_query", "host", "array_order"):
            with self.subTest(change=change):
                fixture = Fixture()
                prop = fixture.query["confirm"][uid(201)][1]["properties"]["Files"]
                file = prop["files"][0]
                if change == "path":
                    file["file"]["url"] = signed_url("b", path="replacement.zip")
                elif change == "name":
                    file["name"] = "replacement.zip"
                elif change == "unknown":
                    file["unknown_file_field"]["keep"] = False
                elif change == "external":
                    file["type"] = "external"
                    file["external"] = {"url": "https://example.invalid/replacement"}
                elif change == "non_signing_query":
                    file["file"]["url"] = signed_url("b", extra="&versionId=another-version")
                elif change == "host":
                    file["file"]["url"] = signed_url("b").replace("prod-files-secure.s3.us-west-2.amazonaws.com", "example.invalid")
                else:
                    prop["files"].insert(0, {"type": "external", "name": "new", "external": {"url": "https://example.invalid/new"}})
                fixture.freeze()
                result = fixture.run()
                self.assertEqual(result["counts"]["metadata_verified"], 2)
                self.assertFalse(fixture.read_output()["catalog"]["entries"][2]["metadata_complete"])
                self.assertEqual(fixture.evidence()[2]["raw_confirm"], fixture.query["confirm"][uid(201)][1])

    def test_url_parsing_cannot_erase_control_characters_bad_utf8_or_non_auth_query_encoding_changes(self):
        pairs = [(signed_url(extra="&versionId=%FF"), signed_url("b", extra="&versionId=%FE")),
                 (signed_url(), signed_url("b").replace("retained.zip", "reta\nined.zip")),
                 (signed_url(extra="&versionId=+"), signed_url("b", extra="&versionId=%20"))]
        for initial_url, confirm_url in pairs:
            with self.subTest(confirm_url=confirm_url):
                fixture = Fixture()
                fixture.query["initial"][uid(201)][1]["properties"]["Files"]["files"][0]["file"]["url"] = initial_url
                fixture.query["confirm"][uid(201)][1]["properties"]["Files"]["files"][0]["file"]["url"] = confirm_url
                fixture.freeze()
                self.assertEqual(fixture.run()["counts"]["metadata_verified"], 2)
                self.assertFalse(fixture.read_output()["catalog"]["entries"][2]["metadata_complete"])

    def test_signed_url_exception_does_not_apply_to_an_unknown_files_property(self):
        fixture = Fixture()
        for phase in ("initial", "confirm"):
            unknown = file_property()
            unknown["id"] = "unregistered-files"
            fixture.query[phase][uid(201)][1]["properties"]["Unapproved Files"] = unknown
        fixture.query["confirm"][uid(201)][1]["properties"]["Unapproved Files"]["files"][0]["file"]["url"] = signed_url("b")
        fixture.freeze()
        self.assertEqual(fixture.run()["counts"]["metadata_verified"], 2)
        self.assertEqual(fixture.evidence()[2]["issues"], [{"code": "METADATA_CHANGED"}])

    def test_complete_retained_relation_is_replayed_and_binds_a_23_item_truncated_query(self):
        fixture = Fixture()
        full = fixture.expand_router()
        fixture.freeze()
        self.assertEqual(fixture.run()["counts"]["metadata_verified"], 3)
        row = fixture.evidence()[1]
        self.assertEqual(row["observed_complete_properties"]["Members"]["value"], full)
        self.assertEqual(len(row["raw_initial"]["properties"]["Members"]["relation"]), 23)
        self.assertTrue(row["raw_initial"]["properties"]["Members"]["has_more"])

    def test_query_membership_not_in_the_retained_full_relation_is_not_promoted(self):
        fixture = Fixture()
        fixture.expand_router()
        fixture.query["confirm"][uid(201)][0]["properties"]["Members"]["relation"][0]["id"] = uid(9999)
        fixture.freeze()
        self.assertEqual(fixture.run()["counts"]["metadata_verified"], 2)
        self.assertEqual(fixture.evidence()[1]["issues"], [{"code": "METADATA_RELATION_CHANGED"}])

    def test_name_default_context_edit_marker_or_parent_mismatch_keeps_the_exact_entry_incomplete(self):
        for change in ("name", "default", "null_default", "time", "parent", "duplicate"):
            with self.subTest(change=change):
                fixture = Fixture()
                raw = fixture.query["confirm"][uid(201)][1]
                if change == "name":
                    raw["properties"]["Skill name"]["title"][0]["plain_text"] = "Another name"
                elif change == "default":
                    raw["properties"]["Default Context"]["checkbox"] = True
                elif change == "null_default":
                    for phase in ("initial", "confirm"):
                        fixture.query[phase][uid(201)][1]["properties"]["Default Context"]["checkbox"] = None
                elif change == "time":
                    raw["last_edited_time"] = "2026-01-02T00:00:00.000Z"
                elif change == "parent":
                    raw["parent"]["data_source_id"] = uid(9999)
                else:
                    fixture.query["confirm"][uid(201)].append(deepcopy(raw))
                fixture.freeze()
                self.assertEqual(fixture.run()["counts"]["metadata_verified"], 2)
                self.assertFalse(fixture.read_output()["catalog"]["entries"][2]["metadata_complete"])

    def test_stable_native_metadata_that_differs_from_the_frozen_catalog_is_not_promoted(self):
        fixture = Fixture()
        for phase in ("initial", "confirm"):
            fixture.query[phase][uid(201)][1]["properties"]["Skill name"]["title"][0]["plain_text"] = "New current title"
        fixture.freeze()
        self.assertEqual(fixture.run()["counts"]["metadata_verified"], 2)
        self.assertEqual(fixture.evidence()[2]["issues"], [{"code": "CATALOG_METADATA_CHANGED"}])

    def test_tampered_retained_router_bytes_stop_before_output_without_touching_inputs(self):
        fixture = Fixture()
        fixture.freeze()
        before = fixture.input.read_bytes()
        path = fixture.router_output / "raw/000001.json"
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaises(verifier.EvidenceError) as error:
            fixture.run()
        self.assertEqual(error.exception.code, "ROUTER_RESPONSE_HASH_MISMATCH")
        self.assertFalse(fixture.output.exists())
        self.assertEqual(fixture.input.read_bytes(), before)

    def test_same_signed_url_rule_can_resolve_only_the_known_router_boundary_difference(self):
        fixture = Fixture()
        file = fixture.router_pages[uid(2)][1]["properties"]["Files"]["files"][0]["file"]
        file.update(url=signed_url("b", "20260101T010000Z"), expiry_time="2026-01-01T02:00:00.000Z")
        fixture.freeze()
        self.assertEqual(fixture.run()["counts"]["metadata_verified"], 3)
        row = fixture.evidence()[1]
        self.assertEqual(row["router_evidence"]["original_status"], "changed")
        self.assertEqual(len(row["router_after_comparison"]["file_access_renewals"]), 1)

    def test_missing_metadata_is_not_silently_replaced_and_existing_output_is_not_overwritten(self):
        fixture = Fixture()
        fixture.data["catalog"]["entries"][2].pop("metadata")
        fixture.freeze()
        self.assertEqual(fixture.run()["counts"]["metadata_verified"], 2)
        self.assertNotIn("metadata", fixture.read_output()["catalog"]["entries"][2])
        with self.assertRaises(verifier.EvidenceError) as error:
            fixture.run()
        self.assertEqual(error.exception.code, "OUTPUT_EXISTS")


if __name__ == "__main__":
    unittest.main()
