"""Synthetic GET-only Router evidence tests; temporary fixtures are retained."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("collect_router_metadata", Path(__file__).with_name("collect-migration-router-metadata.py"))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load the collector under test")
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


def uid(number):
    return "00000000-0000-4000-8000-" + format(number, "012x")


def text(value, kind="text"):
    result = {"type": kind, "plain_text": value, "annotations": {"bold": False}, "retained_extra": "rich text detail"}
    if kind == "text":
        result["text"] = {"content": value, "link": None}
    else:
        result["mention"] = {"type": "page", "page": {"id": uid(90)}}
    return result


def rich(identity, value, kind="rich_text"):
    return {"id": identity, "type": kind, kind: [text(value)]}


def property_page(identity, kind, values, cursor=None):
    return {"object": "list", "type": "property_item", "has_more": cursor is not None, "next_cursor": cursor,
            "property_item": {"id": identity, "type": kind, kind: {}, "next_url": None if cursor is None else "https://api.notion.com/unused-next-url"},
            "results": [{"object": "property_item", "id": identity, "type": kind, kind: deepcopy(value), "retained_item_extra": True} for value in values],
            "request_status": {"type": "complete", "incomplete_reason": None}, "retained_page_extra": "untouched"}


class Fixture:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="migration-router-metadata-test-"))
        self.input, self.summary, self.output = self.root / "input.json", self.root / "summary.json", self.root / "evidence"
        self.page, self.database, self.data_source = uid(1), uid(2), uid(3)
        self.page_path = "v1/pages/" + self.page
        source = {"provider": {"kind": "git", "repository": "https://example.invalid/synthetic"},
                  "external_assets": {"retained_unknown_option": True}, "unknown_future_source": [1, False]}
        published = {"version": 1, "revision": "original-revision", "plan_hash": "a" * 64,
                     "publisher_subscription_id": self.page, "members": [{"member_key": "member", "page_id": uid(10),
                     "content_hash": "b" * 64, "revision": "original-member-revision", "retained_member_extra": True}]}
        self.before = {"object": "page", "id": self.page, "last_edited_time": "2026-01-01T00:00:00.000Z",
                       "parent": {"type": "data_source_id", "data_source_id": self.data_source, "database_id": self.database},
                       "archived": False, "in_trash": False, "request_id": "first-request", "unknown_page_field": {"retain": True},
                       "properties": {
                           "Name": rich("title", "Synthetic Router", "title"),
                           "Description": rich("desc", "Retain every original field."),
                           "Default Context": {"id": "def", "type": "checkbox", "checkbox": False},
                           "Status": {"id": "stat", "type": "select", "select": {"name": "verified", "color": "green"}},
                           "Source": rich("src%3Araw", json.dumps(source)),
                           "Published Members": rich("pub%3Araw", json.dumps(published)),
                           "Target Database ID": rich("target", uid(4)),
                           "Unknown Option": {"id": "future", "type": "number", "number": 7, "future_shape": {"nested": [True, 0]}},
                       }}
        self.after = deepcopy(self.before)
        self.after["request_id"] = "second-request"
        legacy_id = "notion_subscription:" + self.page
        item = {"legacy_id": legacy_id, "raw": {"id": legacy_id, "kind": "router", "name": "Catalog title",
                "locator": {"type": "notion_subscription", "subscription_id": self.page, "database_id": self.database,
                            "data_source_id": self.data_source, "target_database_id": uid(4)}, "unknown_catalog_field": {"retain": True}},
                "complete": False, "references": [], "retention_ref": "catalog:synthetic", "retention_verified": True}
        self.inventory = {"version": 1, "approved_legacy_ids": [], "approved_scope": {"status": "unapproved"},
                          "preservation": {"routers": {"complete": False, "items": [item]},
                                           "operations": {"complete": False, "items": [{"terminal_verified": False, "raw": {"state": "verified"}}]},
                                           "pins": {"complete": False, "items": [{"asserted_user_pin": False, "complete": True}]}},
                          "unknown_inventory_field": {"retain": True}}
        self.routes, self.calls, self.original_responses = {}, [], []
        self.freeze()

    def freeze(self):
        self.input.write_bytes(collector.encoded(self.inventory))
        self.summary.write_bytes(collector.encoded({"version": 1, "mode": "read_only_operation_origins",
                                                   "output": {"input_sha256": collector.digest(self.input.read_bytes())}}))

    def read(self, path):
        self.calls.append(path)
        if path == self.page_path:
            value = self.before if self.calls.count(self.page_path) == 1 else self.after
        else:
            value = self.routes[path]
        if isinstance(value, Exception):
            raise value
        raw = json.dumps(value, ensure_ascii=False, indent=2).encode() + b"\n"
        self.original_responses.append(raw)
        return raw

    def run(self):
        return collector.collect(input_path=self.input, summary_path=self.summary, output_path=self.output, reader=self.read)

    def observed(self):
        return [json.loads(line) for line in (self.output / "router-evidence.jsonl").read_bytes().splitlines()]

    def records(self):
        return [json.loads(line) for line in (self.output / "requests.jsonl").read_bytes().splitlines()]

    def relation(self, count=101):
        identity = "mem%3Aroles"
        members = [{"id": uid(100 + index)} for index in range(count)]
        value = {"id": identity, "type": "relation", "relation": members[:25], "has_more": count > 25}
        self.before["properties"]["Additional relation"] = value
        self.after["properties"]["Additional relation"] = deepcopy(value)
        if count > 25:
            self.routes[collector.property_path(self.page, identity)] = property_page(identity, "relation", members[:100], "next + cursor" if count > 100 else None)
        if count > 100:
            self.routes[collector.property_path(self.page, identity, "next + cursor")] = property_page(identity, "relation", members[100:])
        return identity, members

    def native(self):
        item = self.inventory["preservation"]["routers"]["items"][0]
        item["legacy_id"] = item["raw"]["id"] = "notion_page:" + self.page
        item["raw"]["locator"] = {"type": "notion_page", "page_id": self.page,
                                  "database_id": self.database, "data_source_id": self.data_source}
        for page in (self.before, self.after):
            for name in ("Source", "Published Members", "Status", "Target Database ID"):
                page["properties"].pop(name)
            page["properties"]["Skill name"] = page["properties"].pop("Name")
            page["properties"]["Description"]["id"] = "notion%3A%2F%2Fskills%2Fdescription_property"
            page["properties"].update({"Kind": {"id": "kind", "type": "select", "select": {"name": "router"}},
                "Members": {"id": "members", "type": "relation", "relation": [{"id": uid(10)}], "has_more": False},
                "References": {"id": "refs", "type": "rich_text", "rich_text": []},
                "Files": {"id": "files", "type": "files", "files": [{"name": "retained.zip", "type": "file",
                    "file": {"url": "https://example.invalid/retained.zip?signature=first", "expiry_time": "2026-01-01T01:00:00Z"},
                    "unknown_file_field": "retain"}]}})
        self.freeze()


class RouterMetadataTests(unittest.TestCase):
    def test_plain_json_metadata_uses_two_gets_and_preserves_raw_unknowns_and_all_gates(self):
        fixture = Fixture()
        source_bytes = fixture.input.read_bytes(), fixture.summary.read_bytes()
        result = fixture.run()
        self.assertEqual(result["counts"], {"routers": 1, "stable": 1, "changed": 0, "incomplete": 0, "unavailable": 0, "metadata_get_requests": 2})
        self.assertEqual(fixture.calls, [fixture.page_path, fixture.page_path])
        self.assertEqual((fixture.input.read_bytes(), fixture.summary.read_bytes()), source_bytes)
        self.assertFalse((fixture.output / "input.json").exists())
        observed = fixture.observed()[0]
        self.assertEqual(observed["original_item"], fixture.inventory["preservation"]["routers"]["items"][0])
        self.assertEqual(observed["raw_page_before"], fixture.before)
        self.assertEqual(observed["raw_page_after"], fixture.after)
        self.assertEqual(observed["fields"]["Source"]["parsed_json"]["external_assets"], {"retained_unknown_option": True})
        self.assertTrue(observed["fields"]["Published Members"]["parsed_json"]["members"][0]["retained_member_extra"])
        self.assertFalse(observed["fields"]["Default Context"]["value"])
        self.assertEqual(observed["properties"]["Unknown Option"]["raw_inline"]["future_shape"], {"nested": [True, 0]})
        for receipt, raw in zip(fixture.records(), fixture.original_responses):
            self.assertEqual((fixture.output / receipt["response"]["file"]).read_bytes(), raw)
            self.assertEqual(receipt["response"]["sha256"], collector.digest(raw))
            self.assertEqual(receipt["method"], "GET")
        self.assertTrue(observed["page_stability"]["unchanged"])
        self.assertFalse(result["safeguards"]["atomic_snapshot"])
        self.assertFalse(result["safeguards"]["source_semantics_approved"])
        self.assertFalse(result["safeguards"]["apply_allowed"])

    def test_101_relations_paginate_with_encoded_id_unchanged_and_cursor_encoded_once(self):
        fixture = Fixture()
        identity, members = fixture.relation()
        self.assertEqual(fixture.run()["counts"]["stable"], 1)
        observed = fixture.observed()[0]["properties"]["Additional relation"]
        self.assertEqual(observed["value"], members)
        self.assertEqual(observed["pagination"], {"needed": True, "exhausted": True, "requests": [2, 3]})
        self.assertEqual(len(fixture.calls), 4)
        self.assertTrue(all("%253A" not in path for path in fixture.calls))
        self.assertIn("/properties/" + identity + "?page_size=100&start_cursor=next+%2B+cursor", fixture.calls[2])
        self.assertEqual(fixture.calls[-1], fixture.page_path)
        self.assertEqual(json.loads((fixture.output / "raw/000002.json").read_bytes())["retained_page_extra"], "untouched")

    def test_inline_relations_and_long_pure_text_do_not_add_property_requests(self):
        fixture = Fixture()
        fixture.relation(2)
        segments = [text("paragraph " + str(index)) for index in range(60)]
        for page in (fixture.before, fixture.after):
            page["properties"]["Description"]["rich_text"] = deepcopy(segments)
        self.assertEqual(fixture.run()["counts"]["metadata_get_requests"], 2)
        self.assertEqual(fixture.observed()[0]["fields"]["Description"]["text"], "".join(item["plain_text"] for item in segments))

    def test_has_more_true_is_respected_even_when_the_inline_relation_contains_only_23_values(self):
        fixture = Fixture()
        identity, members = fixture.relation(30)
        for page in (fixture.before, fixture.after):
            page["properties"]["Additional relation"]["relation"] = deepcopy(members[:23])
        self.assertEqual(fixture.run()["counts"]["stable"], 1)
        self.assertEqual(len(fixture.calls), 3)
        self.assertEqual(fixture.observed()[0]["properties"]["Additional relation"]["value"], members)

    def test_native_router_uses_its_own_fields_and_preserves_every_attachment_field(self):
        fixture = Fixture()
        fixture.native()
        result = fixture.run()
        self.assertEqual(result["counts"]["stable"], 1)
        observed = fixture.observed()[0]
        self.assertEqual(observed["target"]["family"], "notion_page")
        self.assertNotIn("Published Members", observed["required_fields"])
        self.assertEqual(observed["fields"]["Name"]["native_name"], "Skill name")
        self.assertEqual(observed["fields"]["References"]["text"], "")
        self.assertEqual(observed["fields"]["Members"]["value"], [{"id": uid(10)}])
        self.assertEqual(observed["properties"]["Files"]["value"], fixture.before["properties"]["Files"]["files"])

    def test_file_urls_are_retained_and_not_silently_exempted_from_metadata_stability(self):
        fixture = Fixture()
        fixture.native()
        fixture.after["properties"]["Files"]["files"][0]["file"].update(
            url="https://example.invalid/retained.zip?signature=second", expiry_time="2026-01-01T02:00:00Z")
        self.assertEqual(fixture.run()["counts"]["changed"], 1)
        observed = fixture.observed()[0]
        self.assertNotEqual(observed["raw_page_before"]["properties"]["Files"], observed["raw_page_after"]["properties"]["Files"])
        self.assertNotIn("content_sha256", observed["properties"]["Files"])

    def test_mentions_are_expanded_without_interpreting_or_dropping_unknown_native_fields(self):
        fixture = Fixture()
        values = [text("Mentioned "), text("Page", "mention")]
        for page in (fixture.before, fixture.after):
            page["properties"]["Name"]["title"] = deepcopy(values)
        fixture.routes[collector.property_path(fixture.page, "title")] = property_page("title", "title", values)
        self.assertEqual(fixture.run()["counts"]["stable"], 1)
        self.assertEqual(len(fixture.calls), 3)
        self.assertEqual(fixture.observed()[0]["fields"]["Name"]["text"], "Mentioned Page")

    def test_same_edit_time_with_changed_metadata_fails_the_observed_stability_check(self):
        fixture = Fixture()
        fixture.after["properties"]["Default Context"]["checkbox"] = True
        result = fixture.run()
        self.assertEqual(result["counts"]["changed"], 1)
        self.assertEqual(result["issues"], {"PAGE_CHANGED_DURING_OBSERVATION": 1})
        self.assertFalse(fixture.observed()[0]["page_stability"]["unchanged"])
        self.assertEqual(len(fixture.calls), 2)

    def test_broken_pagination_stops_without_retry_and_still_rereads_the_observed_page(self):
        for broken in ("cursor", "wrapper", "duplicate", "incomplete", "inline_membership"):
            with self.subTest(broken=broken):
                fixture = Fixture()
                identity, members = fixture.relation()
                first = fixture.routes[collector.property_path(fixture.page, identity)]
                second = fixture.routes[collector.property_path(fixture.page, identity, "next + cursor")]
                if broken == "cursor":
                    second["has_more"], second["next_cursor"] = True, "next + cursor"
                    second["property_item"]["next_url"] = "https://invalid.example/never-follow"
                elif broken == "wrapper":
                    first["property_item"]["id"] = "another-property"
                elif broken == "duplicate":
                    second["results"][0]["relation"] = deepcopy(members[0])
                elif broken == "incomplete":
                    first["request_status"] = {"type": "incomplete", "incomplete_reason": "result_limit"}
                else:
                    first["results"][0]["relation"]["id"] = uid(900)
                result = fixture.run()
                self.assertEqual(result["counts"]["incomplete"], 1)
                self.assertEqual(fixture.calls[-1], fixture.page_path)
                self.assertLessEqual(len(fixture.calls), 4)
                self.assertTrue(fixture.observed()[0]["page_stability"]["unchanged"])
                self.assertEqual(len(fixture.records()), len(fixture.calls))

    def test_required_field_absence_or_identity_mismatch_preserves_the_rest_and_rereads(self):
        for broken in ("missing_field", "parent", "page_id"):
            with self.subTest(broken=broken):
                fixture = Fixture()
                for page in (fixture.before, fixture.after):
                    if broken == "missing_field":
                        page["properties"].pop("Published Members")
                    elif broken == "parent":
                        page["parent"]["data_source_id"] = uid(99)
                    else:
                        page["id"] = uid(99)
                self.assertEqual(fixture.run()["counts"]["incomplete"], 1)
                self.assertEqual(fixture.calls, [fixture.page_path, fixture.page_path])
                self.assertEqual(fixture.observed()[0]["raw_page_before"], fixture.before)

    def test_invalid_source_json_is_a_retained_native_fact_not_a_repaired_or_approved_source(self):
        fixture = Fixture()
        for page in (fixture.before, fixture.after):
            page["properties"]["Source"]["rich_text"] = [text("{original incomplete JSON")]
        self.assertEqual(fixture.run()["counts"]["stable"], 1)
        field = fixture.observed()[0]["fields"]["Source"]
        self.assertEqual(field["text"], "{original incomplete JSON")
        self.assertEqual(field["json_status"], "invalid")
        self.assertNotIn("parsed_json", field)

    def test_failed_after_read_cannot_claim_stability_and_keeps_the_initial_page(self):
        fixture = Fixture()
        fixture.after = collector.EvidenceError("READ_TIMEOUT", "synthetic timeout")
        result = fixture.run()
        self.assertEqual(result["counts"]["incomplete"], 1)
        observed = fixture.observed()[0]
        self.assertFalse(observed["page_stability"]["checked"])
        self.assertEqual(observed["raw_page_before"], fixture.before)
        self.assertIsNone(observed["raw_page_after"])
        self.assertEqual(fixture.records()[-1]["code"], "READ_TIMEOUT")

    def test_changed_input_or_existing_output_never_uses_the_reader(self):
        fixture = Fixture()
        fixture.input.write_bytes(fixture.input.read_bytes() + b"\n")
        with self.assertRaises(collector.EvidenceError) as error:
            fixture.run()
        self.assertEqual(error.exception.code, "INPUT_HASH_MISMATCH")
        self.assertEqual(fixture.calls, [])
        self.assertFalse(fixture.output.exists())
        fixture.freeze()
        fixture.output.mkdir()
        with self.assertRaises(collector.EvidenceError) as error:
            fixture.run()
        self.assertEqual(error.exception.code, "OUTPUT_EXISTS")
        self.assertEqual(fixture.calls, [])



if __name__ == "__main__":
    unittest.main()
