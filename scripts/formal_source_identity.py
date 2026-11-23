"""Bind a formal run to its Git checkout or the official paired source snapshot."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import re
import subprocess


def source_identity(repository, protected_files, environment=None):
    repository = Path(repository).resolve(strict=True)
    environment = os.environ if environment is None else environment
    observed = subprocess.run(
        ["git", "rev-parse", "--show-toplevel", "HEAD"], cwd=repository,
        text=True, capture_output=True,
    )
    lines = observed.stdout.splitlines()
    if (observed.returncode == 0 and len(lines) == 2
            and Path(lines[0]).resolve() == repository
            and re.fullmatch(r"[a-f0-9]{40}", lines[1])):
        return {"checkout_commit": lines[1], "source_provenance": {"kind": "git-checkout"}}

    def require(condition, message):
        if not condition:
            raise ValueError("Formal source provenance: " + message)

    def absolute(raw):
        require(isinstance(raw, str) and Path(raw).is_absolute(), "expected an absolute path")
        return Path(raw).resolve(strict=True)

    def read(path):
        raw = path.read_bytes()
        value = json.loads(raw)
        require(isinstance(value, dict), "expected a manifest object")
        return value, hashlib.sha256(raw).hexdigest()

    require(environment.get("PAIRED_CLI_SOURCE") and environment.get("PAIRED_RUN_ROOT"),
            "gitless sources require the official paired run")
    require(absolute(environment["PAIRED_CLI_SOURCE"]) == repository, "selected CLI source differs")
    run_root = absolute(environment["PAIRED_RUN_ROOT"])
    run, run_hash = read(run_root / "run.json")
    require(run.get("version") == 1 and run.get("kind") == "isolated-development-run"
            and run.get("target") == "command", "unexpected run manifest")
    require(absolute(run.get("root")) == run_root and run.get("run_id") == run_root.name,
            "run root or ID differs")
    require(absolute(run.get("paths", {}).get("PAIRED_CLI_SOURCE")) == repository
            and (run_root / "source/cli").resolve() == repository, "run CLI source differs")
    build_root = absolute(run.get("build_root"))
    build, build_hash = read(build_root / "build.json")
    require(build.get("version") == 1 and build.get("kind") == "paired-build",
            "unexpected build manifest")
    require(absolute(build.get("root")) == build_root
            and run.get("build_id") == build.get("build_id") == build_root.name,
            "selected build root or ID differs")
    require(isinstance(run.get("environment_id"), str) and run["environment_id"]
            and run["environment_id"] == build.get("environment_id"), "environment ID differs")
    source = build.get("sources", {}).get("cli", {})
    require(isinstance(source, dict) and re.fullmatch(r"[a-f0-9]{40}", source.get("commit", "")),
            "missing original CLI commit")
    members = source.get("files")
    require(isinstance(members, list), "missing source inventory")
    digest = hashlib.sha256(json.dumps(members, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    require(digest == source.get("sha256"), "source inventory digest differs")
    inventory = {}
    for member in members:
        require(isinstance(member, dict), "invalid source inventory member")
        name, expected = member.get("path"), member.get("sha256")
        require(isinstance(name, str) and name and not PurePosixPath(name).is_absolute()
                and ".." not in PurePosixPath(name).parts and name not in inventory
                and isinstance(expected, str) and re.fullmatch(r"[a-f0-9]{64}", expected),
                "invalid source inventory identity")
        inventory[name] = expected
    verified = []
    for name, expected in protected_files.items():
        # Dependencies are separately bound by coverage and the paired build.
        # They are not files from the original Git/source inventory.
        if "node_modules" in PurePosixPath(name).parts:
            continue
        require(inventory.get(name) == expected, "protected source differs from the selected build: " + name)
        target = (repository / name).resolve(strict=True)
        require(target.is_relative_to(repository)
                and hashlib.sha256(target.read_bytes()).hexdigest() == expected,
                "protected source bytes differ: " + name)
        verified.append(name)
    return {
        "checkout_commit": None,
        "source_provenance": {
            "kind": "paired-source-snapshot", "environment_id": run["environment_id"],
            "run_id": run["run_id"], "build_id": build["build_id"],
            "original_commit": source["commit"], "source_inventory_sha256": digest,
            "run_manifest_sha256": run_hash, "build_manifest_sha256": build_hash,
            "protected_source_files_verified": sorted(verified),
        },
    }
