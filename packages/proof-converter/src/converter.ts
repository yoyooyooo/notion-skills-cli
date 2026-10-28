import { Context, Crypto, Effect, FileSystem, Schema } from "effect"
import { Buffer } from "node:buffer"
import { join } from "node:path"
import {
  ContentRecordSchema,
  PageSchema,
  decode,
  fail,
  property,
  recordFromPage,
  SkillsError,
  aliasFor,
  SnapshotSchema,
  text,
  type Snapshot,
} from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import {
  publicationGuard,
  publicationManifest,
  publicationOwnership,
} from "../../core/src/publication-integrity.ts"
import { readReferences, rewritePageLinks, withoutChildPages } from "../../core/src/references.ts"
import { canonicalMain } from "../../core/src/portable.ts"
import { fromNotionMarkdown } from "../../core/src/markdown.ts"
import { pageId } from "../../core/src/ref.ts"
import { sha256 } from "../../core/src/store.ts"
import { PublicationMarkerSchema } from "../../core/src/publication-integrity-state.ts"
import { metadata } from "../../core/src/publication-observation.ts"

// Historical formulas belong exclusively to this separate artifact. Runtime never imports it.
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Id = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
)
const Nonempty = Schema.String.check(Schema.isPattern(/\S/))
export const OldMarkerSchema = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literal("committed"),
  operation_id: Nonempty,
  intended_hash: Hash,
  manifest_hash: Hash,
  ownership_hash: Hash,
  revision: Hash,
})
const TargetSchema = Schema.Struct({
  page_id: Id,
  database_id: Id,
  data_source_id: Id,
  source_format: Schema.Literals([
    "original-provenance-v1",
    "extended-guard-v1",
    "canonical-name-v2",
  ]),
  expected_publication: Nonempty,
  expected_default_context: Schema.Boolean,
  expected_members: Schema.Array(Id),
  audit_ref: Nonempty,
  audit_sha256: Hash,
  canonical_baseline_ref: Schema.optional(Nonempty),
  canonical_baseline_sha256: Schema.optional(Hash),
})
export const InputSchema = Schema.Struct({
  format: Schema.Literal(1),
  targets: Schema.Array(TargetSchema),
})
export type Target = typeof TargetSchema.Type
const FileSchema = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  sha256: Hash,
  base64: Schema.String,
})
export const CanonicalBaselineSchema = Schema.Struct({
  format: Schema.Literal(1),
  snapshot: Schema.Struct({
    ...SnapshotSchema.fields,
    router_members: Schema.optional(
      Schema.Array(
        Schema.Union([
          Schema.Struct({ id: Schema.String, ref: Schema.String, metadata: Schema.Unknown }),
          Schema.Struct({
            id: Schema.String,
            kind: Schema.Literal("skill"),
            name: Schema.String,
            description: Schema.String,
            ref: Schema.String,
            metadata: Schema.Unknown,
          }),
        ]),
      ),
    ),
  }),
  files: Schema.Array(FileSchema),
  receipt_ref: Nonempty,
  receipt_sha256: Hash,
})
const ObservationSchema = Schema.Struct({
  credential_identity: Hash,
  audit_base64: Schema.String,
  canonical_baseline_base64: Schema.optional(Schema.String),
  receipt_base64: Schema.optional(Schema.String),
  version_id: Schema.String,
  raw_page: Schema.Unknown,
  // Response evidence excludes per-call request IDs and expiring URLs; full content bytes remain below.
  reads: Schema.Record(Schema.String, Schema.Unknown),
  record: ContentRecordSchema,
  references: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      markdown: Schema.String,
      blocks: Schema.optional(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            type: Schema.String,
            has_children: Schema.Boolean,
            text: Schema.optional(Schema.String),
            numbered_list: Schema.optional(Schema.Struct({ start: Schema.NullOr(Schema.Number) })),
          }),
        ),
      ),
    }),
  ),
  files: Schema.Array(FileSchema),
  publication: Schema.String,
  ownership: Schema.Unknown,
  guard: Schema.Unknown,
  manifest_hash: Hash,
})
const PlannedTargetSchema = Schema.Struct({
  input: TargetSchema,
  before: ObservationSchema,
  after: Schema.Struct({ publication: Schema.String }),
})
export const PlanSchema = Schema.Struct({
  format: Schema.Literal(1),
  kind: Schema.Literals(["remote-proof-v1-to-v2", "remote-proof-canonical-name-v2"]),
  targets: Schema.Array(PlannedTargetSchema),
})
export type Plan = typeof PlanSchema.Type
export type PlannedTarget = typeof PlannedTargetSchema.Type
export type Observation = typeof ObservationSchema.Type
const attempt = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("CONVERSION_BLOCKED", "Invalid converter input or evidence."),
  })
export const strict = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  raw: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(raw, { onExcessProperty: "error" })

function markerText(raw: unknown): string {
  const field = property(property(property(raw).properties).Publication)
  if (field.type !== "rich_text" || typeof field.id !== "string" || !Array.isArray(field.rich_text))
    throw fail(
      "CONVERSION_BLOCKED",
      "Conversion requires an existing Publication rich-text property with its exact property ID.",
    )
  const value = text(field.rich_text)
  if (!value)
    throw fail("CONVERSION_BLOCKED", "Unmanaged pages cannot be enrolled by proof conversion.")
  return value
}
// Response request IDs identify a transport call; signed attachment URLs rotate independently of bytes.
function stableMetadata(value: unknown, response = true): unknown {
  if (Array.isArray(value)) return value.map((item) => stableMetadata(item, false))
  if (!value || typeof value !== "object") return value
  const row = property(value)
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key, item]) => !(response && key === "request_id" && typeof item === "string"))
      .map(([key, item]) => [
        key,
        key === "file" && item && typeof item === "object"
          ? { ...property(item), url: "<downloaded-byte-identity>", expiry_time: "<ephemeral>" }
          : stableMetadata(item, false),
      ]),
  )
}
function validateTargets(targets: readonly Target[]) {
  if (!targets.length || new Set(targets.map((target) => target.page_id)).size !== targets.length)
    throw fail("CONVERSION_BLOCKED", "Enumerate at least one unique, explicitly owned page.")
  for (const target of targets) {
    const canonicalName = target.source_format === "canonical-name-v2"
    const marker = strict(
      canonicalName ? PublicationMarkerSchema : OldMarkerSchema,
      JSON.parse(target.expected_publication),
    )
    if (
      marker.state !== "committed" ||
      canonicalName !==
        (target.canonical_baseline_ref !== undefined &&
          target.canonical_baseline_sha256 !== undefined) ||
      (!canonicalName &&
        (target.canonical_baseline_ref !== undefined ||
          target.canonical_baseline_sha256 !== undefined))
    )
      throw fail(
        "CONVERSION_BLOCKED",
        "Canonical name conversion requires its exact retained baseline and committed v2 proof.",
      )
    if (
      canonical(target.expected_members) !== canonical([...new Set(target.expected_members)].sort())
    )
      throw fail(
        "CONVERSION_BLOCKED",
        "expected_members must be explicit, sorted, unique canonical page IDs.",
      )
  }
}

/** Direct reference reader deliberately bypasses openSkill and the v2-only publication reader. */
export function observe(target: Target, expectedPublication: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const credential_identity = yield* api.credentialIdentity
    const fs = yield* FileSystem.FileSystem
    const auditBytes = yield* fs.readFile(target.audit_ref)
    if ((yield* sha256(auditBytes)) !== target.audit_sha256)
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Retained baseline file differs from audit_sha256."),
      )
    let canonical_baseline_base64: string | undefined
    let receipt_base64: string | undefined
    if (target.source_format === "canonical-name-v2") {
      const bytes = yield* fs.readFile(target.canonical_baseline_ref!)
      if ((yield* sha256(bytes)) !== target.canonical_baseline_sha256)
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "Canonical baseline differs from its exact reviewed hash."),
        )
      const baseline = yield* attempt(() =>
        strict(CanonicalBaselineSchema, JSON.parse(new TextDecoder().decode(bytes))),
      )
      const receipt = yield* fs.readFile(baseline.receipt_ref)
      if ((yield* sha256(receipt)) !== baseline.receipt_sha256)
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "Original receipt differs from its retained hash."),
        )
      canonical_baseline_base64 = Buffer.from(bytes).toString("base64")
      receipt_base64 = Buffer.from(receipt).toString("base64")
    }
    yield* attempt(() => {
      const audit = JSON.parse(new TextDecoder().decode(auditBytes))
      const parent = property(property(audit).parent)
      const guard = publicationGuard(audit)
      if (
        pageId(String(property(audit).id)) !== target.page_id ||
        pageId(String(parent.database_id)) !== target.database_id ||
        pageId(String(parent.data_source_id)) !== target.data_source_id ||
        markerText(audit) !== target.expected_publication ||
        property(property(audit).properties)["Default Context"] === undefined ||
        property(property(audit).properties).Members === undefined ||
        guard.default_context !== target.expected_default_context ||
        canonical(guard.members) !== canonical(target.expected_members)
      )
        throw fail(
          "CONVERSION_BLOCKED",
          "Retained baseline metadata does not establish the exact old page, marker and explicit Members/Default Context expectations.",
        )
    })
    const raw = yield* api.request(`v1/pages/${target.page_id}`)
    const record = yield* attempt(() => {
      const parent = property(property(raw).parent)
      if (
        pageId(String(property(raw).id)) !== target.page_id ||
        property(raw).archived === true ||
        property(raw).in_trash === true ||
        pageId(String(parent.database_id)) !== target.database_id ||
        pageId(String(parent.data_source_id)) !== target.data_source_id
      )
        throw fail(
          "CONVERSION_BLOCKED",
          "Exact live page and content-library parent must match the operator allowlist.",
        )
      if (markerText(raw) !== expectedPublication)
        throw fail("CONVERSION_BLOCKED", "Publication differs from the exact expected marker.")
      const guard = publicationGuard(raw)
      // Missing metadata cannot silently stand for an explicitly reviewed false/empty value.
      const fields = property(property(raw).properties)
      if (
        fields["Default Context"] === undefined ||
        fields.Members === undefined ||
        guard.default_context !== target.expected_default_context ||
        canonical(guard.members) !== canonical(target.expected_members)
      )
        throw fail(
          "CONVERSION_BLOCKED",
          "Members or Default Context differ from explicit operator evidence.",
        )
      return recordFromPage(
        decode(PageSchema, raw),
        {
          alias: target.database_id,
          database_id: target.database_id,
          title: "",
          data_source_ids: [target.data_source_id],
          role: "content",
        },
        target.data_source_id,
      )
    })
    const reads: Record<string, unknown> = {}
    const recording: Context.Service.Shape<typeof Notion> = {
      ...api,
      request: (path, body, options) => {
        if (body !== undefined || (options?.method !== undefined && options.method !== "GET"))
          return Effect.fail(fail("CONVERSION_BLOCKED", "Planning reader attempted a mutation."))
        return api.request(path).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              reads[path] = stableMetadata(value)
            }),
          ),
        )
      },
    }
    const references = yield* readReferences(record, raw).pipe(
      Effect.provideService(Notion, recording),
    )
    const files: Array<typeof FileSchema.Type> = []
    for (const file of references.files)
      files.push({
        path: file.path,
        bytes: file.bytes.length,
        sha256: yield* sha256(file.bytes),
        base64: Buffer.from(file.bytes).toString("base64"),
      })
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    if (new Set(files.map((file) => file.path)).size !== files.length)
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Duplicate projected asset paths cannot be converted."),
      )
    const snapshot: Snapshot = {
      snapshot_id: "proof-conversion",
      scope: "proof-conversion",
      record,
      entrypoint: record.entrypoint,
      version_id: references.version_id,
      created_at: 0,
      files,
      references: references.pages,
      router_members: references.members,
    }
    const manifest_hash = yield* sha256(canonical(yield* publicationManifest(snapshot)))
    // Re-read every reference/property response, then root metadata last. No writes occur here.
    for (const [path, before] of Object.entries(reads)) {
      const after = yield* api.request(path)
      if (canonical(stableMetadata(after)) !== canonical(before))
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "Reference metadata or Markdown changed while reading.", {
            path,
          }),
        )
    }
    const end = yield* api.request(`v1/pages/${target.page_id}`)
    if (canonical(stableMetadata(end)) !== canonical(stableMetadata(raw)))
      return yield* Effect.fail(fail("CONVERSION_BLOCKED", "Root metadata changed while reading."))
    if ((yield* api.credentialIdentity) !== credential_identity)
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Credential identity changed during observation."),
      )
    return {
      version_id: references.version_id,
      ...(canonical_baseline_base64 === undefined
        ? {}
        : { canonical_baseline_base64, receipt_base64 }),
      raw_page: raw,
      reads,
      record,
      references: references.pages,
      files,
      publication: expectedPublication,
      credential_identity,
      audit_base64: Buffer.from(auditBytes).toString("base64"),
      ownership: yield* attempt(() => publicationOwnership(raw)),
      guard: yield* attempt(() => publicationGuard(raw)),
      manifest_hash,
    } satisfies Observation
  })
}
function comparableRoot(raw: unknown, afterWrite: boolean) {
  const root = { ...property(stableMetadata(raw)) }
  if (afterWrite) {
    delete root.last_edited_time
    delete root.last_edited_by
    const fields = { ...property(root.properties) }
    for (const [name, field] of Object.entries(fields)) {
      const value = { ...property(field) }
      if (value.type === "last_edited_time") delete value.last_edited_time
      if (value.type === "last_edited_by") delete value.last_edited_by
      fields[name] = value
    }
    const publication = { ...property(fields.Publication) }
    delete publication.rich_text
    fields.Publication = publication
    root.properties = fields
  }
  return root
}
function comparable(observation: Observation, afterWrite = false) {
  const raw_page = comparableRoot(observation.raw_page, afterWrite)
  if (!afterWrite) return { ...observation, raw_page }
  // The reference reader also brackets the graph with this exact root response.
  // Apply the same own-PATCH exclusions to both copies; every other read stays exact.
  const rootPath = `v1/pages/${pageId(String(property(observation.raw_page).id))}`
  const reads = Object.fromEntries(
    Object.entries(observation.reads).map(([path, value]) => [
      path,
      path === rootPath ? comparableRoot(value, true) : value,
    ]),
  )
  return { ...observation, raw_page, reads, publication: "<converted>" }
}

function retainedBytes(file: typeof FileSchema.Type) {
  return Effect.gen(function* () {
    const bytes = Buffer.from(file.base64, "base64")
    if (
      bytes.toString("base64") !== file.base64 ||
      bytes.length !== file.bytes ||
      (yield* sha256(bytes)) !== file.sha256
    )
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Retained file bytes do not match their declared identity."),
      )
    return bytes
  })
}
function replaceCanonicalName(bytes: Uint8Array, oldName: string, newName: string) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  const line = `"name": ${JSON.stringify(oldName)}`
  const match = /^---\n([\s\S]*?)\n---\n\n/.exec(source)
  if (!match || match[1]!.split("\n").filter((value) => value === line).length !== 1)
    throw fail(
      "CONVERSION_BLOCKED",
      "Historical entrypoint must have the exact canonical alias name field.",
    )
  return new TextEncoder().encode(
    source.replace(match[0], match[0].replace(line, `"name": ${JSON.stringify(newName)}`)),
  )
}
function canonicalNameManifest(target: Target, before: Observation) {
  return Effect.gen(function* () {
    const baselineBytes = Buffer.from(before.canonical_baseline_base64 ?? "", "base64")
    const receiptBytes = Buffer.from(before.receipt_base64 ?? "", "base64")
    if (
      baselineBytes.toString("base64") !== before.canonical_baseline_base64 ||
      (yield* sha256(baselineBytes)) !== target.canonical_baseline_sha256
    )
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Retained canonical baseline identity does not verify."),
      )
    const baseline = yield* attempt(() =>
      strict(CanonicalBaselineSchema, JSON.parse(baselineBytes.toString("utf8"))),
    )
    if (
      receiptBytes.toString("base64") !== before.receipt_base64 ||
      (yield* sha256(receiptBytes)) !== baseline.receipt_sha256
    )
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Original receipt identity does not verify."),
      )
    const snapshot = baseline.snapshot
    yield* attempt(() => {
      const outer = property(JSON.parse(receiptBytes.toString("utf8")))
      const receipt = typeof outer.stdout === "string" ? property(JSON.parse(outer.stdout)) : outer
      if (
        receipt.ok !== true ||
        receipt.verified !== true ||
        receipt.snapshot_id !== snapshot.snapshot_id ||
        receipt.version_id !== snapshot.version_id ||
        canonical(receipt.record) !== canonical(snapshot.record) ||
        canonical(snapshot.record) !== canonical(before.record) ||
        canonical(snapshot.references) !== canonical(before.references)
      )
        throw fail(
          "CONVERSION_BLOCKED",
          "Original verified receipt, historical raw references and exact record must match the retained snapshot and current graph.",
        )
    })
    const audit = yield* attempt(() =>
      JSON.parse(Buffer.from(before.audit_base64, "base64").toString("utf8")),
    )
    if (
      (yield* sha256(Buffer.from(before.audit_base64, "base64"))) !== target.audit_sha256 ||
      canonical(metadata(audit)) !== canonical(metadata(before.raw_page))
    )
      return yield* Effect.fail(
        fail(
          "CONVERSION_BLOCKED",
          "Current raw metadata must match the retained original publication metadata exactly.",
        ),
      )
    if (
      snapshot.historical_snapshot_id !== undefined ||
      snapshot.snapshot_id !==
        `s_${yield* sha256(JSON.stringify([snapshot.scope, snapshot.record.id, snapshot.version_id]))}` ||
      snapshot.entrypoint !== before.record.entrypoint
    )
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Original snapshot identity does not verify."),
      )
    const files = [...baseline.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )
    const declared = [...snapshot.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )
    if (
      new Set(files.map((file) => file.path)).size !== files.length ||
      canonical(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))) !==
        canonical(declared) ||
      files.length !== before.files.length ||
      !files.some((file) => file.path === "ntn-skills-source.zip")
    )
      return yield* Effect.fail(
        fail(
          "CONVERSION_BLOCKED",
          "Historical files must exactly cover the original snapshot including the source archive.",
        ),
      )
    for (const [index, file] of files.entries()) {
      const bytes = yield* retainedBytes(file)
      const current = before.files[index]!
      const expected =
        file.path === snapshot.entrypoint
          ? yield* attempt(() =>
              replaceCanonicalName(bytes, aliasFor(snapshot.record.name), snapshot.record.name),
            )
          : bytes
      if (
        current.path !== file.path ||
        !Buffer.from(expected).equals(yield* retainedBytes(current))
      )
        return yield* Effect.fail(
          fail(
            "CONVERSION_BLOCKED",
            "Only the mechanically derived canonical name field may differ; raw content and every resource must remain identical.",
            { path: file.path },
          ),
        )
    }
    const manifest = yield* publicationManifest(snapshot)
    if (snapshot.record.kind === "router") {
      // Router manifests exclude generated Members from the authored root tuple.
      const raw = snapshot.references!.find((page) => page.path === snapshot.entrypoint)!
      const body = fromNotionMarkdown(
        rewritePageLinks(
          withoutChildPages(raw.markdown),
          snapshot.entrypoint,
          snapshot.references!,
          "local",
          snapshot.router_members,
        ),
      )
      const current = canonicalMain(snapshot.record.name, snapshot.record.description, body, {
        path: snapshot.entrypoint,
        bytes: new Uint8Array(),
      })
      const legacy = yield* attempt(() =>
        replaceCanonicalName(current.bytes, snapshot.record.name, aliasFor(snapshot.record.name)),
      )
      const entry = manifest.files.find((file) => file[0] === snapshot.entrypoint)!
      entry[1] = legacy.length
      entry[2] = yield* sha256(legacy)
    }
    const currentManifest = yield* publicationManifest({ ...snapshot, files: before.files })
    if ((yield* sha256(canonical(currentManifest))) !== before.manifest_hash)
      return yield* Effect.fail(
        fail(
          "CONVERSION_BLOCKED",
          "Current canonical manifest does not match the complete observed graph.",
        ),
      )
    return yield* sha256(canonical(manifest))
  })
}
export function plannedTarget(target: Target, before: Observation) {
  return Effect.gen(function* () {
    const old = yield* attempt(() =>
      strict(
        target.source_format === "canonical-name-v2" ? PublicationMarkerSchema : OldMarkerSchema,
        JSON.parse(target.expected_publication),
      ),
    )
    if (old.state !== "committed")
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Only committed historical proofs may be converted."),
      )
    const oldManifest =
      target.source_format === "canonical-name-v2"
        ? yield* canonicalNameManifest(target, before)
        : before.manifest_hash
    if (target.source_format === "canonical-name-v2" && oldManifest === before.manifest_hash)
      return yield* Effect.fail(
        fail(
          "CONVERSION_BLOCKED",
          "Canonical name conversion requires an actual, exactly derived name projection change.",
        ),
      )
    const oldOwnership = yield* sha256(
      canonical(
        target.source_format === "original-provenance-v1" ? before.ownership : before.guard,
      ),
    )
    const oldRevision = yield* sha256(
      canonical([old.operation_id, old.intended_hash, oldManifest, oldOwnership]),
    )
    if (
      before.publication !== target.expected_publication ||
      old.manifest_hash !== oldManifest ||
      old.ownership_hash !== oldOwnership ||
      old.revision !== oldRevision
    )
      return yield* Effect.fail(
        fail(
          "CONVERSION_BLOCKED",
          "The old committed manifest, provenance guard or revision formula does not verify.",
        ),
      )
    const ownership_hash = yield* sha256(canonical(before.guard))
    const revision = yield* sha256(
      canonical([old.operation_id, old.intended_hash, before.manifest_hash, ownership_hash]),
    )
    const publication = JSON.stringify({
      version: 2,
      state: "committed",
      operation_id: old.operation_id,
      intended_hash: old.intended_hash,
      revision,
      manifest_hash: before.manifest_hash,
      ownership_hash,
      ...("creation" in old && old.creation !== undefined ? { creation: old.creation } : {}),
    })
    return { input: target, before, after: { publication } } satisfies PlannedTarget
  })
}
export function makePlan(input: typeof InputSchema.Type) {
  return Effect.gen(function* () {
    yield* attempt(() => {
      strict(InputSchema, input)
      validateTargets(input.targets)
    })
    const targets: PlannedTarget[] = []
    for (const target of input.targets) {
      const before = yield* observe(target, target.expected_publication)
      const repeated = yield* observe(target, target.expected_publication)
      if (canonical(comparable(before)) !== canonical(comparable(repeated)))
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "Content changed between complete planning reads."),
        )
      targets.push(yield* plannedTarget(target, before))
    }
    const canonicalName = input.targets.some(
      (target) => target.source_format === "canonical-name-v2",
    )
    if (
      canonicalName &&
      input.targets.some((target) => target.source_format !== "canonical-name-v2")
    )
      return yield* Effect.fail(
        fail(
          "CONVERSION_BLOCKED",
          "Canonical name migration cannot be mixed with historical v1 conversion.",
        ),
      )
    return {
      format: 1,
      kind: canonicalName ? "remote-proof-canonical-name-v2" : "remote-proof-v1-to-v2",
      targets,
    } satisfies Plan
  })
}

/** Atomic no-replace installation, synced before a remote mutation can begin. */
export function persistExclusive(path: string, value: unknown) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const crypto = yield* Crypto.Crypto
      const staged = `${path}.${yield* crypto.randomUUIDv4()}.pending`
      const handle = yield* fs.open(staged, { flag: "wx", mode: 0o600, noFollow: true })
      yield* Effect.addFinalizer(() => fs.remove(staged, { force: true }).pipe(Effect.orDie))
      yield* handle.writeAll(new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n"))
      yield* handle.sync
      const installed = yield* fs.link(staged, path).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      )
      yield* (yield* fs.open(join(path, ".."), { flag: "r" })).sync
      return installed
    }),
  )
}
const AttemptSchema = Schema.Struct({
  format: Schema.Literal(1),
  kind: Schema.Literal("remote-proof-conversion-attempt"),
  plan_hash: Hash,
  page_id: Id,
  target: PlannedTargetSchema,
})
export type ConversionResult = {
  page_id: string
  state: "converted" | "unchanged" | "conflict" | "unknown"
  wrote: boolean
  detail?: string
}

/** Any durable attempt, even a crash before send, permanently forbids a second PATCH. */
export function applyPlan(planBytes: string, expectedHash: string, ledger: string, apply: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const api = yield* Notion
    const crypto = yield* Crypto.Crypto
    const plan = yield* attempt(() => strict(PlanSchema, JSON.parse(planBytes)))
    const planHash = yield* sha256(planBytes)
    if (planHash !== expectedHash)
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Reviewed plan file bytes differ from --expected-plan-hash."),
      )
    yield* attempt(() => validateTargets(plan.targets.map((target) => target.input)))
    if (
      plan.targets.some(
        (target) =>
          (target.input.source_format === "canonical-name-v2") !==
          (plan.kind === "remote-proof-canonical-name-v2"),
      )
    )
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Plan kind must match every explicit source formula."),
      )
    // Validate every planned formula before considering any write.
    for (const target of plan.targets) {
      const rebuilt = yield* plannedTarget(target.input, target.before)
      if (canonical(rebuilt) !== canonical(target))
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "Plan contains an inconsistent after marker."),
        )
      for (const file of target.before.files) {
        const bytes = Buffer.from(file.base64, "base64")
        if (
          bytes.toString("base64") !== file.base64 ||
          bytes.length !== file.bytes ||
          (yield* sha256(bytes)) !== file.sha256
        )
          return yield* Effect.fail(
            fail("CONVERSION_BLOCKED", "Retained plan bytes do not match their declared identity."),
          )
      }
    }
    yield* fs.makeDirectory(ledger, { recursive: true, mode: 0o700 })
    const results: ConversionResult[] = []
    for (const target of plan.targets) {
      const id = target.input.page_id
      const attemptPath = join(ledger, `${id}.attempt.json`)
      const intent = {
        format: 1 as const,
        kind: "remote-proof-conversion-attempt" as const,
        plan_hash: planHash,
        page_id: id,
        target,
      }
      const exists = yield* fs.exists(attemptPath)
      let wrote = false
      let writeOutcome: unknown = { state: "not-sent" }
      if (exists) {
        const source = yield* fs.readFileString(attemptPath)
        const retained = yield* attempt(() => strict(AttemptSchema, JSON.parse(source)))
        if (canonical(retained) !== canonical(intent))
          return yield* Effect.fail(
            fail(
              "CONVERSION_BLOCKED",
              "This page already has a different retained attempt; inspect it without writing.",
            ),
          )
      } else if (apply) {
        const current = yield* observe(target.input, target.input.expected_publication)
        if (canonical(comparable(current)) !== canonical(comparable(target.before)))
          return yield* Effect.fail(
            fail("CONVERSION_BLOCKED", "Current bytes or metadata differ from the reviewed plan."),
          )
        // Durable attempt precedes the last metadata reread and the only possible PATCH.
        const installed = yield* persistExclusive(attemptPath, intent)
        if (installed) {
          const immediate = yield* api.request(`v1/pages/${id}`)
          if (canonical(stableMetadata(immediate)) !== canonical(stableMetadata(current.raw_page)))
            return yield* Effect.fail(
              fail(
                "CONVERSION_BLOCKED",
                "Root changed immediately before write; attempt retained and cannot be retried.",
              ),
            )
          if ((yield* api.credentialIdentity) !== current.credential_identity)
            return yield* Effect.fail(
              fail("CONVERSION_BLOCKED", "Credential scope changed immediately before write."),
            )
          wrote = true
          const response = yield* api
            .request(
              `v1/pages/${id}`,
              {
                properties: {
                  [String(property(property(property(immediate).properties).Publication).id)]: {
                    rich_text: [{ type: "text", text: { content: target.after.publication } }],
                  },
                },
              },
              { method: "PATCH" },
            )
            .pipe(Effect.result)
          writeOutcome =
            response._tag === "Success"
              ? { state: "response-received", raw: response.success }
              : {
                  state: "request-failed",
                  code: response.failure.code,
                  details: response.failure.details,
                }
        } else {
          const source = yield* fs.readFileString(attemptPath)
          if (
            canonical(yield* attempt(() => strict(AttemptSchema, JSON.parse(source)))) !==
            canonical(intent)
          )
            return yield* Effect.fail(
              fail("CONVERSION_BLOCKED", "Concurrent converter attempt differs; no write sent."),
            )
        }
      }
      // Always inspect metadata immediately after the request, including unknown transport outcomes.
      const readback = yield* Effect.gen(function* () {
        const raw = yield* api.request(`v1/pages/${id}`)
        const marker = yield* attempt(() => markerText(raw))
        if (marker === target.after.publication) {
          const observed = yield* observe(target.input, target.after.publication)
          if (canonical(comparable(observed, true)) !== canonical(comparable(target.before, true)))
            return {
              page_id: id,
              state: "conflict" as const,
              wrote,
              detail: "New marker observed but preserved bytes or metadata differ.",
              raw_page: raw,
            }
          return { page_id: id, state: "converted" as const, wrote, raw_page: raw, observed }
        }
        if (marker === target.input.expected_publication) {
          const observed = yield* observe(target.input, target.input.expected_publication)
          const same = canonical(comparable(observed)) === canonical(comparable(target.before))
          return {
            page_id: id,
            state: same ? ("unchanged" as const) : ("conflict" as const),
            wrote,
            raw_page: raw,
            observed,
          }
        }
        return {
          page_id: id,
          state: "conflict" as const,
          wrote,
          detail: "Remote marker differs from both exact planned markers.",
          raw_page: raw,
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            page_id: id,
            state: "unknown" as const,
            wrote,
            detail: error instanceof SkillsError ? error.code : "READBACK_FAILED",
          }),
        ),
      )
      yield* persistExclusive(
        join(ledger, `${id}.${yield* crypto.randomUUIDv4()}.observation.json`),
        {
          format: 1,
          kind: "remote-proof-conversion-observation",
          plan_hash: planHash,
          write_outcome: writeOutcome,
          ...readback,
        },
      )
      results.push({
        page_id: readback.page_id,
        state: readback.state,
        wrote: readback.wrote,
        ...("detail" in readback ? { detail: readback.detail } : {}),
      })
      if (readback.state !== "converted") break
    }
    return { plan_hash: planHash, results }
  })
}
