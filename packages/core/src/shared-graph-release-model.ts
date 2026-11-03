import { Effect, Schema } from "effect"
import { PrepareGraphLockSchema, type PrepareBinding } from "./graph-prepare-model.ts"
import { fail, SkillsError, SnapshotSchema, type Snapshot } from "./model.ts"
import { fileRef, parseRef } from "./ref.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { SharedSnapshotHistoryPlanSchema } from "./shared-snapshot-history.ts"
import { sha256 } from "./store.ts"

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
export const GraphReleaseBudgetSchema = Schema.Struct({
  maxNodes: Positive,
  maxDepth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  maxBytes: Positive,
  maxInstructionBytes: Positive,
  maxContextBytes: Positive,
})
export type GraphReleaseBudget = typeof GraphReleaseBudgetSchema.Type
export const GRAPH_RELEASE_DEFAULT_BUDGET: GraphReleaseBudget = {
  maxNodes: 64,
  maxDepth: 16,
  maxBytes: 128 * 1024 * 1024,
  maxInstructionBytes: 1024 * 1024,
  maxContextBytes: 1024 * 1024,
}
export const GraphReleaseManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("graph_release"),
  library: Schema.Struct({
    library_id: Schema.String,
    skills_database_id: Schema.String,
    skills_data_source_id: Schema.String,
    records_database_id: Schema.String,
    records_data_source_id: Schema.String,
  }),
  selection: Schema.Struct({
    mode: Schema.Literals(["selected", "all_members"]),
    initial_roots: Schema.Array(Schema.String),
    optional_node_ids: Schema.Array(Schema.String),
    references: Schema.Literal("metadata_only_unless_explicitly_selected"),
  }),
  graph: PrepareGraphLockSchema,
  pins: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      pin_id: Schema.String.check(Schema.isPattern(/^snapshot-[a-f0-9]{64}$/u)),
    }),
  ),
})
export type GraphReleaseManifest = typeof GraphReleaseManifestSchema.Type
export const GraphReleasePlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("graph_release_plan"),
  graph_id: Schema.String.check(Schema.isPattern(/^graph-[a-f0-9]{64}$/u)),
  manifest: GraphReleaseManifestSchema,
  budget: GraphReleaseBudgetSchema,
  nodes: Schema.Array(
    Schema.Struct({ snapshot: SnapshotSchema, history: SharedSnapshotHistoryPlanSchema }),
  ),
})
export type GraphReleasePlan = typeof GraphReleasePlanSchema.Type
export const GraphReleasePendingSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("graph_release_dispatched"),
  scope: Sha,
  plan: GraphReleasePlanSchema,
})
export const GraphReleaseCompleteSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("graph_release_retained"),
  scope: Sha,
  graph_id: Schema.String,
  manifest: GraphReleaseManifestSchema,
  local_snapshot_ids: Schema.Array(Schema.String),
  object_sha256s: Schema.Array(Sha),
})

export const graphCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export const graphChecked = <A>(run: () => A): Effect.Effect<A, SkillsError> =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("GRAPH_RELEASE_INVALID", "The complete fixed graph is invalid."),
  })

export function bindingForSnapshot(snapshot: Snapshot): PrepareBinding {
  const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
  if (main === undefined)
    throw fail("GRAPH_RELEASE_INVALID", "A selected graph node has no complete main file.")
  return {
    record: snapshot.record,
    scope: snapshot.scope,
    snapshot_id: snapshot.snapshot_id,
    version_id: snapshot.version_id,
    body_sha256: main.sha256,
    ref: fileRef(
      snapshot.record.id,
      snapshot.entrypoint,
      snapshot.snapshot_id,
      snapshot.file_bindings?.find((file) => file.path === snapshot.entrypoint)?.file_id,
    ),
  }
}

/** Validate the public prepare contract without treating a digest as proof of its contents. */
export function validateReleaseVector(input: unknown) {
  return Effect.gen(function* () {
    const graph = yield* graphChecked(() =>
      Schema.decodeUnknownSync(PrepareGraphLockSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    const { sha256: digest, ...vector } = graph
    if (digest !== (yield* sha256(canonicalSharedJson(vector))))
      return yield* Effect.fail(
        fail("GRAPH_RELEASE_INVALID", "The observed version vector checksum is invalid."),
      )
    for (const binding of graph.bindings)
      if (
        binding.snapshot_id !==
        `s_${yield* sha256(JSON.stringify([binding.scope, binding.record.id, binding.version_id]))}`
      )
        return yield* Effect.fail(
          fail(
            "GRAPH_RELEASE_INVALID",
            "A frozen node pin does not match its scope, logical identity and version.",
          ),
        )
    yield* graphChecked(() => {
      if (graph.purpose !== "use" || graph.roots.length === 0 || graph.bindings.length === 0)
        throw fail(
          "GRAPH_RELEASE_INCOMPLETE",
          "Freeze a successful use preparation with its complete selected Required closure.",
        )
      const ids = graph.bindings.map((binding) => binding.record.id)
      if (
        new Set(ids).size !== ids.length ||
        canonicalSharedJson(ids) !== canonicalSharedJson([...ids].sort(graphCompare)) ||
        canonicalSharedJson(graph.roots) !==
          canonicalSharedJson([...new Set(graph.roots)].sort(graphCompare)) ||
        graph.roots.some((id) => !ids.includes(id)) ||
        graph.bindings.some((binding) => binding.scope !== graph.scope)
      )
        throw fail(
          "GRAPH_RELEASE_INVALID",
          "Graph identities, scope or deterministic order differ.",
        )
      const edges = new Set<string>()
      const ordered = [...graph.required].sort(
        (a, b) =>
          graphCompare(a.from, b.from) || graphCompare(a.to, b.to) || graphCompare(a.ref, b.ref),
      )
      if (canonicalSharedJson(ordered) !== canonicalSharedJson(graph.required))
        throw fail("GRAPH_RELEASE_INVALID", "Required edges must use deterministic order.")
      for (const binding of graph.bindings) {
        const ref = parseRef(binding.ref)
        if (
          ref.selector !== binding.record.id ||
          ref.snapshot !== binding.snapshot_id ||
          ref.path !== binding.record.entrypoint
        )
          throw fail(
            "GRAPH_RELEASE_INVALID",
            "A frozen main reference differs from its exact binding.",
          )
      }
      for (const edge of graph.required) {
        const key = canonicalSharedJson(edge)
        if (!ids.includes(edge.from) || !ids.includes(edge.to) || edges.has(key))
          throw fail("GRAPH_RELEASE_INCOMPLETE", "A Required edge has no unique frozen node.")
        edges.add(key)
        const target = graph.bindings.find((binding) => binding.record.id === edge.to)
        const ref = parseRef(edge.ref)
        if (
          target === undefined ||
          (ref.selector !== target.record.id &&
            !(
              target.record.locator.type === "shared_skill" &&
              ref.selector === target.record.locator.page_id
            )) ||
          ref.path !== target.record.entrypoint ||
          (ref.snapshot !== undefined && ref.snapshot !== target.snapshot_id)
        )
          throw fail(
            "GRAPH_RELEASE_CONFLICT",
            "A Required link differs from its exact frozen target.",
          )
      }
      const visited = new Set<string>()
      const visit = (id: string, stack: readonly string[]) => {
        if (stack.includes(id))
          throw fail("GRAPH_RELEASE_CYCLE", "The selected Required graph contains a cycle.", {
            path: [...stack, id],
          })
        if (visited.has(id)) return
        for (const edge of graph.required.filter((edge) => edge.from === id))
          visit(edge.to, [...stack, id])
        visited.add(id)
      }
      for (const root of graph.roots) visit(root, [])
      if (visited.size !== ids.length)
        throw fail(
          "GRAPH_RELEASE_INCOMPLETE",
          "Every frozen node must be an explicit root or reachable through Requires.",
        )
    })
    return graph
  })
}
