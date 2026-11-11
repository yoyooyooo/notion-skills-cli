import { Clock, Crypto, Effect, FileSystem, Path, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  currentConsumptionEffects,
  withConsumptionEffects,
  type ConsumptionObservationOptions,
} from "./consumption-effects.ts"
import { authScope } from "./catalog.ts"
import { locallySelectedScope, type ObservedSnapshot, type ReadPolicyOptions } from "./cache.ts"
import {
  fail,
  property,
  SkillsError,
  snapshotMembers,
  type ContentRecord,
  type Snapshot,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { fileRef, pageId, parseTarget, type SkillTarget } from "./ref.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { targetSnapshot } from "./snapshot.ts"
import { withSharedGraphReads, withSharedGraphReadDepth } from "./shared-graph-read-context.ts"
import { derivedGraphDirectory, relationDirectory } from "./graph-derived-directory.ts"
import { sha256, Store } from "./store.ts"
import {
  normalizePrepareExecution,
  prepareRequestPolicy,
  withPrepareExecution,
  type PrepareExecutionOptions,
} from "./preparation-execution.ts"
import {
  PREPARE_DEFAULT_BUDGET,
  PrepareInputSchema,
  type PrepareBinding,
  type PrepareDirectoryEntry,
  type PrepareIncomplete,
  type PrepareInput,
  type PrepareNode,
  type PrepareReady,
  type PrepareRole,
  type PreparedNode,
} from "./graph-prepare-model.ts"

type Services =
  | Notion
  | Store
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError ? error : fail("INVALID_ARGUMENT", "Invalid preparation input."),
  })
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const roleOrder: readonly PrepareRole[] = ["root", "required", "member", "reference"]
const rolesWith = (roles: readonly PrepareRole[], role: PrepareRole) =>
  roleOrder.filter((candidate) => candidate === role || roles.includes(candidate))
const selectorKey = (selector: string) => {
  const page = pageId(selector)
  return page === undefined
    ? selector.replace(/^upstream:/u, "notion_subscription:")
    : `notion_page:${page}`
}
const exactTarget = (input: string) => {
  const target = parseTarget(input)
  if (
    !target.snapshot &&
    !pageId(target.selector) &&
    !/^(shared_skill:[^:]+:.+|(?:notion_subscription|upstream):[a-f0-9-]+)$/u.test(target.selector)
  )
    throw fail(
      "EXACT_TARGET_REQUIRED",
      "Preparation requires an exact content ID, page URL or pinned ref.",
      { target: input },
    )
  return target
}
const recordSelectors = (record: ContentRecord): readonly string[] => {
  const locator = record.locator
  return [
    record.id,
    ...(locator.type === "notion_page" || locator.type === "shared_skill"
      ? [`notion_page:${locator.page_id}`]
      : locator.type === "notion_subscription"
        ? [`notion_subscription:${locator.subscription_id}`]
        : []),
  ]
}
const deferred = (error: SkillsError) =>
  error.code === "NOTION_QUEUE_FULL" || property(error.details).deferred === true
const failure = (error: SkillsError) => ({
  code: error.code,
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details }),
})

function readPolicy(input: PrepareInput): ReadPolicyOptions {
  switch (input.freshness?.policy) {
    case "refresh":
      return { refresh: true }
    case "offline":
      return { offline: true }
    case "max_age":
      return { maxAge: input.freshness.max_age_ms }
    default:
      return {}
  }
}

/** One request-scoped graph owner over the ordinary verified snapshot reader.
 * It neither executes content nor starts a transport, retry loop or background worker.
 */
export function prepareGraph(
  inputValue: PrepareInput,
  options: Parameters<typeof prepareGraphWithSnapshots>[1] = {},
) {
  return withConsumptionEffects(
    prepareGraphWithSnapshots(inputValue, options).pipe(
      Effect.map(({ preparation }) => preparation),
    ),
    options,
  )
}

/** Internal same-operation artifacts for the consumer. No second snapshot read is needed. */
export function prepareGraphWithSnapshots(
  inputValue: PrepareInput,
  options: ConsumptionObservationOptions & {
    readonly database?: string
    readonly execution?: PrepareExecutionOptions
    readonly metrics?: boolean
  } = {},
) {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const execution = yield* checked(() => normalizePrepareExecution(options.execution))
    const requestPolicy = prepareRequestPolicy(execution)
    const input = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(PrepareInputSchema)(inputValue),
      catch: () =>
        fail(
          "INVALID_ARGUMENT",
          "Prepare input must match the roots, purpose, bindings, freshness and budget schema.",
        ),
    })
    const budget = { ...PREPARE_DEFAULT_BUDGET, ...input.budget }
    const targets = [...new Set(input.roots)].sort(compare)
    yield* checked(() => {
      for (const [name, value] of Object.entries(budget))
        if (!Number.isSafeInteger(value))
          throw fail("INVALID_ARGUMENT", `${name} must be a safe integer.`)
      for (const root of targets) exactTarget(root)
    })
    const api = yield* Notion
    const credentialIdentity = yield* Effect.cached(api.credentialIdentity)
    const connectionIdentity =
      api.connectionIdentity === undefined
        ? undefined
        : yield* Effect.cached(api.connectionIdentity)
    const currentUser = yield* Effect.cached(api.request("v1/users/me", undefined, requestPolicy))
    // Cache identity only within this operation; all content I/O retains the same Service/scheduler.
    const selectedApi: Notion["Service"] = {
      ...api,
      credentialIdentity,
      ...(connectionIdentity === undefined ? {} : { connectionIdentity }),
      request: (path, body, requestOptions) =>
        path === "v1/users/me" && body === undefined
          ? currentUser
          : api.request(path, body, { ...requestOptions, ...requestPolicy }),
    }
    return yield* withPrepareExecution(
      prepareSelected(input, targets, budget, {
        database: options.database,
        sharedReadOnly: options.readOnly === true || execution.priority === "prefetch",
        metrics: options.metrics,
        startedAt,
      }).pipe(Effect.provideService(Notion, selectedApi)),
      execution,
    )
  })
}

type PreparedGraphArtifacts = {
  readonly preparation: PrepareReady
  readonly snapshots: ReadonlyMap<string, ObservedSnapshot>
}

function prepareSelected(
  input: PrepareInput,
  targets: readonly string[],
  budget: PrepareReady["budget"],
  options: {
    readonly database?: string
    readonly sharedReadOnly?: boolean
    readonly metrics?: boolean
    readonly startedAt: number
  },
): Effect.Effect<PreparedGraphArtifacts, SkillsError, Services> {
  return Effect.gen(function* () {
    const policy = readPolicy(input)
    const scope = policy.offline ? yield* locallySelectedScope(true) : yield* authScope
    if (scope === undefined)
      return yield* Effect.fail(
        fail("CACHE_SCOPE_UNAVAILABLE", "Preparation requires the selected account scope."),
      )
    const fixedSelectors = new Set(
      (input.sessionBindings ?? [])
        .flatMap((binding) => recordSelectors(binding.record))
        .map(selectorKey),
    )
    const currentRoots = targets
      .map(exactTarget)
      .filter(
        (target) =>
          target.snapshot === undefined && !fixedSelectors.has(selectorKey(target.selector)),
      )
      .map((target) => target.selector)
    return yield* withSharedGraphReads(
      prepareSelectedInScope(input, targets, budget, options, scope),
      {
        scope,
        currentRoots,
        purpose: input.purpose,
        maxNodes: budget.maxNodes,
        maxDepth: budget.maxDepth,
      },
    )
  })
}

function prepareSelectedInScope(
  input: PrepareInput,
  targets: readonly string[],
  budget: PrepareReady["budget"],
  options: {
    readonly database?: string
    readonly sharedReadOnly?: boolean
    readonly metrics?: boolean
    readonly startedAt: number
  },
  scope: string,
): Effect.Effect<PreparedGraphArtifacts, SkillsError, Services> {
  return Effect.gen(function* () {
    const policy = readPolicy(input)
    const store = yield* Store
    const startedAt = options.startedAt
    let rootReadyMs: number | undefined
    let derivedCacheHits = 0,
      derivedCacheMisses = 0
    const aliases = new Map<string, string>()
    const pins = new Map<string, string>()
    const session = new Map<string, PrepareBinding>()
    const nodes = new Map<string, PrepareNode>()
    const snapshots = new Map<string, ObservedSnapshot>()
    const errorsById = new Map<string, SkillsError>()
    const heights = new Map<string, number>()
    const attempted = new Set<string>()
    const required = new Map<string, PrepareReady["required"][number]>()
    let maxDepth = 0
    const register = (record: ContentRecord, snapshotId: string) => {
      for (const selector of recordSelectors(record)) {
        const key = selectorKey(selector)
        const previous = aliases.get(key)
        if (previous !== undefined && previous !== record.id)
          throw fail(
            "PREPARE_IDENTITY_CONFLICT",
            "One physical content identity names different logical nodes.",
            { selector, ids: [previous, record.id] },
          )
        aliases.set(key, record.id)
      }
      const owner = pins.get(snapshotId)
      if (owner !== undefined && owner !== record.id)
        throw fail("PREPARE_IDENTITY_CONFLICT", "One snapshot names different logical nodes.")
      pins.set(snapshotId, record.id)
    }
    yield* checked(() => {
      for (const binding of input.sessionBindings ?? []) {
        if (binding.scope !== scope)
          throw fail(
            "PREPARE_SCOPE_CONFLICT",
            "A session binding belongs to another selected account scope.",
            { id: binding.record.id },
          )
        const previous = session.get(binding.record.id)
        if (
          previous !== undefined &&
          canonicalSharedJson(previous) !== canonicalSharedJson(binding)
        )
          throw fail(
            "PREPARE_VERSION_CONFLICT",
            "A session supplies conflicting bindings for one identity.",
            { id: binding.record.id, snapshots: [previous.snapshot_id, binding.snapshot_id] },
          )
        register(binding.record, binding.snapshot_id)
        session.set(binding.record.id, binding)
      }
    })
    const addKnown = (entry: PrepareDirectoryEntry, role: PrepareRole) => {
      const previous = nodes.get(entry.id)
      nodes.set(
        entry.id,
        previous === undefined
          ? {
              id: entry.id,
              ref: entry.ref,
              kind: entry.kind,
              name: entry.name,
              description: entry.description,
              availability: entry.availability,
              state: "known",
              roles: [role],
            }
          : { ...previous, roles: rolesWith(previous.roles, role) },
      )
    }
    const orderedNodes = () => [...nodes.values()].sort((a, b) => compare(a.id, b.id))
    const orderedEdges = () =>
      [...required.values()].sort(
        (a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.ref, b.ref),
      )
    const bindings = () =>
      orderedNodes().flatMap((node) => (node.state === "prepared" ? [node.binding] : []))
    const selectedId = (target: SkillTarget) => {
      const direct = aliases.get(selectorKey(target.selector))
      if (direct !== undefined || target.snapshot === undefined) return direct
      const owner = pins.get(target.snapshot)
      if (owner === undefined) return undefined
      const record = snapshots.get(owner)?.record ?? session.get(owner)?.record
      return record !== undefined &&
        (target.selector === "" ||
          [record.name, record.alias, ...recordSelectors(record)].includes(
            selectorKey(target.selector),
          ))
        ? owner
        : undefined
    }
    const failNode = (target: string, role: PrepareRole, error: SkillsError) => {
      let id = target
      try {
        const parsed = parseTarget(target)
        id = selectedId(parsed) ?? (selectorKey(parsed.selector) || parsed.snapshot || target)
      } catch {
        // A malformed relation is itself the reported failure; presentation cannot rethrow it.
      }
      const previous = nodes.get(id)
      if (previous?.state !== "prepared")
        nodes.set(id, {
          id,
          ref: target,
          roles: rolesWith(previous?.roles ?? [], role),
          state: deferred(error) ? "deferred" : "failed",
          error: failure(error),
        })
      errorsById.set(id, error)
    }
    const visit = (
      targetText: string,
      role: "root" | "required",
      stack: readonly string[],
    ): Effect.Effect<string, SkillsError, Services> =>
      Effect.gen(function* () {
        const target = yield* checked(() => exactTarget(targetText))
        let id = selectedId(target)
        const previousBinding = id === undefined ? undefined : session.get(id)
        if (
          previousBinding !== undefined &&
          target.snapshot !== undefined &&
          target.snapshot !== previousBinding.snapshot_id
        )
          return yield* Effect.fail(
            fail(
              "PREPARE_VERSION_CONFLICT",
              "An explicit version conflicts with the session binding.",
              { id, expected: previousBinding.snapshot_id, actual: target.snapshot, path: stack },
            ),
          )
        const selected: SkillTarget =
          previousBinding === undefined
            ? target
            : {
                ...target,
                selector: previousBinding.record.id,
                snapshot: previousBinding.snapshot_id,
              }
        const cycle = id === undefined ? -1 : stack.indexOf(id)
        if (cycle >= 0)
          return yield* Effect.fail(
            fail("PREPARE_REQUIRED_CYCLE", "Required dependencies contain a cycle.", {
              path: [...stack.slice(cycle), id],
            }),
          )
        const depth = stack.length
        const height = id === undefined ? 0 : (heights.get(id) ?? 0)
        maxDepth = Math.max(maxDepth, depth + height)
        if (depth + height > budget.maxDepth)
          return yield* Effect.fail(
            fail("PREPARE_DEPTH_BUDGET", "The required closure exceeds the depth budget.", {
              max_depth: budget.maxDepth,
              path: [...stack, id ?? targetText],
              depth: depth + height,
            }),
          )
        if (id !== undefined && errorsById.has(id)) return yield* Effect.fail(errorsById.get(id)!)
        let snapshot = id === undefined ? undefined : snapshots.get(id)
        if (
          snapshot !== undefined &&
          selected.snapshot !== undefined &&
          selected.snapshot !== snapshot.snapshot_id
        )
          return yield* Effect.fail(
            fail("PREPARE_VERSION_CONFLICT", "The graph selected two versions of one identity.", {
              id,
              expected: snapshot.snapshot_id,
              actual: selected.snapshot,
              path: stack,
            }),
          )
        if (snapshot === undefined) {
          const key = id ?? (selectorKey(target.selector) || target.snapshot || targetText)
          if (!attempted.has(key) && attempted.size >= budget.maxNodes)
            return yield* Effect.fail(
              fail("PREPARE_NODE_BUDGET", "The required closure exceeds the node budget.", {
                max_nodes: budget.maxNodes,
                target: targetText,
                path: stack,
              }),
            )
          attempted.add(key)
          snapshot = yield* withSharedGraphReadDepth(
            targetSnapshot(
              selected,
              {
                ...options,
                ...(selected.snapshot === undefined ? policy : { offline: policy.offline }),
              },
              "generated",
              "entrypoint",
            ),
            depth,
          )
          id = snapshot.record.id
          yield* checked(() => register(snapshot!.record, snapshot!.snapshot_id))
          attempted.delete(key)
          attempted.add(id)
          const same = snapshots.get(id)
          if (same !== undefined && same.snapshot_id !== snapshot.snapshot_id)
            return yield* Effect.fail(
              fail("PREPARE_VERSION_CONFLICT", "The graph selected two versions of one identity.", {
                id,
                expected: same.snapshot_id,
                actual: snapshot.snapshot_id,
              }),
            )
          if (snapshot.scope !== scope)
            return yield* Effect.fail(
              fail(
                "PREPARE_SCOPE_CONFLICT",
                "The selected snapshot belongs to another account scope.",
                { id },
              ),
            )
          snapshots.set(id, snapshot)
        }
        const record = snapshot.record
        id = record.id
        if (record.enabled === false)
          return yield* Effect.fail(
            fail("CONTENT_DISABLED", "Disabled content cannot be prepared.", { id }),
          )
        if (role === "required" && record.kind !== "skill")
          return yield* Effect.fail(
            fail(
              "PREPARE_REQUIRED_KIND",
              "A required dependency must be a Skill; Prompt and Router content cannot activate implicitly.",
              { id, kind: record.kind, path: [...stack, id] },
            ),
          )
        const selectedPath =
          target.file_id === undefined
            ? target.path
            : snapshot.file_bindings?.find((binding) => binding.file_id === target.file_id)?.path
        if (
          (target.file_id !== undefined && selectedPath === undefined) ||
          (selectedPath && selectedPath !== snapshot.entrypoint)
        )
          return yield* Effect.fail(
            fail(
              "PREPARE_ROOT_NOT_MAIN",
              "Prepare selects a content main file; supporting resources remain references.",
              { id, path: selectedPath ?? target.path },
            ),
          )
        const existing = nodes.get(id)
        if (existing?.state === "prepared") {
          nodes.set(id, { ...existing, roles: rolesWith(existing.roles, role) })
          if (heights.has(id)) return id
        } else {
          const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
          if (main === undefined)
            return yield* Effect.fail(
              fail("SNAPSHOT_CORRUPT", "The selected snapshot has no main file.", { id }),
            )
          if (main.bytes > budget.maxInstructionBytes)
            return yield* Effect.fail(
              fail(
                "PREPARE_INSTRUCTION_BUDGET",
                "A required main instruction exceeds its byte budget.",
                { id, bytes: main.bytes, max_instruction_bytes: budget.maxInstructionBytes },
              ),
            )
          const bytes = yield* store.readBytes(`objects/${main.sha256}`)
          if (bytes.byteLength !== main.bytes || (yield* sha256(bytes)) !== main.sha256)
            return yield* Effect.fail(
              fail(
                "SNAPSHOT_CORRUPT",
                "The selected main file does not match its immutable hash.",
                { id },
              ),
            )
          const content = yield* checked(() => {
            try {
              const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
              if (value.includes("\0")) throw new Error("NUL")
              return value
            } catch {
              throw fail("BINARY_FILE", "A prepared main instruction must be UTF-8 text.", { id })
            }
          })
          const ref = fileRef(
            id,
            snapshot.entrypoint,
            snapshot.snapshot_id,
            snapshot.file_bindings?.find((binding) => binding.path === snapshot!.entrypoint)
              ?.file_id,
          )
          const binding: PrepareBinding = {
            record,
            scope,
            snapshot_id: snapshot.snapshot_id,
            version_id: snapshot.version_id,
            body_sha256: main.sha256,
            ref,
          }
          const expectedBinding = session.get(id)
          if (
            expectedBinding !== undefined &&
            canonicalSharedJson(expectedBinding) !== canonicalSharedJson(binding)
          )
            return yield* Effect.fail(
              fail(
                "PREPARE_BINDING_CONFLICT",
                "A session binding differs from its verified immutable snapshot.",
                { id, snapshot_id: snapshot.snapshot_id },
              ),
            )
          const derived = yield* derivedGraphDirectory(snapshot, main.sha256)
          if (derived.hit) derivedCacheHits++
          else derivedCacheMisses++
          const node: PreparedNode = {
            id,
            ref,
            state: "prepared",
            kind: record.kind,
            record,
            binding,
            roles: rolesWith(existing?.roles ?? [], role),
            path: snapshot.entrypoint,
            content,
            bytes: main.bytes,
            body_sha256: main.sha256,
            ...derived.directory,
            ...(snapshot.source === undefined ? {} : { source: snapshot.source }),
            ...(snapshot.freshness === undefined ? {} : { freshness: snapshot.freshness }),
          }
          nodes.set(id, node)
          if (
            rootReadyMs === undefined &&
            targets.every((target) => {
              const rootId = selectedId(parseTarget(target))
              return rootId !== undefined && nodes.get(rootId)?.state === "prepared"
            })
          )
            rootReadyMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt)
          for (const child of node.required) {
            addKnown(child, "required")
            required.set(canonicalSharedJson([id, child.id, child.ref]), {
              from: id,
              to: child.id,
              ref: child.ref,
            })
          }
          for (const child of node.candidates) addKnown(child, "member")
          for (const child of node.references) addKnown(child, "reference")
          const contextBytes = new TextEncoder().encode(
            JSON.stringify({ nodes: orderedNodes(), required: orderedEdges() }),
          ).byteLength
          if (contextBytes > budget.maxContextBytes)
            return yield* Effect.fail(
              fail(
                "PREPARE_CONTEXT_BUDGET",
                "The complete instructions and directories exceed the context byte budget.",
                { context_bytes: contextBytes, max_context_bytes: budget.maxContextBytes },
              ),
            )
        }
        let subtreeHeight = 0
        if (input.purpose === "use") {
          for (const child of relationDirectory(snapshot.required)) {
            if (child.availability !== "available")
              return yield* Effect.fail(
                fail("CONTENT_DISABLED", "A required dependency is unavailable.", {
                  id: child.id,
                  path: [...stack, id, child.id],
                }),
              )
            const childId = yield* visit(child.ref, "required", [...stack, id])
            if (childId !== child.id)
              return yield* Effect.fail(
                fail(
                  "PREPARE_IDENTITY_CONFLICT",
                  "A required reference resolves to another logical identity.",
                  { expected: child.id, actual: childId, ref: child.ref },
                ),
              )
            subtreeHeight = Math.max(subtreeHeight, 1 + (heights.get(childId) ?? 0))
          }
        }
        heights.set(id, subtreeHeight)
        return id
      }).pipe(Effect.tapError((error) => Effect.sync(() => failNode(targetText, role, error))))

    const roots: Array<PrepareReady["roots"][number]> = []
    const errors: Array<PrepareIncomplete["errors"][number]> = []
    for (const target of targets) {
      const result = yield* visit(target, "root", []).pipe(Effect.result)
      const id = result._tag === "Success" ? result.success : selectedId(parseTarget(target))
      const node = id === undefined ? undefined : nodes.get(id)
      roots.push({
        target,
        ...(id === undefined ? {} : { id }),
        ...(node?.state === "prepared" ? { ref: node.ref } : {}),
        readiness: result._tag === "Success" ? "ready" : "not_ready",
      })
      if (result._tag === "Failure") errors.push({ target, ...failure(result.failure) })
    }
    const prepared = orderedNodes().filter((node) => node.state === "prepared")
    const effects = yield* currentConsumptionEffects
    const base = {
      version: 1 as const,
      ...(effects === undefined ? {} : { effects }),
      purpose: input.purpose,
      scope,
      roots,
      nodes: orderedNodes(),
      required: orderedEdges(),
      required_closure: input.purpose === "use" ? prepared.map((node) => node.id) : [],
      budget,
      usage: {
        prepared_nodes: prepared.length,
        instruction_bytes: prepared.reduce((total, node) => total + node.bytes, 0),
        context_bytes: 0,
        max_depth: maxDepth,
      },
    }
    const vector = {
      version: 1 as const,
      kind: "observed_version_vector" as const,
      purpose: input.purpose,
      scope,
      roots: [...new Set(roots.flatMap((root) => (root.id === undefined ? [] : [root.id])))].sort(
        compare,
      ),
      required: orderedEdges(),
      bindings: bindings(),
    }
    const ready: PrepareReady = {
      ...base,
      status: "ready",
      session_bindings: vector.bindings,
      graph_lock: { ...vector, sha256: yield* sha256(canonicalSharedJson(vector)) },
    }
    const requiredReadyMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt)
    // Count the successful CLI JSON envelope, including directories and locks, before optional telemetry.
    // The self-reported decimal length reaches a fixed point in at most a few iterations.
    let contextBytes = 0
    while (true) {
      const next = new TextEncoder().encode(
        JSON.stringify({
          ok: true,
          ...ready,
          usage: { ...ready.usage, context_bytes: contextBytes },
        }),
      ).byteLength
      if (next === contextBytes) break
      contextBytes = next
    }
    if (contextBytes > budget.maxContextBytes && errors.length === 0) {
      errors.push({
        target: targets.join(", "),
        code: "PREPARE_CONTEXT_BUDGET",
        message: "The complete preparation JSON exceeds the context byte budget.",
        details: { context_bytes: contextBytes, max_context_bytes: budget.maxContextBytes },
      })
      for (let i = 0; i < roots.length; i++) roots[i] = { ...roots[i]!, readiness: "not_ready" }
    }
    if (errors.length > 0) {
      const result: PrepareIncomplete = {
        ...base,
        usage: { ...base.usage, context_bytes: contextBytes },
        status: errors.every(
          (error) =>
            error.code === "NOTION_QUEUE_FULL" || property(error.details).deferred === true,
        )
          ? "deferred"
          : prepared.length > 0
            ? "partial"
            : "failed",
        observed_bindings: bindings(),
        errors,
      }
      const first = errors[0]!
      return yield* Effect.fail(
        fail(first.code, `Preparation is incomplete: ${first.message}`, {
          ...property(first.details),
          preparation: result,
        }),
      )
    }
    return {
      preparation: {
        ...ready,
        usage: { ...ready.usage, context_bytes: contextBytes },
        ...(options.metrics
          ? {
              preparation_metrics: {
                version: 1 as const,
                root_ready_ms: rootReadyMs ?? requiredReadyMs,
                required_ready_ms: requiredReadyMs,
                elapsed_ms: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
                derived_cache_hits: derivedCacheHits,
                derived_cache_misses: derivedCacheMisses,
              },
            }
          : {}),
      },
      snapshots,
    }
  })
}
