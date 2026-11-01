from copy import deepcopy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("pilot_assembly", Path(__file__).with_name("prepare-migration-pilot-review.py"))
assembly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembly)


class PilotAssemblyTests(unittest.TestCase):
    def test_fixed_source_bytes_and_extra_paths_are_not_silently_changed(self):
        files = {"SKILL.md": b"Exact source\n", "assets/data.bin": bytes([0, 255, 1])}
        fixed = {"root": "skills/example", "files": [{"path": path, "source_path": "skills/example/" + path,
                 "bytes": len(data), "git_oid": hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()}
                for path, data in files.items()]}

        def zipped(entries):
            out = io.BytesIO()
            with zipfile.ZipFile(out, "w") as archive:
                archive.writestr(".ntn-skills.json", json.dumps({"format": "ntn-skills", "version": 2}))
                for path, data in entries.items():
                    archive.writestr(path, data)
            return out.getvalue()

        self.assertEqual(assembly.verified_source(zipped(files), fixed), files)
        for changed in [{**files, "extra.md": b"unselected"}, {**files, "assets/data.bin": bytes([0, 254, 1])}]:
            with self.assertRaises(assembly.EvidenceError):
                assembly.verified_source(zipped(changed), fixed)

    def test_new_actual_bytes_never_upgrade_original_ownership_or_complete_flags(self):
        original = {"legacy_id": "old", "record": {"id": "old"}, "metadata": {"original": [1, 2]},
                    "files_complete": False, "metadata_complete": False, "legacy_mode": "unknown", "legacy_layout": "unknown",
                    "files": [{"legacy_id": "main-original", "path": "SKILL.md", "ownership": "unknown", "raw": {"original": "retained"}}]}
        before = deepcopy(original)
        file = {"legacy_id": "main-original", "path": "SKILL.md", "ownership": "unknown",
                "body": {"complete": True, "sha256": "a" * 64, "bytes": 3, "retention_ref": "retained:current", "retention_verified": True},
                "raw": {"pilot_current_capture": {"snapshot_id": "old-pin"}}}
        result = assembly.augment_entry(original, [file], {"snapshot_id": "old-pin", "ref": "skill://exact?pin=old"}, {"actual_file_count": 1})
        self.assertEqual(original, before)
        self.assertFalse(result["files_complete"])
        self.assertFalse(result["metadata_complete"])
        self.assertEqual(result["legacy_mode"], "unknown")
        self.assertEqual(result["files"][0]["ownership"], "unknown")
        self.assertEqual(result["files"][0]["raw"]["original"], "retained")
        with self.assertRaises(assembly.EvidenceError):
            assembly.augment_entry(original, [{**file, "ownership": "following"}], {"snapshot_id": "old-pin", "ref": "same"}, {})
        with self.assertRaises(assembly.EvidenceError):
            assembly.augment_entry(original, [{**file, "raw": {"original": "overwritten"}}], {"snapshot_id": "old-pin", "ref": "same"}, {})

    def test_full_input_keeps_other_entries_all_preservation_and_unsettled_operations(self):
        base = {"approved_legacy_ids": [], "catalog": {"coverage": {"exhaustive": False}, "entries": [
            {"legacy_id": "selected", "files_complete": False}, {"legacy_id": "unrelated", "unknown": True}]},
            "preservation": {"operations": {"complete": False, "items": [{"legacy_id": "unknown-op", "terminal_verified": False, "raw": {"original": 1}}]},
                             "pins": {"complete": True, "items": [{"pin": "keep"}]}},
            "readiness_evidence": {"basis_sha256": "old-basis", "operations": [{"keep": "original receipt"}]}}
        before = deepcopy(base)
        result = assembly.merge_full_input(base, [{"legacy_id": "selected", "files_complete": False, "new_fact": "exact bytes"}])
        self.assertEqual(base, before)
        self.assertEqual(result["approved_legacy_ids"], [])
        self.assertEqual(result["preservation"], base["preservation"])
        self.assertEqual(result["readiness_evidence"], base["readiness_evidence"])
        self.assertEqual(result["catalog"]["coverage"], base["catalog"]["coverage"])
        self.assertEqual(result["catalog"]["entries"][1], base["catalog"]["entries"][1])
        with self.assertRaises(assembly.EvidenceError):
            assembly.merge_full_input(base, [{"legacy_id": "unobserved"}])

    def test_native_identity_is_bound_even_when_all_wrapper_hashes_are_self_consistent(self):
        # Keep temporary evidence for inspection; do not permanently delete it.
        root = Path(tempfile.mkdtemp(prefix="migration-pilot-assembly-test-"))
        page = "00000000-0000-4000-8000-000000000001"
        foreign = "00000000-0000-4000-8000-000000000002"
        raw = assembly.encoded({"object": "page_markdown", "id": foreign, "markdown": "body", "truncated": False, "unknown_block_ids": []})
        assembly.write_new(root / "raw/000001.json", raw)
        item = {"record_id": "original", "snapshot_id": "original-pin", "page_id": page, "path": "SKILL.md",
                "native_preimage": {"kind": "notion_page_markdown", "api_version": "2026-03-11", "markdown_version": "default",
                    "page_id": page, "request_path": f"v1/pages/{page}/markdown", "retention_ref": "/original/raw/000001.json",
                    "response_sha256": assembly.digest(raw), "response_bytes": len(raw), "body_sha256": assembly.digest(b"body")}}
        item_bytes = assembly.encoded(item)
        assembly.write_new(root / "preimages/000001.json", item_bytes)
        summary = {"mode": "read_only_native_preimages", "status": "observed", "native_pages": 51, "notion_write_requests": 0,
                   "preimages": [{"file": "preimages/000001.json", "sha256": assembly.digest(item_bytes)}]}
        summary_bytes = assembly.encoded(summary)
        assembly.write_new(root / "summary.json", summary_bytes)
        with self.assertRaisesRegex(assembly.EvidenceError, "exact identity"):
            assembly.native_items({"summary": {"path": str(root / "summary.json"), "sha256": assembly.digest(summary_bytes)},
                                   "original_root": "/original"}, assembly.Inputs())


if __name__ == "__main__":
    unittest.main()
