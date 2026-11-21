import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
const workflow = read(".github/workflows/ci.yml")
const packageCheck = read("scripts/package-check.ts")
const runners = [read("scripts/package-smoke.ts"), read("scripts/sdk-package-smoke.mjs")]

function verify(text: string, distribution: string) {
  const [job, ...steps] = text.split(/^ {6}- /mu)
  const check = steps.findIndex((step) => /^\s*run: bun run check\s*$/mu.test(step))
  const consumer = steps.findIndex((step) =>
    /^\s*run: bun scripts\/package-check\.ts\b/mu.test(step),
  )
  const upload = steps.findIndex((step) => /uses: actions\/upload-artifact@/u.test(step))
  const entry = steps[consumer] ?? ""
  if (check < 0 || consumer <= check || upload <= consumer)
    throw new Error("PACKAGE_CI_ENTRY_DISCONNECTED")
  if (
    /^ {4}(?:if|continue-on-error):/mu.test(job ?? "") ||
    /^\s*(?:if|continue-on-error):|\|\|\s*true/mu.test(entry)
  )
    throw new Error("PACKAGE_CI_GATE_WEAKENED")

  const artifact = steps[upload] ?? ""
  const evidenceRoot = entry.match(/NTN_SMOKE_EVIDENCE_ROOT: (.+)/u)?.[1]?.trim()
  const summary = entry.match(/> "\$RUNNER_TEMP\/([^"\n]+)"/u)?.[1]
  const retention = Number(artifact.match(/retention-days: (\d+)/u)?.[1])
  if (
    !evidenceRoot ||
    !summary ||
    !/^\s*if: always\(\)\s*$/mu.test(artifact) ||
    !Number.isInteger(retention) ||
    retention < 1 ||
    retention > 7
  )
    throw new Error("PACKAGE_CI_RESULTS_NOT_RETAINED")
  const patterns = artifact
    .split("\n")
    .map((line) => line.trim().replaceAll("${{ runner.temp }}", "/runner-temp"))
    .filter((line) => line.startsWith("/runner-temp/") || line.startsWith("!/runner-temp/"))
  const retained = (path: string) =>
    patterns.some((pattern) => !pattern.startsWith("!") && new Bun.Glob(pattern).match(path)) &&
    !patterns.some(
      (pattern) => pattern.startsWith("!") && new Bun.Glob(pattern.slice(1)).match(path),
    )
  const root = evidenceRoot.replaceAll("${{ runner.temp }}", "/runner-temp")
  const outputs = runners.flatMap((runner, index) => {
    // Read the filenames from the actual runners so renamed request ledgers stay covered.
    const names = new Set(
      Array.from(
        runner.matchAll(
          /join\((?:scratch|root), "(report\.json|[^"\n]*requests[^"\n]*\.jsonl)"\)/gu,
        ),
        (match) => match[1]!,
      ),
    )
    if (!names.has("report.json") || ![...names].some((name) => name.endsWith(".jsonl")))
      throw new Error("PACKAGE_CI_RUNNER_OUTPUTS_MISSING")
    return [...names].flatMap((name) => {
      const path = `${root}/consumer-${index}/${name}`
      return name.endsWith(".jsonl") ? [path, path.replace(/\.jsonl$/u, ".events.jsonl")] : [path]
    })
  })
  if (
    ![`/runner-temp/${summary}`, ...outputs].every(retained) ||
    ["report.json", "requests.jsonl"].some((name) =>
      retained(`${root}/consumer/node_modules/pkg/${name}`),
    )
  )
    throw new Error("PACKAGE_CI_RESULTS_NOT_RETAINED")

  const source = distribution.replace(/\s+/gu, " ")
  if (
    !source.includes(
      'await run(["bun", join(root, "scripts/package-smoke.ts"), "--archive", archive])',
    ) ||
    !source.includes(
      'await run([ "node", join(root, "scripts/sdk-package-smoke.mjs"), "--archive", archive,',
    )
  )
    throw new Error("PACKAGE_CI_ARCHIVE_DISCONNECTED")
  if (
    !/if \(exit\) throw /u.test(source) ||
    !source.includes("if (sdkFailure !== undefined) throw sdkFailure") ||
    !/sdk\?\.contract !== "current-only" \|\| sdk\.selection !== "all" \|\| sdk\.failed !== 0/u.test(
      source,
    )
  )
    throw new Error("PACKAGE_CI_SDK_GATE_WEAKENED")
}

test("CI runs the same installed CLI and SDK archive and retains failed reports and request logs", () => {
  expect(() => verify(workflow, packageCheck)).not.toThrow()
})

test("missing, skipped or softened package lanes and lost consumer logs fail the workflow contract", () => {
  for (const change of [
    (text: string) => text.replace("bun scripts/package-check.ts", "bun scripts/other.ts"),
    (text: string) =>
      text.replace("        env:\n", "        if: matrix.os == 'ubuntu-latest'\n        env:\n"),
    (text: string) =>
      text.replace("        env:\n", "        continue-on-error: true\n        env:\n"),
    (text: string) => text.replace('ntn-package-check.json"', 'ntn-package-check.json" || true'),
    (text: string) => text.replace("if: always()", "if: success()"),
    (text: string) => text.replace("**/report.json", "**/other.json"),
    (text: string) => text.replace("**/*requests*.jsonl", "**/requests*.jsonl"),
    (text: string) => text.replace("!${{ runner.temp }}", "${{ runner.temp }}"),
    (text: string) => text.replace("retention-days: 7", "retention-days: 90"),
  ]) {
    const changed = change(workflow)
    expect(changed).not.toBe(workflow)
    expect(() => verify(changed, packageCheck)).toThrow()
  }
})

test("disconnected CLI or SDK archives and ignored SDK failures fail the distribution contract", () => {
  for (const change of [
    (text: string) => text.replace("scripts/package-smoke.ts", "scripts/other.ts"),
    (text: string) => text.replace("scripts/sdk-package-smoke.mjs", "scripts/other.mjs"),
    (text: string) => text.replace('"--archive", archive', '"--archive", otherArchive'),
    (text: string) => text.replace('"--archive",\n    archive,', '"--archive",\n    otherArchive,'),
    (text: string) => text.replace("if (exit) throw", "if (false) throw"),
    (text: string) => text.replace("if (sdkFailure !== undefined) throw sdkFailure", ""),
    (text: string) => text.replace('sdk.selection !== "all"', 'sdk.selection !== "selected"'),
    (text: string) => text.replace("sdk.failed !== 0", "sdk.failed < 0"),
  ]) {
    const changed = change(packageCheck)
    expect(changed).not.toBe(packageCheck)
    expect(() => verify(workflow, changed)).toThrow()
  }
})
