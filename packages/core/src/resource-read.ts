import { Cause, Effect, Option, Schema } from "effect"
import { databaseId as resolveDatabaseId } from "./catalog.ts"
import { validateSnapshotManifest } from "./cache.ts"
import type { VerifiedManifest } from "./consumer-model.ts"
import { aliasFor, entrypointFor, fail, SkillsError, type Snapshot } from "./model.ts"
import { fileRef, normalizePath, pageId, parseRef } from "./ref.ts"
import { openFixedSnapshotFiles } from "./fixed-snapshot-files.ts"
import { validateSharedRecordIdentity } from "./shared-content.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { boundSnapshotPath } from "./snapshot.ts"
import { sha256 } from "./store.ts"
import {
  RESOURCE_READ_CONTRACT_VERSION,
  RESOURCE_READ_DEFAULT_BUDGET,
  RESOURCE_READ_MAX_BUDGET,
  ResourceReadInputSchema,
  ResourceReadResultSchema,
  type ResourceReadInput,
  type ResourceReadReady,
  type ResourceReadResult,
} from "./resource-read-model.ts"

export * from "./resource-read-model.ts"

const invalidProof = () => fail("RESOURCE_INVALID_PROOF", "Resource read evidence is inconsistent.")
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVALID_ARGUMENT", "Invalid fixed resource selection."),
  })

function budgetFor(input: ResourceReadInput) {
  const budget = { ...RESOURCE_READ_DEFAULT_BUDGET, ...input.budget }
  for (const key of ["maxFiles", "maxBytes", "timeBudgetMs"] as const) {
    if (
      !Number.isSafeInteger(budget[key]) ||
      budget[key] <= 0 ||
      budget[key] > RESOURCE_READ_MAX_BUDGET[key]
    )
      throw fail("INVALID_ARGUMENT", key + " must be a positive integer within its hard limit.", {
        maximum: RESOURCE_READ_MAX_BUDGET[key],
      })
  }
  return budget
}
function ownerKey(selector: string) {
  const page = pageId(selector)
  if (page !== undefined) return "notion_page:" + page
  if (/^shared_skill:[^:]+:.+$/u.test(selector)) return selector
  const subscription = /^(?:notion_subscription|upstream):(.+)$/u.exec(selector)
  if (subscription !== null && pageId(subscription[1]!) === subscription[1])
    return "notion_subscription:" + subscription[1]
  throw fail("INVALID_ARGUMENT", "Resources require an exact fixed Skill owner.")
}

/** Structural limits run before the SDK acquires its runtime. */
export function decodeResourceReadInput(value: unknown): ResourceReadInput {
  let input: ResourceReadInput
  try {
    input = Schema.decodeUnknownSync(ResourceReadInputSchema, { onExcessProperty: "error" })(value)
  } catch {
    throw fail(
      "INVALID_ARGUMENT",
      "Resource input must match the versioned refs and budget schema.",
    )
  }
  const budget = budgetFor(input)
  if (input.refs.length === 0 || new Set(input.refs).size !== input.refs.length)
    throw fail("INVALID_ARGUMENT", "Select a nonempty set of distinct fixed resource refs.")
  if (input.refs.length > budget.maxFiles)
    throw fail("RESOURCE_FILE_BUDGET", "The resource selection exceeds its file budget.", {
      files: input.refs.length,
      max_files: budget.maxFiles,
    })
  let owner: string | undefined
  let pin: string | undefined
  for (const ref of input.refs) {
    const target = parseRef(ref)
    if (!target.snapshot || !target.path)
      throw fail("INVALID_ARGUMENT", "Each resource ref requires a fixed snapshot and file path.")
    const selectedOwner = ownerKey(target.selector)
    owner ??= selectedOwner
    pin ??= target.snapshot
    if (selectedOwner !== owner || target.snapshot !== pin)
      throw fail(
        "RESOURCE_SELECTION_CONFLICT",
        "A resource batch requires one fixed owner and snapshot.",
      )
  }
  return input
}

function validateManifestShape(snapshot: Snapshot) {
  const { record, entrypoint, files } = snapshot
  const locator = record.locator
  if (locator.type === "local")
    throw fail("STATE_CORRUPT", "A fixed remote resource owner cannot use a local locator.")
  if (
    record.entrypoint !== entrypointFor(record.kind) ||
    entrypoint !== record.entrypoint ||
    record.ref !== fileRef(record.id, entrypoint) ||
    record.alias !== aliasFor(record.name)
  )
    throw fail("STATE_CORRUPT", "The fixed resource manifest has inconsistent content identity.")
  validateSharedRecordIdentity(record)
  const identifiers =
    locator.type === "notion_subscription"
      ? [
          locator.subscription_id,
          locator.database_id,
          locator.data_source_id,
          locator.target_database_id,
        ]
      : [locator.page_id, locator.database_id, locator.data_source_id]
  if (identifiers.some((value) => pageId(value) !== value))
    throw fail("STATE_CORRUPT", "The fixed resource locator requires canonical Notion identities.")
  if (
    (locator.type === "notion_page" && record.id !== "notion_page:" + locator.page_id) ||
    (locator.type === "notion_subscription" &&
      (record.id !== "notion_subscription:" + locator.subscription_id || record.kind !== "router"))
  )
    throw fail("STATE_CORRUPT", "The fixed resource manifest has inconsistent ownership.")
  const paths = new Set(files.map((file) => file.path))
  if (
    paths.size !== files.length ||
    !paths.has(entrypoint) ||
    files.some(
      (file) =>
        !file.path ||
        normalizePath(file.path) !== file.path ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(file.sha256),
    )
  )
    throw fail("STATE_CORRUPT", "The fixed resource file directory is invalid.")
  const bindings = snapshot.file_bindings ?? []
  if (
    new Set(bindings.map((binding) => binding.file_id)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.page_id)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.path)).size !== bindings.length ||
    bindings.some(
      (binding) =>
        !paths.has(binding.path) ||
        !binding.file_id ||
        binding.file_id.trim() !== binding.file_id ||
        binding.file_id.length > 256 ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(binding.file_id) ||
        pageId(binding.page_id) !== binding.page_id,
    )
  )
    throw fail("STATE_CORRUPT", "The fixed resource File bindings are invalid.")
  const main = bindings.find((binding) => binding.path === entrypoint)
  if (
    snapshot.file_bindings !== undefined &&
    (main === undefined || locator.type !== "shared_skill" || main.page_id !== locator.page_id)
  )
    throw fail("STATE_CORRUPT", "The fixed resource manifest has no exact main File binding.")
}

function selectFiles(snapshot: Snapshot, input: ResourceReadInput, database?: string) {
  validateManifestShape(snapshot)
  const budget = budgetFor(input)
  const paths = new Set<string>()
  let total = 0
  return input.refs.map((requested_ref) => {
    const target = parseRef(requested_ref)
    if (
      ownerKey(target.selector) !== snapshot.record.id ||
      target.snapshot !== snapshot.snapshot_id
    )
      throw fail(
        "RESOURCE_SELECTION_CONFLICT",
        "The fixed snapshot belongs to another resource owner.",
      )
    const locator = snapshot.record.locator
    const selectedDatabase =
      locator.type === "local"
        ? undefined
        : locator.type === "notion_subscription"
          ? locator.target_database_id
          : locator.database_id
    if (database !== undefined && selectedDatabase !== database)
      throw fail("SKILL_NOT_FOUND", "The Skill does not belong to the selected database.")
    const path = boundSnapshotPath(snapshot, target)
    const file = snapshot.files.find((file) => file.path === path)
    if (file === undefined)
      throw fail("FILE_NOT_FOUND", "The fixed resource path is unavailable.", { path })
    if (file.path === snapshot.entrypoint)
      throw fail(
        "RESOURCE_MAIN_NOT_ALLOWED",
        "Resource batches exclude the main instruction entrypoint.",
      )
    if (paths.has(file.path))
      throw fail("RESOURCE_SELECTION_CONFLICT", "Resource refs resolve to the same fixed file.")
    paths.add(file.path)
    total += file.bytes
    if (!Number.isSafeInteger(total) || total > budget.maxBytes)
      throw fail("RESOURCE_BYTE_BUDGET", "The resource selection exceeds its source byte budget.", {
        bytes: total,
        max_bytes: budget.maxBytes,
      })
    const file_id = snapshot.file_bindings?.find((binding) => binding.path === file.path)?.file_id
    return {
      requested_ref,
      ref: fileRef(snapshot.record.id, file.path, snapshot.snapshot_id, file_id),
      ...(file_id === undefined ? {} : { file_id }),
      ...file,
    }
  })
}

function manifestFor(snapshot: Snapshot): VerifiedManifest {
  return {
    complete: true,
    scope: snapshot.scope,
    snapshot_id: snapshot.snapshot_id,
    ...(snapshot.historical_snapshot_id === undefined
      ? {}
      : { historical_snapshot_id: snapshot.historical_snapshot_id }),
    version_id: snapshot.version_id,
    record: snapshot.record,
    entrypoint: snapshot.entrypoint,
    files: snapshot.files,
    ...(snapshot.file_bindings === undefined ? {} : { file_bindings: snapshot.file_bindings }),
    ...(snapshot.source_projection === undefined
      ? {}
      : { source_projection: snapshot.source_projection }),
  }
}
function base64(bytes: Uint8Array) {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  return btoa(chunks.join(""))
}
function textContent(bytes: Uint8Array): string | undefined {
  if (!bytes.includes(0)) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      /* Arbitrary bytes remain exact binary data. */
    }
  }
  return undefined
}
function payload(bytes: Uint8Array): { encoding: "utf8" | "base64"; content: string } {
  const text = textContent(bytes)
  return text === undefined
    ? { encoding: "base64", content: base64(bytes) }
    : { encoding: "utf8", content: text }
}
function payloadBytes(file: ResourceReadReady["files"][number]) {
  if (
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    file.bytes > RESOURCE_READ_MAX_BUDGET.maxBytes
  )
    throw invalidProof()
  if (file.encoding === "utf8") {
    if (file.content.length > file.bytes || file.content.includes("\0")) throw invalidProof()
    const bytes = new TextEncoder().encode(file.content)
    if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== file.content)
      throw invalidProof()
    return bytes
  }
  if (
    file.content.length !== 4 * Math.ceil(file.bytes / 3) ||
    /[^A-Za-z0-9+/=]/u.test(file.content)
  )
    throw invalidProof()
  const bytes = Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0))
  if (base64(bytes) !== file.content || textContent(bytes) !== undefined) throw invalidProof()
  return bytes
}

/** Pure complete-batch verification. No Store, Notion runtime, or body re-read. */
export function decodeResourceReadResult(value: unknown, expected?: ResourceReadInput) {
  return Effect.gen(function* () {
    const result = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(ResourceReadResultSchema, { onExcessProperty: "error" })(value),
      catch: invalidProof,
    })
    if (result.status !== "ready") return result
    const input = yield* Effect.try({
      try: () =>
        decodeResourceReadInput(
          expected ?? {
            version: RESOURCE_READ_CONTRACT_VERSION,
            refs: result.files.map((file) => file.requested_ref),
            budget: result.budget,
          },
        ),
      catch: invalidProof,
    })
    const snapshot: Snapshot = { ...result.manifest, created_at: 0 }
    yield* validateSnapshotManifest(snapshot).pipe(Effect.mapError(invalidProof))
    const selected = yield* Effect.try({
      try: () => selectFiles(snapshot, input),
      catch: invalidProof,
    })
    if (
      !same(result.budget, budgetFor(input)) ||
      result.files.length !== selected.length ||
      result.manifest_sha256 !== (yield* sha256(canonicalSharedJson(result.manifest))) ||
      !same(result.selection, {
        scope: snapshot.scope,
        owner: snapshot.record.id,
        snapshot_id: snapshot.snapshot_id,
        version_id: snapshot.version_id,
      }) ||
      !same(
        result.materialization.paths,
        selected.map((file) => file.path),
      )
    )
      return yield* Effect.fail(invalidProof())
    let total = 0
    for (const [index, file] of result.files.entries()) {
      const wanted = selected[index]!
      if (
        !same(
          {
            requested_ref: file.requested_ref,
            ref: file.ref,
            path: file.path,
            bytes: file.bytes,
            sha256: file.sha256,
            ...(file.mode === undefined ? {} : { mode: file.mode }),
            ...(file.file_id === undefined ? {} : { file_id: file.file_id }),
          },
          wanted,
        )
      )
        return yield* Effect.fail(invalidProof())
      const bytes = yield* Effect.try({ try: () => payloadBytes(file), catch: invalidProof })
      if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
        return yield* Effect.fail(invalidProof())
      total += bytes.length
    }
    if (!same(result.totals, { files: result.files.length, bytes: total }))
      return yield* Effect.fail(invalidProof())
    return result
  })
}

export type ResourceReadOptions = {
  readonly database?: string
  readonly offline?: boolean
  readonly signal?: AbortSignal
}

function readReady(input: ResourceReadInput, options: ResourceReadOptions) {
  return Effect.gen(function* () {
    const target = parseRef(input.refs[0]!)
    const database =
      options.database === undefined ? undefined : yield* resolveDatabaseId(options.database)
    let selected: ReturnType<typeof selectFiles> | undefined
    const opened = yield* openFixedSnapshotFiles(
      target.snapshot!,
      (snapshot) => {
        selected = selectFiles(snapshot, input, database)
        return selected.map((file) => file.path)
      },
      options,
    )
    const snapshot = opened.snapshot
    const bytesByPath = new Map(opened.files.map((file) => [file.path, file.bytes]))
    if (selected === undefined)
      return yield* Effect.fail(fail("STATE_CORRUPT", "The resource selection was not admitted."))
    const admitted = selected
    const manifest = manifestFor(snapshot)
    const files = yield* checked(() =>
      admitted.map((file) => {
        const bytes = bytesByPath.get(file.path)
        if (bytes === undefined)
          throw fail("STATE_CORRUPT", "A selected resource was not materialized.")
        return { ...file, ...payload(bytes) }
      }),
    )
    const ready: ResourceReadReady = {
      version: RESOURCE_READ_CONTRACT_VERSION,
      status: "ready",
      manifest,
      manifest_sha256: yield* sha256(canonicalSharedJson(manifest)),
      selection: {
        scope: snapshot.scope,
        owner: snapshot.record.id,
        snapshot_id: snapshot.snapshot_id,
        version_id: snapshot.version_id,
      },
      budget: budgetFor(input),
      files,
      totals: { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) },
      materialization: { status: "selected_files_ready", paths: files.map((file) => file.path) },
      delivery: { status: "not_observed" },
    }
    return yield* decodeResourceReadResult(ready, input)
  })
}

/** One resource-only operation; a failed/cancelled batch never exposes partial ready evidence. */
export function readResources(value: unknown, options: ResourceReadOptions = {}) {
  return Effect.suspend(() => {
    const cancelled: ResourceReadResult = {
      version: RESOURCE_READ_CONTRACT_VERSION,
      status: "cancelled",
      reason: "interrupted",
    }
    const signal = options.signal
    if (signal?.aborted) return Effect.succeed(cancelled)
    const work = checked(() => decodeResourceReadInput(value)).pipe(
      Effect.flatMap((input) =>
        readReady(input, options).pipe(
          Effect.timeout(budgetFor(input).timeBudgetMs),
          Effect.mapError((error) =>
            error instanceof SkillsError
              ? error
              : fail(
                  "RESOURCE_TIME_BUDGET",
                  "Resource reading exceeded its complete-operation time budget.",
                  {
                    time_budget_ms: budgetFor(input).timeBudgetMs,
                  },
                ),
          ),
        ),
      ),
      Effect.catchCause((cause) => {
        const error = Option.getOrUndefined(Cause.findErrorOption(cause))
        if (
          Cause.hasDies(cause) ||
          Cause.hasInterruptsOnly(cause) ||
          !(error instanceof SkillsError)
        )
          return Effect.failCause(cause)
        return Effect.succeed<ResourceReadResult>({
          version: RESOURCE_READ_CONTRACT_VERSION,
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
    const cancellation = Effect.callback<ResourceReadResult>((resume) => {
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
