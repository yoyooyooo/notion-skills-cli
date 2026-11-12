#!/usr/bin/env python3
"""Replay RequestEngine guard failures in a retained, isolated source/dependency fixture."""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, sys, time

parser = argparse.ArgumentParser()
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
coverage = json.loads((repo / "verification/models/request-engine/coverage.json").read_text())
shutil.copy2(repo / "verification/models/request-engine/coverage.json", out / "coverage.json")
shutil.copy2(Path(__file__), out / "check-request-engine-mutations.py")
sha = lambda value: hashlib.sha256(value).hexdigest()
for name, expected in coverage["files"].items():
    assert sha((repo / name).read_bytes()) == expected, f"Review source correspondence first: {name}"

fixture = out / "fixture"
fixture.mkdir()
for name in ["package.json", "tsconfig.json", "bun.lock"]:
    if (repo / name).exists():
        shutil.copy2(repo / name, fixture / name)
shutil.copytree(repo / "packages", fixture / "packages",
                ignore=shutil.ignore_patterns("node_modules", "dist", ".cache", ".DS_Store"), symlinks=True)
modules = fixture / "node_modules"
modules.mkdir()
shutil.copytree((repo / "node_modules/effect").resolve(), modules / "effect", symlinks=False)

def link_dependencies(source, destination):
    destination.mkdir(exist_ok=True)
    for entry in source.iterdir():
        if entry.name.startswith(".") or entry.name == "effect":
            continue
        target = destination / entry.name
        if entry.name.startswith("@"):
            link_dependencies(entry, target)
            continue
        resolved = entry.resolve()
        if resolved.is_relative_to(repo / "packages"):
            resolved = fixture / resolved.relative_to(repo)
        if not target.exists():
            target.symlink_to(resolved, target_is_directory=entry.is_dir())

link_dependencies(repo / "node_modules", modules)
for package in (repo / "packages").iterdir():
    local = package / "node_modules"
    if local.is_dir():
        destination = fixture / package.relative_to(repo) / "node_modules"
        link_dependencies(local, destination)
        (destination / "effect").symlink_to(modules / "effect", target_is_directory=True)

cache = "node_modules/effect/dist/Cache.js"
coalescing = "packages/core/src/shared-read-coalescing.ts"
transport = "packages/core/src/notion.ts"
scheduler = "packages/core/src/notion-request-scheduler.ts"
budget = "packages/core/src/request-budget.ts"
shared_test = "packages/core/test/shared-read-coalescing.test.ts"
notion_test = "packages/core/test/notion.test.ts"
budget_test = "packages/core/test/request-budget.test.ts"
contract_test = "packages/core/test/request-engine-contract.test.ts"

cases = [
    ("surviving-waiter", cache,
     [("if (this.awaiters > 0 || this.fiber.pollUnsafe()) return effect.void;",
       "if (this.fiber.pollUnsafe()) return effect.void;")],
     shared_test, "cancelling the", "SurvivingWaiterKeepsProducer"),
    ("last-owner-release", cache,
     [("if (this.awaiters > 0 || this.fiber.pollUnsafe()) return effect.void;",
       "if (true) return effect.void;")],
     shared_test, "last cancelled waiter", "LastWaiterReleasesProducer"),
    ("scope-key", coalescing,
     [("JSON.stringify([request.key, request.method, request.path, request.content ?? null])",
       'JSON.stringify(["same-scope", request.method, request.path, request.content ?? null])')],
     shared_test, "credential/body identity", "ScopeIsolated"),
    ("invocation-budget-key", transport,
     [("...(budget === undefined ? [] : [budget.identity]),", "...[],")],
     contract_test, "FV07 a shared key", "BudgetIsolated"),
    ("queue-budget-key", transport,
     [("options?.queueBudgetMs ?? NOTION_ADMISSION_BUDGET_MS,", "NOTION_ADMISSION_BUDGET_MS,")],
     notion_test, "incompatible queue budgets", "QueueBudgetIsolated"),
    ("service-local-cache", coalescing,
     [("export function makeSharedReadCoalescer(", "let reusedCache\n\nexport function makeSharedReadCoalescer("),
      ("const cache = yield* Cache.make({", "const cache = reusedCache ?? (yield* Cache.make({"),
      ("    })\n    return {\n      run:", "    }))\n    reusedCache = cache\n    return {\n      run:")],
     shared_test, "separate service instances", "ServiceIsolated"),
    ("settled-result-ttl", coalescing,
     [("timeToLive: 0,", "timeToLive: 60_000,")],
     shared_test, "completed success", "SettledResultNotReused"),
    ("late-cleanup-entry-identity", cache,
     [("if (Option.isSome(current) && current.value === entry) {", "if (Option.isSome(current)) {")],
     shared_test, "abandoned producer", "ReplacementSurvivesOldCleanup"),
    ("cooldown-admission", scheduler,
     [("if (!decision.admitted) {", "if (false && !decision.admitted) {")],
     contract_test, "FV07 cooled queue", "CooldownBeforeAdmission"),
    ("queue-deadline", scheduler,
     [("const deadline = queueDeadline < operationDeadline ? queueDeadline : operationDeadline",
       "const deadline = operationDeadline")],
     notion_test, "incompatible queue budgets", "CallerDeadlineRespected"),
    ("invocation-deadline", transport,
     [("const budget = Option.getOrUndefined(yield* Effect.serviceOption(RequestBudget))",
       "const budget = undefined")],
     budget_test, "queue waits consume deadline", "CallerDeadlineRespected"),
    ("attempt-count", budget,
     [("if (attempts >= limits.requests)", "if (false && attempts >= limits.requests)")],
     budget_test, "request budget stops a real retry", "AttemptBudgetRespected"),
    ("unknown-mutation-retry", transport,
     [("? isRetryableNotionWriteRejection(details)", "? true")],
     contract_test, "FV07 an uncertain mutation", "UnknownMutationNeverRetried"),
    ("network-permit-release", scheduler,
     [("? yield* permits.withPermitsIfAvailable(1)(take)",
       "? (yield* permits.take(1), Option.some(yield* take))")],
     contract_test, "FV07 cooled queue", "NoPermitDuringQueueOrBackoff"),
    ("queue-lease-release", scheduler,
     [("if (state.remove) yield* state.remove(ticket.id)",
       "if (false && state.remove) yield* state.remove(ticket.id)")],
     contract_test, "FV07 cooled queue", "CancelledQueueReleasesLease"),
    ("attempt-timeout", transport,
     [("Effect.timeout(timeoutMs),", "(effect) => effect,")],
     contract_test, "FV07 a single HTTP", "AttemptDeadlineRespected"),
]
originals = out / "originals"
originals.mkdir()
results = []
summary = {
    "complete": False, "passed": False,
    "fixture": str(fixture), "source_commit": coverage["synchronized_commit"],
    "checkout_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
    "verifier_sha256": sha(Path(__file__).read_bytes()),
    "coverage_sha256": sha((repo / "verification/models/request-engine/coverage.json").read_bytes()),
    "runtime": {"bun": subprocess.check_output(["bun", "--version"], text=True).strip(),
                "python": sys.version.split()[0]},
    "source_hashes": coverage["files"],
    "dependency": {"effect": "4.0.5", "file": cache, "sha256": coverage["files"][cache]},
    "scope": "Controlled public Notion service/coalescer/scheduler code, no remote HTTP or real Notion mutations.",
    "results": results,
}
def save():
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
def failure_hook(kind, error, traceback):
    summary["error"] = {"type": kind.__name__, "message": str(error)}
    save()
    sys.__excepthook__(kind, error, traceback)
sys.excepthook = failure_hook
def run(label, test, pattern):
    started = time.monotonic()
    try:
        p = subprocess.run(["bun", "test", test, "-t", pattern, "--timeout", "10000"],
                           cwd=fixture, text=True, capture_output=True, timeout=25)
    except subprocess.TimeoutExpired as error:
        content = (error.stdout or b"") + (error.stderr or b"")
        (out / (label + ".log")).write_bytes(content + b"\nHARNESS TIMEOUT\n")
        raise
    (out / (label + ".log")).write_text(p.stdout + p.stderr)
    return p, round(time.monotonic() - started, 3)
save()
for name, filename, replacements, test, pattern, rule in cases:
    target = fixture / filename
    original = target.read_bytes()
    (originals / (name + ".original")).write_bytes(original)
    text = original.decode()
    for old, new in replacements:
        assert text.count(old) == 1, (name, "guard drift", old, text.count(old))
        text = text.replace(old, new, 1)
    mutated = text.encode()
    (originals / (name + ".mutant")).write_bytes(mutated)
    baseline, baseline_seconds = run(name + "-baseline", test, pattern)
    assert baseline.returncode == 0, (name, "baseline failed", baseline.stderr)
    assert "(pass)" in baseline.stdout + baseline.stderr, (name, "no baseline test ran")
    target.write_bytes(mutated)
    try:
        broken, broken_seconds = run(name + "-mutant", test, pattern)
        output = broken.stdout + broken.stderr
        assert broken.returncode != 0, (name, "real mutation escaped")
        assert "(fail)" in output and "expect(" in output, (name, "not an assertion failure", output)
        assert "error: Cannot find" not in output and "SyntaxError:" not in output, (name, "tool error")
    finally:
        assert target.read_bytes() == mutated, (name, "concurrent fixture modification")
        target.write_bytes(original)
    restored, restored_seconds = run(name + "-restored", test, pattern)
    assert restored.returncode == 0, (name, "restored failed", restored.stderr)
    assert "(pass)" in restored.stdout + restored.stderr, (name, "no restored test ran")
    assert target.read_bytes() == original
    row = {
        "case": name, "rule": rule, "file": filename,
        "test": test, "test_pattern": pattern,
        "original_sha256": sha(original), "mutant_sha256": sha(mutated),
        "baseline_exit": baseline.returncode, "mutant_exit": broken.returncode,
        "restored_exit": restored.returncode,
        "seconds": [baseline_seconds, broken_seconds, restored_seconds],
    }
    results.append(row)
    save()
    print(json.dumps({"case": name, "rule": rule, "caught": True}), flush=True)

for name, expected in coverage["files"].items():
    assert sha((repo / name).read_bytes()) == expected, f"Protected checkout changed: {name}"
summary["complete"] = True
summary["passed"] = True
summary["real_guard_mutations_caught"] = len(results)
summary["protected_checkout_unchanged"] = True
save()
print(json.dumps({"passed": True, "real_guard_mutations_caught": len(results), "out": str(out)}))
