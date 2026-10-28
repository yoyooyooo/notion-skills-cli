import { Clock, Crypto, Effect, FileSystem, Schema } from "effect"
import { cachedRemoteObservation, effectiveCachePolicy } from "./cache.ts"
import { portableIdentity, snapshotPortable } from "./export.ts"
import {
  decode,
  fail,
  property,
  notionPage,
  SnapshotSchema,
  SkillsError,
  type Snapshot,
} from "./model.ts"
import { replaceSkill } from "./mutation.ts"
import { Notion } from "./notion.ts"
import { portableFiles, type PortableSkill } from "./portable.ts"
import { pageId, parseTarget } from "./ref.ts"
import { referenceContentIdentity } from "./reference-mutation.ts"
import { openSkill } from "./snapshot.ts"
import { configuration, sha256, Store } from "./store.ts"
import { SyncLocal, type LocalInspection } from "./sync-local.ts"

export interface BindSyncOptions {
  readonly path: string
  readonly as?: string
  readonly database?: string
  readonly dryRun?: boolean
}
export interface SyncStatusOptions {
  readonly refresh?: boolean
}
export interface PlanSyncOptions {
  readonly all?: boolean
  readonly bindingIds?: readonly string[]
  readonly from?: "local" | "notion"
  readonly output?: string
}
export interface UnbindSyncOptions {
  readonly dryRun?: boolean
}
export interface SyncBinding {
  readonly id: string
  readonly label: string
  readonly page_id: string
  readonly database_id: string
  readonly data_source_id: string
  readonly scope: string
  readonly logical_path: string
  readonly active: boolean
  readonly revision: number
}
export type SyncDirection = "push" | "pull" | "unchanged" | "advance_baseline"
export type SyncStorageMode = "exact" | "page_only"

const FileSchema = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
})
const ContentSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  main: Schema.String,
  files: Schema.Array(FileSchema),
  content_id: Schema.String,
})
type Content = typeof ContentSchema.Type
export const BindingSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  page_id: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  scope: Schema.String,
  logical_path: Schema.String,
  active: Schema.Boolean,
  revision: Schema.Number,
})
export const BaseSchema = Schema.Struct({
  format: Schema.Literal("ntn-skills-sync-base"),
  version: Schema.Literal(1),
  binding_id: Schema.String,
  generation: Schema.Number,
  initialized: Schema.Boolean,
  content: Schema.optional(ContentSchema),
  mode: Schema.optional(Schema.Literals(["exact", "page_only"])),
  snapshot_id: Schema.optional(Schema.String),
  remote_version: Schema.optional(Schema.String),
})
export type Base = typeof BaseSchema.Type
const LocalSchema = Schema.Struct({
  logical_path: Schema.String,
  resolved_path: Schema.String,
  exists: Schema.Boolean,
  proof: Schema.Unknown,
  file_hashes: Schema.Array(FileSchema),
  content: Schema.optional(ContentSchema),
})
const EdgeSchema = Schema.Struct({
  binding: BindingSchema,
  base: BaseSchema,
  local: LocalSchema,
  remote: SnapshotSchema,
  remote_content: ContentSchema,
  mode: Schema.Literals(["exact", "page_only"]),
  direction: Schema.Literals(["push", "pull", "unchanged", "advance_baseline"]),
  source: Schema.optional(Schema.Literals(["local", "notion"])),
  intended: ContentSchema,
  actions: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      action: Schema.Literals(["add", "update", "remove", "retain"]),
    }),
  ),
})
type Edge = { -readonly [K in keyof typeof EdgeSchema.Type]: (typeof EdgeSchema.Type)[K] }
const ConflictSchema = Schema.Struct({
  code: Schema.String,
  binding_ids: Schema.Array(Schema.String),
})
const PlanBodySchema = Schema.Struct({
  format: Schema.Literal("ntn-skills-sync-plan"),
  version: Schema.Literal(1),
  applicable: Schema.Boolean,
  bindings: Schema.Array(EdgeSchema),
  conflicts: Schema.Array(ConflictSchema),
})
export const PlanSchema = Schema.Struct({
  ...PlanBodySchema.fields,
  plan_id: Schema.String,
})
export type SyncPlan = typeof PlanSchema.Type
const ReceiptBindingSchema = Schema.Struct({
  binding_id: Schema.String,
  page_id: Schema.String,
  resolved_path: Schema.String,
  stage: Schema.Literals(["prepared", "writing", "verified", "complete", "diverged"]),
  generation_before: Schema.Number,
  generation_after: Schema.optional(Schema.Number),
  retained: Schema.Array(
    Schema.Struct({ path: Schema.String, retention_path: Schema.optional(Schema.String) }),
  ),
})
export const AppliedSyncBindingSchema = Schema.Struct({
  ...ReceiptBindingSchema.fields,
  action: Schema.Literals(["push", "pull", "unchanged", "advance_baseline"]),
  verified: Schema.Boolean,
  content_id: Schema.String,
  snapshot_id: Schema.optional(Schema.String),
  scope: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
})
export const ReceiptSchema = Schema.Struct({
  format: Schema.Literal("ntn-skills-sync-receipt"),
  version: Schema.Literal(1),
  operation_id: Schema.String,
  plan_id: Schema.String,
  created_at: Schema.Number,
  status: Schema.Literals(["pending", "complete", "diverged"]),
  groups: Schema.Array(
    Schema.Struct({
      page_id: Schema.String,
      stage: Schema.Literals(["prepared", "writing", "verified"]),
      snapshot_id: Schema.optional(Schema.String),
    }),
  ),
  bindings: Schema.Array(ReceiptBindingSchema),
  failure: Schema.optional(Schema.Struct({ code: Schema.String })),
})
type Mutable<T> = T extends readonly (infer V)[]
  ? Mutable<V>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T
export type SyncReceipt = Mutable<typeof ReceiptSchema.Type>
const baseKey = (id: string) => `sync/bases/${id}.json`
const planKey = (id: string) => `sync/plans/${id}.json`
const receiptKey = (id: string) => `sync/receipts/${id}.json`

// Stable serialization is shared by plan identities and local target proofs; object key order
// must never make a reviewed plan executable against a different precondition.
export function stableSyncJson(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value))
    throw fail("STATE_CORRUPT", "Sync state contains a nonfinite number.")
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return `[${value.map(stableSyncJson).join(",")}]`
  const row = value as Record<string, unknown>
  return `{${Object.keys(row)
    .filter((key) => row[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSyncJson(row[key])}`)
    .join(",")}}`
}
const same = (a: unknown, b: unknown) => stableSyncJson(a) === stableSyncJson(b)
const attempt = <A>(fn: () => A) =>
  Effect.try({
    try: fn,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("STATE_CORRUPT", "Invalid synchronization state."),
  })
const identity = (skill: PortableSkill, mode: SyncStorageMode) =>
  mode === "page_only" ? referenceContentIdentity(skill) : portableIdentity(skill)

function storageMode(snapshot: Snapshot) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const raw = yield* api.request(`v1/pages/${notionPage(snapshot.record).locator.page_id}`)
    const props = property(property(raw).properties)
    const values = Object.values(props).map(property)
    const files =
      values.some((p) => p.id === "notion%3A%2F%2Fskills%2Ffiles_property") ||
      Boolean(property(props.Files).id)
    const references =
      values.some((p) => p.id === "notion%3A%2F%2Fskills%2Freferences_property") ||
      Boolean(property(props.References).id)
    return references && !files ? ("page_only" as const) : ("exact" as const)
  })
}
function saveContent(skill: PortableSkill, mode: SyncStorageMode) {
  return Effect.gen(function* () {
    yield* attempt(() => portableFiles(skill))
    const store = yield* Store
    const files: Array<typeof FileSchema.Type> = []
    for (const file of [...skill.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const hash = yield* sha256(file.bytes)
      yield* store.writeBytes(`objects/${hash}`, file.bytes)
      files.push({ path: file.path, bytes: file.bytes.length, sha256: hash })
    }
    return {
      name: skill.name,
      description: skill.description,
      main: skill.main,
      files,
      content_id: yield* identity(skill, mode),
    } satisfies Content
  })
}
function loadContent(content: Content, mode: SyncStorageMode) {
  return Effect.gen(function* () {
    const store = yield* Store
    const files: Array<{ path: string; bytes: Uint8Array }> = []
    for (const file of content.files) {
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Sync content failed checksum validation.", { path: file.path }),
        )
      files.push({ path: file.path, bytes })
    }
    const skill = {
      kind: "skill" as const,
      name: content.name,
      description: content.description,
      main: content.main,
      files,
    }
    yield* attempt(() => portableFiles(skill))
    if ((yield* identity(skill, mode)) !== content.content_id)
      return yield* Effect.fail(fail("STATE_CORRUPT", "Sync content identity is invalid."))
    return skill
  })
}
function readBase(binding: SyncBinding) {
  return Effect.gen(function* () {
    const store = yield* Store
    const base = yield* store.readJson(baseKey(binding.id), BaseSchema)
    if (
      !base ||
      base.binding_id !== binding.id ||
      !Number.isSafeInteger(base.generation) ||
      base.generation < 0 ||
      (base.initialized
        ? !base.content ||
          !base.mode ||
          !base.snapshot_id ||
          !base.remote_version ||
          base.generation < 1
        : Boolean(base.content) || base.generation !== 0)
    )
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The registered binding has missing or malformed baseline state.", {
          binding_id: binding.id,
        }),
      )
    if (base.content) yield* loadContent(base.content, base.mode!)
    return base
  })
}
function bindings(selector?: string, all = false) {
  return Effect.gen(function* () {
    const config = yield* configuration
    const active = (config.sync_bindings ?? []).filter((binding) => binding.active)
    if (all) return active
    const matches = active.filter(
      (binding) => binding.id === selector || binding.label === selector,
    )
    if (!matches.length)
      return yield* Effect.fail(
        fail("SYNC_BINDING_MISSING", "No active sync binding matched.", { binding: selector }),
      )
    if (matches.length > 1)
      return yield* Effect.fail(
        fail("SYNC_BINDING_AMBIGUOUS", "Use an unambiguous binding ID.", { binding: selector }),
      )
    return matches
  })
}
function pendingReceipts() {
  return Effect.gen(function* () {
    const store = yield* Store
    const keys = yield* store.listKeys("sync/receipts/")
    const result: SyncReceipt[] = []
    for (const key of keys) {
      const match = /^sync\/receipts\/(o_[a-f0-9-]{36})\.json$/.exec(key)
      if (!match)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "The sync receipt filename is malformed.", { key }),
        )
      const receipt = yield* store.readJson(key, ReceiptSchema)
      if (!receipt || receipt.operation_id !== match[1])
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "A sync receipt is missing or malformed.", { key }),
        )
      const plan = yield* readPlan(receipt.plan_id)
      if (
        !Number.isSafeInteger(receipt.created_at) ||
        receipt.created_at < 0 ||
        receipt.bindings.length !== plan.bindings.length ||
        new Set(receipt.bindings.map((entry) => entry.binding_id)).size !==
          receipt.bindings.length ||
        receipt.groups.length !== new Set(plan.bindings.map((edge) => edge.binding.page_id)).size ||
        new Set(receipt.groups.map((group) => group.page_id)).size !== receipt.groups.length
      )
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "The retained receipt participant set is inconsistent.", { key }),
        )
      for (const entry of receipt.bindings) {
        const edge = plan.bindings.find((item) => item.binding.id === entry.binding_id)
        if (
          !edge ||
          entry.page_id !== edge.binding.page_id ||
          entry.resolved_path !== edge.local.resolved_path ||
          entry.generation_before !== edge.base.generation ||
          (entry.generation_after !== undefined &&
            entry.generation_after !== edge.base.generation &&
            entry.generation_after !== edge.base.generation + 1) ||
          (entry.stage === "complete" && entry.generation_after === undefined) ||
          (receipt.status === "complete" && entry.stage !== "complete")
        )
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "The retained receipt binding state is inconsistent.", { key }),
          )
      }
      if (
        receipt.groups.some(
          (group) => !plan.bindings.some((edge) => edge.binding.page_id === group.page_id),
        ) ||
        (receipt.status === "diverged" &&
          !receipt.bindings.some((entry) => entry.stage === "diverged"))
      )
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "The retained receipt group state is inconsistent.", { key }),
        )
      if (receipt.status === "pending") result.push(receipt as SyncReceipt)
    }
    return result
  })
}
function assertUnfenced(
  edges: readonly { binding: SyncBinding; local: { resolved_path: string } }[],
) {
  return Effect.gen(function* () {
    for (const receipt of yield* pendingReceipts()) {
      if (
        receipt.bindings.some((pending) =>
          edges.some(
            (edge) =>
              edge.binding.page_id === pending.page_id ||
              edge.local.resolved_path === pending.resolved_path,
          ),
        )
      )
        return yield* Effect.fail(
          fail("SYNC_PENDING", "Reconcile the unfinished operation before applying another plan.", {
            operation_id: receipt.operation_id,
            receipt_path: `sqlite:sync_receipts/${receipt.operation_id}`,
          }),
        )
    }
  })
}
function verifyRemote(binding: SyncBinding, snapshot: Snapshot) {
  if (
    snapshot.scope !== binding.scope ||
    pageId(snapshot.record.id) !== binding.page_id ||
    notionPage(snapshot.record).locator.database_id !== binding.database_id ||
    notionPage(snapshot.record).locator.data_source_id !== binding.data_source_id
  )
    return Effect.fail(
      fail("SYNC_PLAN_STALE", "Bound remote identity or credential scope changed.", {
        binding_id: binding.id,
      }),
    )
  return Effect.void
}
function observe(binding: SyncBinding, base: Base) {
  return Effect.gen(function* () {
    const local = yield* SyncLocal
    const inspection = yield* local.inspect(binding.logical_path, {
      allowMissing: !base.initialized,
      ...(base.content ? { trackedPaths: base.content.files.map((file) => file.path) } : {}),
    })
    if (base.initialized && !inspection.exists)
      return yield* Effect.fail(
        fail("SYNC_LOCAL_MISSING", "An established local Skill directory is missing.", {
          binding_id: binding.id,
        }),
      )
    const remote = yield* openSkill(binding.page_id)
    yield* verifyRemote(binding, remote)
    const mode = yield* storageMode(remote)
    if (base.initialized && base.mode !== mode)
      return yield* Effect.fail(
        fail("SYNC_PLAN_STALE", "The bound page storage mode changed.", { binding_id: binding.id }),
      )
    const remoteContent = yield* saveContent(yield* snapshotPortable(remote), mode)
    const localContent = inspection.content
      ? yield* saveContent(inspection.content, mode)
      : undefined
    return { inspection, remote, mode, remoteContent, localContent }
  })
}
// All baseline publication goes through this function, after complete local and remote
// readback. Read/status/plan paths deliberately have no access to baseline promotion.
function publishConvergence(
  binding: SyncBinding,
  expected: Base,
  local: LocalInspection,
  remote: Snapshot,
  mode: SyncStorageMode,
  intendedId: string,
  commit?: { readonly receipt?: SyncReceipt; readonly registration?: boolean },
) {
  return Effect.gen(function* () {
    const current = commit?.registration ? expected : yield* readBase(binding)
    if (!same(current, expected))
      return yield* Effect.fail(
        fail("SYNC_PLAN_STALE", "The common baseline changed.", { binding_id: binding.id }),
      )
    yield* verifyRemote(binding, remote)
    if (!local.content || (yield* identity(local.content, mode)) !== intendedId)
      return yield* Effect.fail(
        fail("SYNC_DIVERGED", "Local readback differs from the intended result.", {
          binding_id: binding.id,
        }),
      )
    const remoteContent = yield* saveContent(yield* snapshotPortable(remote), mode)
    if (remoteContent.content_id !== intendedId)
      return yield* Effect.fail(
        fail("SYNC_DIVERGED", "Remote readback differs from the intended result.", {
          binding_id: binding.id,
        }),
      )
    const filesystem = yield* SyncLocal
    const finalLocal = yield* filesystem.inspect(binding.logical_path, {
      trackedPaths: [
        ...new Set([
          ...local.file_hashes.map((file) => file.path),
          ...(expected.content?.files.map((file) => file.path) ?? []),
        ]),
      ],
    })
    const plannedFileProofs = new Map(local.proof.files.map((file) => [file.path, file.proof]))
    for (const file of finalLocal.proof.files) {
      const before = plannedFileProofs.get(file.path)
      if (before && !same(before, file.proof))
        return yield* Effect.fail(
          fail(
            "SYNC_TARGET_DRIFT",
            "A final local file link or destination changed before baseline publication.",
            { binding_id: binding.id, path: file.path },
          ),
        )
    }
    if (
      !same(finalLocal.proof.root, local.proof.root) ||
      !same(finalLocal.file_hashes, local.file_hashes) ||
      !finalLocal.content ||
      (yield* identity(finalLocal.content, mode)) !== intendedId
    )
      return yield* Effect.fail(
        fail(
          "SYNC_TARGET_DRIFT",
          "The local destination changed before common baseline publication.",
          { binding_id: binding.id },
        ),
      )
    const unchanged = expected.initialized && expected.content!.content_id === intendedId
    const next: Base = {
      format: "ntn-skills-sync-base",
      version: 1,
      binding_id: binding.id,
      generation: expected.generation + (unchanged ? 0 : 1),
      initialized: true,
      content: remoteContent,
      mode,
      snapshot_id: remote.snapshot_id,
      remote_version: remote.version_id,
    }
    const store = yield* Store
    if (commit?.registration) yield* store.registerBindingWithBase(binding, next)
    else if (commit?.receipt) {
      const entry = commit.receipt.bindings.find((item) => item.binding_id === binding.id)!
      const previousStage = entry.stage
      const previousGeneration = entry.generation_after
      entry.stage = "complete"
      entry.generation_after = next.generation
      yield* store
        .advanceBaseAndReceipt(binding.id, expected.generation, next, commit.receipt)
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              entry.stage = previousStage
              entry.generation_after = previousGeneration
            }),
          ),
        )
    } else yield* store.writeJson(baseKey(binding.id), next)
    return next
  })
}
export function bindSync(target: string, options: BindSyncOptions) {
  return Effect.gen(function* () {
    const parsed = yield* attempt(() => parseTarget(target))
    if (
      parsed.snapshot ||
      parsed.path ||
      !options.path?.trim() ||
      (options.as !== undefined && !options.as.trim())
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Bind requires a current pathless target, a local directory and a nonempty label.",
        ),
      )
    const local = yield* SyncLocal
    return yield* local.withLocks(
      ["sync:configuration"],
      Effect.gen(function* () {
        const remote = yield* openSkill(parsed.selector, { database: options.database })
        const canonical = pageId(remote.record.id)
        if (!canonical)
          return yield* Effect.fail(fail("INVALID_RESPONSE", "The remote page ID is invalid."))
        const inspection = yield* local.inspect(options.path, { allowMissing: true })
        const config = yield* configuration
        const existing = config.sync_bindings ?? []
        const duplicate = existing.find(
          (binding) =>
            binding.active &&
            binding.page_id === canonical &&
            binding.scope === remote.scope &&
            binding.logical_path === inspection.logical_path,
        )
        if (duplicate) {
          if (options.as !== undefined && options.as.trim() !== duplicate.label)
            return yield* Effect.fail(
              fail("SYNC_BINDING_CONFLICT", "This edge is already registered with another label.", {
                binding_id: duplicate.id,
                supplied_label: options.as.trim(),
                registered_label: duplicate.label,
              }),
            )
          const base = yield* readBase(duplicate)
          if (base.initialized && !inspection.exists)
            return yield* Effect.fail(
              fail("SYNC_LOCAL_MISSING", "The registered local Skill directory is missing."),
            )
          return {
            binding: duplicate,
            logical_path: inspection.logical_path,
            resolved_path: inspection.resolved_path,
            baseline_initialized: base.initialized,
            status: base.initialized ? "initialized" : "needs_initialization",
            reused: true,
            dry_run: Boolean(options.dryRun),
          }
        }
        const label = options.as?.trim() ?? remote.record.alias
        if (existing.some((binding) => binding.active && binding.label === label))
          return yield* Effect.fail(
            fail("SYNC_BINDING_CONFLICT", "The binding label is already in use; provide --as.", {
              label,
            }),
          )
        for (const other of existing.filter((binding) => binding.active)) {
          const otherBase = yield* readBase(other)
          const otherLocal = yield* local.inspect(other.logical_path, {
            allowMissing: !otherBase.initialized,
            ...(otherBase.content
              ? { trackedPaths: otherBase.content.files.map((file) => file.path) }
              : {}),
          })
          if (
            otherLocal.resolved_path === inspection.resolved_path &&
            (other.page_id !== canonical || other.scope !== remote.scope)
          )
            return yield* Effect.fail(
              fail(
                "SYNC_TARGET_CONFLICT",
                "The real local directory is bound to another remote page.",
                { binding_id: other.id },
              ),
            )
        }
        const id = `b_${yield* sha256(stableSyncJson([remote.scope, canonical, inspection.logical_path, label]))}`
        const binding: SyncBinding = {
          id,
          label,
          page_id: canonical,
          database_id: notionPage(remote.record).locator.database_id,
          data_source_id: notionPage(remote.record).locator.data_source_id,
          scope: remote.scope,
          logical_path: inspection.logical_path,
          active: true,
          revision: (existing.find((item) => item.id === id)?.revision ?? 0) + 1,
        }
        const mode = yield* storageMode(remote)
        const remoteContent = yield* saveContent(yield* snapshotPortable(remote), mode)
        const equal =
          inspection.content !== undefined &&
          (yield* identity(inspection.content, mode)) === remoteContent.content_id
        const preservedBase = existing.find((item) => item.id === id)
        const initialized =
          equal || (preservedBase ? (yield* readBase(preservedBase)).initialized : false)
        if (!options.dryRun) {
          const store = yield* Store
          const prior = existing.find((item) => item.id === id)
          if (!prior && (yield* store.readJson(baseKey(id), BaseSchema)) !== undefined)
            return yield* Effect.fail(
              fail(
                "STATE_CORRUPT",
                "A retained orphan baseline exists for this registration; it cannot be overwritten.",
                { binding_id: id, baseline_path: `sqlite:bases/${id}` },
              ),
            )
          const base: Base = prior
            ? yield* readBase(prior)
            : {
                format: "ntn-skills-sync-base",
                version: 1,
                binding_id: id,
                generation: 0,
                initialized: false,
                mode,
              }
          if (equal) {
            const checkedRemote = yield* openSkill(canonical)
            if (checkedRemote.version_id !== remote.version_id)
              return yield* Effect.fail(
                fail("SYNC_PLAN_STALE", "The remote changed during registration."),
              )
            const checkedLocal = yield* local.inspect(inspection.logical_path, {
              allowMissing: true,
            })
            if (
              !same(checkedLocal.proof, inspection.proof) ||
              !same(checkedLocal.file_hashes, inspection.file_hashes)
            )
              return yield* Effect.fail(
                fail("SYNC_PLAN_STALE", "The local target changed during registration."),
              )
            yield* publishConvergence(
              binding,
              base,
              checkedLocal,
              checkedRemote,
              mode,
              remoteContent.content_id,
              { registration: true },
            )
          } else yield* store.registerBindingWithBase(binding, base)
        }
        return {
          binding,
          logical_path: inspection.logical_path,
          resolved_path: inspection.resolved_path,
          baseline_initialized: initialized,
          status: initialized ? "initialized" : "needs_initialization",
          dry_run: Boolean(options.dryRun),
          reused: false,
        }
      }),
    )
  })
}
function classify(
  base: Base,
  localId: string | undefined,
  remoteId: string,
  from?: "local" | "notion",
): SyncDirection | "conflict" {
  if (from === "local")
    return localId === undefined
      ? "conflict"
      : localId === remoteId
        ? base.content?.content_id === localId
          ? "unchanged"
          : "advance_baseline"
        : "push"
  if (from === "notion")
    return localId === remoteId
      ? base.content?.content_id === remoteId
        ? "unchanged"
        : "advance_baseline"
      : "pull"
  if (!base.initialized) return "conflict"
  if (localId === remoteId)
    return localId === base.content!.content_id ? "unchanged" : "advance_baseline"
  if (localId === base.content!.content_id) return "pull"
  if (remoteId === base.content!.content_id) return "push"
  return "conflict"
}
function fileActions(local: Content | undefined, intended: Content) {
  const current = new Map((local?.files ?? []).map((file) => [file.path, file.sha256]))
  const desired = new Map(intended.files.map((file) => [file.path, file.sha256]))
  return [...new Set([...current.keys(), ...desired.keys()])].sort().map((path) => ({
    path,
    action: !desired.has(path)
      ? ("remove" as const)
      : !current.has(path)
        ? ("add" as const)
        : current.get(path) === desired.get(path)
          ? ("retain" as const)
          : ("update" as const),
  }))
}
export function planSync(binding?: string, options: PlanSyncOptions = {}) {
  return Effect.gen(function* () {
    if (
      [Boolean(binding), Boolean(options.all), options.bindingIds !== undefined].filter(Boolean)
        .length !== 1 ||
      (options.bindingIds !== undefined &&
        (!options.bindingIds.length ||
          options.bindingIds.some((id) => !id.trim()) ||
          new Set(options.bindingIds).size !== options.bindingIds.length)) ||
      ((options.all || (options.bindingIds?.length ?? 0) > 1) && options.from !== undefined) ||
      (options.from !== undefined && options.from !== "local" && options.from !== "notion")
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Choose exactly one binding, --all or explicit binding IDs; --from is single-binding only.",
        ),
      )
    const local = yield* SyncLocal
    return yield* local.withLocks(
      ["sync:configuration"],
      Effect.gen(function* () {
        const selected =
          options.bindingIds === undefined
            ? yield* bindings(binding, Boolean(options.all))
            : yield* Effect.forEach(options.bindingIds, (id) =>
                Effect.gen(function* () {
                  const matches = yield* bindings(id)
                  if (matches[0]!.id !== id)
                    return yield* Effect.fail(
                      fail(
                        "SYNC_BINDING_MISSING",
                        "Grouped planning requires exact active binding IDs.",
                        { binding: id },
                      ),
                    )
                  return matches[0]!
                }),
              )
        if (!selected.length)
          return yield* Effect.fail(
            fail("SYNC_BINDING_MISSING", "No active bindings are registered."),
          )
        const edges: Edge[] = []
        const conflicts: Array<typeof ConflictSchema.Type> = []
        for (const item of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
          const base = yield* readBase(item)
          const observed = yield* observe(item, base)
          const direction = classify(
            base,
            observed.localContent?.content_id,
            observed.remoteContent.content_id,
            options.from,
          )
          if (direction === "conflict")
            conflicts.push({
              code: !base.initialized ? "SYNC_INITIALIZATION_REQUIRED" : "SYNC_CONFLICT",
              binding_ids: [item.id],
            })
          const intended = direction === "push" ? observed.localContent! : observed.remoteContent
          edges.push({
            binding: item,
            base,
            local: {
              logical_path: observed.inspection.logical_path,
              resolved_path: observed.inspection.resolved_path,
              exists: observed.inspection.exists,
              proof: observed.inspection.proof,
              file_hashes: observed.inspection.file_hashes,
              ...(observed.localContent ? { content: observed.localContent } : {}),
            },
            remote: observed.remote,
            remote_content: observed.remoteContent,
            mode: observed.mode,
            direction: direction === "conflict" ? "unchanged" : direction,
            ...(options.from ? { source: options.from } : {}),
            intended,
            actions: fileActions(observed.localContent, intended),
          })
        }
        const pages = new Map<string, Edge[]>()
        const targets = new Map<string, Edge[]>()
        for (const edge of edges) {
          pages.set(edge.binding.page_id, [...(pages.get(edge.binding.page_id) ?? []), edge])
          targets.set(edge.local.resolved_path, [
            ...(targets.get(edge.local.resolved_path) ?? []),
            edge,
          ])
        }
        for (const group of targets.values())
          if (
            new Set(group.map((edge) => `${edge.binding.scope}:${edge.binding.page_id}`)).size > 1
          )
            conflicts.push({
              code: "SYNC_TARGET_CONFLICT",
              binding_ids: group.map((edge) => edge.binding.id),
            })
        for (const group of pages.values()) {
          if (
            new Set(
              group.map((edge) => `${edge.binding.scope}:${edge.remote.version_id}:${edge.mode}`),
            ).size > 1
          )
            conflicts.push({
              code: "SYNC_PLAN_STALE",
              binding_ids: group.map((edge) => edge.binding.id),
            })
          const pushes = group.filter((edge) => edge.direction === "push")
          if (new Set(pushes.map((edge) => edge.intended.content_id)).size > 1) {
            conflicts.push({
              code: "SYNC_CONFLICT",
              binding_ids: pushes.map((edge) => edge.binding.id),
            })
            continue
          }
          if (pushes.length) {
            const accepted = pushes[0]!.intended
            for (const edge of group) {
              // A remote-only change on an independent edge is superseded by the one
              // accepted local candidate; a second local candidate must agree with it.
              if (edge.direction !== "push") {
                if (
                  edge.local.content &&
                  edge.local.content.content_id !== edge.base.content?.content_id &&
                  edge.local.content.content_id !== accepted.content_id
                ) {
                  conflicts.push({
                    code: "SYNC_CONFLICT",
                    binding_ids: [edge.binding.id, pushes[0]!.binding.id],
                  })
                  continue
                }
                edge.intended = accepted
                edge.direction =
                  edge.local.content?.content_id === accepted.content_id
                    ? "advance_baseline"
                    : "pull"
                edge.actions = fileActions(edge.local.content, accepted)
              }
            }
          }
        }
        const body = yield* attempt(() =>
          Schema.decodeUnknownSync(PlanBodySchema)({
            format: "ntn-skills-sync-plan",
            version: 1,
            applicable: !conflicts.length,
            bindings: edges,
            conflicts,
          }),
        )
        const id = `p_${yield* sha256(stableSyncJson(body))}`
        const plan: SyncPlan = { ...body, plan_id: id }
        const store = yield* Store
        yield* store.writeJson(planKey(id), plan)
        const bytes = new TextEncoder().encode(stableSyncJson(plan) + "\n")
        const copy = options.output ? yield* store.output(options.output, bytes) : undefined
        const result = {
          ...plan,
          plan_path: `sqlite:plans/${id}`,
          ...(copy ? { output: copy.output, reused: copy.reused } : {}),
        }
        if (conflicts.length)
          return yield* Effect.fail(
            fail(
              conflicts[0]!.code,
              "The saved sync plan contains conflicts and cannot be applied.",
              result,
            ),
          )
        return result
      }),
    )
  })
}
function readPlan(input: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    let plan: SyncPlan | undefined
    if (/^p_[a-f0-9]{64}$/.test(input)) plan = yield* store.readJson(planKey(input), PlanSchema)
    else {
      const fs = yield* FileSystem.FileSystem
      const raw = yield* fs
        .readFileString(input)
        .pipe(
          Effect.mapError(() => fail("SYNC_PLAN_MISSING", "Could not read the saved plan file.")),
        )
      plan = yield* attempt(() => {
        const rawPlan: unknown = JSON.parse(raw)
        const decoded = Schema.decodeUnknownSync(PlanSchema)(rawPlan)
        if (!same(rawPlan, decoded))
          throw fail("STATE_CORRUPT", "Plan copies cannot add undocumented fields.")
        return decoded
      })
    }
    if (!plan)
      return yield* Effect.fail(fail("SYNC_PLAN_MISSING", "The saved sync plan is missing."))
    const { plan_id, ...body } = plan
    if (
      !/^p_[a-f0-9]{64}$/.test(plan_id) ||
      `p_${yield* sha256(stableSyncJson(body))}` !== plan_id ||
      (/^p_[a-f0-9]{64}$/.test(input) && input !== plan_id)
    )
      return yield* Effect.fail(fail("STATE_CORRUPT", "The saved sync plan digest is invalid."))
    if (!plan.applicable || plan.conflicts.length || !plan.bindings.length)
      return yield* Effect.fail(
        fail("SYNC_CONFLICT", "This saved plan is not executable.", { plan_id }),
      )
    if (new Set(plan.bindings.map((edge) => edge.binding.id)).size !== plan.bindings.length)
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The saved plan contains duplicate binding IDs."),
      )
    const registered = yield* store.readJson(planKey(plan_id), PlanSchema)
    if (!registered || !same(registered, plan))
      return yield* Effect.fail(
        fail(
          "STATE_CORRUPT",
          "A copied plan must exactly match its registered immutable artifact.",
          { plan_id },
        ),
      )
    const groupResults = new Map<string, string>()
    for (const edge of plan.bindings) {
      const candidate = groupResults.get(edge.binding.page_id)
      if (candidate !== undefined && candidate !== edge.intended.content_id)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "A saved page group has incompatible intended results."),
        )
      groupResults.set(edge.binding.page_id, edge.intended.content_id)
    }
    for (const edge of plan.bindings) {
      yield* loadContent(edge.intended, edge.mode)
      yield* loadContent(edge.remote_content, edge.mode)
      if (edge.local.content) yield* loadContent(edge.local.content, edge.mode)
      if (!same(edge.actions, fileActions(edge.local.content, edge.intended)))
        return yield* Effect.fail(fail("STATE_CORRUPT", "Saved plan file actions are invalid."))
      if (
        edge.base.binding_id !== edge.binding.id ||
        edge.local.logical_path !== edge.binding.logical_path ||
        edge.remote.scope !== edge.binding.scope ||
        notionPage(edge.remote.record).locator.page_id !== edge.binding.page_id ||
        notionPage(edge.remote.record).locator.database_id !== edge.binding.database_id ||
        notionPage(edge.remote.record).locator.data_source_id !== edge.binding.data_source_id
      )
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Saved plan participant identities are inconsistent."),
        )
    }
    return plan
  })
}
function preflight(plan: SyncPlan) {
  return Effect.gen(function* () {
    const selected = yield* bindings(undefined, true)
    yield* assertUnfenced(plan.bindings)
    const observed = new Map<string, SyncObservation>()
    for (const edge of plan.bindings) {
      const binding = selected.find((item) => item.id === edge.binding.id)
      if (!binding || !same(binding, edge.binding))
        return yield* Effect.fail(
          fail("SYNC_PLAN_STALE", "The binding configuration changed.", {
            binding_id: edge.binding.id,
          }),
        )
      const base = yield* readBase(binding)
      if (!same(base, edge.base))
        return yield* Effect.fail(
          fail("SYNC_PLAN_STALE", "The common baseline changed.", { binding_id: binding.id }),
        )
      const current = yield* observe(binding, base)
      if (
        current.mode !== edge.mode ||
        current.remote.snapshot_id !== edge.remote.snapshot_id ||
        current.remote.version_id !== edge.remote.version_id ||
        current.remoteContent.content_id !== edge.remote_content.content_id ||
        current.inspection.exists !== edge.local.exists ||
        current.inspection.logical_path !== edge.local.logical_path ||
        current.inspection.resolved_path !== edge.local.resolved_path ||
        !same(current.inspection.proof, edge.local.proof) ||
        !same(current.inspection.file_hashes, edge.local.file_hashes) ||
        !same(current.localContent, edge.local.content)
      )
        return yield* Effect.fail(
          fail(
            "SYNC_PLAN_STALE",
            "Remote content, local content or the filesystem target changed.",
            { binding_id: binding.id },
          ),
        )
      for (const other of selected) {
        if (other.id === binding.id) continue
        const otherBase = yield* readBase(other)
        const local = yield* SyncLocal
        const target = yield* local.inspect(other.logical_path, {
          allowMissing: !otherBase.initialized,
          ...(otherBase.content
            ? { trackedPaths: otherBase.content.files.map((file) => file.path) }
            : {}),
        })
        if (
          target.resolved_path === current.inspection.resolved_path &&
          (other.page_id !== binding.page_id || other.scope !== binding.scope)
        )
          return yield* Effect.fail(
            fail(
              "SYNC_TARGET_CONFLICT",
              "An active binding targets this real directory from another page.",
            ),
          )
      }
      observed.set(binding.id, current)
    }
    return observed
  })
}
interface SyncObservation {
  readonly inspection: LocalInspection
  readonly remote: Snapshot
  readonly mode: SyncStorageMode
  readonly remoteContent: Content
  readonly localContent: Content | undefined
}
export function applySync(planIdOrFile: string) {
  return Effect.gen(function* () {
    const plan = yield* readPlan(planIdOrFile)
    const local = yield* SyncLocal
    return yield* local.withLocks(
      [
        "sync:configuration",
        ...plan.bindings.flatMap((edge) => [
          `sync:page:${edge.binding.page_id}`,
          `sync:target:${edge.local.resolved_path}`,
        ]),
      ],
      Effect.gen(function* () {
        const initial = yield* preflight(plan)
        const store = yield* Store
        const crypto = yield* Crypto.Crypto
        const operationId = `o_${yield* crypto.randomUUIDv4()}`
        const groups = [...new Set(plan.bindings.map((edge) => edge.binding.page_id))].map(
          (page_id) => ({ page_id, stage: "prepared" as const }),
        )
        const receipt: SyncReceipt = {
          format: "ntn-skills-sync-receipt",
          version: 1,
          operation_id: operationId,
          plan_id: plan.plan_id,
          created_at: yield* Clock.currentTimeMillis,
          status: "pending",
          groups,
          bindings: plan.bindings.map((edge) => ({
            binding_id: edge.binding.id,
            page_id: edge.binding.page_id,
            resolved_path: edge.local.resolved_path,
            stage: "prepared",
            generation_before: edge.base.generation,
            retained: [],
          })),
        }
        yield* store.writeJson(receiptKey(operationId), receipt)
        const save = () => store.writeJson(receiptKey(operationId), receipt)
        const execute = Effect.gen(function* () {
          const committed = new Map<string, LocalInspection>()
          for (const group of receipt.groups) {
            const edges = plan.bindings
              .filter((edge) => edge.binding.page_id === group.page_id)
              .sort(
                (a, b) =>
                  Number(b.direction === "push") - Number(a.direction === "push") ||
                  a.binding.id.localeCompare(b.binding.id),
              )
            const representative = edges[0]!
            const push = edges.find((edge) => edge.direction === "push")
            let remote = initial.get(representative.binding.id)!.remote
            if (push) {
              group.stage = "writing"
              yield* save()
              yield* replaceSkill(yield* loadContent(push.intended, push.mode), {
                target: decode(SnapshotSchema, push.remote),
              })
            }
            remote = yield* openSkill(group.page_id)
            yield* verifyRemote(representative.binding, remote)
            if (
              (yield* identity(yield* snapshotPortable(remote), representative.mode)) !==
              representative.intended.content_id
            )
              return yield* Effect.fail(
                fail(
                  "SYNC_DIVERGED",
                  "Remote write readback did not match the saved intended result.",
                  { page_id: group.page_id },
                ),
              )
            group.stage = "verified"
            group.snapshot_id = remote.snapshot_id
            yield* save()
            for (const edge of edges) {
              const entry = receipt.bindings.find((item) => item.binding_id === edge.binding.id)!
              let inspection = initial.get(edge.binding.id)!.inspection
              entry.stage = "writing"
              yield* save()
              const targetKey = `${edge.binding.page_id}:${edge.local.resolved_path}`
              const already = committed.get(targetKey)
              if (already) {
                inspection = yield* local.inspect(edge.binding.logical_path, {
                  trackedPaths: edge.intended.files.map((file) => file.path),
                })
                if (!same(inspection.proof.root, property(edge.local.proof).root))
                  return yield* Effect.fail(
                    fail(
                      "SYNC_TARGET_DRIFT",
                      "A duplicate real target link chain changed during apply.",
                    ),
                  )
              } else if (edge.local.content?.content_id !== edge.intended.content_id) {
                const result = yield* local.commit(
                  inspection,
                  yield* loadContent(edge.intended, edge.mode),
                  [
                    ...new Set([
                      ...(edge.base.content?.files.map((file) => file.path) ?? []),
                      ...(edge.local.content?.files.map((file) => file.path) ?? []),
                    ]),
                  ],
                  operationId,
                )
                inspection = result.inspection
                entry.retained = [...result.retained]
                committed.set(targetKey, inspection)
              } else {
                const fresh = yield* local.inspect(edge.binding.logical_path, {
                  allowMissing: !edge.base.initialized,
                  ...(edge.base.content
                    ? { trackedPaths: edge.base.content.files.map((file) => file.path) }
                    : {}),
                })
                if (
                  !same(fresh.proof, inspection.proof) ||
                  !same(fresh.file_hashes, inspection.file_hashes)
                )
                  return yield* Effect.fail(
                    fail("SYNC_PLAN_STALE", "Local target changed at the commit boundary.", {
                      binding_id: edge.binding.id,
                    }),
                  )
                inspection = fresh
                committed.set(targetKey, inspection)
              }
              // Verify the accepted remote result again after local fan-out; a competing
              // independent editor is divergence, never permission to adopt its content.
              const checkedRemote = yield* openSkill(edge.binding.page_id)
              const checkedLocal = yield* local.inspect(edge.binding.logical_path, {
                trackedPaths: edge.intended.files.map((file) => file.path),
              })
              if (
                !same(checkedLocal.proof, inspection.proof) ||
                !same(checkedLocal.file_hashes, inspection.file_hashes)
              )
                return yield* Effect.fail(
                  fail(
                    "SYNC_TARGET_DRIFT",
                    "Local destination changed after the commit boundary.",
                    { binding_id: edge.binding.id },
                  ),
                )
              entry.stage = "verified"
              yield* save()
              const next = yield* publishConvergence(
                edge.binding,
                edge.base,
                checkedLocal,
                checkedRemote,
                edge.mode,
                edge.intended.content_id,
                { receipt },
              )
              entry.stage = "complete"
              entry.generation_after = next.generation
              yield* save()
            }
          }
          receipt.status = "complete"
          yield* save()
          return {
            plan_id: plan.plan_id,
            operation_id: operationId,
            verified: true,
            receipt_path: `sqlite:sync_receipts/${operationId}`,
            receipt,
            bindings: receipt.bindings.map((entry) => {
              const edge = plan.bindings.find((item) => item.binding.id === entry.binding_id)!
              const snapshotId = receipt.groups.find(
                (group) => group.page_id === edge.binding.page_id,
              )?.snapshot_id
              return {
                ...entry,
                action: edge.direction,
                verified: true,
                content_id: edge.intended.content_id,
                snapshot_id: snapshotId,
                page_id: edge.binding.page_id,
                scope: edge.binding.scope,
                database_id: edge.binding.database_id,
                data_source_id: edge.binding.data_source_id,
              }
            }),
          }
        })
        return yield* execute.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              receipt.status = "pending"
              receipt.failure = { code: error.code }
              yield* save()
              return yield* Effect.fail(
                fail(error.code, error.message, {
                  operation_id: operationId,
                  receipt_path: `sqlite:sync_receipts/${operationId}`,
                  cause_details: error.details,
                  receipt,
                }),
              )
            }),
          ),
        )
      }),
    )
  })
}
export function syncStatus(binding?: string, options: SyncStatusOptions = {}) {
  return Effect.gen(function* () {
    const selected = yield* bindings(binding, !binding)
    const local = yield* SyncLocal
    const pending = yield* pendingReceipts()
    const policy = yield* effectiveCachePolicy
    const now = yield* Clock.currentTimeMillis
    const results = []
    for (const item of selected) {
      const base = yield* readBase(item)
      const inspection = yield* local.inspect(item.logical_path, {
        allowMissing: !base.initialized,
        ...(base.content ? { trackedPaths: base.content.files.map((file) => file.path) } : {}),
      })
      const observation = options.refresh
        ? { snapshot: yield* openSkill(item.page_id, { refresh: true }), validated_at: now }
        : yield* cachedRemoteObservation(item.page_id, item.scope)
      if (observation) yield* verifyRemote(item, observation.snapshot)
      const mode =
        observation && options.refresh ? yield* storageMode(observation.snapshot) : base.mode
      const localId = inspection.content
        ? yield* identity(inspection.content, mode ?? "exact")
        : undefined
      const remoteId = observation
        ? yield* identity(yield* snapshotPortable(observation.snapshot), mode ?? "exact")
        : undefined
      const age = observation ? now - observation.validated_at : undefined
      const stale =
        age === undefined ? null : !Number.isFinite(age) || age < 0 || age >= policy.read_max_age_ms
      const related = pending.filter((receipt) =>
        receipt.bindings.some(
          (entry) =>
            entry.page_id === item.page_id || entry.resolved_path === inspection.resolved_path,
        ),
      )
      results.push({
        binding: item,
        logical_path: inspection.logical_path,
        resolved_path: inspection.resolved_path,
        baseline_initialized: base.initialized,
        baseline_generation: base.generation,
        common_content_id: base.content?.content_id ?? null,
        local_content_id: localId ?? null,
        remote_content_id: remoteId ?? null,
        remote_snapshot_id: observation?.snapshot.snapshot_id ?? null,
        remote_version: observation?.snapshot.version_id ?? null,
        remote_validated_at: observation?.validated_at ?? null,
        remote_age_ms: age ?? null,
        remote_stale: stale,
        remote_freshness: !observation
          ? "unknown"
          : options.refresh
            ? "validated"
            : stale
              ? "stale"
              : "observed",
        equality_mode: mode ?? "unknown",
        authoritative: Boolean(options.refresh),
        provisional: !options.refresh,
        status: !base.initialized
          ? "needs_initialization"
          : remoteId === undefined || localId === undefined
            ? "unknown"
            : classify(base, localId, remoteId),
        pending_receipts: related.map((receipt) => ({
          operation_id: receipt.operation_id,
          receipt_path: `sqlite:sync_receipts/${receipt.operation_id}`,
        })),
      })
    }
    return { bindings: results }
  })
}
export function unbindSync(binding: string, options: UnbindSyncOptions = {}) {
  return Effect.gen(function* () {
    const local = yield* SyncLocal
    return yield* local.withLocks(
      ["sync:configuration"],
      Effect.gen(function* () {
        const selected = (yield* bindings(binding))[0]!
        yield* readBase(selected)
        const next = { ...selected, active: false, revision: selected.revision + 1 }
        if (!options.dryRun) {
          const store = yield* Store
          yield* store.registerBindingWithBase(next, yield* readBase(selected))
        }
        return {
          binding: options.dryRun ? selected : next,
          dry_run: Boolean(options.dryRun),
          deactivated: !options.dryRun,
          retained: {
            local_content: true,
            remote_content: true,
            baseline: true,
            plans: true,
            receipts: true,
          },
        }
      }),
    )
  })
}
export function reconcileSync(binding: string) {
  return Effect.gen(function* () {
    const local = yield* SyncLocal
    return yield* local.withLocks(
      ["sync:configuration"],
      Effect.gen(function* () {
        const registered = (yield* configuration).sync_bindings ?? []
        const matches = registered.filter((item) => item.id === binding || item.label === binding)
        if (!matches.length)
          return yield* Effect.fail(
            fail("SYNC_BINDING_MISSING", "No retained binding matched reconciliation."),
          )
        if (matches.length > 1)
          return yield* Effect.fail(
            fail("SYNC_BINDING_AMBIGUOUS", "Use a retained binding ID for reconciliation."),
          )
        const selected = matches[0]!
        const base = yield* readBase(selected)
        const root = yield* local.inspect(selected.logical_path, {
          allowMissing: !base.initialized,
          ...(base.content ? { trackedPaths: base.content.files.map((file) => file.path) } : {}),
        })
        const receipts = (yield* pendingReceipts()).filter((receipt) =>
          receipt.bindings.some(
            (entry) =>
              entry.page_id === selected.page_id || entry.resolved_path === root.resolved_path,
          ),
        )
        if (!receipts.length)
          return {
            binding: selected,
            outcome: "no_pending_operation",
            baseline_advanced: false,
            receipts: [],
          }
        const store = yield* Store
        const results = []
        for (const receipt of receipts) {
          const plan = yield* readPlan(receipt.plan_id)
          const active = (yield* configuration).sync_bindings ?? []
          let diverged = false
          let advanced = false
          for (const entry of receipt.bindings) {
            const edge = plan.bindings.find((item) => item.binding.id === entry.binding_id)
            if (!edge)
              return yield* Effect.fail(
                fail("STATE_CORRUPT", "Receipt references a binding absent from its plan."),
              )
            const currentBinding = active.find((item) => item.id === entry.binding_id)
            const permittedDeactivation =
              currentBinding &&
              !currentBinding.active &&
              currentBinding.revision === edge.binding.revision + 1
            if (
              !currentBinding ||
              !(
                same(currentBinding, edge.binding) ||
                (permittedDeactivation &&
                  same(
                    {
                      ...currentBinding,
                      active: edge.binding.active,
                      revision: edge.binding.revision,
                    },
                    edge.binding,
                  ))
              )
            )
              return yield* Effect.fail(
                fail(
                  "SYNC_PLAN_STALE",
                  "The unfinished operation binding target changed; its fence is retained.",
                  { operation_id: receipt.operation_id },
                ),
              )
            const currentBase = yield* readBase(currentBinding)
            let inspection = yield* local.inspect(currentBinding.logical_path, {
              allowMissing: !currentBase.initialized,
              trackedPaths: [
                ...new Set([
                  ...edge.intended.files.map((file) => file.path),
                  ...(edge.base.content?.files.map((file) => file.path) ?? []),
                ]),
              ],
            })
            if (inspection.resolved_path !== entry.resolved_path)
              return yield* Effect.fail(
                fail(
                  "SYNC_PLAN_STALE",
                  "The unfinished operation filesystem target changed; its fence is retained.",
                  { operation_id: receipt.operation_id },
                ),
              )
            const originalProof = property(edge.local.proof)
            const originalRoot = property(originalProof.root)
            const oldNodes = Array.isArray(originalRoot.nodes) ? originalRoot.nodes : []
            const newNodes = inspection.proof.root.nodes
            if (
              !oldNodes.length ||
              !same(oldNodes, edge.local.exists ? newNodes : newNodes.slice(0, oldNodes.length))
            )
              return yield* Effect.fail(
                fail(
                  "SYNC_PLAN_STALE",
                  "The unfinished operation link chain changed; its fence is retained.",
                  { operation_id: receipt.operation_id },
                ),
              )
            const originalFiles = Array.isArray(originalProof.files) ? originalProof.files : []
            for (const oldFile of originalFiles) {
              const oldEntry = property(oldFile)
              const oldProof = property(oldEntry.proof)
              const oldFileNodes = Array.isArray(oldProof.nodes) ? oldProof.nodes.map(property) : []
              const nextFile = inspection.proof.files.find((file) => file.path === oldEntry.path)
              if (!nextFile) {
                if (edge.intended.files.some((file) => file.path === oldEntry.path))
                  return yield* Effect.fail(
                    fail(
                      "SYNC_PLAN_STALE",
                      "A retained intended local file destination is unavailable.",
                    ),
                  )
                continue
              }
              const immutableNodes = oldFileNodes.filter((node) => node.kind !== "file")
              if (
                oldProof.resolved_path !== nextFile.proof.resolved_path ||
                !same(
                  immutableNodes,
                  nextFile.proof.nodes.filter((node) => node.kind !== "file"),
                )
              )
                return yield* Effect.fail(
                  fail(
                    "SYNC_PLAN_STALE",
                    "A local file link or parent changed during the unfinished operation; its fence is retained.",
                    { operation_id: receipt.operation_id, path: oldEntry.path },
                  ),
                )
            }
            const remote = yield* openSkill(currentBinding.page_id)
            yield* verifyRemote(currentBinding, remote)
            const mode = yield* storageMode(remote)
            if (mode !== edge.mode)
              return yield* Effect.fail(
                fail(
                  "SYNC_PLAN_STALE",
                  "The unfinished operation storage mode changed; its fence is retained.",
                ),
              )
            const rechecked = yield* local.inspect(currentBinding.logical_path, {
              allowMissing: !currentBase.initialized,
              trackedPaths: [
                ...new Set([
                  ...edge.intended.files.map((file) => file.path),
                  ...(edge.base.content?.files.map((file) => file.path) ?? []),
                ]),
              ],
            })
            if (
              !same(inspection.proof, rechecked.proof) ||
              !same(inspection.file_hashes, rechecked.file_hashes)
            )
              return yield* Effect.fail(
                fail(
                  "SYNC_TARGET_DRIFT",
                  "The local target changed during reconciliation; its fence is retained.",
                ),
              )
            inspection = rechecked
            const localId = inspection.content
              ? yield* identity(inspection.content, mode)
              : undefined
            const remoteId = yield* identity(yield* snapshotPortable(remote), mode)
            if (localId === edge.intended.content_id && remoteId === edge.intended.content_id) {
              // A crash after baseline publication but before receipt publication must not
              // increment the generation a second time.
              if (
                !same(currentBase, edge.base) &&
                !(
                  currentBase.initialized &&
                  currentBase.generation === edge.base.generation + 1 &&
                  currentBase.content?.content_id === edge.intended.content_id
                )
              )
                return yield* Effect.fail(
                  fail("SYNC_PLAN_STALE", "The unfinished operation common baseline changed."),
                )
              if (entry.stage === "complete") {
                if (
                  !currentBase.initialized ||
                  currentBase.content?.content_id !== edge.intended.content_id ||
                  currentBase.generation !== entry.generation_after
                )
                  return yield* Effect.fail(
                    fail(
                      "STATE_CORRUPT",
                      "A verified receipt edge disagrees with its published common baseline.",
                    ),
                  )
                continue
              }
              const next = yield* publishConvergence(
                currentBinding,
                currentBase,
                inspection,
                remote,
                mode,
                edge.intended.content_id,
                { receipt },
              )
              advanced ||= next.generation > edge.base.generation
              entry.stage = "complete"
              entry.generation_after = next.generation
            } else {
              if (
                !same(currentBase, edge.base) &&
                !(
                  entry.stage === "complete" &&
                  currentBase.initialized &&
                  currentBase.generation === entry.generation_after &&
                  currentBase.content?.content_id === edge.intended.content_id
                )
              )
                return yield* Effect.fail(
                  fail(
                    "STATE_CORRUPT",
                    "A divergent unfinished operation has an unexpected common baseline.",
                  ),
                )
              entry.stage = "diverged"
              diverged = true
            }
            yield* store.writeJson(receiptKey(receipt.operation_id), receipt)
          }
          receipt.status = diverged ? "diverged" : "complete"
          yield* store.writeJson(receiptKey(receipt.operation_id), receipt)
          results.push({
            operation_id: receipt.operation_id,
            outcome: receipt.status,
            baseline_advanced: advanced,
            receipt_path: `sqlite:sync_receipts/${receipt.operation_id}`,
            receipt,
          })
        }
        const result = {
          binding: selected,
          outcome: results.some((item) => item.outcome === "diverged") ? "diverged" : "complete",
          baseline_advanced: results.some((item) => item.baseline_advanced),
          receipts: results,
        }
        if (result.outcome === "diverged")
          return yield* Effect.fail(
            fail(
              "SYNC_DIVERGED",
              "Fresh readback classified divergence; old common baselines are retained and no mutation was replayed.",
              result,
            ),
          )
        return result
      }),
    )
  })
}
