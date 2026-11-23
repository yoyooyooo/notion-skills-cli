#!/usr/bin/env python3
"""Replay current formal guards in retained, isolated source/dependency fixtures."""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, sys, time
from formal_mutation_result import failed_assertion

parser = argparse.ArgumentParser()
parser.add_argument("--suite", choices=["request-engine", "current-lifecycle"], required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
assert args.out.is_absolute(), "--out must be an owned absolute path"
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
coverage_path = repo / "verification/models" / args.suite / "coverage.json"
coverage = json.loads(coverage_path.read_text())
shutil.copy2(coverage_path, out / "coverage.json")
shutil.copy2(Path(__file__), out / "check-formal-mutations.py")
classifier_path = Path(__file__).with_name("formal_mutation_result.py")
shutil.copy2(classifier_path, out / classifier_path.name)
sha = lambda value: hashlib.sha256(value).hexdigest()
for name, expected in coverage["files"].items():
    assert sha((repo / name).read_bytes()) == expected, f"Review source correspondence first: {name}"

fixture = out / "fixture"
fixture.mkdir()
for name in ["package.json", "tsconfig.json", "bun.lock", "vitest.config.ts"]:
    if (repo / name).exists():
        shutil.copy2(repo / name, fixture / name)
shutil.copytree(repo / "packages", fixture / "packages",
                ignore=shutil.ignore_patterns("node_modules", "dist", ".cache", ".DS_Store"), symlinks=True)
(fixture / "scripts").mkdir()
shutil.copy2(repo / "scripts/sdk-source-fixture.mjs", fixture / "scripts/sdk-source-fixture.mjs")
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
immutable = "packages/core/src/shared-immutable-read.ts"
immutable_test = "packages/core/test/shared-immutable-read.test.ts"
current_resource = "packages/core/src/shared-current-resource.ts"
sdk_test = "packages/core/test/sdk-immutable-read.node.test.ts"

request_cases = [
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
    ("immutable-runtime-scope", current_resource,
     [("import { Clock, Effect, FileSystem, Option, Schema, Stream }", "import { Clock, Crypto, Effect, FileSystem, Option, Schema, Stream }"),
      ("detached.run(read),", "read.pipe(Effect.provideService(Notion, api), Effect.provideService(Crypto.Crypto, yield* Crypto.Crypto), Effect.provideService(HttpClient.HttpClient, yield* HttpClient.HttpClient)),")],
     sdk_test, "two public SDK runtimes", "SurvivingWaiterKeepsProducer"),
    ("immutable-admission-capacity", immutable,
     [("active >= limits.entries ||", "false ||"),
      ("admittedBytes + bytes > limits.bytes", "false")],
     immutable_test, "admission bounds new shared producers", "SharedAdmissionBounded"),
    ("immutable-cleanup-capacity", immutable,
     [("if (!selected.started) finish()", "finish()")],
     immutable_test, "a cancelled producer holds its capacity", "SharedAdmissionBounded"),
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
operation = "packages/core/src/shared-current-operation.ts"
operation_test = "packages/core/test/shared-current-operation.test.ts"
lifecycle_cases = [
    ("current-read-final-fence", "packages/core/src/shared-snapshot.ts",
     [("if (consumptionFence(finalIndex, finalConsumption) !== consumptionFence(index, consumption))",
       "if (false && consumptionFence(finalIndex, finalConsumption) !== consumptionFence(index, consumption))")],
     "packages/core/test/shared-current-snapshot.test.ts",
     "a writer starting or completing during body reads", "NoMixedCurrentPublication"),
    ("non-content-owner-activation", operation,
     [('const projection = "projection" in intent', 'const projection = false')],
     operation_test, "generated bodies use one finite intent", "NonContentPreservesReadiness"),
    ("unknown-product-action-replay", operation,
     [('if (active !== null && (mode !== "resume" || action.replay === "never"))',
       'if (active !== null && mode !== "resume")')],
     operation_test, "unknown absent append is never replayed", "UnknownNonIdempotentNeverRepeated"),
    ("non-content-completion-owner", operation,
     [('if (preserveReadyOwner && state.state !== "ready")',
       'if (false && preserveReadyOwner && state.state !== "ready")')],
     operation_test, "an owner becoming unready during projection", "NonContentCompletionQualified"),
]
cases = request_cases if args.suite == "request-engine" else lifecycle_cases
originals = out / "originals"
originals.mkdir()
results = []
summary = {
    "complete": False, "passed": False, "suite": args.suite,
    "fixture": str(fixture), "source_commit": coverage["synchronized_commit"],
    "checkout_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
    "verifier_sha256": sha(Path(__file__).read_bytes()),
    "result_classifier_sha256": sha(classifier_path.read_bytes()),
    "coverage_sha256": sha(coverage_path.read_bytes()),
    "runtime": {"bun": subprocess.check_output(["bun", "--version"], text=True).strip(),
                "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                "python": sys.version.split()[0]},
    "source_hashes": coverage["files"],
    "dependency": ({"effect": "4.0.5", "file": cache, "sha256": coverage["files"][cache]}
                   if args.suite == "request-engine" else None),
    "scope": ("Controlled public Notion service/coalescer/scheduler and SDK code. The immutable runtime case uses an owned local HTTP server, independent public SDK runtimes and a frozen fixture; no real credentials or remote Notion mutations."
              if args.suite == "request-engine" else
              "Production current reader and finite operation kernel with controlled Notion service responses. Each guard is removed in an isolated source copy and checked by its existing behavioral assertion. No live Notion, Pi or provider claim."),
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
    node = test.endswith(".node.test.ts")
    report = out / (label + ".json")
    command = (["node", "node_modules/vitest/vitest.mjs", "run", "--config", "vitest.config.ts",
                test, "-t", pattern, "--reporter=json", "--outputFile=" + str(report)] if node else
               ["bun", "test", test, "-t", pattern, "--timeout", "10000"])
    try:
        p = subprocess.run(command, cwd=fixture, text=True, capture_output=True,
                           timeout=120 if node else 25)
    except subprocess.TimeoutExpired as error:
        content = (error.stdout or b"") + (error.stderr or b"")
        (out / (label + ".log")).write_bytes(content + b"\nHARNESS TIMEOUT\n")
        raise
    (out / (label + ".log")).write_text(p.stdout + p.stderr)
    if node:
        assert report.exists(), (label, "missing structured Vitest result", p.stdout, p.stderr)
        data = json.loads(report.read_text())
        assertions = [a for file in data["testResults"] for a in file["assertionResults"]]
        p.real_assertions = [a for a in assertions if a["status"] in ["passed", "failed"]]
        p.assertion_failures = [message for a in p.real_assertions if a["status"] == "failed"
                                for message in a.get("failureMessages", [])]
    return p, round(time.monotonic() - started, 3)
def passed_test(p):
    return (any(a["status"] == "passed" for a in p.real_assertions)
            if hasattr(p, "real_assertions") else "(pass)" in p.stdout + p.stderr)
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
    assert passed_test(baseline), (name, "no baseline test ran")
    target.write_bytes(mutated)
    try:
        broken, broken_seconds = run(name + "-mutant", test, pattern)
        output = broken.stdout + broken.stderr
        assert broken.returncode != 0, (name, "real mutation escaped")
        assert failed_assertion(broken), (name, "not an assertion failure", output)
        if name == "immutable-runtime-scope":
            assert any("NOTION_SCHEDULER_UNAVAILABLE" in message
                       for message in broken.assertion_failures), (
                name, "survivor must encounter the creator's closed scheduler", output)
    finally:
        assert target.read_bytes() == mutated, (name, "concurrent fixture modification")
        target.write_bytes(original)
    restored, restored_seconds = run(name + "-restored", test, pattern)
    assert restored.returncode == 0, (name, "restored failed", restored.stderr)
    assert passed_test(restored), (name, "no restored test ran")
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
