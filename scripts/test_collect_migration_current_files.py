import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("current_pilot", Path(__file__).with_name("collect-migration-current-files.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
RUNS = Path(tempfile.mkdtemp(prefix="ntn-migration-current-files-tests-"))

FAKE_CLI = r'''
import hashlib,json,sys
from pathlib import Path
fixture=json.loads(Path(sys.argv[1]).read_text()); args=sys.argv[2:]
with Path(fixture['trace']).open('a') as out: out.write(json.dumps(args)+'\n')
records=fixture['records']; action=args[0]
def flag(name): return args[args.index(name)+1]
record=next(x for x in records if (x['record']['ref'] if action=='read' else x['snapshot_id'])==args[1])
if action=='read' and record.get('fail_read'):
 print(json.dumps({'ok':False,'error':{'code':'PUBLICATION_INCOMPLETE','details':{'operation_id':'original-unknown-operation'}}}));sys.exit(1)
data={k:record[k] for k in ['record','scope','snapshot_id','version_id','ref']}
data.update(ok=True,entrypoint=record['record']['entrypoint'],source='notion' if action=='read' else 'local_snapshot',freshness={'policy':'refresh' if action=='read' else 'pinned'})
if record.get('wrong_scope'): data['scope']='0'*64
if record.get('wrong_ref'): data['ref']=record['wrong_ref']
files={key:value.encode() for key,value in record['files'].items()}
if action=='read':
 target=Path(flag('--output')); target.write_bytes(files[record['record']['entrypoint']])
 data.update(path=record['record']['entrypoint'],bytes=target.stat().st_size,request_metrics={'requests':1})
elif action=='files':
 data.update(files=[{'path':k,'bytes':len(v),'ref':record['ref']+'#'+k} for k,v in files.items()],request_metrics={'requests':0})
elif action=='export':
 target=Path(flag('--output'));target.mkdir()
 manifest={'format':'ntn-skills','version':2,'kind':record['record']['kind'],'name':record['record']['name'],'description':record['record']['description'],'main':record['record']['entrypoint']}
 files['.ntn-skills.json']=(json.dumps(manifest)+'\n').encode()
 inventory=[]
 for key,value in files.items():
  path=target/key;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(value+b'tampered' if key==record.get('tamper_path') else value)
  inventory.append({'path':key,'bytes':len(value),'hash':hashlib.sha256(value).hexdigest(),'role':'manifest' if key=='.ntn-skills.json' else 'entrypoint' if key==record['record']['entrypoint'] else 'resource'})
 data.update(operation='export',projection='snapshot',format='directory',files=inventory)
else: raise RuntimeError('Unexpected mutation/other command')
print(json.dumps(data))
'''


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False) + "\n")


def fixture(**changes):
    root = Path(tempfile.mkdtemp(prefix="pilot-", dir=RUNS))
    database, source = "10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"
    scope = "a" * 64
    rows, entries = [], []
    for index, name in enumerate(("Router", "Doc", "Shared"), 1):
        native = f"30000000-0000-4000-8000-{index:012d}"
        family = "notion_subscription" if index == 1 else "notion_page"
        main = "ROUTER.md" if index == 1 else "SKILL.md"
        locator = {"type": family, "database_id": database, "data_source_id": source,
                   "subscription_id" if index == 1 else "page_id": native}
        if index == 1:
            locator["target_database_id"] = database
        record = {"id": family + ":" + native, "name": name, "alias": name.lower(), "kind": "router" if index == 1 else "skill",
                  "description": "Synthetic " + name, "entrypoint": main, "default_context": False,
                  "locator": locator, "ref": "skill://" + ("upstream%3A" if index == 1 else "") + native + "/" + main}
        header = '---\n"description": ' + json.dumps(record["description"]) + '\n"name": ' + json.dumps(name) + '\n---\n\n'
        files = {main: header + "Current exact body.\n", "references/guide.md": "Complete supporting body.\n", "ntn-skills-source.zip": "retained fake archive"}
        if index == 1:
            members = "\n".join(f"- [{n}](skill://30000000-0000-4000-8000-{i:012d}/SKILL.md) — Synthetic {n}" for i,n in ((2,"Doc"),(3,"Shared")))
            files = {main: header + record["description"] + "\n\n## Members\n\n" + members + "\n"}
        snapshot = "s_" + str(index) * 64
        rows.append({"record": record, "scope": scope, "snapshot_id": snapshot, "version_id": "v" + str(index),
                     "ref": record["ref"] + "?snapshot=" + snapshot, "files": files, **changes.get(name, {})})
        entries.append({"legacy_id": record["id"], "record": record, "legacy_mode": "unknown", "legacy_layout": "unknown", "files_complete": False})
    subset = {"scope": scope, "approved_legacy_ids": [], "entries": entries}
    metadata = {"entries": [{"legacy_id": e["legacy_id"], "status": "verified", "properties": {}} for e in entries]}
    pins = {"selection": "collection-order samples", "selected": {e["legacy_id"]: [] for e in entries}}
    config = {"format": "ah498-migration-current-files", "version": 1, "cwd": str(root), "output": str(root / "output"),
              "cliCommand": [sys.executable, str(root / "fake-cli.py"), str(root / "fixture.json")], "timeoutSeconds": 10}
    for name, value in (("subset", subset), ("metadata", metadata), ("pins", pins)):
        path = root / (name + ".json"); write_json(path, value)
        config[name] = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    (root / "fake-cli.py").write_text(FAKE_CLI)
    write_json(root / "fixture.json", {"records": rows, "trace": str(root / "trace.jsonl")})
    write_json(root / "config.json", config)
    return root


def run(root):
    config, sources, bindings = MODULE.load_config(root / "config.json")
    result = MODULE.Collector(config, sources, bindings).run()
    calls = [json.loads(line) for line in (root / "trace.jsonl").read_text().splitlines()]
    return result, calls


class CurrentFilePilotTests(unittest.TestCase):
    def test_complete_tree_uses_only_three_refreshes_then_exact_offline_pins(self):
        root = fixture(); result, calls = run(root)
        self.assertEqual(result["status"], "complete")
        self.assertEqual([args[0] for args in calls], ["read", "files", "export"] * 3)
        self.assertTrue(all("--refresh" in args for args in calls if args[0] == "read"))
        self.assertTrue(all("--offline" in args for args in calls if args[0] != "read"))
        self.assertEqual(len(result["entries"][0]["observed_router_members"]), 2)
        self.assertEqual({row["path"] for row in result["entries"][1]["files"]}, {"SKILL.md", "references/guide.md", "ntn-skills-source.zip"})
        self.assertEqual(result["approved_legacy_ids"], [])
        self.assertFalse(result["classification_changed"])
        self.assertTrue(result["input_unchanged"])
        self.assertEqual(result["entries"][1]["current_native_preimage"], "not_asserted")

    def test_unknown_publication_stops_that_entry_without_replay(self):
        root = fixture(Router={"fail_read": True}); result, calls = run(root)
        self.assertEqual(result["status"], "partial")
        self.assertEqual([row["status"] for row in result["entries"]], ["stopped", "captured", "captured"])
        self.assertEqual([args[0] for args in calls], ["read", "read", "files", "export", "read", "files", "export"])
        self.assertIn("original-unknown-operation", (root / "output/commands/001-1-read/stdout.json").read_text())
        self.assertFalse(result["operation_recovery_requested"])
        self.assertEqual(result["production_mutations_requested"], 0)

    def test_export_hash_mismatch_is_not_complete_and_keeps_partial_bytes(self):
        root = fixture(Doc={"tamper_path": "references/guide.md"}); result, _ = run(root)
        self.assertEqual(result["entries"][1]["status"], "stopped")
        self.assertEqual(result["entries"][1]["code"], "EXPORT_MISMATCH")
        self.assertTrue((root / "output/entries/02/snapshot/references/guide.md").read_bytes().endswith(b"tampered"))

    def test_wrong_scope_cannot_continue_to_files_or_export(self):
        root = fixture(Doc={"wrong_scope": True}); result, calls = run(root)
        self.assertEqual(result["entries"][1]["code"], "PUBLIC_IDENTITY_MISMATCH")
        self.assertEqual(len(calls), 7)
        self.assertEqual(calls[3][0], "read")
        self.assertEqual(calls[4][0], "read")

    def test_wrong_pinned_ref_cannot_borrow_an_otherwise_correct_snapshot_receipt(self):
        root = fixture(Doc={"wrong_ref": "skill://other-record/SKILL.md?snapshot=s_" + "2" * 64})
        result, calls = run(root)
        self.assertEqual(result["entries"][1]["code"], "PUBLIC_PIN_MISMATCH")
        self.assertEqual(len(calls), 7)
        self.assertEqual(calls[3][0], "read")
        self.assertEqual(calls[4][0], "read")

    def test_config_check_is_read_only_and_frozen_input_drift_fails(self):
        root = fixture(); MODULE.load_config(root / "config.json")
        self.assertFalse((root / "output").exists())
        self.assertFalse((root / "trace.jsonl").exists())
        with (root / "subset.json").open("ab") as stream: stream.write(b" ")
        with self.assertRaisesRegex(MODULE.EvidenceError, "frozen input changed"):
            MODULE.load_config(root / "config.json")

    def test_unrecognized_router_display_keeps_complete_files_but_no_inferred_members(self):
        root = fixture()
        data = json.loads((root / "fixture.json").read_text())
        data["records"][0]["files"]["ROUTER.md"] += "Additional native display.\n"
        write_json(root / "fixture.json", data)
        result, _ = run(root)
        self.assertEqual(result["status"], "complete")
        router = result["entries"][0]
        self.assertEqual(router["router_members_observation"], "unparsed")
        self.assertNotIn("observed_router_members", router)
        self.assertEqual(len(router["files"]), 1)


if __name__ == "__main__":
    unittest.main()
