import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { prepareGraph } from "../packages/core/src/graph-prepare.ts"
import { nativeGraphFixture } from "../packages/core/test/graph-prepare-live-fixture.ts"
import { library } from "../packages/core/test/shared-snapshot-fixture.ts"

const directory = process.env.NTN_NG16_EVIDENCE_DIR
const phase = process.env.NTN_NG16_PHASE
if (!directory || (phase !== "baseline" && phase !== "optimized"))
  throw new Error(
    "Set NTN_NG16_EVIDENCE_DIR and NTN_NG16_PHASE=baseline|optimized before measuring.",
  )
const sampleCount = 3
const budget = { maxNodes: 128, maxContextBytes: 8 * 1024 * 1024 }
type Fixture = ReturnType<typeof nativeGraphFixture>

function counts(calls: Fixture["calls"]) {
  const endpoint = (path: string) => path.split("?", 1)[0]
  return {
    total: calls.length,
    skills_inventory: calls.filter(
      (call) => endpoint(call.path) === `v1/data_sources/${library.skills.data_source_id}/query`,
    ).length,
    files_queries: calls.filter(
      (call) => endpoint(call.path) === `v1/data_sources/${library.files.data_source_id}/query`,
    ).length,
    records_queries: calls.filter(
      (call) => endpoint(call.path) === `v1/data_sources/${library.records.data_source_id}/query`,
    ).length,
    relation_pages: calls.filter((call) => /\/properties\//u.test(call.path)).length,
    current_body: calls.filter((call) => /\/markdown$/u.test(endpoint(call.path) ?? "")).length,
    writes: calls.filter(
      (call) => call.method !== "GET" && !/\/query$/u.test(endpoint(call.path) ?? ""),
    ).length,
  }
}

const results: unknown[] = []
for (const topology of ["diamond", "wide-101"] as const) {
  for (let sample = 0; sample < sampleCount; sample++) {
    const f = nativeGraphFixture(topology === "diamond" ? {} : { width: 100 })
    const roots = topology === "diamond" ? [f.pageIds[0]!, f.pageIds[2]!] : [f.pageIds[0]!]
    const input = { roots, purpose: "use" as const, budget }
    await f.run(prepareGraph(input, { database: library.skills.database_id }))
    f.json.clear()
    f.objects.clear()
    for (const condition of ["cold", "warm", "metadata_revalidate"] as const) {
      f.clearCalls()
      const start = performance.now()
      const result = await f.run(
        prepareGraph(
          {
            ...input,
            ...(condition === "metadata_revalidate"
              ? { freshness: { policy: "max_age" as const, max_age_ms: 1 } }
              : {}),
          },
          { database: library.skills.database_id, metrics: phase === "optimized" },
        ),
      )
      const elapsed = performance.now() - start
      const expected = topology === "diamond" ? 4 : 101
      if (result.status !== "ready" || result.usage.prepared_nodes !== expected)
        throw new Error("The frozen measurement topology did not prepare its complete closure.")
      const observed = counts(f.calls)
      if (observed.writes !== 0)
        throw new Error("Measured read-only graph unexpectedly wrote new facts.")
      results.push({
        topology,
        sample,
        condition,
        elapsed_ms: elapsed,
        counts: observed,
        preparation_metrics: result.preparation_metrics,
        graph_lock: result.graph_lock,
        calls: [...f.calls],
      })
    }
  }
}
await mkdir(directory, { recursive: true })
const path = join(directory, `${phase}.json`)
const report = {
  version: 1,
  evidence_kind: "controlled_effect_service",
  phase,
  sample_count_per_case: sampleCount,
  budget,
  percentile_claim: null,
  notes: [
    "These are controlled service counts and local execution timings, not real network latency or physical-machine evidence.",
    "Remote immutable observations are seeded before measurement; each cold sample has empty local JSON/object caches.",
    "Warm uses the normal TTL; metadata_revalidate uses a one-millisecond read max age within the existing full-body validity window.",
    "Real HTTP attempt byte categories, queues, retries and Pro/Mini timing remain separate evidence.",
  ],
  results,
}
await writeFile(path, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify({ path, sample_count_per_case: sampleCount, cases: results.length }))
