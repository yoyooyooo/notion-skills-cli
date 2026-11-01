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
import { FileEventSchema, RetainedContentSchema } from "./shared-file-state.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownPolicy,
  SharedNotionMarkdownPolicySchema,
  SharedNotionMarkdownProjectionSchema,
} from "./shared-notion-projection.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { parseYaml } from "./yaml.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const PortableProjectionSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  references: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  materialization: Schema.optional(
    Schema.Struct({ authored: Schema.String, generated: Schema.String }),
  ),
})
export const SharedCreatePlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_create"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  skill_id: Identity,
  content_kind: ContentKindSchema,
  name: Schema.String,
  description: Schema.String,
  default_context: Schema.Boolean,
  original_main_path: Schema.String,
  entrypoint: Schema.String,
  members: Schema.Array(Schema.String),
  input_projection: Schema.optional(PortableProjectionSchema),
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
      }),
      projection: SharedNotionMarkdownProjectionSchema,
      content: RetainedContentSchema,
      event: FileEventSchema,
    }),
  ),
})
export type SharedCreatePlan = typeof SharedCreatePlanSchema.Type
export const SharedCreateManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_create_manifest"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  skill_id: Identity,
  content_kind: ContentKindSchema,
  name: Schema.String,
  description: Schema.String,
  default_context: Schema.Boolean,
  original_main_path: Schema.String,
  entrypoint: Schema.String,
  members: Schema.Array(Schema.String),
  input_projection: Schema.optional(PortableProjectionSchema),
  reference_check: Schema.Struct({ checked_files: Schema.Number, local_references: Schema.Number }),
  files: Schema.Array(
    Schema.Struct({
      file_id: Identity,
      path: Schema.String,
      input_path: Schema.String,
      input: Schema.Struct({ object_id: Identity, sha256: Hash, bytes: Schema.Number }),
      projection: SharedNotionMarkdownPolicySchema,
      content: RetainedContentSchema,
      event: FileEventSchema,
    }),
  ),
})
export const SharedCreateJournalSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  library_id: Identity,
  plan: SharedCreatePlanSchema,
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
  binary_support: false,
  metadata_compare_and_swap: false,
} as const
export function sharedCreateExpectations(
  plan: SharedCreatePlan,
  bindings: readonly {
    readonly file_id: string
    readonly path: string
    readonly page_id: string
  }[],
) {
  return {
    expected_files: plan.files.map((file) => {
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
    expected_metadata: {
      name: plan.name,
      description: plan.description,
      kind: plan.content_kind,
      enabled: true as const,
      default_context: plan.default_context,
      ...(plan.content_kind === "router" ? { members: plan.members } : {}),
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
export function sharedCreateInputPayload(text: string) {
  return { version: 1 as const, kind: "utf8_input" as const, text }
}
export function sharedCreateBodyPayload(markdown: string) {
  return {
    version: 1 as const,
    kind: "normalized_markdown" as const,
    normalization_version: 1 as const,
    markdown,
  }
}

/** Only hashes and exact identities live in the manifest; body objects are separate. */
export function sharedCreateManifest(plan: SharedCreatePlan) {
  return {
    version: 1 as const,
    kind: "skill_create_manifest" as const,
    operation_id: plan.operation_id,
    library: plan.library,
    skill_id: plan.skill_id,
    content_kind: plan.content_kind,
    name: plan.name,
    description: plan.description,
    default_context: plan.default_context,
    original_main_path: plan.original_main_path,
    entrypoint: plan.entrypoint,
    members: plan.members,
    ...(plan.input_projection === undefined ? {} : { input_projection: plan.input_projection }),
    reference_check: plan.reference_check,
    files: plan.files.map((file) => ({
      file_id: file.file_id,
      path: file.path,
      input_path: file.input_path,
      input: {
        object_id: file.input.object_id,
        sha256: file.input.sha256,
        bytes: file.input.bytes,
      },
      projection: sharedNotionMarkdownPolicy(file.projection),
      content: file.content,
      event: file.event,
    })),
  }
}

export interface SharedCreateInput {
  readonly portable: PortableSkill
  readonly defaultContext?: boolean
  /** Exact same-library current page identities, resolved before freezing. */
  readonly members?: readonly string[]
}

/** Deterministic, no I/O: input bytes, explicit projection and every identity freeze together. */
export function makeSharedCreatePlan(
  library: SharedLibrary,
  input: SharedCreateInput,
  projectionVersion: 1 | 2 | 3 = 3,
) {
  return Effect.gen(function* () {
    const portable = input.portable
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
      if (input.members !== undefined && portable.kind !== "router")
        throw fail("INVALID_MEMBERS", "Only a native Router may specify Members.")
      const members = [...new Set(input.members ?? [])].sort()
      if (members.some((id) => pageId(id) !== id) || members.length > 100)
        throw fail(
          "INVALID_MEMBERS",
          "Native create accepts at most 100 exact canonical member page identities in one relation create.",
        )
      if (portable.kind === "router" && library.skills.property_ids.Members === undefined)
        throw fail(
          "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
          "This library needs a registered native Members relation before Router creation.",
        )
      const files = portable.files
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
          if (file.path === portable.main && projectionVersion !== 1) {
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
          const authored =
            file.path === portable.main ? importDocument(file, { name, description }).body : text
          return {
            path,
            input_path: file.path,
            text,
            projection: projectSharedNotionMarkdown(authored, {
              version: projectionVersion,
              purpose: "data_source_create",
            }),
          }
        })
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      const tree = composeSharedFiles({
        base: files.map((file) => ({
          path: file.path,
          bytes: new TextEncoder().encode(file.projection.markdown),
        })),
        mounts: [],
        overrides: [],
        entrypoint,
      })
      const references = assertSharedFileReferences(tree.files, projectionVersion)
      return { name, description, entrypoint, members, files, references }
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
          },
          projection: file.projection,
          content: {
            object_id: `body-${bodyHash}`,
            sha256: bodyHash,
            bytes: new TextEncoder().encode(file.projection.markdown).length,
          },
        }
      }),
    )
    const identity = {
      version: 1,
      library,
      content_kind: portable.kind,
      name: prepared.name,
      description: prepared.description,
      default_context: input.defaultContext ?? false,
      original_main_path: portable.main,
      entrypoint: prepared.entrypoint,
      members: prepared.members,
      ...(portable.projection === undefined ? {} : { input_projection: portable.projection }),
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
    const skillId = `skill-${digest}`
    const files = yield* Effect.forEach(candidates, (file) =>
      Effect.gen(function* () {
        const fileId = `file-${yield* sha256(canonicalSharedJson([skillId, file.path]))}`
        const fields = {
          kind: "adopted" as const,
          file_id: fileId,
          parents: [] as readonly string[],
          content: file.content,
        }
        const eventId = `create-file-${yield* sha256(canonicalSharedJson({ version: 1, ...fields }))}`
        return { ...file, file_id: fileId, event: { ...fields, event_id: eventId } }
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
      original_main_path: portable.main,
      entrypoint: prepared.entrypoint,
      members: prepared.members,
      reference_check: prepared.references,
      files,
      ...(portable.projection === undefined ? {} : { input_projection: portable.projection }),
    }
    yield* createChecked(() => {
      Schema.decodeUnknownSync(SharedCreatePlanSchema)(plan, { onExcessProperty: "error" })
      validateSharedRecordEnvelope(plan.operation_id, sharedCreateManifest(plan))
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
    readonly projection: { readonly version: 1 | 2 | 3; readonly purpose?: string }
  }[],
): 1 | 2 | 3 {
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
    const portable: PortableSkill = {
      kind: plan.content_kind,
      name: plan.name,
      description: plan.description,
      main: plan.original_main_path,
      files: plan.files.map((file) => ({
        path: file.input_path,
        bytes: new TextEncoder().encode(file.input.text),
      })),
      ...(plan.input_projection === undefined ? {} : { projection: plan.input_projection }),
    }
    const projectionVersion = yield* createChecked(() => sharedCreateProjectionVersion(plan.files))
    const expected = yield* makeSharedCreatePlan(
      plan.library,
      {
        portable,
        defaultContext: plan.default_context,
        ...(plan.content_kind === "router" ? { members: plan.members } : {}),
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
