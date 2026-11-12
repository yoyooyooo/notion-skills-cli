#!/usr/bin/env python3
"""Exercise four real operation-recovery guards in an isolated linked worktree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--out", required=True)
parser.add_argument("--protected-worktree", required=True)
parser.add_argument("--bun", default="bun")
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
protected = Path(args.protected_worktree).resolve()
assert protected.is_dir(), "Name the actual protected product worktree"
assert repo != protected, "Never mutate the active product worktree"
assert (repo / ".git").is_file(), "Use an isolated linked Git worktree"
gitdir = subprocess.check_output(["git", "rev-parse", "--absolute-git-dir"], cwd=repo, text=True).strip()
common = subprocess.check_output(["git", "rev-parse", "--git-common-dir"], cwd=repo, text=True).strip()
assert Path(gitdir).resolve() != (repo / common).resolve(), "A separate linked worktree is required"
dependencies = repo / "node_modules"
assert dependencies.is_dir() and not dependencies.is_symlink(), "Install dependencies in this worktree"
for base in [dependencies, repo / "packages"]:
    for directory, dirs, files in os.walk(base, followlinks=False):
        for name in dirs + files:
            candidate = Path(directory) / name
            if candidate.is_symlink():
                assert candidate.resolve().is_relative_to(repo), f"Dependency escapes isolated copy: {candidate}"
out = Path(args.out).resolve()
assert not out.is_relative_to(repo), "Keep test output and caches outside the checkout"
if out.exists():
    assert not any(out.iterdir()), "Use a new output directory"
else:
    out.mkdir(parents=True)
scratch = out / "process-scratch"
scratch.mkdir()
env = os.environ.copy()
for name in ["TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "BUN_INSTALL_CACHE_DIR"]:
    env[name] = str(scratch)
env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = str(scratch / "transpiler")

cases = [
    {
        "name": "exact-ack-get-independent-of-query",
        "model": "AcknowledgedRecordPrefix",
        "rule": "AckLookupIndependentOfQuery",
        "file": "packages/core/src/shared-create-dispatch.ts",
        "pattern": r"observeMutation\(library, plan, path, body, method, pageId\)",
        "replace": "observeMutation(library, plan, path, body, method)",
        "test_file": "packages/core/test/shared-create-known-recovery.test.ts",
        "test": "an acknowledged Record resumes by exact page GET while its query index remains invisible",
        "tests": 1,
        "meaning": "A durable exact ACK response page must be read even while Record query indexes return no rows.",
    },
    {
        "name": "fresh-premise-before-every-native-suffix-write",
        "model": "AcknowledgedRecordPrefix",
        "rule": "DispatchNeedsFreshPremise",
        "file": "packages/core/src/shared-create-recovery-native.ts",
        "pattern": r"observeNativeMainRecovery\(library, plan, page, acknowledged\)\.pipe\(Effect\.asVoid\)",
        "replace": "Effect.void",
        "test_file": "packages/core/test/shared-create-native-recovery.test.ts",
        "test": "body change during the retained suffix stops before completion, with no body patch or later resume",
        "tests": 1,
        "meaning": "A body change after the second Record must prevent every later suffix write, not merely reject at final verification.",
    },
    {
        "name": "complete-independent-acceptance-binding",
        "model": "IndependentAcceptance",
        "rule": "ColdRecoveryNeedsCompleteProof",
        "file": "packages/core/src/shared-file-add-acceptance.ts",
        "pattern": r"if \(!same\(completion, expected\)\)",
        "replace": "if (false && !same(completion, expected))",
        "test_file": "packages/core/test/shared-file-management.test.ts",
        "test": "independent add acceptance cold readers reject a coherently rehashed wrong",
        "tests": 2,
        "meaning": "A well-formed immutable completion Record must bind the exact full review and adopted event hashes.",
    },
    {
        "name": "historical-feedback-ack-independent-of-current-body",
        "model": "RestoreFeedback",
        "rule": "HistoricalAckPreserved",
        "file": "packages/core/src/shared-file-request.ts",
        "pattern": r"(const sameNative =\n)(\s+observed\.context\.library_id === after\.library_id &&)",
        "replace": r"\1          sameContext(observed.context, after) &&\n\2",
        "test_file": "packages/core/test/shared-file-request.test.ts",
        "test": "a verified feedback ACK remains historical when the body changes before its readback",
        "tests": 1,
        "meaning": "Later body drift stops new body authority but must not turn an exact acknowledged metadata receipt into an unknown or mismatched operation.",
    },
]

def digest(value):
    return hashlib.sha256(value).hexdigest()

def snapshot(root):
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root
    ).decode().split("\0")
    return {
        name: {"sha256": digest((root / name).read_bytes()), "mode": (root / name).stat().st_mode & 0o777}
        for name in sorted(set(filter(None, names))) if (root / name).is_file()
    }

def execute(label, case):
    command = [args.bun, "test", case["test_file"], "-t", re.escape(case["test"]) if case["tests"] == 1 else case["test"], "--timeout", "60000"]
    start = time.monotonic()
    result = subprocess.run(command, cwd=repo, env=env, capture_output=True, text=True, timeout=90)
    (out / (label + ".stdout.log")).write_text(result.stdout)
    (out / (label + ".stderr.log")).write_text(result.stderr)
    output = result.stdout + "\n" + result.stderr
    matched = re.search(r"(\d+) pass", output)
    return {
        "command": command, "exit": result.returncode,
        "elapsed_seconds": round(time.monotonic() - start, 3),
        "passing_tests": int(matched.group(1)) if matched else 0,
        "stdout_sha256": digest(result.stdout.encode()),
        "stderr_sha256": digest(result.stderr.encode()),
    }, output

before = snapshot(repo)
(out / "source-before.json").write_text(json.dumps(before, indent=2) + "\n")
coverage_path = protected / "verification/models/operation-recovery/coverage.json"
coverage = json.loads(coverage_path.read_text())
for name, expected in coverage["files"].items():
    assert digest((protected / name).read_bytes()) == expected, f"Review protected source binding first: {name}"
    assert digest((repo / name).read_bytes()) == expected, f"Candidate is not the reviewed source and tests: {name}"
protected_sources = {
    name: {"sha256": digest((protected / name).read_bytes()), "mode": (protected / name).stat().st_mode & 0o777}
    for name in coverage["files"]
}
summary = {
    "worktree": str(repo), "protected_worktree": str(protected),
    "coverage_sha256": digest(coverage_path.read_bytes()),
    "source_binding_verified": coverage["files"],
    "cases": [], "passed": False,
    "claim": "Four actual source guards with independent public-function regressions. These are source tests, not live Notion or cross-machine exactly-once evidence.",
}
try:
    for case in cases:
        path = repo / case["file"]
        original = path.read_bytes()
        original_mode = path.stat().st_mode & 0o777
        assert len(list(re.finditer(case["pattern"], original.decode()))) == 1, f"Review changed guard: {case['name']}"
        mutated = re.sub(case["pattern"], case["replace"], original.decode(), count=1).encode()
        assert original != mutated, "Mutation must change the actual source"
        row = {key: case[key] for key in ["name", "model", "rule", "file", "test_file", "test", "meaning"]}
        row["source_sha256"] = digest(original)
        row["mutated_sha256"] = digest(mutated)
        summary["cases"].append(row)
        row["baseline"], _ = execute(case["name"] + "-baseline", case)
        assert row["baseline"]["exit"] == 0 and row["baseline"]["passing_tests"] == case["tests"], f"Baseline not exercised: {case['name']}"
        assert path.read_bytes() == original, "Concurrent source change before mutation; stop"
        path.write_bytes(mutated)
        try:
            row["mutant"], output = execute(case["name"] + "-mutant", case)
            row["assertion_failure"] = (
                row["mutant"]["exit"] != 0
                and re.search(r"toBe|toHaveLength|toMatchObject|toEqual", output) is not None
                and re.search(r"Expected|expect\(received\)|AssertionError", output) is not None
                and re.search(r"SyntaxError|ReferenceError|TypeError:|MODULE_NOT_FOUND|Cannot find module|ParseError", output) is None
            )
        finally:
            assert path.read_bytes() == mutated, "Concurrent change detected; preserve it instead of overwriting"
            path.write_bytes(original)
            assert path.stat().st_mode & 0o777 == original_mode
            row["restored_sha256"] = digest(path.read_bytes())
        row["restored"], _ = execute(case["name"] + "-restored", case)
        assert row["assertion_failure"], f"No real assertion counterexample: {case['name']}"
        assert row["restored"]["exit"] == 0 and row["restored"]["passing_tests"] == case["tests"], f"Restored regression failed: {case['name']}"
        assert row["source_sha256"] == row["restored_sha256"]
    after = snapshot(repo)
    (out / "source-after.json").write_text(json.dumps(after, indent=2) + "\n")
    summary["complete_source_and_modes_restored"] = before == after
    summary["protected_source_unchanged"] = protected_sources == {
        name: {"sha256": digest((protected / name).read_bytes()), "mode": (protected / name).stat().st_mode & 0o777}
        for name in protected_sources
    }
    summary["protected_source_count"] = len(protected_sources)
    assert summary["complete_source_and_modes_restored"], "Candidate changed beyond the restored guards"
    assert summary["protected_source_unchanged"], "Protected product source or tests changed concurrently; review before claiming success"
    summary["passed"] = True
finally:
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary), flush=True)
sys.exit(0 if summary["passed"] else 1)
