"""Synthetic native preimage observations; no remote requests or fixture deletion."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("collect_native_preimages", Path(__file__).with_name("collect-migration-native-preimages.py"))
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


def uid(number):
    return "00000000-0000-4000-8000-" + format(number, "012x")


class Fixture:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="migration-native-preimage-test-"))
        self.output = self.root / "observation"
        self.calls, self.responses, self.snapshots, self.expected = [], {}, [], []
        for ordinal, (base, count) in enumerate(((1, 44), (101, 7)), 1):
            refs, files = [], [{"path": "ntn-skills-source.zip", "bytes": 42, "sha256": "f" * 64}]
            for index in range(count):
                identity = uid(base + index)
                name = "SKILL.md" if index == 0 else "references/file-" + str(index) + ".md"
                materialized = "A prior materialized [link](./other.md).\n"
                refs.append({"id": identity, "path": name, "markdown": materialized, "blocks": []})
                files.append({"path": name, "bytes": 17, "sha256": "a" * 64})
                route = "v1/pages/" + identity + "/markdown"
                raw = {"object": "page_markdown", "id": identity, "markdown": "Fresh raw page\r\n\r\n",
                       "truncated": False, "unknown_block_ids": [], "unknown_retained_field": {"keep": True}}
                if index % 2:
                    raw["warnings"] = []
                self.responses[route] = json.dumps(raw, indent=2).encode() + b"\n"
            value = {"snapshot_id": "s_" + str(ordinal) * 64, "entrypoint": "SKILL.md", "record": {
                        "id": "notion_page:" + uid(base), "kind": "skill", "entrypoint": "SKILL.md",
                        "locator": {"type": "notion_page", "page_id": uid(base)}}, "references": refs, "files": files}
            path = self.root / (str(ordinal) + ".json")
            path.write_bytes(collector.encoded(value))
            self.snapshots.append(path)
        self.freeze()

    def freeze(self):
        self.expected = [(str(path), collector.digest(path.read_bytes())) for path in self.snapshots]

    def read(self, path):
        number = len(self.calls) + 1
        if number > 1:
            # No next request may precede durable raw data and the prior receipt/journal entry.
            previous = str(number - 1).zfill(6)
            assert (self.output / "raw" / (previous + ".json")).is_file()
            assert (self.output / "requests" / (previous + ".receipt.json")).is_file()
            assert len((self.output / "requests.jsonl").read_bytes().splitlines()) == number - 1
        assert (self.output / "requests" / (str(number).zfill(6) + ".request.json")).is_file()
        self.calls.append(path)
        result = self.responses[path]
        if isinstance(result, Exception):
            raise result
        return result

    def run(self, check_only=False):
        return collector.collect(snapshots=self.expected, output_path=self.output, reader=self.read, check_only=check_only)

    def first(self, updates):
        path = next(iter(self.responses))
        value = json.loads(self.responses[path])
        value.update(updates)
        self.responses[path] = json.dumps(value, indent=2).encode() + b"\n"
        return path


class NativePreimageTests(unittest.TestCase):
    def test_fifty_one_gets_preserve_wire_unknowns_and_materialized_canonical_distinction(self):
        fixture = Fixture()
        original = [path.read_bytes() for path in fixture.snapshots]
        with patch.object(collector.os, "fsync", wraps=collector.os.fsync) as sync:
            summary = fixture.run()
        self.assertEqual((summary["native_pages"], summary["get_requests"]), (51, 51))
        self.assertEqual(fixture.calls, list(fixture.responses))
        self.assertGreater(sync.call_count, 51 * 4)
        self.assertFalse(summary["atomic_snapshot"])
        self.assertFalse(summary["original_references_are_wire_responses"])
        self.assertFalse(summary["migration_input_written"])
        self.assertFalse(summary["ownership_or_approval_changed"])
        self.assertFalse(summary["operation_outcomes_changed"])
        self.assertEqual([path.read_bytes() for path in fixture.snapshots], original)
        receipts = [json.loads(line) for line in (fixture.output / "requests.jsonl").read_bytes().splitlines()]
        for ordinal, (route, raw) in enumerate(fixture.responses.items(), 1):
            retained = fixture.output / "raw" / (str(ordinal).zfill(6) + ".json")
            self.assertEqual(retained.read_bytes(), raw)
            self.assertEqual(receipts[ordinal - 1]["response"]["sha256"], collector.digest(raw))
            self.assertEqual(receipts[ordinal - 1]["validation"], {"status": "observed"})
            self.assertEqual(receipts[ordinal - 1]["path"], route)
        item = json.loads((fixture.output / "preimages/000001.json").read_bytes())
        self.assertEqual(item["native_preimage"]["markdown_version"], "default")
        self.assertEqual(item["native_preimage"]["body_sha256"], collector.digest(b"Fresh raw page\n\n"))
        self.assertEqual(item["native_preimage"]["response_sha256"], collector.digest(next(iter(fixture.responses.values()))))
        self.assertFalse(item["comparison"]["raw_markdown_equals_materialized_reference"])
        self.assertFalse(item["comparison"]["normalized_body_equals_canonical_file"])
        self.assertEqual(item["original_reference"]["representation"], "materialized_reference_not_wire")
        self.assertFalse((fixture.output / "input.json").exists())

    def test_wrong_page_and_each_incomplete_shape_stop_after_exactly_one_response(self):
        for update in ({"id": uid(999)}, {"truncated": True}, {"truncated": None},
                       {"unknown_block_ids": [uid(9)]}, {"unknown_block_ids": None},
                       {"warnings": ["incomplete"]}, {"warnings": None}, {"markdown": None},
                       {"markdown": "before <unknown /> after"}):
            with self.subTest(update=update):
                fixture = Fixture()
                route = fixture.first(update)
                with self.assertRaisesRegex(collector.EvidenceError, "incomplete|unsupported"):
                    fixture.run()
                self.assertEqual(fixture.calls, [route])
                self.assertEqual((fixture.output / "raw/000001.json").read_bytes(), fixture.responses[route])
                stopped = json.loads((fixture.output / "stopped.json").read_bytes())
                self.assertEqual((stopped["get_requests"], stopped["native_pages_observed"]), (1, 0))
                self.assertEqual(stopped["code"], "NATIVE_RESPONSE_INCOMPLETE")
                self.assertFalse((fixture.output / "summary.json").exists())

    def test_failure_on_second_get_retains_partial_stdout_and_never_requests_third(self):
        fixture = Fixture()
        paths = list(fixture.responses)
        partial = b'{"object":"page_markdown",'
        fixture.responses[paths[1]] = collector.EvidenceError("READ_TIMEOUT", "synthetic timeout", partial)
        with self.assertRaises(collector.EvidenceError):
            fixture.run()
        self.assertEqual(fixture.calls, paths[:2])
        self.assertEqual((fixture.output / "raw/000002.json").read_bytes(), partial)
        receipts = [json.loads(line) for line in (fixture.output / "requests.jsonl").read_bytes().splitlines()]
        self.assertEqual(receipts[1]["validation"], {"status": "failed", "code": "READ_TIMEOUT"})
        self.assertEqual(json.loads((fixture.output / "stopped.json").read_bytes())["native_pages_observed"], 1)
        with self.assertRaisesRegex(collector.EvidenceError, "never resume"):
            fixture.run()
        self.assertEqual(len(fixture.calls), 2)

    def test_duplicate_json_keys_invalid_utf8_and_non_utf8_json_preserve_raw_then_stop(self):
        for raw in (b'{"object":"page_markdown","object":"error"}', b'{"markdown":"\xff"}',
                    json.dumps({"object": "page_markdown"}).encode("utf-16")):
            with self.subTest(raw=raw[:40]):
                fixture = Fixture()
                route = next(iter(fixture.responses))
                fixture.responses[route] = raw
                with self.assertRaises(collector.EvidenceError):
                    fixture.run()
                self.assertEqual(fixture.calls, [route])
                self.assertEqual((fixture.output / "raw/000001.json").read_bytes(), raw)
                self.assertTrue((fixture.output / "stopped.json").is_file())

    def test_duplicate_page_or_incorrect_frozen_hash_cannot_start_a_read(self):
        for mismatch in ("page", "hash", "path", "count"):
            with self.subTest(mismatch=mismatch):
                fixture = Fixture()
                value = json.loads(fixture.snapshots[0].read_bytes())
                if mismatch == "page":
                    value["references"][1]["id"] = value["references"][0]["id"]
                elif mismatch == "path":
                    value["references"][1]["path"] = "../outside.md"
                elif mismatch == "count":
                    value["references"].pop()
                else:
                    value["changed"] = True
                fixture.snapshots[0].write_bytes(collector.encoded(value))
                if mismatch != "hash":
                    fixture.freeze()
                with self.assertRaises(collector.EvidenceError):
                    fixture.run()
                self.assertEqual(fixture.calls, [])
                self.assertFalse(fixture.output.exists())

    def test_check_only_never_calls_reader_or_creates_output(self):
        fixture = Fixture()
        result = fixture.run(check_only=True)
        self.assertEqual(result["snapshot_reference_counts"], [44, 7])
        self.assertEqual(result["network_requests"], 0)
        self.assertEqual(fixture.calls, [])
        self.assertFalse(fixture.output.exists())

    def test_raw_retention_failure_stops_without_claiming_a_complete_response(self):
        fixture = Fixture()
        original_write = collector.evidence.write_new

        def fail_raw(path, data):
            if path.parent.name == "raw":
                raise OSError("synthetic raw retention failure")
            return original_write(path, data)

        with patch.object(collector.evidence, "write_new", side_effect=fail_raw):
            with self.assertRaises(collector.EvidenceError):
                fixture.run()
        self.assertEqual(len(fixture.calls), 1)
        receipt = json.loads((fixture.output / "requests/000001.receipt.json").read_bytes())
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["validation"]["code"], "EVIDENCE_IO_FAILED")
        self.assertTrue(receipt["response_retention_failed"])
        self.assertNotIn("response", receipt)
        stopped = json.loads((fixture.output / "stopped.json").read_bytes())
        self.assertEqual((stopped["get_requests"], stopped["native_pages_observed"]), (1, 0))

    def test_native_transport_only_permits_one_default_get_to_a_frozen_path(self):
        fixture = Fixture()
        paths = list(fixture.responses)
        reader = collector.NativeReader(paths, executable="/synthetic/official-ntn")
        result = subprocess.CompletedProcess([], 0, fixture.responses[paths[0]], b"diagnostic not retained")
        with patch.object(collector.subprocess, "run", return_value=result) as run, patch.object(collector.time, "sleep"):
            self.assertEqual(reader(paths[0]), result.stdout)
            for invalid in (paths[0], paths[1] + "?markdown_version=v2", "v1/search", "v1/pages/" + uid(999) + "/markdown"):
                with self.assertRaises(collector.EvidenceError):
                    reader(invalid)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], ["/synthetic/official-ntn", "api", paths[0], "--notion-version", "2026-03-11", "-X", "GET"])
        self.assertNotIn("env", run.call_args.kwargs)
        self.assertEqual(reader.last_completion["exit_code"], 0)

    def test_native_transport_timeout_retains_stdout_without_retry(self):
        fixture = Fixture()
        path = next(iter(fixture.responses))
        reader = collector.NativeReader(fixture.responses, executable="/synthetic/official-ntn")
        timeout = subprocess.TimeoutExpired("ntn", 45, output=b"partial raw", stderr=b"private diagnostic")
        with patch.object(collector.subprocess, "run", side_effect=timeout) as run, patch.object(collector.time, "sleep"):
            with self.assertRaises(collector.EvidenceError) as caught:
                reader(path)
            self.assertEqual(caught.exception.raw, b"partial raw")
            with self.assertRaises(collector.EvidenceError):
                reader(path)
        self.assertEqual(run.call_count, 1)
        self.assertTrue(reader.last_completion["timed_out"])
        self.assertEqual(reader.last_completion["stderr_sha256"], collector.digest(b"private diagnostic"))


if __name__ == "__main__":
    unittest.main()
