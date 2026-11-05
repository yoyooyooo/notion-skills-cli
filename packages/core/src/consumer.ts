import { Cause, Effect, Option, Schema } from "effect"
import { prepareGraphWithSnapshots } from "./graph-prepare.ts"
import { type PreparedNode } from "./graph-prepare-model.ts"
import { aliasFor, entrypointFor, fail, SkillsError } from "./model.ts"
import { fileRef, normalizePath, pageId, parseRef, parseTarget } from "./ref.ts"
import { validateSharedRecordIdentity } from "./shared-content.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import {
  CONSUMER_CONTRACT_VERSION,
  SOURCE_IDENTITY_COMPILER,
  ConsumeInputSchema,
  ConsumeResultSchema,
  type ConsumeInput,
  type ConsumeEntry,
  type ConsumeReady,
  type ConsumeResult,
  type VerifiedManifest,
} from "./consumer-model.ts"

export * from "./consumer-model.ts"

const invalid = () => fail("CONSUME_INVALID_PROOF", "Consumption evidence is inconsistent.")
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const sorted = (values: readonly string[]) => [...values].sort()
const relations = (node: PreparedNode) => ({
  required: node.required,
  candidates: node.candidates,
  references: node.references,
  unresolved_references: node.unresolved_references,
})

function validateSelection(targetText: string, node: PreparedNode) {
  const target = parseTarget(targetText)
  const record = node.record
  const locator = record.locator
  const physical = pageId(target.selector)
  const selected =
    target.selector === record.id ||
    (physical !== undefined &&
      (locator.type === "shared_skill" || locator.type === "notion_page") &&
      locator.page_id === physical) ||
    (locator.type === "notion_subscription" &&
      target.selector === `upstream:${locator.subscription_id}`) ||
    (target.snapshot !== undefined && ["", record.name, record.alias].includes(target.selector))
  if (
    !selected ||
    (target.snapshot !== undefined && target.snapshot !== node.binding.snapshot_id) ||
    (target.file_id === undefined && target.path && target.path !== node.path) ||
    (target.file_id !== undefined && target.file_id !== parseRef(node.ref).file_id)
  )
    throw invalid()
}

function validateManifest(entry: ConsumeEntry, node: PreparedNode, scope: string) {
  const manifest = entry.manifest
  const record = manifest.record
  const locator = record.locator
  if (
    entry.id !== node.id ||
    record.id !== node.id ||
    record.enabled === false ||
    !same(record, node.record) ||
    !same(record, node.binding.record) ||
    record.kind !== node.kind ||
    record.entrypoint !== entrypointFor(record.kind) ||
    record.ref !== fileRef(record.id, record.entrypoint) ||
    record.alias !== aliasFor(record.name) ||
    manifest.scope !== scope ||
    node.binding.scope !== scope ||
    manifest.snapshot_id !== node.binding.snapshot_id ||
    manifest.version_id !== node.binding.version_id ||
    manifest.entrypoint !== record.entrypoint ||
    node.path !== record.entrypoint ||
    node.ref !== node.binding.ref ||
    node.body_sha256 !== node.binding.body_sha256
  )
    throw invalid()
  validateSharedRecordIdentity(record)
  if (
    locator.type === "shared_skill" &&
    (pageId(locator.page_id) !== locator.page_id ||
      pageId(locator.database_id) !== locator.database_id ||
      pageId(locator.data_source_id) !== locator.data_source_id)
  )
    throw invalid()
  if (locator.type === "notion_page" && record.id !== `notion_page:${locator.page_id}`)
    throw invalid()
  if (
    locator.type === "notion_subscription" &&
    record.id !== `notion_subscription:${locator.subscription_id}`
  )
    throw invalid()
  const paths = new Set<string>()
  for (const file of manifest.files) {
    if (
      !file.path ||
      normalizePath(file.path) !== file.path ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw invalid()
    paths.add(file.path)
  }
  const bindings = manifest.file_bindings ?? []
  if (
    new Set(bindings.map((binding) => binding.file_id)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.page_id)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.path)).size !== bindings.length ||
    bindings.some(
      (binding) =>
        !paths.has(binding.path) ||
        binding.file_id.trim() !== binding.file_id ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(binding.file_id),
    )
  )
    throw invalid()
  const mainBinding = bindings.find((binding) => binding.path === manifest.entrypoint)
  if (
    manifest.file_bindings !== undefined &&
    (mainBinding === undefined ||
      locator.type !== "shared_skill" ||
      mainBinding.page_id !== locator.page_id)
  )
    throw invalid()
  if (
    node.ref !== fileRef(record.id, manifest.entrypoint, manifest.snapshot_id, mainBinding?.file_id)
  )
    throw invalid()
  const files = manifest.files.map((file) => ({
    ...file,
    ref: fileRef(
      record.id,
      file.path,
      manifest.snapshot_id,
      bindings.find((binding) => binding.path === file.path)?.file_id,
    ),
  }))
  if (!same(files, node.files)) throw invalid()
  const main = manifest.files.find((file) => file.path === manifest.entrypoint)
  if (main === undefined || main.bytes !== node.bytes || main.sha256 !== node.body_sha256)
    throw invalid()
  const source = entry.source_body
  const totalLines = node.content.split("\n").length
  if (
    source.ref !== node.ref ||
    source.path !== node.path ||
    source.sha256 !== node.body_sha256 ||
    source.bytes !== node.bytes ||
    source.range.end !== totalLines ||
    source.range.total_lines !== totalLines ||
    !Number.isSafeInteger(source.range.end) ||
    node.content.includes("\0") ||
    new TextEncoder().encode(node.content).byteLength !== node.bytes
  )
    throw invalid()
  const readyPaths = new Set(entry.materialization.paths)
  const allReady = readyPaths.size === paths.size
  if (
    readyPaths.size !== entry.materialization.paths.length ||
    !readyPaths.has(manifest.entrypoint) ||
    [...readyPaths].some((path) => !paths.has(path)) ||
    (entry.materialization.status === "all_files_ready") !== allReady
  )
    throw invalid()
  const projection = entry.projection
  if (
    projection.source_body_sha256 !== node.body_sha256 ||
    projection.projection_sha256 !== node.body_sha256 ||
    projection.bytes !== node.bytes
  )
    throw invalid()
}

/** Wire/SDK boundary decoder shared with the producer; no Store or network access. */
export function decodeConsumeResult(value: unknown, expected?: ConsumeInput) {
  return Effect.gen(function* () {
    const result = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(ConsumeResultSchema, { onExcessProperty: "error" })(value),
      catch: invalid,
    })
    if (result.status !== "ready") return result
    const graph = result.preparation
    if (
      expected !== undefined &&
      (graph.purpose !== expected.purpose ||
        !same(
          sorted(graph.roots.map((root) => root.target)),
          sorted([...new Set(expected.targets)]),
        ) ||
        expected.sessionBindings?.some((binding) =>
          graph.session_bindings.some(
            (selected) => selected.record.id === binding.record.id && !same(selected, binding),
          ),
        ))
    )
      return yield* Effect.fail(invalid())
    const prepared = graph.nodes.filter((node) => node.state === "prepared")
    const ids = prepared.map((node) => node.id)
    const directoryEdges = [
      ...new Set(
        prepared.flatMap((node) =>
          node.required.map((child) =>
            canonicalSharedJson({ from: node.id, to: child.id, ref: child.ref }),
          ),
        ),
      ),
    ].sort()
    const roots = sorted([
      ...new Set(graph.roots.flatMap((root) => (root.id === undefined ? [] : [root.id]))),
    ])
    const { sha256: lockHash, ...vector } = graph.graph_lock
    if (
      graph.nodes.some((node) => node.state !== "prepared" && node.state !== "known") ||
      new Set(graph.nodes.map((node) => node.id)).size !== graph.nodes.length ||
      graph.roots.length === 0 ||
      graph.roots.some(
        (root) =>
          root.readiness !== "ready" ||
          root.id === undefined ||
          !prepared.some((node) => node.id === root.id && node.ref === root.ref),
      ) ||
      !same(sorted(result.entries.map((entry) => entry.id)), sorted(ids)) ||
      !same(
        graph.session_bindings,
        prepared.map((node) => node.binding),
      ) ||
      vector.scope !== graph.scope ||
      vector.purpose !== graph.purpose ||
      !same(vector.roots, roots) ||
      !same(vector.required, graph.required) ||
      !same(directoryEdges, sorted(graph.required.map((edge) => canonicalSharedJson(edge)))) ||
      !same(vector.bindings, graph.session_bindings) ||
      (yield* sha256(canonicalSharedJson(vector))) !== lockHash ||
      graph.required.some(
        (edge) => !ids.includes(edge.from) || (graph.purpose === "use" && !ids.includes(edge.to)),
      ) ||
      (graph.purpose === "inspect" &&
        (graph.required_closure.length !== 0 || !same(sorted(ids), roots))) ||
      (graph.purpose === "use" && !same(sorted(graph.required_closure), sorted(ids))) ||
      graph.usage.prepared_nodes !== prepared.length ||
      graph.usage.instruction_bytes !== prepared.reduce((total, node) => total + node.bytes, 0) ||
      graph.usage.prepared_nodes > graph.budget.maxNodes ||
      graph.usage.max_depth > graph.budget.maxDepth ||
      graph.usage.context_bytes > graph.budget.maxContextBytes ||
      prepared.some((node) => node.bytes > graph.budget.maxInstructionBytes)
    )
      return yield* Effect.fail(invalid())
    for (const node of prepared) {
      const entry = result.entries.find((candidate) => candidate.id === node.id)
      if (entry === undefined) return yield* Effect.fail(invalid())
      yield* Effect.try({ try: () => validateManifest(entry, node, graph.scope), catch: invalid })
      yield* Effect.try({
        try: () => {
          for (const root of graph.roots)
            if (root.id === node.id) validateSelection(root.target, node)
          if (graph.purpose === "use")
            for (const edge of graph.required)
              if (edge.to === node.id) {
                if (node.kind !== "skill") throw invalid()
                validateSelection(edge.ref, node)
              }
        },
        catch: invalid,
      })
      const manifest = entry.manifest
      const identity =
        manifest.historical_snapshot_id === undefined
          ? node.id
          : manifest.record.locator.type === "notion_page"
            ? manifest.record.locator.page_id
            : undefined
      if (
        identity === undefined ||
        manifest.snapshot_id !==
          `s_${yield* sha256(JSON.stringify([manifest.scope, identity, manifest.version_id]))}` ||
        (yield* sha256(node.content)) !== node.body_sha256 ||
        (yield* sha256(canonicalSharedJson(manifest))) !== entry.manifest_sha256 ||
        (yield* sha256(canonicalSharedJson(relations(node)))) !== entry.projection.relations_sha256
      )
        return yield* Effect.fail(invalid())
    }
    // Lock consistency is separate from dependency resolution; only the prepared root closure is admissible.
    if (graph.purpose === "use") {
      const visited = new Set<string>()
      const visit = (id: string, path: ReadonlySet<string>): boolean => {
        if (path.has(id)) return false
        if (visited.has(id)) return true
        const next = new Set([...path, id])
        for (const edge of graph.required.filter((edge) => edge.from === id))
          if (!visit(edge.to, next)) return false
        visited.add(id)
        return true
      }
      if (roots.some((root) => !visit(root, new Set())) || !same(sorted([...visited]), sorted(ids)))
        return yield* Effect.fail(invalid())
    }
    return result
  })
}

/** Shared preflight: adapters can reject unsupported input before acquiring local state. */
export function decodeConsumeInput(inputValue: unknown): ConsumeInput {
  let input: ConsumeInput
  try {
    input = Schema.decodeUnknownSync(ConsumeInputSchema, { onExcessProperty: "error" })(inputValue)
  } catch {
    throw fail("INVALID_ARGUMENT", "Consume input must match contract version 1.")
  }
  if (
    (input.requestedFiles?.length ?? 0) > 0 ||
    (input.projection !== undefined && input.projection.compiler !== SOURCE_IDENTITY_COMPILER)
  )
    throw fail(
      "CONSUME_UNSUPPORTED",
      "Requested files and non-identity model projections are not implemented by this consumer.",
      {
        requested_files: (input.requestedFiles?.length ?? 0) > 0,
        projection_compiler: input.projection?.compiler ?? SOURCE_IDENTITY_COMPILER,
      },
    )
  return input
}

function consumeReady(
  inputValue: unknown,
  options: Parameters<typeof prepareGraphWithSnapshots>[1],
) {
  return Effect.gen(function* () {
    const input = yield* Effect.try({
      try: () => decodeConsumeInput(inputValue),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_ARGUMENT", "Consume input must match contract version 1."),
    })
    const { preparation, snapshots } = yield* prepareGraphWithSnapshots(
      {
        roots: input.targets,
        purpose: input.purpose,
        ...(input.sessionBindings === undefined ? {} : { sessionBindings: input.sessionBindings }),
        ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
        ...(input.budget === undefined ? {} : { budget: input.budget }),
      },
      options,
    )
    const entries: ConsumeEntry[] = []
    for (const node of preparation.nodes) {
      if (node.state !== "prepared") continue
      const snapshot = snapshots.get(node.id)
      if (snapshot === undefined) return yield* Effect.fail(invalid())
      const manifest: VerifiedManifest = {
        complete: true,
        scope: snapshot.scope,
        snapshot_id: snapshot.snapshot_id,
        version_id: snapshot.version_id,
        record: snapshot.record,
        entrypoint: snapshot.entrypoint,
        files: snapshot.files,
        ...(snapshot.historical_snapshot_id === undefined
          ? {}
          : { historical_snapshot_id: snapshot.historical_snapshot_id }),
        ...(snapshot.file_bindings === undefined ? {} : { file_bindings: snapshot.file_bindings }),
        ...(snapshot.source_projection === undefined
          ? {}
          : { source_projection: snapshot.source_projection }),
      }
      const totalLines = node.content.split("\n").length
      const materialized = snapshot.materialization
      entries.push({
        id: node.id,
        manifest,
        manifest_sha256: yield* sha256(canonicalSharedJson(manifest)),
        source_body: {
          kind: "verified_snapshot_entry",
          ref: node.ref,
          path: node.path,
          bytes: node.bytes,
          sha256: node.body_sha256,
          range: { start: 1, end: totalLines, total_lines: totalLines },
          has_more: false,
        },
        materialization: {
          status:
            materialized === undefined || materialized.local_files_ready
              ? "all_files_ready"
              : "entry_ready",
          paths: materialized?.materialized_paths ?? snapshot.files.map((file) => file.path),
        },
        projection: {
          status: "identity",
          compiler: SOURCE_IDENTITY_COMPILER,
          source_body_sha256: node.body_sha256,
          relations_sha256: yield* sha256(canonicalSharedJson(relations(node))),
          projection_sha256: node.body_sha256,
          bytes: node.bytes,
        },
      })
    }
    const result: ConsumeReady = {
      version: CONSUMER_CONTRACT_VERSION,
      status: "ready",
      preparation,
      entries,
      export: { status: "not_requested" },
      delivery: { status: "not_observed" },
      activation: { status: "not_evaluated" },
    }
    return yield* decodeConsumeResult(result, input)
  })
}

export type ConsumeOptions = NonNullable<Parameters<typeof prepareGraphWithSnapshots>[1]> & {
  readonly signal?: AbortSignal
}

/** One read owner. Explicit cancellation waits for request cleanup; external Effect
 * interruption keeps its native semantics. Neither case can attest model delivery.
 */
export function consume(input: unknown, options: ConsumeOptions = {}) {
  return Effect.suspend(() => {
    const cancelled: ConsumeResult = {
      version: CONSUMER_CONTRACT_VERSION,
      status: "cancelled",
      reason: "interrupted",
    }
    const signal = options.signal
    if (signal?.aborted) return Effect.succeed(cancelled)
    const work = consumeReady(input, options).pipe(
      Effect.catchCause((cause) => {
        const error = Option.getOrUndefined(Cause.findErrorOption(cause))
        if (
          Cause.hasDies(cause) ||
          Cause.hasInterruptsOnly(cause) ||
          !(error instanceof SkillsError)
        )
          return Effect.failCause(cause)
        return Effect.succeed<ConsumeResult>({
          version: CONSUMER_CONTRACT_VERSION,
          status: "failed",
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        })
      }),
    )
    if (signal === undefined) return work
    const cancellation = Effect.callback<ConsumeResult>((resume) => {
      const abort = () => resume(Effect.succeed(cancelled))
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      return Effect.sync(() => signal.removeEventListener("abort", abort))
    })
    return work.pipe(
      Effect.raceFirst(cancellation),
      Effect.map((result) => (signal.aborted ? cancelled : result)),
    )
  })
}
