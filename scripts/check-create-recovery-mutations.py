#!/usr/bin/env python3
"""Replay two reviewed recovery guards only in a separate candidate worktree."""
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
assert repo != protected, "Never mutate the active product worktree"
assert (repo / ".git").is_file(), "Use an isolated linked Git worktree"
gitdir = subprocess.check_output(["git", "rev-parse", "--absolute-git-dir"], cwd=repo, text=True).strip()
common = subprocess.check_output(["git", "rev-parse", "--git-common-dir"], cwd=repo, text=True).strip()
assert Path(gitdir).resolve() != (repo / common).resolve(), "A separate linked worktree is required"
dependencies = repo / "node_modules"
assert dependencies.is_dir() and not dependencies.is_symlink(), "Copy dependencies into this worktree"
for base in [dependencies, repo / "packages"]:
    for directory, dirs, files in os.walk(base, followlinks=False):
        for name in dirs + files:
            candidate = Path(directory) / name
            if candidate.is_symlink():
                assert candidate.resolve().is_relative_to(repo), f"Dependency escapes isolated copy: {candidate}"
out = Path(args.out).resolve()
assert not out.is_relative_to(repo), "Keep all test output and caches outside the checkout"
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
source = "packages/core/test/shared-create-known-recovery.test.ts"
cases = [
    {
        "name": "complete-original-dispatch-set",
        "file": "packages/core/src/shared-create-recovery-known-bootstrap.ts",
        "pattern": r"if \(\s*seenNative\.size !== native\.size \|\|\s*seenFacts\.size !== facts\.size \|\|\s*retained\.length !== native\.size \+ facts\.size\s*\)",
        "replace": lambda match: "if (false && (" + match.group(0)[4:-1] + "))",
        "test": "the complete original request set rejects missing-record-dispatch without a recovery write",
        "assertion": r"toBe|toEqual",
        "meaning": "Removing one original Record dispatch must prevent a reviewed recovery admission.",
    },
    {
        "name": "projection-authority-before-first-write",
        "file": "packages/core/src/shared-create-dispatch.ts",
        "pattern": r'if \(method === "PATCH"\) yield\* observeMutation\(library, plan, path, body, method\)',
        "replace": lambda _match: "/* mutation: first-PATCH scope check removed; postcondition remains */",
        "test": "reference metadata dispatcher rejects markdown-key outside the exact reviewed allowance",
        "assertion": r"toHaveLength",
        "meaning": "A rejected request must have zero transport writes; a post-write refusal is too late.",
    },
]
def digest(value):
    return hashlib.sha256(value).hexdigest()

def tracked_snapshot():
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=repo
    ).decode().split("\0")
    result = {}
    for name in sorted(set(filter(None, names))):
        path = repo / name
        if path.is_file():
            result[name] = {"sha256": digest(path.read_bytes()), "mode": path.stat().st_mode & 0o777}
    return result

def execute(label, pattern):
    command = [args.bun, "test", source, "-t", pattern, "--timeout", "60000"]
    start = time.monotonic()
    result = subprocess.run(command, cwd=repo, env=env, capture_output=True, text=True, timeout=90)
    (out / (label + ".stdout.log")).write_text(result.stdout)
    (out / (label + ".stderr.log")).write_text(result.stderr)
    return {
        "command": command, "exit": result.returncode,
        "elapsed_seconds": round(time.monotonic() - start, 3),
        "stdout_sha256": digest(result.stdout.encode()),
        "stderr_sha256": digest(result.stderr.encode()),
    }, result.stdout + "\n" + result.stderr

before = tracked_snapshot()
(out / "source-before.json").write_text(json.dumps(before, indent=2) + "\n")
summary = {
    "worktree": str(repo), "protected_worktree": str(protected),
    "test_file": source, "cases": [], "passed": False,
    "claim": "Two real-code recovery boundaries, not the original four mutation checks or live Notion behavior.",
}
try:
    for case in cases:
        path = repo / case["file"]
        original = path.read_bytes()
        original_mode = path.stat().st_mode & 0o777
        matches = list(re.finditer(case["pattern"], original.decode()))
        assert len(matches) == 1, f"Review changed guard before mutation: {case['name']}"
        mutated = re.sub(case["pattern"], case["replace"], original.decode(), count=1).encode()
        row = {"case": case["name"], "file": case["file"], "meaning": case["meaning"], "source_sha256": digest(original)}
        summary["cases"].append(row)
        row["baseline"], _ = execute(case["name"] + "-baseline", case["test"])
        assert row["baseline"]["exit"] == 0, f"Baseline failed: {case['name']}"
        assert path.read_bytes() == original, "Source changed before mutation; stop"
        path.write_bytes(mutated)
        try:
            row["mutant"], output = execute(case["name"] + "-mutant", case["test"])
            row["assertion_failure"] = (
                row["mutant"]["exit"] != 0
                and re.search(case["assertion"], output) is not None
                and re.search(r"Expected|expect\(received\)|AssertionError", output) is not None
                and re.search(r"SyntaxError|ReferenceError|TypeError:|MODULE_NOT_FOUND|Cannot find module|ParseError", output) is None
            )
        finally:
            assert path.read_bytes() == mutated, "Concurrent change detected; preserve it instead of restoring over it"
            path.write_bytes(original)
            assert (path.stat().st_mode & 0o777) == original_mode
            row["restored_sha256"] = digest(path.read_bytes())
        row["restored"], _ = execute(case["name"] + "-restored", case["test"])
        assert row["assertion_failure"], f"Removed guard did not produce the required assertion counterexample: {case['name']}"
        assert row["restored"]["exit"] == 0, f"Restored case failed: {case['name']}"
        assert row["source_sha256"] == row["restored_sha256"]
    after = tracked_snapshot()
    (out / "source-after.json").write_text(json.dumps(after, indent=2) + "\n")
    summary["complete_source_and_modes_restored"] = before == after
    assert before == after, "The isolated source tree changed beyond the restored guards"
    summary["passed"] = True
finally:
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary), flush=True)
sys.exit(0 if summary["passed"] else 1)
