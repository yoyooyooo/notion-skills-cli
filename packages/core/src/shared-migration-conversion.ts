import { Effect, Schema } from "effect"
import { importDocument } from "./import.ts"
import {
  ContentKindSchema,
  entrypointFor,
  fail,
  property,
  SkillsError,
  validateDescription,
  validateDisplayName,
} from "./model.ts"
import { pageId } from "./ref.ts"
import { sharedSkillId } from "./shared-content.ts"
import { composeSharedFiles } from "./shared-composition.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import {
  FileEventSchema,
  normalizeObservedBody,
  RetainedContentSchema,
  type FileEvent,
} from "./shared-file-state.ts"
import { gitBlobOid } from "./shared-github-source.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import {
  migrationConversionPolicy,
  resolveMigrationActivation,
  SharedMigrationActivationSchema,
  type SharedMigrationActivation,
} from "./shared-migration-activation.ts"
import {
  prepareSharedMigrationCreateInput,
  reviewSharedMigrationCreateInput,
  type MigrationCopyExecutionPolicy,
  type MigrationCreateBindingInput,
  type MigrationRetainedFile,
} from "./shared-migration-create-binding.ts"
import {
  SharedMigrationEntrySchema,
  SharedMigrationPreservedItemSchema,
  type SharedMigrationEntry,
} from "./shared-migration-plan.ts"
import {
  projectSharedNotionMarkdown,
  SharedNotionMarkdownProjectionSchema,
} from "./shared-notion-projection.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  makeSourceBinding,
  SharedGitSourceBindingSchema,
  type SharedGitSourceBinding,
} from "./shared-source-binding.ts"
import { sha256 } from "./store.ts"
import { parseYaml } from "./yaml.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Size = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const TextObject = Schema.Struct({
  text: Schema.String,
  sha256: Hash,
  bytes: Size,
  retention_ref: Schema.String,
})
const NativeFields = {
  kind: Schema.Literal("notion_page_markdown"),
  page_id: Schema.String,
  api_version: Schema.Literal("2026-03-11"),
  markdown_version: Schema.Literals(["default", "v2"]),
  request_path: Schema.String,
  retention_ref: Schema.String,
}
export const MigrationNativePreimageSchema = Schema.Struct({
  ...NativeFields,
  response_json: Schema.String,
})
export type MigrationNativePreimage = typeof MigrationNativePreimageSchema.Type
const NativeEvidenceSchema = Schema.Struct({
  ...NativeFields,
  response_json: Schema.String,
  response_sha256: Hash,
  response_bytes: Size,
  body_sha256: Hash,
})
const SourceFileSchema = Schema.Struct({
  path: Schema.String,
  retention_ref: Schema.String,
  sha256: Hash,
  bytes: Size,
  base64: Schema.String,
})
const MetadataSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  kind: ContentKindSchema,
  enabled: Schema.Literal(true),
  default_context: Schema.Boolean,
  entrypoint: Schema.String,
})
const MemberSchema = Schema.Struct({
  legacy_id: Schema.String,
  skill_id: Identity,
  record_id: Schema.String,
  page_id: Schema.Null,
})
const ConvertedFileSchema = Schema.Struct({
  legacy_id: Schema.String,
  file_id: Identity,
  path: Schema.String,
  selection: Schema.Literals(["current", "source"]),
  original: TextObject,
  native_preimage: NativeEvidenceSchema,
  input: TextObject,
  projection: SharedNotionMarkdownProjectionSchema,
  content: RetainedContentSchema,
  initial_event: FileEventSchema,
})
export const SharedMigrationConversionCandidateSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("migration_create_candidate"),
  conversion_policy: Schema.Literals(["legacy_page_to_native_v1", "legacy_page_to_native_v2"]),
  /** Absent in saved candidates: retain their original full-plan execution gate. */
  execution_policy: Schema.optional(Schema.Literal("copy_to_new_native_v1")),
  activation: Schema.optional(SharedMigrationActivationSchema),
  candidate_id: Schema.String.check(Schema.isPattern(/^migration-create-[a-f0-9]{64}$/u)),
  migration_plan_id: Schema.String,
  migration_input_sha256: Hash,
  legacy_id: Schema.String,
  skill_id: Identity,
  record_id: Schema.String,
  library: SharedLibrarySchema,
  metadata: MetadataSchema,
  legacy_entry: Schema.Unknown,
  legacy_source: Schema.NullOr(Schema.Unknown),
  legacy_router: Schema.NullOr(Schema.Unknown),
  source: Schema.NullOr(SharedGitSourceBindingSchema),
  source_files: Schema.Array(SourceFileSchema),
  files: Schema.Array(ConvertedFileSchema),
  member_bindings: Schema.Array(MemberSchema),
  reference_check: Schema.Struct({ checked_files: Size, local_references: Size }),
  execution: Schema.Struct({
    apply_allowed: Schema.Literal(false),
    original_migration_input_required: Schema.Literal(true),
    physical_bindings_verified: Schema.Literal(false),
    native_receipt_verified: Schema.Literal(false),
  }),
})
export type SharedMigrationConversionCandidate =
  typeof SharedMigrationConversionCandidateSchema.Type
export type MigrationConversionFile = MigrationRetainedFile & {
  readonly native_preimage: MigrationNativePreimage
}
export type MigrationSourceFile = {
  readonly path: string
  readonly retention_ref: string
  readonly bytes: Uint8Array
}
export type MigrationConversionInput = Omit<MigrationCreateBindingInput, "files"> & {
  readonly files: readonly MigrationConversionFile[]
  /** Explicitly bound into the candidate, origin and public review digest. */
  readonly execution_policy?: MigrationCopyExecutionPolicy
  /** The complete selected fixed tree, including assets that will never be body pages. */
  readonly source_files?: readonly MigrationSourceFile[]
}

const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SHARED_MIGRATION_CONVERSION_INVALID",
            "Invalid explicit migration conversion evidence.",
          ),
  })
function reject(code: string, message: string, details?: unknown): never {
  throw fail(code, message, details)
}
function utf8(bytes: Uint8Array): string {
  let value: string
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return reject(
      "SHARED_MIGRATION_CONVERSION_BINARY",
      "A native body requires complete lossless UTF-8 input; the original bytes remain retained.",
    )
  }
  if (value.includes("\0") || new TextEncoder().encode(value).length !== bytes.length)
    reject(
      "SHARED_MIGRATION_CONVERSION_BINARY",
      "A native body requires complete lossless UTF-8 input; the original bytes remain retained.",
    )
  return value
}
function encoded(bytes: Uint8Array): string {
  let value = ""
  for (let at = 0; at < bytes.length; at += 4096)
    value += String.fromCharCode(...bytes.subarray(at, at + 4096))
  return btoa(value)
}
function decoded(value: string): Uint8Array {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  if (encoded(bytes) !== value)
    reject("SHARED_MIGRATION_CONVERSION_INVALID", "Retained source bytes require canonical base64.")
  return bytes
}
function metadata(entry: SharedMigrationEntry, activation?: SharedMigrationActivation) {
  const record = property(entry.record),
    locator = property(record.locator)
  if (
    locator.type !== "notion_page" ||
    typeof locator.page_id !== "string" ||
    pageId(locator.page_id) !== locator.page_id
  )
    reject(
      "SHARED_MIGRATION_CONVERSION_LAYOUT",
      "This conversion requires actual page bodies. A generated subscription Router needs its own explicit metadata/relation conversion; it is not a native body preimage.",
    )
  const kind = Schema.decodeUnknownSync(ContentKindSchema)(record.kind)
  if (
    record.id !== entry.legacy_id ||
    typeof record.name !== "string" ||
    typeof record.description !== "string" ||
    typeof record.default_context !== "boolean" ||
    record.entrypoint !== entrypointFor(kind)
  )
    reject(
      "SHARED_MIGRATION_CONVERSION_METADATA",
      "Retain the exact original record identity, metadata and entrypoint.",
    )
  if (record.enabled !== true && activation === undefined)
    reject(
      "SHARED_MIGRATION_CONVERSION_ENABLED_UNSUPPORTED",
      "This bounded conversion requires an explicitly enabled original record. A disabled or unknown original must not be enabled by migration.",
    )
  return {
    name: validateDisplayName(record.name),
    description: validateDescription(record.description),
    kind,
    enabled: true as const,
    default_context: record.default_context,
    entrypoint: entrypointFor(kind),
  }
}
function authored(
  text: string,
  path: string,
  meta: typeof MetadataSchema.Type,
  following: boolean,
) {
  if (path !== meta.entrypoint) return text
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (frontmatter) {
    const data: unknown = parseYaml(frontmatter[1] ?? "")
    if (data === null || typeof data !== "object" || Array.isArray(data))
      reject(
        "SHARED_MIGRATION_CONVERSION_METADATA",
        "Main frontmatter must be an explicit metadata mapping.",
      )
    const unsupported = Object.keys(data).filter(
      (key) => !["name", "description", "notion_page_id"].includes(key),
    )
    if (
      unsupported.length &&
      (!following || (!Object.hasOwn(data, "name") && !Object.hasOwn(data, "description")))
    )
      reject(
        "SHARED_FRONTMATTER_UNSUPPORTED",
        "The selected main cannot preserve these extra frontmatter fields through the existing consumer. Retain the original and resolve an explicit representable conversion.",
        { fields: unsupported.sort() },
      )
  }
  // Following keeps the full original source main, including its extra metadata,
  // in the selected immutable Source. Only the native projection uses its body.
  return importDocument(
    { path, bytes: new TextEncoder().encode(text) },
    { name: meta.name, description: meta.description },
  ).body
}

function retainSourceFiles(
  source: SharedGitSourceBinding | null,
  supplied: readonly MigrationSourceFile[],
) {
  return Effect.gen(function* () {
    if (source === null) {
      if (supplied.length)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CONVERSION_SOURCE",
            "A source-less record cannot borrow supplied source bytes.",
          ),
        )
      return [] as readonly (typeof SourceFileSchema.Type)[]
    }
    if (
      supplied.length !== source.files.length ||
      new Set(supplied.map((file) => file.path)).size !== supplied.length
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_SOURCE",
          "Supply the complete exact fixed Source tree once, including non-page assets.",
        ),
      )
    const result: (typeof SourceFileSchema.Type)[] = []
    for (const expected of source.files) {
      const file = supplied.find((item) => item.path === expected.path)
      if (
        !file ||
        !(file.bytes instanceof Uint8Array) ||
        !file.retention_ref ||
        file.bytes.length !== expected.bytes ||
        (yield* gitBlobOid(file.bytes)) !== expected.git_oid
      )
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CONVERSION_SOURCE",
            "Source bytes differ from the selected fixed Git blob or its declared size.",
            { path: expected.path },
          ),
        )
      result.push({
        path: file.path,
        retention_ref: file.retention_ref,
        sha256: yield* sha256(file.bytes),
        bytes: file.bytes.length,
        base64: encoded(file.bytes),
      })
    }
    return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  })
}

function convertFile(input: {
  readonly library: SharedLibrary
  readonly entry: SharedMigrationEntry
  readonly meta: typeof MetadataSchema.Type
  readonly legacyFile: SharedMigrationEntry["files"][number]
  readonly source: SharedGitSourceBinding | null
  readonly legacySourceId?: string
  readonly sourceFiles: readonly (typeof SourceFileSchema.Type)[]
  readonly supplied: MigrationConversionFile
}) {
  return Effect.gen(function* () {
    const old = input.legacyFile,
      supplied = input.supplied,
      body = old.body
    const originalHash = yield* sha256(supplied.bytes)
    if (
      supplied.legacy_id !== old.legacy_id ||
      !body ||
      !body.complete ||
      !body.retention_verified ||
      body.sha256 !== originalHash ||
      body.bytes !== supplied.bytes.length ||
      body.retention_ref !== supplied.retention_ref
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_ORIGINAL",
          "The complete original logical file differs from the frozen migration body or retention reference.",
        ),
      )
    const original = yield* checked(() => ({
      text: utf8(supplied.bytes),
      sha256: originalHash,
      bytes: supplied.bytes.length,
      retention_ref: supplied.retention_ref,
    }))
    const preimage = yield* checked(() =>
      Schema.decodeUnknownSync(MigrationNativePreimageSchema)(supplied.native_preimage, {
        onExcessProperty: "error",
      }),
    )
    const raw = yield* checked(() => property(JSON.parse(preimage.response_json)))
    const nativeBodyHash = yield* checked(() => {
      const expectedPath = `v1/pages/${preimage.page_id}/markdown${preimage.markdown_version === "v2" ? "?markdown_version=v2" : ""}`
      if (
        pageId(preimage.page_id) !== preimage.page_id ||
        preimage.request_path !== expectedPath ||
        !preimage.retention_ref ||
        raw.object !== "page_markdown" ||
        raw.id !== preimage.page_id ||
        typeof raw.markdown !== "string" ||
        raw.truncated !== false ||
        !Array.isArray(raw.unknown_block_ids) ||
        raw.unknown_block_ids.length !== 0 ||
        (raw.warnings !== undefined && (!Array.isArray(raw.warnings) || raw.warnings.length !== 0))
      )
        reject(
          "SHARED_MIGRATION_CONVERSION_PREIMAGE",
          "Retain a complete exact page Markdown response, its original request and its unmodified JSON bytes.",
        )
      if (
        old.path === input.meta.entrypoint &&
        property(property(input.entry.record).locator).page_id !== preimage.page_id
      )
        reject(
          "SHARED_MIGRATION_CONVERSION_PREIMAGE",
          "The main preimage belongs to another original page.",
        )
      return normalizeObservedBody(raw.markdown)
    })
    const nativeEvidence = {
      ...preimage,
      response_sha256: yield* sha256(preimage.response_json),
      response_bytes: new TextEncoder().encode(preimage.response_json).length,
      body_sha256: yield* sha256(nativeBodyHash),
    }
    const { response_json: _response, ...descriptor } = nativeEvidence
    yield* checked(() => {
      if (
        canonicalSharedJson(property(old.raw).native_preimage) !== canonicalSharedJson(descriptor)
      )
        reject(
          "SHARED_MIGRATION_CONVERSION_PREIMAGE",
          "The actual native response is not the exact preimage frozen in this file's original migration evidence.",
        )
    })
    const following = old.ownership === "following"
    if (!following && old.ownership !== "native" && old.ownership !== "custom")
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_OWNERSHIP",
          "Unresolved ownership and tombstones cannot become new adopted or projected facts.",
        ),
      )
    let selected = original
    if (following) {
      const sourceFile = input.sourceFiles.find((item) => item.path === old.path)
      if (
        input.entry.legacy_mode !== "tracked" ||
        input.source === null ||
        input.legacySourceId !== old.source_id ||
        body.normalization_version !== 1 ||
        old.projection_sha256 !== body.sha256 ||
        !sourceFile
      )
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CONVERSION_OWNERSHIP",
            "Following requires the existing proven old baseline and exact selected Source; conversion never infers it from a body diff.",
          ),
        )
      selected = yield* checked(() => ({
        text: utf8(decoded(sourceFile.base64)),
        sha256: sourceFile.sha256,
        bytes: sourceFile.bytes,
        retention_ref: sourceFile.retention_ref,
      }))
    }
    const projection = yield* checked(() =>
      projectSharedNotionMarkdown(authored(selected.text, old.path, input.meta, following), {
        version: 3,
        purpose: "data_source_create",
      }),
    )
    const contentHash = yield* sha256(projection.markdown)
    const content = {
      object_id: `body-${contentHash}`,
      sha256: contentHash,
      bytes: new TextEncoder().encode(projection.markdown).length,
    }
    const fileId = `migration-file-${yield* sha256(canonicalSharedJson([1, input.library.library_id, input.entry.legacy_id, old.legacy_id]))}`
    const fields =
      following && input.source !== null
        ? {
            kind: "projected" as const,
            file_id: fileId,
            parents: [] as readonly string[],
            source_revision: input.source.commit,
            projection: { normalization_version: 1 as const, sha256: contentHash },
          }
        : { kind: "adopted" as const, file_id: fileId, parents: [] as readonly string[], content }
    const event: FileEvent = {
      ...fields,
      event_id: `migration-event-${yield* sha256(canonicalSharedJson({ version: 1, ...fields }))}`,
    }
    return {
      legacy_id: old.legacy_id,
      file_id: fileId,
      path: old.path,
      selection: following ? ("source" as const) : ("current" as const),
      original,
      native_preimage: nativeEvidence,
      input: selected,
      projection,
      content,
      initial_event: event,
    }
  })
}

/** Rebuild only the retained target's deterministic conversion. This is not an
 * approval check and grants no dispatch permission; creation re-runs the original
 * full migration planner with the caller's frozen migration input below. */
function rebuildRetainedCandidate(input: Omit<SharedMigrationConversionCandidate, "candidate_id">) {
  return Effect.gen(function* () {
    const library = yield* checked(() =>
      Schema.decodeUnknownSync(SharedLibrarySchema)(input.library, { onExcessProperty: "error" }),
    )
    const entry = yield* checked(() =>
      Schema.decodeUnknownSync(SharedMigrationEntrySchema)(input.legacy_entry, {
        onExcessProperty: "error",
      }),
    )
    const activation = yield* resolveMigrationActivation(entry, input.conversion_policy)
    if (
      (input.conversion_policy === "legacy_page_to_native_v1" &&
        Object.hasOwn(input, "activation")) ||
      canonicalSharedJson(activation ?? null) !== canonicalSharedJson(input.activation ?? null)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_ACTIVATION_INVALID",
          "The migration activation mapping differs from its saved versioned policy and original evidence.",
        ),
      )
    const meta = yield* checked(() => metadata(entry, activation))
    const skillId = `migration-skill-${yield* sha256(canonicalSharedJson([1, library.library_id, entry.legacy_id]))}`
    const recordId = yield* checked(() => sharedSkillId(library.library_id, skillId))
    if (
      input.legacy_id !== entry.legacy_id ||
      input.skill_id !== skillId ||
      input.record_id !== recordId ||
      canonicalSharedJson(meta) !== canonicalSharedJson(input.metadata)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_IDENTITY",
          "The original metadata or stable migration identity differs from the retained entry.",
        ),
      )
    let source: SharedGitSourceBinding | null = null
    let legacySourceId: string | undefined
    if (input.legacy_source !== null) {
      const original = yield* checked(() =>
        Schema.decodeUnknownSync(SharedMigrationPreservedItemSchema)(input.legacy_source, {
          onExcessProperty: "error",
        }),
      )
      if (
        !original.complete ||
        original.source_semantics !== "fixed_git_v1" ||
        !original.references.includes(entry.legacy_id) ||
        original.fixed_source === undefined
      )
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CONVERSION_SOURCE",
            "The retained Source does not prove this original member selection.",
          ),
        )
      source = yield* makeSourceBinding(original.fixed_source)
      legacySourceId = original.legacy_id
    }
    if (canonicalSharedJson(source) !== canonicalSharedJson(input.source))
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_SOURCE",
          "The selected Source differs from its complete immutable original descriptor.",
        ),
      )
    const sourceFiles = yield* retainSourceFiles(
      source,
      yield* checked(() =>
        input.source_files.map((file) => ({
          path: file.path,
          retention_ref: file.retention_ref,
          bytes: decoded(file.base64),
        })),
      ),
    )
    if (
      input.files.length !== entry.files.length ||
      new Set(input.files.map((file) => file.legacy_id)).size !== input.files.length
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_ORIGINAL",
          "Retain every original managed file once; Source assets are a separate complete collection.",
        ),
      )
    const files: (typeof ConvertedFileSchema.Type)[] = []
    for (const old of [...entry.files].sort((a, b) =>
      a.legacy_id < b.legacy_id ? -1 : a.legacy_id > b.legacy_id ? 1 : 0,
    )) {
      const file = input.files.find((item) => item.legacy_id === old.legacy_id)
      if (!file)
        return yield* Effect.fail(
          fail("SHARED_MIGRATION_CONVERSION_ORIGINAL", "An original managed file is absent."),
        )
      const {
        response_sha256: _hash,
        response_bytes: _bytes,
        body_sha256: _body,
        ...preimage
      } = file.native_preimage
      files.push(
        yield* convertFile({
          library,
          entry,
          meta,
          legacyFile: old,
          source,
          ...(legacySourceId === undefined ? {} : { legacySourceId }),
          sourceFiles,
          supplied: {
            legacy_id: file.legacy_id,
            retention_ref: file.original.retention_ref,
            bytes: new TextEncoder().encode(file.original.text),
            native_preimage: preimage,
          },
        }),
      )
    }
    const following = files.filter((file) => file.selection === "source")
    if (
      (entry.legacy_mode === "tracked") !== (source !== null) ||
      (source !== null && following.length === 0)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_OWNERSHIP",
          "A tracked record cannot lose its selected Source, and historical custom provenance is not current following.",
        ),
      )
    let members: (typeof MemberSchema.Type)[] = []
    if (meta.kind === "router") {
      const router = yield* checked(() =>
        Schema.decodeUnknownSync(SharedMigrationPreservedItemSchema)(input.legacy_router, {
          onExcessProperty: "error",
        }),
      )
      if (
        router.legacy_id !== entry.legacy_id ||
        !router.complete ||
        new Set(router.references).size !== router.references.length ||
        !library.skills.property_ids.Members
      )
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CONVERSION_MEMBERS",
            "Retain the complete exact original Router relation before binding new member pages.",
          ),
        )
      members = yield* Effect.forEach([...router.references].sort(), (legacyId) =>
        Effect.gen(function* () {
          const id = `migration-skill-${yield* sha256(canonicalSharedJson([1, library.library_id, legacyId]))}`
          return {
            legacy_id: legacyId,
            skill_id: id,
            record_id: yield* checked(() => sharedSkillId(library.library_id, id)),
            page_id: null,
          }
        }),
      )
    } else if (input.legacy_router !== null)
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_MEMBERS",
          "A non-Router cannot borrow retained Router membership.",
        ),
      )
    const completeTree = yield* checked(() => {
      const projected = new Map(
        files.map((file) => [file.path, new TextEncoder().encode(file.projection.markdown)]),
      )
      const base = sourceFiles.map((file) => ({
        path: file.path,
        bytes: projected.get(file.path) ?? decoded(file.base64),
      }))
      for (const [path, bytes] of projected)
        if (!base.some((file) => file.path === path)) base.push({ path, bytes })
      return composeSharedFiles({ base, mounts: [], overrides: [], entrypoint: meta.entrypoint })
    })
    const referenceCheck = yield* checked(() => assertSharedFileReferences(completeTree.files, 3))
    const fields = {
      ...input,
      library,
      metadata: meta,
      source,
      source_files: sourceFiles,
      files,
      member_bindings: members,
      reference_check: referenceCheck,
    }
    const candidateId = `migration-create-${yield* sha256(canonicalSharedJson(fields))}`
    return yield* checked(() =>
      Schema.decodeUnknownSync(SharedMigrationConversionCandidateSchema)(
        { ...fields, candidate_id: candidateId },
        { onExcessProperty: "error" },
      ),
    )
  })
}

export function validateRetainedMigrationConversion(input: unknown) {
  return Effect.gen(function* () {
    const candidate = yield* checked(() =>
      Schema.decodeUnknownSync(SharedMigrationConversionCandidateSchema)(
        JSON.parse(canonicalSharedJson(input)),
        { onExcessProperty: "error" },
      ),
    )
    const { candidate_id: _id, ...fields } = candidate
    const expected = yield* rebuildRetainedCandidate(fields)
    if (canonicalSharedJson(expected) !== canonicalSharedJson(candidate))
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_INVALID",
          "The retained migration candidate differs from its exact original bytes, fixed Source, preimage or declared conversion policy.",
        ),
      )
    return expected
  })
}

/** No I/O: derive a conversion through its declared execution boundary. Missing
 * policy preserves the full-plan gate; the explicit copy boundary still requires
 * target approval, complete dependencies and the original operation safeguards. */
function makeConversion(input: MigrationConversionInput, review: boolean) {
  return Effect.gen(function* () {
    const { plan, library, prepared, source, legacySource } = yield* review
      ? reviewSharedMigrationCreateInput(input)
      : prepareSharedMigrationCreateInput(input, input.execution_policy)
    const conversionPolicy = migrationConversionPolicy(prepared.entry)
    const activation = yield* resolveMigrationActivation(prepared.entry, conversionPolicy)
    const meta = yield* checked(() => metadata(prepared.entry, activation))
    const sourceFiles = yield* retainSourceFiles(source, input.source_files ?? [])
    const legacySourceId =
      legacySource === null ? undefined : String(property(legacySource).legacy_id)
    const files: (typeof ConvertedFileSchema.Type)[] = []
    for (const old of [...prepared.entry.files].sort((a, b) =>
      a.legacy_id < b.legacy_id ? -1 : a.legacy_id > b.legacy_id ? 1 : 0,
    )) {
      const supplied = input.files.find((file) => file.legacy_id === old.legacy_id)
      if (!supplied)
        return yield* Effect.fail(
          fail("SHARED_MIGRATION_CONVERSION_ORIGINAL", "An exact original file is absent."),
        )
      files.push(
        yield* convertFile({
          library,
          entry: prepared.entry,
          meta,
          legacyFile: old,
          source,
          ...(legacySourceId === undefined ? {} : { legacySourceId }),
          sourceFiles,
          supplied,
        }),
      )
    }
    const router =
      meta.kind === "router"
        ? plan.evidence.preservation.routers.items.find(
            (item) => item.legacy_id === input.legacy_id,
          )
        : null
    return yield* rebuildRetainedCandidate({
      version: 2,
      kind: "migration_create_candidate",
      conversion_policy: conversionPolicy,
      ...(input.execution_policy === undefined ? {} : { execution_policy: input.execution_policy }),
      ...(activation === undefined ? {} : { activation }),
      migration_plan_id: plan.plan_id,
      migration_input_sha256: plan.input_sha256,
      legacy_id: input.legacy_id,
      skill_id: prepared.mapping.skill_id,
      record_id: prepared.mapping.record_id,
      library,
      metadata: meta,
      legacy_entry: prepared.entry,
      legacy_source: legacySource,
      legacy_router: router ?? null,
      source,
      source_files: sourceFiles,
      files,
      member_bindings: [],
      reference_check: { checked_files: 0, local_references: 0 },
      execution: {
        apply_allowed: false,
        original_migration_input_required: true,
        physical_bindings_verified: false,
        native_receipt_verified: false,
      },
    })
  })
}

export function makeSharedMigrationConversion(input: MigrationConversionInput) {
  return makeConversion(input, false)
}

/** Allows a concrete read-only proposal before scope approval; execution still
 * reconstructs through makeSharedMigrationConversion and its original gates. */
export function reviewSharedMigrationConversion(input: MigrationConversionInput) {
  return makeConversion(input, true)
}

/** Required immediately before any new create dispatch. A stored origin alone
 * is enough for read-only reconciliation, never enough to authorize new writes. */
export function retainedMigrationConversionInput(
  migrationInput: unknown,
  candidate: SharedMigrationConversionCandidate,
): MigrationConversionInput {
  return {
    migration_input: migrationInput,
    legacy_id: candidate.legacy_id,
    library: candidate.library,
    ...(candidate.execution_policy === undefined
      ? {}
      : { execution_policy: candidate.execution_policy }),
    files: candidate.files.map((file) => {
      const {
        response_sha256: _hash,
        response_bytes: _bytes,
        body_sha256: _body,
        ...native
      } = file.native_preimage
      return {
        legacy_id: file.legacy_id,
        retention_ref: file.original.retention_ref,
        bytes: new TextEncoder().encode(file.original.text),
        native_preimage: native,
      }
    }),
    source_files: candidate.source_files.map((file) => ({
      path: file.path,
      retention_ref: file.retention_ref,
      bytes: decoded(file.base64),
    })),
  }
}

export function validateSharedMigrationConversion(migrationInput: unknown, input: unknown) {
  return Effect.gen(function* () {
    const candidate = yield* validateRetainedMigrationConversion(input)
    const expected = yield* makeSharedMigrationConversion(
      yield* checked(() => retainedMigrationConversionInput(migrationInput, candidate)),
    )
    if (canonicalSharedJson(candidate) !== canonicalSharedJson(expected))
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CONVERSION_INVALID",
          "The candidate does not reconstruct from the original approved migration input.",
        ),
      )
    return expected
  })
}
