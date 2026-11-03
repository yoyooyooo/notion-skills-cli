import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { localContentRestrictedHashes } from "./content-restrictions.ts"
import { prepareGraph } from "./graph-prepare.ts"
import type { PrepareReady } from "./graph-prepare-model.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property, SnapshotSchema, snapshotMembers } from "./model.ts"
import type { Snapshot } from "./model.ts"
import { fileRef, parseRef } from "./ref.ts"
import {
  bindingForSnapshot,
  GRAPH_RELEASE_DEFAULT_BUDGET,
  GraphReleaseBudgetSchema,
  GraphReleaseCompleteSchema,
  GraphReleaseManifestSchema,
  GraphReleasePendingSchema,
  GraphReleasePlanSchema,
  graphChecked,
  graphCompare,
  validateReleaseVector,
  type GraphReleaseBudget,
  type GraphReleaseManifest,
  type GraphReleasePlan,
} from "./shared-graph-release-model.ts"
import {
  assertSharedHistoryIdentity,
  cacheSharedHistoricalSnapshot,
  currentSharedHistorySkill,
  sharedSnapshotFrozenTree,
} from "./shared-history-workflow.ts"
import {
  materializeRetainedSnapshot,
  registerRetainedSnapshot,
} from "./shared-history-materialization.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  appendSharedArchiveRecord,
  canonicalSharedJson,
  querySharedArchiveRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import {
  inspectSharedSnapshotHistory,
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
  restoreSharedSnapshotHistory,
  validateSharedSnapshotHistoryPlan,
} from "./shared-snapshot-history.ts"
import { snapshotInfo, targetSnapshot } from "./snapshot.ts"
import type { ObservedSnapshot } from "./cache.ts"
import { sha256, Store } from "./store.ts"

const operationId = (graphId: string) => `retain-${graphId}`
const localPrefix = (scope: string, graphId: string) =>
  `operations/shared-graph-history/${scope}/${graphId}`
const libraryIdentity = (library: SharedLibrary): GraphReleaseManifest["library"] => ({
  library_id: library.library_id,
  skills_database_id: library.skills.database_id,
  skills_data_source_id: library.skills.data_source_id,
  records_database_id: library.records.database_id,
  records_data_source_id: library.records.data_source_id,
})
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const objectHashes = (
  manifests: readonly {
    readonly files: readonly {
      readonly sha256: string
      readonly chunks: readonly { readonly sha256: string }[]
    }[]
  }[],
) =>
  [
    ...new Set(
      manifests.flatMap((manifest) =>
        manifest.files.flatMap((file) => [
          file.sha256,
          ...file.chunks.map((chunk) => chunk.sha256),
        ]),
      ),
    ),
  ].sort(graphCompare)

function selectedVectors(input: unknown) {
  return Effect.gen(function* () {
    const raw = property(input)
    const inputs = Array.isArray(raw.graphs) ? raw.graphs : [raw.graph_lock ?? input]
    if (inputs.length === 0)
      return yield* Effect.fail(fail("GRAPH_RELEASE_INCOMPLETE", "Choose at least one graph."))
    const graphs = yield* Effect.forEach(inputs, validateReleaseVector)
    const first = graphs[0]
    if (first === undefined)
      return yield* Effect.fail(fail("GRAPH_RELEASE_INCOMPLETE", "Choose at least one graph."))
    const bindings = new Map<string, PrepareReady["graph_lock"]["bindings"][number]>()
    const edges = new Map<string, PrepareReady["graph_lock"]["required"][number]>()
    const roots = new Set<string>()
    yield* graphChecked(() => {
      for (const graph of graphs) {
        if (graph.scope !== first.scope)
          throw fail("GRAPH_RELEASE_SCOPE", "Selected graphs belong to different account scopes.")
        for (const binding of graph.bindings) {
          const previous = bindings.get(binding.record.id)
          if (previous !== undefined && !same(previous, binding))
            throw fail(
              "GRAPH_RELEASE_VERSION_CONFLICT",
              "The selected graphs name different versions of one logical node.",
              { id: binding.record.id },
            )
          bindings.set(binding.record.id, binding)
        }
        for (const root of graph.roots) roots.add(root)
        for (const edge of graph.required) edges.set(canonicalSharedJson(edge), edge)
      }
    })
    const vector = {
      version: 1 as const,
      kind: "observed_version_vector" as const,
      purpose: "use" as const,
      scope: first.scope,
      roots: [...roots].sort(graphCompare),
      required: [...edges.values()].sort(
        (a, b) =>
          graphCompare(a.from, b.from) || graphCompare(a.to, b.to) || graphCompare(a.ref, b.ref),
      ),
      bindings: [...bindings.values()].sort((a, b) => graphCompare(a.record.id, b.record.id)),
    }
    return yield* validateReleaseVector({
      ...vector,
      sha256: yield* sha256(canonicalSharedJson(vector)),
    })
  })
}

function enforceBudget(nodes: readonly Snapshot[], budget: GraphReleaseBudget) {
  const bytes = nodes.reduce(
    (total, node) => total + node.files.reduce((sum, file) => sum + file.bytes, 0),
    0,
  )
  if (nodes.length > budget.maxNodes || !Number.isSafeInteger(bytes) || bytes > budget.maxBytes)
    throw fail("GRAPH_RELEASE_BUDGET", "The explicit graph exceeds its full-file budget.", {
      nodes: nodes.length,
      bytes,
      max_nodes: budget.maxNodes,
      max_bytes: budget.maxBytes,
    })
  return {
    nodes: nodes.length,
    files: nodes.reduce((sum, node) => sum + node.files.length, 0),
    bytes,
  }
}

/** Reads existing immutable local snapshots. Only explicit all_members acquires additional nodes. */
export function prepareGraphRelease(
  input: unknown,
  options: {
    readonly entry: string
    readonly includeMembers?: boolean
    readonly budget?: Partial<GraphReleaseBudget>
  },
) {
  return Effect.gen(function* () {
    const original = yield* selectedVectors(input)
    const scope = yield* authScope
    if (original.scope !== scope)
      return yield* Effect.fail(
        fail("GRAPH_RELEASE_SCOPE", "The selected graph belongs to another authenticated scope."),
      )
    const library = yield* loadSharedLibrary(options.entry)
    const budget = yield* graphChecked(() =>
      Schema.decodeUnknownSync(GraphReleaseBudgetSchema)({
        ...GRAPH_RELEASE_DEFAULT_BUDGET,
        ...options.budget,
      }),
    )
    if (!Object.values(budget).every(Number.isSafeInteger))
      return yield* Effect.fail(
        fail("GRAPH_RELEASE_BUDGET", "Graph budgets must be safe integers."),
      )
    const rootRefs = original.bindings
      .filter((binding) => original.roots.includes(binding.record.id))
      .map((binding) => binding.ref)
    let prepared = yield* prepareGraph(
      { roots: rootRefs, purpose: "use", sessionBindings: original.bindings, budget },
      { database: options.entry },
    )
    if (!same(prepared.graph_lock, original))
      return yield* Effect.fail(
        fail(
          "GRAPH_RELEASE_CONFLICT",
          "The input vector differs from its verified frozen snapshots.",
        ),
      )
    let rounds = 0
    if (options.includeMembers === true) {
      for (;;) {
        const selected = new Set(prepared.graph_lock.bindings.map((binding) => binding.record.id))
        const additional = new Map<string, string>()
        for (const node of prepared.nodes) {
          if (node.state !== "prepared") continue
          for (const candidate of node.candidates) {
            if (selected.has(candidate.id)) continue
            if (candidate.kind !== "skill" || candidate.availability !== "available")
              return yield* Effect.fail(
                fail(
                  "GRAPH_RELEASE_OPTIONAL_UNAVAILABLE",
                  "An explicitly requested Member is unavailable.",
                  {
                    id: candidate.id,
                    availability: candidate.availability,
                  },
                ),
              )
            additional.set(candidate.id, candidate.ref)
          }
        }
        if (additional.size === 0) break
        rounds++
        if (rounds > budget.maxDepth || selected.size + additional.size > budget.maxNodes)
          return yield* Effect.fail(
            fail(
              "GRAPH_RELEASE_BUDGET",
              "The explicit Members expansion exceeds its graph budget.",
              {
                nodes: selected.size + additional.size,
                member_depth: rounds,
                max_nodes: budget.maxNodes,
                max_depth: budget.maxDepth,
              },
            ),
          )
        rootRefs.push(...additional.values())
        prepared = yield* prepareGraph(
          {
            roots: rootRefs,
            purpose: "use",
            sessionBindings: prepared.graph_lock.bindings,
            budget,
          },
          { database: options.entry },
        )
        for (const id of additional.keys())
          if (!prepared.graph_lock.bindings.some((binding) => binding.record.id === id))
            return yield* Effect.fail(
              fail("GRAPH_RELEASE_CONFLICT", "A Member resolved to a different stable identity.", {
                id,
              }),
            )
      }
    }
    const store = yield* Store
    const nodes: GraphReleasePlan["nodes"][number][] = []
    for (const binding of prepared.graph_lock.bindings) {
      const saved = yield* store.readJson(`snapshots/${binding.snapshot_id}.json`, SnapshotSchema)
      const observedSnapshot =
        saved ?? (yield* targetSnapshot(parseRef(binding.ref), { database: options.entry }))
      const snapshot = yield* graphChecked(() =>
        Schema.decodeUnknownSync(SnapshotSchema)(observedSnapshot),
      )
      const observed = yield* graphChecked(() => bindingForSnapshot(snapshot))
      if (!same(observed, binding))
        return yield* Effect.fail(
          fail("GRAPH_RELEASE_CONFLICT", "A selected immutable snapshot is missing or changed.", {
            snapshot_id: binding.snapshot_id,
          }),
        )
      nodes.push({ snapshot, history: yield* prepareSharedSnapshotHistory(library, snapshot) })
      yield* graphChecked(() =>
        enforceBudget(
          nodes.map((node) => node.snapshot),
          budget,
        ),
      )
    }
    const manifest: GraphReleaseManifest = {
      version: 1,
      kind: "graph_release",
      library: libraryIdentity(library),
      selection: {
        mode: options.includeMembers ? "all_members" : "selected",
        initial_roots: original.roots,
        optional_node_ids: prepared.graph_lock.roots.filter((id) => !original.roots.includes(id)),
        references: "metadata_only_unless_explicitly_selected",
      },
      graph: prepared.graph_lock,
      pins: nodes.map((node) => ({ id: node.snapshot.record.id, pin_id: node.history.pin_id })),
    }
    const plan: GraphReleasePlan = {
      version: 1,
      kind: "graph_release_plan",
      graph_id: `graph-${yield* sha256(canonicalSharedJson(manifest))}`,
      manifest,
      budget,
      nodes,
    }
    return yield* validateGraphReleasePlan(library, plan)
  })
}

function validateManifest(library: SharedLibrary, input: unknown, graphId: string) {
  return Effect.gen(function* () {
    const manifest = yield* graphChecked(() =>
      Schema.decodeUnknownSync(GraphReleaseManifestSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    if (
      !/^graph-[a-f0-9]{64}$/u.test(graphId) ||
      graphId !== `graph-${yield* sha256(canonicalSharedJson(manifest))}`
    )
      return yield* Effect.fail(
        fail("GRAPH_RELEASE_INVALID", "The release manifest checksum differs."),
      )
    if (!same(manifest.library, libraryIdentity(library)))
      return yield* Effect.fail(
        fail(
          "GRAPH_RELEASE_SCOPE",
          "The release belongs to another registered library or Records table.",
        ),
      )
    yield* validateReleaseVector(manifest.graph)
    yield* graphChecked(() => {
      validateSharedRecordEnvelope(operationId(graphId), manifest)
      const ids = manifest.graph.bindings.map((binding) => binding.record.id)
      if (
        !same(
          manifest.pins.map((pin) => pin.id),
          ids,
        )
      )
        throw fail(
          "GRAPH_RELEASE_INCOMPLETE",
          "The release does not retain every selected node exactly once.",
        )
      const initial = manifest.selection.initial_roots
      const optional = manifest.selection.optional_node_ids
      if (
        initial.length === 0 ||
        !same(initial, [...new Set(initial)].sort(graphCompare)) ||
        !same(optional, [...new Set(optional)].sort(graphCompare)) ||
        initial.some((id) => optional.includes(id)) ||
        !same([...initial, ...optional].sort(graphCompare), manifest.graph.roots) ||
        (manifest.selection.mode === "selected" && optional.length !== 0)
      )
        throw fail("GRAPH_RELEASE_INVALID", "The release optional selection is ambiguous.")
      for (const binding of manifest.graph.bindings) {
        const locator = binding.record.locator
        if (
          locator.type !== "shared_skill" ||
          locator.library_id !== library.library_id ||
          locator.database_id !== library.skills.database_id ||
          locator.data_source_id !== library.skills.data_source_id
        )
          throw fail(
            "GRAPH_RELEASE_SCOPE",
            "Every release node must belong to this exact shared library.",
          )
      }
    })
    return manifest
  })
}

export function validateGraphReleasePlan(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* graphChecked(() =>
      Schema.decodeUnknownSync(GraphReleasePlanSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    const manifest = yield* validateManifest(library, plan.manifest, plan.graph_id)
    if (
      !same(
        plan.nodes.map((node) => node.snapshot.record.id),
        manifest.pins.map((pin) => pin.id),
      )
    )
      return yield* Effect.fail(
        fail("GRAPH_RELEASE_INCOMPLETE", "The plan has missing, extra or repeated node histories."),
      )
    for (const [index, node] of plan.nodes.entries()) {
      const history = yield* validateSharedSnapshotHistoryPlan(library, node.history)
      const observed = yield* graphChecked(() => bindingForSnapshot(node.snapshot))
      const binding = manifest.graph.bindings[index]
      const pin = manifest.pins[index]
      if (
        binding === undefined ||
        pin === undefined ||
        history.pin_id !== pin.pin_id ||
        !same(observed, binding) ||
        sharedSnapshotFrozenTree(node.snapshot) !== sharedSnapshotFrozenTree(history.manifest)
      )
        return yield* Effect.fail(
          fail("GRAPH_RELEASE_CONFLICT", "A node history differs from the exact frozen vector."),
        )
      if (manifest.selection.mode === "all_members")
        for (const member of snapshotMembers(node.snapshot) ?? [])
          if (!manifest.pins.some((candidate) => candidate.id === member.id))
            return yield* Effect.fail(
              fail(
                "GRAPH_RELEASE_INCOMPLETE",
                "The explicit all-Members release omits a frozen Member.",
                { id: member.id },
              ),
            )
    }
    const expectedEdges = plan.nodes
      .flatMap((node) =>
        (node.snapshot.required ?? []).map((edge) => ({
          from: node.snapshot.record.id,
          to: edge.id,
          ref: edge.ref,
        })),
      )
      .sort(
        (a, b) =>
          graphCompare(a.from, b.from) || graphCompare(a.to, b.to) || graphCompare(a.ref, b.ref),
      )
    if (!same(expectedEdges, manifest.graph.required))
      return yield* Effect.fail(
        fail(
          "GRAPH_RELEASE_INCOMPLETE",
          "The vector differs from the exact frozen Requires relations.",
        ),
      )
    yield* graphChecked(() => {
      for (const edge of expectedEdges) {
        const target = manifest.graph.bindings.find((binding) => binding.record.id === edge.to)
        if (target === undefined)
          throw fail("GRAPH_RELEASE_INCOMPLETE", "A required target is missing.")
        const ref = parseRef(edge.ref)
        const locator = target.record.locator
        if (
          locator.type !== "shared_skill" ||
          ![target.record.id, locator.page_id].includes(ref.selector) ||
          ref.path !== target.record.entrypoint ||
          (ref.snapshot !== undefined && ref.snapshot !== target.snapshot_id)
        )
          throw fail(
            "GRAPH_RELEASE_CONFLICT",
            "A required link names another frozen node or version.",
          )
      }
      enforceBudget(
        plan.nodes.map((node) => node.snapshot),
        plan.budget,
      )
    })
    return plan
  })
}

function verifyCurrentAccess(library: SharedLibrary, manifest: GraphReleaseManifest) {
  return Effect.forEach(manifest.graph.bindings, (binding) =>
    Effect.gen(function* () {
      const locator = binding.record.locator
      if (locator.type !== "shared_skill")
        return yield* Effect.fail(
          fail("GRAPH_RELEASE_SCOPE", "A release node is not a shared Skill."),
        )
      const current = yield* currentSharedHistorySkill(library, locator.page_id)
      yield* graphChecked(() => assertSharedHistoryIdentity(current, binding.record))
    }),
  )
}

function retainedManifest(library: SharedLibrary, graphId: string) {
  return Effect.gen(function* () {
    const rows = yield* querySharedArchiveRecords(library, { entityId: graphId, recordId: graphId })
    const row = rows[0]
    if (rows.length === 0)
      return yield* Effect.fail(
        fail(
          "GRAPH_RELEASE_UNRESOLVED",
          "The exact graph manifest has not been observed; current content cannot replace it.",
          {
            graph_id: graphId,
            next_mode: "reconcile",
          },
        ),
      )
    if (
      rows.length !== 1 ||
      row?.record_id !== graphId ||
      row.operation_id !== operationId(graphId)
    )
      return yield* Effect.fail(
        fail("GRAPH_RELEASE_CONFLICT", "The graph manifest has conflicting immutable records."),
      )
    return yield* validateManifest(library, row.payload, graphId)
  })
}

/** A pre-dispatch plan fences the whole publication. Any retry of it only observes the original result. */
export function saveGraphRelease(
  input: unknown,
  options: {
    readonly entry: string
    readonly reconcile?: boolean
    readonly allowLocalArchive?: boolean
  },
) {
  return Effect.gen(function* () {
    const library = yield* loadSharedLibrary(options.entry)
    const plan = yield* validateGraphReleasePlan(library, property(input).plan ?? input)
    const scope = yield* authScope
    if (scope !== plan.manifest.graph.scope)
      return yield* Effect.fail(
        fail(
          "GRAPH_RELEASE_SCOPE",
          "The original graph plan belongs to another authenticated scope.",
        ),
      )
    yield* verifyCurrentAccess(library, plan.manifest)
    const store = yield* Store
    const prefix = localPrefix(scope, plan.graph_id)
    return yield* withLocalLocks(
      store.root,
      [prefix],
      Effect.gen(function* () {
        const pending = yield* store.readJson(`${prefix}/plan.json`, GraphReleasePendingSchema)
        const complete = yield* store.readJson(
          `${prefix}/complete.json`,
          GraphReleaseCompleteSchema,
        )
        if (pending !== undefined && (pending.scope !== scope || !same(pending.plan, plan)))
          return yield* Effect.fail(
            fail("GRAPH_RELEASE_CONFLICT", "The original graph operation cannot be replaced."),
          )
        if (
          complete !== undefined &&
          (complete.scope !== scope ||
            complete.graph_id !== plan.graph_id ||
            !same(complete.manifest, plan.manifest))
        )
          return yield* Effect.fail(
            fail(
              "GRAPH_RELEASE_CONFLICT",
              "The retained local graph receipt differs from this plan.",
            ),
          )
        const existing = yield* retainedManifest(library, plan.graph_id).pipe(Effect.result)
        if (existing._tag === "Success") {
          if (!same(existing.success, plan.manifest))
            return yield* Effect.fail(
              fail("GRAPH_RELEASE_CONFLICT", "The original remote graph differs from this plan."),
            )
          yield* store.writeJson(`${prefix}/complete.json`, {
            version: 1,
            kind: "graph_release_retained",
            scope,
            graph_id: plan.graph_id,
            manifest: plan.manifest,
            local_snapshot_ids: plan.nodes.map((node) => node.snapshot.snapshot_id),
            object_sha256s: objectHashes(plan.nodes.map((node) => node.history.manifest)),
          })
          if (pending !== undefined) yield* store.retireKeys([`${prefix}/plan.json`])
          return {
            graph_id: plan.graph_id,
            manifest: plan.manifest,
            verification: "manifest" as const,
            mode: "reconcile" as const,
          }
        }
        if (existing.failure.code !== "GRAPH_RELEASE_UNRESOLVED")
          return yield* Effect.fail(existing.failure)
        if (pending !== undefined || complete !== undefined || options.reconcile === true)
          return yield* Effect.fail(existing.failure)
        for (const node of plan.nodes) {
          const saved = yield* store.readJson(
            `snapshots/${node.snapshot.snapshot_id}.json`,
            SnapshotSchema,
          )
          if (saved === undefined || !same(saved, node.snapshot))
            return yield* Effect.fail(
              fail(
                "GRAPH_RELEASE_CONFLICT",
                "The original local snapshot preimage is unavailable or differs.",
              ),
            )
        }
        const restricted = new Set(
          yield* localContentRestrictedHashes(
            plan.nodes.flatMap((node) => node.snapshot.files.map((file) => file.sha256)),
          ),
        )
        if (restricted.size && options.allowLocalArchive !== true)
          return yield* Effect.fail(
            fail(
              "LOCAL_RESOURCE_ARCHIVE_REQUIRED",
              "This exact graph includes local resource bytes; explicitly authorize their retention.",
              {
                graph_id: plan.graph_id,
                paths: plan.nodes.flatMap((node) =>
                  node.snapshot.files
                    .filter((file) => restricted.has(file.sha256))
                    .map((file) => ({ id: node.snapshot.record.id, path: file.path })),
                ),
              },
            ),
          )
        yield* store.writeJson(`${prefix}/plan.json`, {
          version: 1,
          kind: "graph_release_dispatched",
          scope,
          plan,
        })
        for (const node of plan.nodes) {
          const retained = yield* retainSharedSnapshotHistory(library, {
            plan: node.history,
            mode: "create",
          })
          if (retained.verification === "manifest") {
            // A prior manifest is not proof that its byte objects remain available.
            yield* restoreSharedSnapshotHistory(library, {
              skillPageId: node.history.manifest.skill_page_id,
              pinId: node.history.pin_id,
            })
          }
        }
        yield* appendSharedArchiveRecord(library, {
          mode: "create",
          recordId: plan.graph_id,
          operationId: operationId(plan.graph_id),
          entityId: plan.graph_id,
          payload: plan.manifest,
        })
        yield* store.writeJson(`${prefix}/complete.json`, {
          version: 1,
          kind: "graph_release_retained",
          scope,
          graph_id: plan.graph_id,
          manifest: plan.manifest,
          local_snapshot_ids: plan.nodes.map((node) => node.snapshot.snapshot_id),
          object_sha256s: objectHashes(plan.nodes.map((node) => node.history.manifest)),
        })
        yield* store.retireKeys([`${prefix}/plan.json`])
        return {
          graph_id: plan.graph_id,
          manifest: plan.manifest,
          verification: "objects_and_manifest" as const,
          mode: "create" as const,
        }
      }),
    ).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          graph_id: plan.graph_id,
          operation_id: operationId(plan.graph_id),
          next_mode: "reconcile",
        }),
      ),
    )
  })
}

/** Load the complete immutable graph and every node manifest, without requesting any byte objects. */
export function inspectGraphRelease(graphId: string, options: { readonly entry: string }) {
  return Effect.gen(function* () {
    if (!/^graph-[a-f0-9]{64}$/u.test(graphId))
      return yield* Effect.fail(
        fail("GRAPH_RELEASE_INVALID", "Select one complete graph release identity."),
      )
    const scope = yield* authScope
    const library = yield* loadSharedLibrary(options.entry)
    const manifest = yield* retainedManifest(library, graphId)
    yield* verifyCurrentAccess(library, manifest)
    const nodes = yield* Effect.forEach(manifest.pins, (pin) =>
      Effect.gen(function* () {
        const binding = manifest.graph.bindings.find((binding) => binding.record.id === pin.id)
        if (binding === undefined || binding.record.locator.type !== "shared_skill")
          return yield* Effect.fail(
            fail("GRAPH_RELEASE_INCOMPLETE", "A retained graph node has no exact binding."),
          )
        const history = yield* inspectSharedSnapshotHistory(library, {
          skillPageId: binding.record.locator.page_id,
          pinId: pin.pin_id,
        })
        const main = history.manifest.files.find(
          (file) => file.path === history.manifest.entrypoint,
        )
        if (
          !same(history.manifest.record, binding.record) ||
          history.manifest.version_id !== binding.version_id ||
          main?.sha256 !== binding.body_sha256 ||
          binding.ref !==
            fileRef(
              binding.record.id,
              history.manifest.entrypoint,
              binding.snapshot_id,
              history.manifest.file_bindings?.find(
                (file) => file.path === history.manifest.entrypoint,
              )?.file_id,
            )
        )
          return yield* Effect.fail(
            fail(
              "GRAPH_RELEASE_CONFLICT",
              "A retained node differs from the fixed graph version vector.",
            ),
          )
        return { id: pin.id, pin_id: pin.pin_id, binding, manifest: history.manifest }
      }),
    )
    const edges = nodes
      .flatMap((node) =>
        (node.manifest.required ?? []).map((edge) => ({
          from: node.id,
          to: edge.id,
          ref: edge.ref,
        })),
      )
      .sort(
        (a, b) =>
          graphCompare(a.from, b.from) || graphCompare(a.to, b.to) || graphCompare(a.ref, b.ref),
      )
    if (!same(edges, manifest.graph.required))
      return yield* Effect.fail(
        fail(
          "GRAPH_RELEASE_INCOMPLETE",
          "The retained graph does not contain its exact Required closure.",
        ),
      )
    if (manifest.selection.mode === "all_members")
      for (const node of nodes)
        for (const member of snapshotMembers(node.manifest) ?? [])
          if (!nodes.some((target) => target.id === member.id))
            return yield* Effect.fail(
              fail("GRAPH_RELEASE_INCOMPLETE", "The retained all-Members selection is incomplete."),
            )
    return {
      graph_id: graphId,
      scope,
      library,
      manifest,
      nodes,
      manifest_complete: true as const,
      materialization: "not_requested" as const,
    }
  })
}

/** Current metadata validates access only. Exact retained objects are the only content source. */
export function restoreGraphRelease(
  graphId: string,
  options: {
    readonly entry: string
    readonly materialize?: "manifest" | "entrypoints" | "all"
  },
) {
  return Effect.gen(function* () {
    const mode = options.materialize ?? "all"
    if (!["manifest", "entrypoints", "all"].includes(mode))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Materialization must be manifest, entrypoints or all."),
      )
    const inspected = yield* inspectGraphRelease(graphId, options)
    if (
      inspected.scope !== inspected.manifest.graph.scope &&
      inspected.manifest.graph.required.some((edge) => parseRef(edge.ref).snapshot !== undefined)
    )
      return yield* Effect.fail(
        fail(
          "GRAPH_RELEASE_SCOPE_REBIND_UNAVAILABLE",
          "A Required relation contains an explicit producer-scope pin; its authored identity cannot be silently rebound to another account scope.",
        ),
      )
    const snapshots: ObservedSnapshot[] = []
    for (const node of inspected.nodes) {
      const retained = yield* registerRetainedSnapshot(
        inspected.scope,
        inspected.library,
        node.pin_id,
        node.manifest,
      )
      if (mode === "all") {
        const restored = yield* restoreSharedSnapshotHistory(inspected.library, {
          skillPageId: node.manifest.skill_page_id,
          pinId: node.pin_id,
        })
        if (!same(restored.manifest, node.manifest))
          return yield* Effect.fail(
            fail("GRAPH_RELEASE_CONFLICT", "A retained manifest changed during restoration."),
          )
        snapshots.push({
          ...(yield* cacheSharedHistoricalSnapshot(inspected.scope, restored)),
          source: "local_snapshot",
          freshness: { policy: "pinned" },
          materialization: {
            manifest_complete: true,
            local_files_ready: true,
            materialized_paths: node.manifest.files.map((file) => file.path),
            loaded: false,
          },
        })
      } else
        snapshots.push(
          yield* materializeRetainedSnapshot(
            retained,
            mode === "entrypoints" ? [node.manifest.entrypoint] : [],
          ),
        )
    }
    const vector = {
      ...inspected.manifest.graph,
      scope: inspected.scope,
      bindings: snapshots.map(bindingForSnapshot),
    }
    const { sha256: _originHash, ...value } = vector
    const graph = yield* validateReleaseVector({
      ...value,
      sha256: yield* sha256(canonicalSharedJson(value)),
    })
    const store = yield* Store
    yield* store.writeJson(`${localPrefix(inspected.scope, graphId)}/complete.json`, {
      version: 1,
      kind: "graph_release_retained",
      scope: inspected.scope,
      graph_id: graphId,
      manifest: inspected.manifest,
      local_snapshot_ids: snapshots.map((snapshot) => snapshot.snapshot_id),
      object_sha256s: objectHashes(inspected.nodes.map((node) => node.manifest)),
    })
    return {
      graph_id: graphId,
      origin_graph: inspected.manifest.graph,
      graph_lock: graph,
      manifest_complete: true,
      materialization: mode === "all" ? "complete" : mode,
      local_files_ready: snapshots.every(
        (snapshot) => snapshot.materialization?.local_files_ready === true,
      ),
      loaded: false,
      nodes: snapshots.map((snapshot) =>
        snapshotInfo({ ...snapshot, source: "local_snapshot", freshness: { policy: "pinned" } }),
      ),
    }
  })
}
