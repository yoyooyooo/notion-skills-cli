import { Effect, Schema } from "effect"
import { importDocument } from "./import.ts"
import {
  ContentKindSchema,
  entrypointFor,
  fail,
  SkillsError,
  validateDescription,
  validateDisplayName,
} from "./model.ts"
import { portableFiles, type PortableSkill } from "./portable.ts"
import { pageId } from "./ref.ts"
import { composeSharedFiles } from "./shared-composition.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import {
  FileEventSchema,
  RetainedContentSchema,
  NativeFileMetadataFields,
  nativeFileMetadata,
  resolveFileState,
  type FileEvent,
} from "./shared-file-state.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import {
  currentSharedNotionMarkdownVersion,
  projectSharedNotionMarkdown,
  sharedNotionMarkdownPolicy,
  SharedNotionMarkdownPolicySchema,
  SharedNotionMarkdownProjectionSchema,
  type SharedNotionMarkdownVersion,
} from "./shared-notion-projection.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { parseYaml } from "./yaml.ts"
import {
  nativeMainFrontmatter,
  splitNativeSupportingMarkdown,
} from "./shared-native-file-metadata.ts"
import {
  prepareSharedResourceContent,
  validatePreparedSharedResource,
} from "./shared-resource-content.ts"
import {
  SharedCreateResourceSchema,
  SharedCreateResourceManifestSchema,
} from "./shared-create-resources.ts"
import { gitBlobOid, validateFixedGithubSource } from "./shared-github-source.ts"
import {
  SharedSourceProjectionSchema,
  SharedSourceProjectionManifestSchema,
  type SharedSourceProjection,
} from "./shared-source-projection-model.ts"
import { sharedCreateBodyPayload, sharedCreateInputPayload } from "./shared-create-objects.ts"
import { sharedCreateLocalManifest, validateSharedCreateLocal } from "./shared-create-local.ts"
import {
  sharedCreateRetainedManifest,
  validateSharedCreateRetained,
} from "./shared-create-retained.ts"
export { sharedCreateBodyPayload, sharedCreateInputPayload } from "./shared-create-objects.ts"
import {
  makeSharedMigrationCreateOrigin,
  SharedMigrationCreateOriginSchema,
  SharedMigrationOriginManifestSchema,
  type MigrationMemberBinding,
} from "./shared-migration-create-origin.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
/** A plan-only draft. FileEventSchema rejects it, so it cannot become a remote
 * ownership fact until the original Skill allocation supplies its real identity. */
const CreateProjectionDraftSchema = Schema.Struct({
  kind: Schema.Literal("source_projection_pending"),
  event_id: Identity,
  file_id: Identity,
  parents: Schema.Array(Identity),
  projection: Schema.Struct({ normalization_version: Schema.Literal(1), sha256: Hash }),
  ...NativeFileMetadataFields,
})
const CreateEventSchema = Schema.Union([FileEventSchema, CreateProjectionDraftSchema])
const RelationBindingsSchema = Schema.Array(
  Schema.Struct({ page_id: Schema.String, skill_id: Identity }),
)
const PortableProjectionSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  references: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  materialization: Schema.optional(
    Schema.Struct({ authored: Schema.String, generated: Schema.String }),
  ),
})
const CreatePlanFields = {
  kind: Schema.Literal("skill_create"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  skill_id: Identity,
  content_kind: ContentKindSchema,
  name: Schema.String,
  description: Schema.String,
  default_context: Schema.Boolean,
  enabled: Schema.optional(Schema.Boolean),
  complete_resources: Schema.optional(Schema.Literal(1)),
  resources: Schema.optional(Schema.Array(SharedCreateResourceSchema)),
  original_main_path: Schema.String,
  entrypoint: Schema.String,
  members: Schema.Array(Schema.String),
  requires: Schema.optional(Schema.Array(Schema.String)),
  relation_bindings: Schema.optional(RelationBindingsSchema),
  input_projection: Schema.optional(PortableProjectionSchema),
  source_projection: Schema.optional(SharedSourceProjectionSchema),
  reference_check: Schema.Struct({ checked_files: Schema.Number, local_references: Schema.Number }),
  files: Schema.Array(
    Schema.Struct({
      file_id: Identity,
      path: Schema.String,
      input_path: Schema.String,
      input: Schema.Struct({
        object_id: Identity,
        text: Schema.String,
        sha256: Hash,
        bytes: Schema.Number,
        mode: Schema.optional(Schema.Literals(["100644", "100755"])),
      }),
      projection: SharedNotionMarkdownProjectionSchema,
      content: RetainedContentSchema,
      event: CreateEventSchema,
      ancestors: Schema.optional(Schema.Array(FileEventSchema)),
      baseline_body: Schema.optional(
        Schema.Struct({ markdown: Schema.String, content: RetainedContentSchema }),
      ),
    }),
  ),
}
export const SharedCreatePlanSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...CreatePlanFields }),
  Schema.Struct({
    version: Schema.Literal(2),
    ...CreatePlanFields,
    files: Schema.Array(
      Schema.Struct({ ...CreatePlanFields.files.value.fields, event: FileEventSchema }),
    ),
    source_projection: Schema.optionalKey(Schema.Never),
    origin: SharedMigrationCreateOriginSchema,
  }),
])
export type SharedCreatePlan = typeof SharedCreatePlanSchema.Type
const CreateManifestFields = {
  kind: Schema.Literal("skill_create_manifest"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  skill_id: Identity,
  content_kind: ContentKindSchema,
  name: Schema.String,
  description: Schema.String,
  default_context: Schema.Boolean,
  enabled: Schema.optional(Schema.Boolean),
  complete_resources: Schema.optional(Schema.Literal(1)),
  resources: Schema.optional(Schema.Array(SharedCreateResourceManifestSchema)),
  original_main_path: Schema.String,
  entrypoint: Schema.String,
  members: Schema.Array(Schema.String),
  requires: Schema.optional(Schema.Array(Schema.String)),
  relation_bindings: Schema.optional(RelationBindingsSchema),
  input_projection: Schema.optional(PortableProjectionSchema),
  source_projection: Schema.optional(SharedSourceProjectionManifestSchema),
  reference_check: Schema.Struct({ checked_files: Schema.Number, local_references: Schema.Number }),
  files: Schema.Array(
    Schema.Struct({
      file_id: Identity,
      path: Schema.String,
      input_path: Schema.String,
      input: Schema.Struct({
        object_id: Identity,
        sha256: Hash,
        bytes: Schema.Number,
        mode: Schema.optional(Schema.Literals(["100644", "100755"])),
      }),
      projection: SharedNotionMarkdownPolicySchema,
      content: RetainedContentSchema,
      event: CreateEventSchema,
      ancestors: Schema.optional(Schema.Array(FileEventSchema)),
      baseline_body: Schema.optional(Schema.Struct({ content: RetainedContentSchema })),
    }),
  ),
}
export const SharedCreateManifestSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...CreateManifestFields }),
  Schema.Struct({
    version: Schema.Literal(2),
    ...CreateManifestFields,
    files: Schema.Array(
      Schema.Struct({ ...CreateManifestFields.files.value.fields, event: FileEventSchema }),
    ),
    source_projection: Schema.optionalKey(Schema.Never),
    origin: SharedMigrationOriginManifestSchema,
  }),
])
export const SharedCreateJournalSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  library_id: Identity,
  plan: SharedCreatePlanSchema,
  ownership_receipt_version: Schema.optional(Schema.Literal(1)),
  dispatch_receipt_version: Schema.optional(Schema.Literal(1)),
})
export const sharedCreateManifestEntity = "skill-create-manifest-v1"
export const sharedCreateOutcomesEntity = "skill-create-outcomes-v1"
export const sharedCreateProtection = {
  native_pages: true,
  existing_body_replacement: false,
  disabled_until_complete: true,
  exact_projected_body_required: true,
  automatic_retry: false,
  original_input_retained: true,
  binary_support: true,
  metadata_compare_and_swap: false,
} as const
export function sharedCreateFixedSource(plan: SharedCreatePlan) {
  return (
    (plan.source_projection?.version === 1 ? plan.source_projection.binding : null) ??
    (plan.version === 2 ? plan.origin.candidate.source : null)
  )
}
export function sharedCreateEnabled(plan: SharedCreatePlan) {
  return plan.enabled ?? true
}
export function sharedCreateFixedSources(plan: SharedCreatePlan) {
  const selected = sharedCreateFixedSource(plan)
  const baseline =
    plan.source_projection?.version === 1 ? plan.source_projection.local?.baseline : undefined
  return [
    ...(selected === null ? [] : [selected]),
    ...(baseline === undefined || baseline.source_id === selected?.source_id ? [] : [baseline]),
  ]
}
export function sharedCreateFiles(plan: SharedCreatePlan) {
  return [
    ...plan.files,
    ...(plan.resources ?? []).map((file) => ({ ...file, content: file.prepared.content })),
  ]
}
export function sharedCreateEvents(plan: SharedCreatePlan) {
  return sharedCreateFiles(plan)
    .flatMap((file) => [...(file.ancestors ?? []), file.event])
    .map((event) => Schema.decodeUnknownSync(FileEventSchema)(event, { onExcessProperty: "error" }))
}
export function sharedCreateExpectations(
  plan: SharedCreatePlan,
  bindings: readonly {
    readonly file_id: string
    readonly path: string
    readonly page_id: string
  }[],
  selectedSource?: {
    readonly source_id: string
    readonly revision: string
    readonly paths: readonly string[]
  },
) {
  const fixed = sharedCreateFixedSource(plan)
  const source =
    selectedSource ??
    (fixed === null
      ? undefined
      : {
          source_id: fixed.source_id,
          revision: fixed.commit,
          paths: fixed.files.map((file) => file.path),
        })
  return {
    expected_files: sharedCreateFiles(plan)
      .filter((file) => file.event.kind !== "deleted")
      .map((file) => {
        const matching = bindings.filter(
          (binding) => binding.file_id === file.file_id && binding.path === file.path,
        )
        if (matching.length !== 1 || matching[0] === undefined)
          throw fail(
            "SHARED_CREATE_INVALID",
            "The original completion does not identify every exact created file page.",
          )
        return {
          file_id: file.file_id,
          path: file.path,
          page_id: matching[0].page_id,
          sha256: file.content.sha256,
        }
      }),
    ...(plan.version === 2
      ? {
          expected_migration: {
            candidate_id: plan.origin.candidate.candidate_id,
            source_id: plan.origin.candidate.source?.source_id ?? "",
            source_revision: plan.origin.candidate.source?.commit ?? "",
            consumed_paths: [
              ...new Set([
                ...plan.origin.candidate.source_files.map((file) => file.path),
                ...plan.files.map((file) => file.path),
              ]),
            ].sort(),
            events: plan.files.map((file) => ({
              file_id: file.file_id,
              event_id: file.event.event_id,
            })),
          },
        }
      : {}),
    ...(plan.source_projection === undefined
      ? {}
      : {
          expected_source_projection: {
            source_id: source!.source_id,
            source_revision: source!.revision,
            consumed_paths: (() => {
              const paths = new Set(source!.paths)
              for (const file of sharedCreateFiles(plan))
                file.event.kind === "deleted" ? paths.delete(file.path) : paths.add(file.path)
              return [...paths].sort()
            })(),
            events: sharedCreateFiles(plan)
              .filter((file) => file.event.kind !== "deleted")
              .map((file) => ({
                file_id: file.file_id,
                event_id: file.event.event_id,
              })),
          },
        }),
    expected_metadata: {
      name: plan.name,
      description: plan.description,
      kind: plan.content_kind,
      enabled: sharedCreateEnabled(plan),
      default_context: plan.default_context,
      ...(plan.content_kind === "router" || plan.members.length > 0
        ? { members: plan.members }
        : {}),
      ...(plan.requires === undefined ? {} : { requires: plan.requires }),
    },
  }
}
export type SharedCreateExpectations = ReturnType<typeof sharedCreateExpectations>
export const createChecked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_CREATE_INVALID", "Invalid frozen native creation input or response."),
  })
/** Only hashes and exact identities live in the manifest; body objects are separate. */
export function sharedCreateManifest(plan: SharedCreatePlan) {
  return {
    version: plan.version,
    kind: "skill_create_manifest" as const,
    ...(plan.version === 2
      ? { origin: { archive: plan.origin.archive, member_bindings: plan.origin.member_bindings } }
      : {}),
    operation_id: plan.operation_id,
    library: plan.library,
    skill_id: plan.skill_id,
    content_kind: plan.content_kind,
    name: plan.name,
    description: plan.description,
    default_context: plan.default_context,
    ...(plan.enabled === undefined ? {} : { enabled: plan.enabled }),
    ...(plan.complete_resources === undefined
      ? {}
      : { complete_resources: plan.complete_resources }),
    ...(plan.resources === undefined
      ? {}
      : {
          resources: plan.resources.map(({ prepared, ...file }) => ({
            ...file,
            content: prepared.content,
          })),
        }),
    original_main_path: plan.original_main_path,
    entrypoint: plan.entrypoint,
    members: plan.members,
    ...(plan.requires === undefined ? {} : { requires: plan.requires }),
    ...(plan.relation_bindings === undefined ? {} : { relation_bindings: plan.relation_bindings }),
    ...(plan.input_projection === undefined ? {} : { input_projection: plan.input_projection }),
    ...(plan.source_projection === undefined
      ? {}
      : {
          source_projection:
            plan.source_projection.version === 1
              ? {
                  ...plan.source_projection,
                  ...(plan.source_projection.local === undefined
                    ? {}
                    : { local: sharedCreateLocalManifest(plan.source_projection.local) }),
                }
              : {
                  ...plan.source_projection,
                  retained: sharedCreateRetainedManifest(plan.source_projection.retained),
                },
        }),
    reference_check: plan.reference_check,
    files: plan.files.map((file) => ({
      file_id: file.file_id,
      path: file.path,
      input_path: file.input_path,
      input: {
        object_id: file.input.object_id,
        sha256: file.input.sha256,
        bytes: file.input.bytes,
        ...(file.input.mode === undefined ? {} : { mode: file.input.mode }),
      },
      projection: sharedNotionMarkdownPolicy(file.projection),
      content: file.content,
      event: file.event,
      ...(file.ancestors === undefined ? {} : { ancestors: file.ancestors }),
      ...(file.baseline_body === undefined
        ? {}
        : { baseline_body: { content: file.baseline_body.content } }),
    })),
  }
}

export interface SharedCreateInput {
  readonly portable: PortableSkill
  readonly defaultContext?: boolean
  readonly enabled?: boolean
  readonly completeResources?: boolean
  readonly markdownImport?: true
  /** Exact same-library current page identities, resolved before freezing. */
  readonly members?: readonly string[]
  readonly requires?: readonly string[]
  readonly relationBindings?: typeof RelationBindingsSchema.Type
  readonly sourceProjection?: SharedSourceProjection
}

/** Deterministic, no I/O: input bytes, explicit projection and every identity freeze together. */
export function makeSharedCreatePlan(
  library: SharedLibrary,
  input: SharedCreateInput,
  projectionVersion: SharedNotionMarkdownVersion = currentSharedNotionMarkdownVersion,
) {
  return Effect.gen(function* () {
    const portable = input.portable
    const complete = input.completeResources === true
    const sourceProjection =
      input.sourceProjection === undefined
        ? undefined
        : yield* createChecked(() =>
            Schema.decodeUnknownSync(SharedSourceProjectionSchema)(input.sourceProjection, {
              onExcessProperty: "error",
            }),
          )
    const local =
      sourceProjection?.version !== 1 || sourceProjection.local === undefined
        ? undefined
        : yield* validateSharedCreateLocal(sourceProjection.local, sourceProjection.binding)
    const retained =
      sourceProjection?.version !== 2
        ? undefined
        : yield* validateSharedCreateRetained(sourceProjection.retained)
    if (local !== undefined && !complete)
      return yield* Effect.fail(
        fail(
          "SOURCE_LOCAL_IMPORT_INVALID",
          "Local customization requires the complete original create contract.",
        ),
      )
    if (sourceProjection?.version === 1) {
      const binding = sourceProjection.binding
      const fixed = yield* createChecked(() =>
        validateFixedGithubSource({
          url: binding.url,
          commit: binding.commit,
          tree: binding.tree,
          root: binding.root,
          files: binding.files,
        }),
      )
      if (
        binding.source_id !==
        `source-${yield* sha256(canonicalSharedJson({ version: 1, kind: "git", ...fixed }))}`
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_SOURCE_INVALID",
            "The initial projection has a different immutable fixed-source identity.",
          ),
        )
      yield* createChecked(() => {
        if (
          pageId(sourceProjection.definition.page_id) !== sourceProjection.definition.page_id ||
          !sourceProjection.definition.source_id ||
          !sourceProjection.definition.member ||
          !library.sources ||
          !library.skills.property_ids.Origin ||
          !library.skills.property_ids["Source Member"]
        )
          throw fail(
            "SHARED_CREATE_SOURCE_INVALID",
            "Initial projection requires its exact registered Source definition and member.",
          )
        if (
          binding.files.some((file) => file.sha256 === undefined) ||
          portable.main !== entrypointFor(portable.kind)
        )
          throw fail(
            "SHARED_CREATE_SOURCE_INVALID",
            "The full resource manifest or canonical main path differs from the frozen source.",
          )
        const documents = [
          ...new Set([
            ...binding.files
              .filter((file) => file.path === portable.main || /\.(md|markdown)$/iu.test(file.path))
              .map((file) => file.path),
            ...(local?.changes.keys() ?? []),
          ]),
        ].sort()
        if (
          canonicalSharedJson(portable.files.map((file) => file.path).sort()) !==
          canonicalSharedJson(documents)
        )
          throw fail(
            "SHARED_CREATE_SOURCE_INVALID",
            "Every Markdown document must have one initial readable page; other bytes stay in the full fixed source.",
          )
      })
      for (const file of portable.files) {
        const change = local?.changes.get(file.path)
        const fixedFile =
          change === "custom"
            ? local!.local.manifest.find((candidate) => candidate.path === file.path)
            : (change === "deleted" ? local!.local.baseline : binding).files.find(
                (candidate) => candidate.path === file.path,
              )
        if (
          fixedFile?.sha256 !== (yield* sha256(file.bytes)) ||
          fixedFile.bytes !== file.bytes.length ||
          fixedFile.mode !== file.mode ||
          ("git_oid" in fixedFile && fixedFile.git_oid !== (yield* gitBlobOid(file.bytes)))
        )
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_SOURCE_INVALID",
              "A projected document does not match its complete fixed-source bytes and Git blob identity.",
            ),
          )
      }
    }
    if (sourceProjection?.version === 2) {
      yield* createChecked(() => {
        if (
          !sourceProjection.provider_revision ||
          !sourceProjection.definition.source_id ||
          !sourceProjection.definition.member ||
          pageId(sourceProjection.definition.page_id) !== sourceProjection.definition.page_id ||
          !library.sources ||
          !library.skills.property_ids.Origin ||
          !library.skills.property_ids["Source Member"] ||
          portable.main !== retained!.input.entrypoint ||
          portable.main !== entrypointFor(portable.kind)
        )
          throw fail(
            "SHARED_CREATE_SOURCE_INVALID",
            "Retained projection requires its exact registered Source/member and complete entrypoint.",
          )
        const documents = retained!.files
          .filter((file) => file.path === portable.main || /\.(md|markdown)$/iu.test(file.path))
          .map((file) => file.path)
          .sort()
        if (
          canonicalSharedJson(documents) !==
          canonicalSharedJson(portable.files.map((file) => file.path).sort())
        )
          throw fail(
            "SHARED_CREATE_SOURCE_INVALID",
            "Every retained Markdown document must have an initial readable page.",
          )
      })
      for (const file of portable.files) {
        const expected = retained!.input.files.find((item) => item.path === file.path)
        if (
          expected === undefined ||
          file.mode !== expected.mode ||
          file.bytes.length !== expected.bytes ||
          (yield* sha256(file.bytes)) !== expected.sha256
        )
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_SOURCE_INVALID",
              "A retained projection differs from its complete original source bytes.",
            ),
          )
      }
    }
    const prepared = yield* createChecked(() => {
      Schema.decodeUnknownSync(SharedLibrarySchema)(library, { onExcessProperty: "error" })
      portableFiles(portable)
      const name = validateDisplayName(portable.name),
        description = validateDescription(portable.description)
      const entrypoint = entrypointFor(portable.kind)
      const originalMain = portable.files.find((file) => file.path === portable.main)!
      if (
        portable.projection !== undefined &&
        (portable.projection.references !== undefined ||
          portable.projection.materialization !== undefined ||
          portable.projection.name !== name ||
          portable.projection.description !== description ||
          portable.projection.body !== importDocument(originalMain, { name, description }).body)
      )
        throw fail(
          "SHARED_NATIVE_CREATE_PROJECTION_UNSUPPORTED",
          "Portable projection metadata must exactly match the authored main file. Legacy references, generated materialization and alternate body authority need an explicit conversion; nothing is silently discarded.",
        )
      if (input.defaultContext !== undefined && typeof input.defaultContext !== "boolean")
        throw fail("INVALID_ARGUMENT", "Default Context must be a boolean.")
      if (
        (input.members !== undefined || input.requires !== undefined) &&
        portable.kind === "prompt"
      )
        throw fail(
          "INVALID_MEMBERS",
          "Only a native Skill or Router may specify Members or Requires.",
        )
      const members = [...(input.members ?? [])].sort()
      const required = input.requires === undefined ? undefined : [...input.requires].sort()
      const targets = [...new Set([...members, ...(required ?? [])])].sort()
      if (
        (complete || sourceProjection !== undefined) &&
        targets.length > 0 &&
        input.relationBindings === undefined
      )
        throw fail(
          "SHARED_CREATE_RELATION_SCOPE",
          "Complete creation must freeze the stable Skill identity of every relation target.",
        )
      if (input.relationBindings !== undefined) {
        Schema.decodeUnknownSync(RelationBindingsSchema)(input.relationBindings, {
          onExcessProperty: "error",
        })
        if (
          canonicalSharedJson(input.relationBindings.map((binding) => binding.page_id)) !==
          canonicalSharedJson(targets)
        )
          throw fail(
            "SHARED_CREATE_RELATION_SCOPE",
            "Frozen relations must cover exactly the selected current pages.",
          )
      }
      for (const [field, ids] of [
        ["Members", members],
        ["Requires", required],
      ] as const) {
        if (ids === undefined) continue
        if (ids.some((id) => pageId(id) !== id) || new Set(ids).size !== ids.length)
          throw fail("INVALID_MEMBERS", `${field} requires unique canonical page identities.`)
        if (ids.length > 100)
          throw fail(
            "RELATION_WRITE_LIMIT",
            "Notion relation arrays replace the complete value and accept at most 100 related pages per write.",
            { field, count: ids.length, limit: 100 },
          )
        if (
          (ids.length > 0 || (field === "Requires" && input.requires !== undefined)) &&
          library.skills.property_ids[field] === undefined
        )
          throw fail(
            "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
            `Register the native ${field} relation before creation.`,
          )
      }
      if (portable.kind === "router" && library.skills.property_ids.Members === undefined)
        throw fail(
          "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
          "This library needs a registered native Members relation before Router creation.",
        )
      const files = portable.files
        .filter(
          (file) =>
            !complete || file.path === portable.main || /\.(md|markdown)$/iu.test(file.path),
        )
        .map((file) => {
          let text: string
          try {
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes)
          } catch {
            throw fail(
              "SHARED_NATIVE_CREATE_BINARY_UNSUPPORTED",
              "Native creation currently requires verifiable UTF-8 files. This binary was retained in the caller's input and no page was created; select a fixed shared source for binary consumption.",
              { path: file.path, bytes: file.bytes.length },
            )
          }
          if (text.includes("\0") || new TextEncoder().encode(text).length !== file.bytes.length)
            throw fail(
              "SHARED_NATIVE_CREATE_BINARY_UNSUPPORTED",
              "Native creation cannot losslessly represent this input as UTF-8 text; no file is omitted.",
              { path: file.path, bytes: file.bytes.length },
            )
          const path = file.path === portable.main ? entrypoint : file.path
          if (
            file.path === portable.main &&
            projectionVersion !== 1 &&
            sourceProjection === undefined &&
            !complete
          ) {
            const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
            if (frontmatter !== null) {
              const metadata: unknown = parseYaml(frontmatter[1] ?? "")
              if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
                throw fail("INVALID_SKILL", "Native main frontmatter must be a metadata mapping.")
              const unsupported = Object.keys(metadata)
                .filter((field) => !["name", "description", "notion_page_id"].includes(field))
                .sort()
              if (unsupported.length !== 0)
                throw fail(
                  "SHARED_FRONTMATTER_UNSUPPORTED",
                  "Native creation cannot preserve additional main frontmatter fields in its current metadata model. The complete input remains unchanged and no field was discarded or written.",
                  { fields: unsupported },
                )
            }
          }
          const supporting =
            file.path !== portable.main && projectionVersion >= 11
              ? splitNativeSupportingMarkdown(text)
              : undefined
          const authored =
            file.path === portable.main
              ? importDocument(file, { name, description }).body
              : (supporting?.body ?? text)
          return {
            path,
            input_path: file.path,
            text,
            ...((complete || sourceProjection !== undefined) && file.mode !== undefined
              ? { mode: file.mode }
              : {}),
            ...((complete || sourceProjection !== undefined) && file.path === portable.main
              ? { frontmatter: nativeMainFrontmatter(text) }
              : {}),
            ...(supporting?.frontmatter === undefined
              ? {}
              : { frontmatter: supporting.frontmatter }),
            projection: projectSharedNotionMarkdown(authored, {
              version: projectionVersion,
              purpose: "data_source_create",
            }),
          }
        })
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      const tree = composeSharedFiles({
        base:
          sourceProjection === undefined
            ? complete
              ? portable.files.map((file) => ({
                  path: file.path === portable.main ? entrypoint : file.path,
                  bytes:
                    file.path === portable.main || /\.(md|markdown)$/iu.test(file.path)
                      ? new TextEncoder().encode(
                          files.find((item) => item.input_path === file.path)!.projection.markdown,
                        )
                      : file.bytes,
                }))
              : files.map((file) => ({
                  path: file.path,
                  bytes: new TextEncoder().encode(file.projection.markdown),
                }))
            : (sourceProjection.version === 1
                ? sourceProjection.binding.files
                : sourceProjection.retained.files
              ).map((file) => ({
                path: file.path,
                // Non-document bytes are not projected. Here only their exact paths participate in link validation.
                bytes: new TextEncoder().encode(
                  files.find((document) => document.path === file.path)?.projection.markdown ?? "",
                ),
              })),
        mounts: [],
        overrides:
          local === undefined
            ? []
            : [...local.changes].map(([path, kind]) =>
                kind === "deleted"
                  ? { kind: "tombstone" as const, file_id: path, path }
                  : {
                      kind: "custom" as const,
                      file_id: path,
                      path,
                      bytes: new TextEncoder().encode(
                        files.find((file) => file.path === path)?.projection.markdown ?? "",
                      ),
                    },
              ),
        entrypoint,
      })
      const references = assertSharedFileReferences(tree.files, projectionVersion)
      return { name, description, entrypoint, members, required, files, references }
    })
    const candidates = yield* Effect.forEach(prepared.files, (file) =>
      Effect.gen(function* () {
        const inputHash = yield* sha256(file.text),
          bodyHash = yield* sha256(file.projection.markdown)
        return {
          path: file.path,
          input_path: file.input_path,
          input: {
            object_id: `input-${inputHash}`,
            text: file.text,
            sha256: inputHash,
            bytes: new TextEncoder().encode(file.text).length,
            ...(file.mode === undefined ? {} : { mode: file.mode }),
          },
          projection: file.projection,
          content: {
            object_id: `body-${bodyHash}`,
            sha256: bodyHash,
            bytes: new TextEncoder().encode(file.projection.markdown).length,
            ...nativeFileMetadata(file),
          },
        }
      }),
    )
    const resources = complete
      ? yield* Effect.forEach(
          portable.files
            .filter((file) => file.path !== portable.main && !/\.(md|markdown)$/iu.test(file.path))
            .sort((a, b) => a.path.localeCompare(b.path)),
          (file) =>
            Effect.gen(function* () {
              return {
                path: file.path,
                input_path: file.path,
                prepared: yield* prepareSharedResourceContent(file.bytes, file.mode ?? null),
              }
            }),
        )
      : undefined
    const identity = {
      version: 1,
      library,
      content_kind: portable.kind,
      name: prepared.name,
      description: prepared.description,
      default_context: input.defaultContext ?? false,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(complete
        ? {
            complete_resources: 1 as const,
            resources: resources!.map(({ prepared, ...file }) => ({
              ...file,
              content: prepared.content,
            })),
          }
        : {}),
      original_main_path: portable.main,
      entrypoint: prepared.entrypoint,
      members: prepared.members,
      ...(prepared.required === undefined ? {} : { requires: prepared.required }),
      ...(input.relationBindings === undefined
        ? {}
        : { relation_bindings: input.relationBindings }),
      ...(portable.projection === undefined ? {} : { input_projection: portable.projection }),
      ...(sourceProjection === undefined ? {} : { source_projection: sourceProjection }),
      files: candidates.map((file) => ({
        path: file.path,
        input_path: file.input_path,
        input_sha256: file.input.sha256,
        input_bytes: file.input.bytes,
        content: file.content,
        projection: sharedNotionMarkdownPolicy(file.projection),
      })),
      reference_check: prepared.references,
    }
    const digest = yield* sha256(canonicalSharedJson(identity))
    const skillId = sourceProjection?.skill_id ?? `skill-${digest}`
    const eventFor = <A extends Omit<FileEvent, "event_id">>(fields: A) =>
      sha256(canonicalSharedJson({ version: 1, ...fields })).pipe(
        Effect.map((hash) => ({ ...fields, event_id: `create-file-${hash}` })),
      )
    const baselineFor = (fileId: string, path: string, native: boolean) =>
      Effect.gen(function* () {
        const original = local?.local.baseline_inputs.find((file) => file.path === path)
        if (original === undefined || local === undefined) return undefined
        if (!native)
          return {
            event: yield* eventFor({
              kind: "resource_followed" as const,
              file_id: fileId,
              parents: [] as readonly string[],
              source_id: local.local.baseline.source_id,
              source_revision: local.local.baseline.commit,
              path,
              source_path: path,
              content: original.prepared.content,
              retained: null,
            }),
            body: undefined,
          }
        const bytes = local.baselineBytes.get(path)!,
          metadata =
            original.prepared.content.mode === null ? {} : { mode: original.prepared.content.mode }
        const text = yield* createChecked(() =>
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: projectionVersion >= 11 }).decode(
            bytes,
          ),
        )
        const supporting =
          path !== prepared.entrypoint && projectionVersion >= 11
            ? splitNativeSupportingMarkdown(text)
            : undefined
        const body =
          path === prepared.entrypoint
            ? yield* createChecked(
                () =>
                  importDocument(
                    { path, bytes },
                    { name: prepared.name, description: prepared.description },
                  ).body,
              )
            : (supporting?.body ?? text)
        const projection = yield* createChecked(() =>
          projectSharedNotionMarkdown(body, {
            version: projectionVersion,
            purpose: "data_source_create",
          }),
        )
        const hash = yield* sha256(projection.markdown)
        const content = {
          object_id: `body-${hash}`,
          sha256: hash,
          bytes: new TextEncoder().encode(projection.markdown).length,
          ...metadata,
          ...(path === prepared.entrypoint ? { frontmatter: nativeMainFrontmatter(text) } : {}),
          ...(supporting?.frontmatter === undefined ? {} : { frontmatter: supporting.frontmatter }),
        }
        const event = yield* eventFor({
          kind: "projected" as const,
          file_id: fileId,
          parents: [] as readonly string[],
          source_revision: local.local.baseline.commit,
          projection: { normalization_version: 1 as const, sha256: hash },
          ...nativeFileMetadata(content),
        })
        return { event, body: { markdown: projection.markdown, content } }
      })
    const files = yield* Effect.forEach(candidates, (file) =>
      Effect.gen(function* () {
        const fileId = `file-${yield* sha256(canonicalSharedJson([skillId, file.path]))}`
        const baseline = yield* baselineFor(fileId, file.path, true)
        const parents = baseline === undefined ? [] : [baseline.event.event_id]
        const change = local?.changes.get(file.path)
        const fields =
          change === "deleted"
            ? { kind: "deleted" as const, file_id: fileId, parents, retained: file.content }
            : sourceProjection === undefined || change === "custom"
              ? {
                  kind: "adopted" as const,
                  file_id: fileId,
                  parents,
                  content: file.content,
                }
              : sourceProjection.version === 2
                ? {
                    kind: "source_projection_pending" as const,
                    file_id: fileId,
                    parents: [] as readonly string[],
                    projection: { normalization_version: 1 as const, sha256: file.content.sha256 },
                    ...nativeFileMetadata(file.content),
                  }
                : {
                    kind: "projected" as const,
                    file_id: fileId,
                    parents: [] as readonly string[],
                    source_revision: sourceProjection.binding.commit,
                    projection: { normalization_version: 1 as const, sha256: file.content.sha256 },
                    ...nativeFileMetadata(file.content),
                  }
        const event =
          fields.kind === "source_projection_pending"
            ? {
                ...fields,
                event_id: `create-projection-${yield* sha256(canonicalSharedJson({ version: 1, ...fields }))}`,
              }
            : yield* eventFor(fields)
        return {
          ...file,
          file_id: fileId,
          event,
          ...(baseline === undefined ? {} : { ancestors: [baseline.event] }),
          ...(baseline?.body === undefined ? {} : { baseline_body: baseline.body }),
        }
      }),
    )
    const resourceFiles =
      resources === undefined
        ? undefined
        : yield* Effect.forEach(resources, (file) =>
            Effect.gen(function* () {
              const fileId = `file-${yield* sha256(canonicalSharedJson([skillId, file.path]))}`
              const baseline = yield* baselineFor(fileId, file.path, false),
                parents = baseline === undefined ? [] : [baseline.event.event_id]
              const fields =
                local?.changes.get(file.path) === "deleted"
                  ? {
                      kind: "deleted" as const,
                      file_id: fileId,
                      parents,
                      retained: file.prepared.content,
                    }
                  : {
                      kind: "adopted" as const,
                      file_id: fileId,
                      parents,
                      content: file.prepared.content,
                    }
              return {
                ...file,
                file_id: fileId,
                event: yield* eventFor(fields),
                ...(baseline === undefined ? {} : { ancestors: [baseline.event] }),
              }
            }),
          )
    const plan: SharedCreatePlan = {
      version: 1,
      kind: "skill_create",
      operation_id: `skill-create-${digest}`,
      library,
      skill_id: skillId,
      content_kind: portable.kind,
      name: prepared.name,
      description: prepared.description,
      default_context: input.defaultContext ?? false,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(complete ? { complete_resources: 1 as const, resources: resourceFiles! } : {}),
      original_main_path: portable.main,
      entrypoint: prepared.entrypoint,
      members: prepared.members,
      ...(prepared.required === undefined ? {} : { requires: prepared.required }),
      ...(input.relationBindings === undefined
        ? {}
        : { relation_bindings: input.relationBindings }),
      reference_check: prepared.references,
      files,
      ...(portable.projection === undefined ? {} : { input_projection: portable.projection }),
      ...(sourceProjection === undefined ? {} : { source_projection: sourceProjection }),
    }
    yield* createChecked(() => {
      Schema.decodeUnknownSync(SharedCreatePlanSchema)(plan, { onExcessProperty: "error" })
      validateSharedRecordEnvelope(plan.operation_id, sharedCreateManifest(plan), "operation")
      if (plan.source_projection?.version === 1)
        validateSharedRecordEnvelope(
          `register-${plan.source_projection.binding.source_id}`,
          plan.source_projection.binding,
          "source",
        )
      for (const file of files) {
        validateSharedRecordEnvelope(
          `retain-input-${file.input.sha256}`,
          sharedCreateInputPayload(file.input.text),
        )
        validateSharedRecordEnvelope(
          `retain-${file.content.sha256}`,
          sharedCreateBodyPayload(file.projection.markdown),
        )
        validateSharedRecordEnvelope(file.event.event_id, file.event)
      }
      for (const file of sharedCreateFiles(plan)) {
        for (const event of [...(file.ancestors ?? []), file.event])
          validateSharedRecordEnvelope(event.event_id, event)
        if (file.event.kind !== "source_projection_pending")
          resolveFileState(file.file_id, [...(file.ancestors ?? []), file.event])
      }
    })
    return plan
  })
}

/** Prepare the same dispatcher input with migration identities and ownership.
 * This is a deterministic origin reconstruction, not permission to dispatch;
 * executeSharedCreate requires the original migration input for new writes. */
export function makeSharedMigrationCreatePlan(
  candidate: unknown,
  members: readonly MigrationMemberBinding[] = [],
) {
  return Effect.gen(function* () {
    const origin = yield* makeSharedMigrationCreateOrigin(candidate, members)
    const source = origin.candidate
    const files = source.files.map((file) => ({
      file_id: file.file_id,
      path: file.path,
      input_path: file.path,
      input: {
        object_id: `input-${file.input.sha256}`,
        text: file.input.text,
        sha256: file.input.sha256,
        bytes: file.input.bytes,
      },
      projection: file.projection,
      content: file.content,
      event: file.initial_event,
    }))
    const fields = {
      version: 2 as const,
      kind: "skill_create" as const,
      library: source.library,
      skill_id: source.skill_id,
      content_kind: source.metadata.kind,
      name: source.metadata.name,
      description: source.metadata.description,
      default_context: source.metadata.default_context,
      original_main_path: source.metadata.entrypoint,
      entrypoint: source.metadata.entrypoint,
      members: origin.member_bindings.map((member) => member.page_id).sort(),
      reference_check: source.reference_check,
      files,
      origin,
    }
    const digest = yield* sha256(canonicalSharedJson(fields))
    const plan: SharedCreatePlan = { ...fields, operation_id: `skill-create-${digest}` }
    yield* createChecked(() => {
      Schema.decodeUnknownSync(SharedCreatePlanSchema)(plan, { onExcessProperty: "error" })
      validateSharedRecordEnvelope(plan.operation_id, sharedCreateManifest(plan), "operation")
      for (const file of files) {
        validateSharedRecordEnvelope(
          `retain-input-${file.input.sha256}`,
          sharedCreateInputPayload(file.input.text),
        )
        validateSharedRecordEnvelope(
          `retain-${file.content.sha256}`,
          sharedCreateBodyPayload(file.projection.markdown),
        )
        validateSharedRecordEnvelope(file.event.event_id, file.event)
      }
    })
    return plan
  })
}

/** Reconstruction must select the retained policy, never the newest default.
 * Every file in one native create shares the same creation policy. */
export function sharedCreateProjectionVersion(
  files: readonly {
    readonly projection: {
      readonly version: SharedNotionMarkdownVersion
      readonly purpose?: string
    }
  }[],
): SharedNotionMarkdownVersion {
  const version = files[0]?.projection.version
  if (
    version === undefined ||
    files.some(
      (file) =>
        file.projection.version !== version ||
        (file.projection.version !== 1 && file.projection.purpose !== "data_source_create"),
    )
  )
    throw fail(
      "SHARED_CREATE_INVALID",
      "The original create must retain one complete creation projection policy.",
    )
  return version
}

export function validateSharedCreatePlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreatePlanSchema)(input, { onExcessProperty: "error" }),
    )
    // Reconstruct only from exact retained original inputs; expected candidates,
    // stable IDs and hashes are never accepted from a mutable caller as authority.
    if (plan.version === 2) {
      const expected = yield* makeSharedMigrationCreatePlan(
        plan.origin.candidate,
        plan.origin.member_bindings,
      )
      if (canonicalSharedJson(expected) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_INVALID",
            "The native create differs from its complete retained migration origin.",
          ),
        )
      return expected
    }
    const portable: PortableSkill = {
      kind: plan.content_kind,
      name: plan.name,
      description: plan.description,
      main: plan.original_main_path,
      files: plan.files.map((file) => ({
        path: file.input_path,
        bytes: new TextEncoder().encode(file.input.text),
        ...(file.input.mode === undefined ? {} : { mode: file.input.mode }),
      })),
      ...(plan.input_projection === undefined ? {} : { projection: plan.input_projection }),
    }
    if ((plan.complete_resources === 1) !== (plan.resources !== undefined))
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_INVALID",
          "A complete creation must freeze its entire raw resource set.",
        ),
      )
    const rawFiles = []
    for (const file of plan.resources ?? []) {
      const verified = yield* validatePreparedSharedResource(file.prepared)
      rawFiles.push({
        path: file.input_path,
        bytes: verified.bytes,
        ...(file.prepared.content.mode === null ? {} : { mode: file.prepared.content.mode }),
      })
    }
    const completePortable = { ...portable, files: [...portable.files, ...rawFiles] }
    const projectionVersion = yield* createChecked(() => sharedCreateProjectionVersion(plan.files))
    const expected = yield* makeSharedCreatePlan(
      plan.library,
      {
        portable: completePortable,
        defaultContext: plan.default_context,
        ...(plan.enabled === undefined ? {} : { enabled: plan.enabled }),
        ...(plan.complete_resources === undefined ? {} : { completeResources: true }),
        ...(plan.content_kind === "router" || plan.members.length > 0
          ? { members: plan.members }
          : {}),
        ...(plan.requires === undefined ? {} : { requires: plan.requires }),
        ...(plan.relation_bindings === undefined
          ? {}
          : { relationBindings: plan.relation_bindings }),
        ...(plan.source_projection === undefined
          ? {}
          : { sourceProjection: plan.source_projection }),
      },
      projectionVersion,
    )
    if (canonicalSharedJson(expected) !== canonicalSharedJson(plan))
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_INVALID",
          "The frozen native creation plan differs from its complete original input and declared projection policy.",
        ),
      )
    return plan
  })
}
