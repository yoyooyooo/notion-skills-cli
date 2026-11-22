import { Crypto, Effect } from "effect"
import {
  ContentKindSchema,
  decode,
  entrypointFor,
  fail,
  SkillsError,
  validateDescription,
  validateDisplayName,
  type ContentKind,
} from "./model.ts"
import { planSharedFiles } from "./shared-composition.ts"
import { decodeCurrentFileContent, type CurrentFileContent } from "./shared-current-file.ts"
import { isCurrentProjectionBinary } from "./shared-current-projection.ts"
import { validateCurrentWriteRelations } from "./shared-current-relations.ts"
import type { PortableRelations } from "./portable.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import {
  prepareCurrentSharedResource,
  validatePreparedCurrentSharedResource,
  type PreparedCurrentSharedResource,
} from "./shared-current-resource.ts"
import { currentUploadFileSpec } from "./shared-current-upload.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { nativeFileTransport, validateNativeMarkdown } from "./shared-native-markdown.ts"

export type CurrentWriteAuthority =
  | { readonly kind: "resource" }
  | { readonly kind: "native" }
  | {
      readonly kind: "source"
      readonly source_id: string
      readonly revision: string
      readonly source_path: string
    }
export type CurrentSkillWriteInput = {
  readonly skill_id: string
  readonly kind: ContentKind
  readonly name: string
  readonly description: string
  readonly enabled?: boolean
  readonly default_context?: boolean
  readonly relations?: PortableRelations
  readonly files: readonly {
    readonly path: string
    readonly bytes: Uint8Array
    readonly mode?: "100644" | "100755"
    readonly file_id?: string
    readonly authority?: CurrentWriteAuthority
  }[]
}
type PreparedFileBase = {
  readonly path: string
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly mode: "100644" | "100755"
  readonly file_id?: string
}
export type PreparedCurrentWriteFile = PreparedFileBase &
  (
    | {
        readonly kind: "resource"
        readonly content: Extract<CurrentFileContent, { kind: "resource" }>
        readonly resource: PreparedCurrentSharedResource
      }
    | {
        readonly kind: "native"
        readonly content: Extract<CurrentFileContent, { kind: "native" }>
        readonly markdown: string
      }
    | {
        readonly kind: "source"
        readonly content: Extract<CurrentFileContent, { kind: "source" }>
        readonly reading_resource: PreparedCurrentSharedResource | null
      }
  )
export type PreparedCurrentSkillWrite = {
  readonly skill_id: string
  readonly kind: ContentKind
  readonly name: string
  readonly description: string
  readonly enabled?: boolean
  readonly default_context?: boolean
  readonly relations?: PortableRelations
  readonly main: string
  readonly files: readonly PreparedCurrentWriteFile[]
  readonly input_sha256: string
}
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_WRITE_INPUT_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Invalid complete current Skill input."),
  })
export function currentWriteIdentity(input: string, label: string): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(input))
    throw invalid(`${label} must be a stable bounded identity.`)
  return input
}
function boundedContent(content: CurrentFileContent): void {
  if (new TextEncoder().encode(canonicalSharedJson(content)).byteLength > 128 * 1024)
    throw invalid(
      "The native Content property is too large. Select resource to retain the exact original with a complete reading projection.",
    )
}

function validateWriteFileInput(file: CurrentSkillWriteInput["files"][number]): void {
  if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > 64 * 1024 * 1024)
    throw invalid("Each current original must contain at most 64 MiB.", { path: file.path })
  if (file.mode !== undefined && file.mode !== "100644" && file.mode !== "100755")
    throw invalid("Only regular-file modes are supported.")
  if (file.file_id !== undefined) currentWriteIdentity(file.file_id, "File ID")
  planSharedFiles({ base: [file], mounts: [], overrides: [], entrypoint: file.path })
}

/** Prepare one selected file. Complete-tree reference and membership admission
 * stays with the caller, so a Source coordinator need not invent a main body. */
export function prepareCurrentWriteFile(
  inputFile: CurrentSkillWriteInput["files"][number],
): Effect.Effect<PreparedCurrentWriteFile, SkillsError, Crypto.Crypto> {
  return Effect.gen(function* () {
    const { bytes, mode } = yield* checked(() => {
      validateWriteFileInput(inputFile)
      return { bytes: inputFile.bytes.slice(), mode: inputFile.mode ?? "100644" }
    })
    const base = {
      path: inputFile.path,
      bytes,
      mode,
      sha256: yield* sha256(bytes),
      ...(inputFile.file_id === undefined ? {} : { file_id: inputFile.file_id }),
    }
    const authority = inputFile.authority ?? { kind: "resource" }
    if (authority.kind === "resource") {
      const binary = isCurrentProjectionBinary(inputFile.path, bytes)
      const spec = yield* checked(() => currentUploadFileSpec(inputFile.path))
      const needsAttachment = binary || bytes.byteLength > 32 * 1024
      const resource = yield* prepareCurrentSharedResource(bytes, mode, {
        storage: binary ? "attachment" : "auto",
        ...(needsAttachment && spec.archiveName !== undefined
          ? { archiveName: spec.archiveName }
          : {}),
      })
      return { ...base, kind: "resource", content: resource.content, resource }
    } else if (authority.kind === "native") {
      const native = yield* checked(() => {
        const original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
        const header =
          /^(\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)(?:\r?\n)*)/u.exec(original)?.[1] ?? ""
        const markdown = original.slice(header.length)
        validateNativeMarkdown(markdown)
        if (
          new TextEncoder().encode(
            JSON.stringify({
              markdown_version: "v2",
              type: "replace_content",
              replace_content: { new_str: nativeFileTransport({ path: inputFile.path, markdown }) },
            }),
          ).byteLength > 480000
        )
          throw invalid(
            "This native body exceeds one bounded Notion replacement. Select resource for its complete reading projection.",
            { path: inputFile.path },
          )
        const content = decodeCurrentFileContent({ kind: "native", mode, frontmatter: header })
        if (content.kind !== "native") throw invalid("Invalid native authority.")
        boundedContent(content)
        return { content, markdown }
      })
      return { ...base, kind: "native", ...native }
    } else if (authority.kind === "source") {
      const content = yield* checked(() =>
        decodeCurrentFileContent({
          ...authority,
          sha256: base.sha256,
          bytes: bytes.byteLength,
          mode,
        }),
      )
      if (content.kind !== "source") return yield* Effect.fail(invalid("Invalid Source authority."))
      const binary = isCurrentProjectionBinary(inputFile.path, bytes)
      const spec = yield* checked(() => currentUploadFileSpec(inputFile.path))
      const reading_resource = binary
        ? yield* prepareCurrentSharedResource(bytes, mode, {
            storage: "attachment",
            ...(spec.archiveName === undefined ? {} : { archiveName: spec.archiveName }),
          })
        : null
      return { ...base, kind: "source", content, reading_resource }
    } else return yield* Effect.fail(invalid("Select native, resource or source authority."))
  })
}

/** Freeze current carriers as well as authored identity; never serialize bytes
 * into an operation fingerprint. A Source reading resource is not its authority. */
export function currentWriteFileFingerprint(file: PreparedCurrentWriteFile) {
  return {
    path: file.path,
    file_id: file.file_id ?? null,
    content: file.content,
    sha256: file.sha256,
    bytes: file.bytes.byteLength,
    mode: file.mode,
    ...(file.kind === "source"
      ? {
          reading_resource:
            file.reading_resource === null
              ? null
              : {
                  content: file.reading_resource.content,
                  manifest: file.reading_resource.manifest,
                },
        }
      : {}),
  }
}

/** Prepare a complete replacement tree before any network mutation. Original
 * bytes remain exact; native Markdown is an explicit authoring choice. */
export function prepareCurrentSkillWrite(input: CurrentSkillWriteInput) {
  return Effect.gen(function* () {
    const metadata = yield* checked(() => {
      const skill_id = currentWriteIdentity(input.skill_id, "Skill ID")
      const kind = decode(ContentKindSchema, input.kind),
        main = entrypointFor(kind)
      if (
        input.files.length === 0 ||
        input.files.length > 10000 ||
        input.files.reduce((size, file) => size + file.bytes.byteLength, 0) > 128 * 1024 * 1024
      )
        throw invalid("One complete Skill is bounded to 10,000 files and 128 MiB.")
      planSharedFiles({ base: input.files, mounts: [], overrides: [], entrypoint: main })
      assertSharedFileReferences(input.files)
      const identities = new Set<string>()
      for (const file of input.files) {
        if (file.file_id !== undefined) {
          currentWriteIdentity(file.file_id, "File ID")
          if (identities.has(file.file_id))
            throw invalid("Each File ID must select one current path.")
          identities.add(file.file_id)
        }
      }
      if (
        (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
        (input.default_context !== undefined && typeof input.default_context !== "boolean")
      )
        throw invalid("Current enablement and default-context values must be booleans.")
      return {
        skill_id,
        kind,
        name: validateDisplayName(input.name),
        description: validateDescription(input.description),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.default_context === undefined ? {} : { default_context: input.default_context }),
        ...(input.relations === undefined
          ? {}
          : {
              relations: validateCurrentWriteRelations(input.relations, kind, skill_id),
            }),
        main,
      }
    })
    const files = yield* Effect.forEach(
      [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      prepareCurrentWriteFile,
    )
    const fingerprint = {
      ...metadata,
      files: files.map(currentWriteFileFingerprint),
    }
    return {
      ...metadata,
      files,
      input_sha256: yield* sha256(canonicalSharedJson(fingerprint)),
    } satisfies PreparedCurrentSkillWrite
  })
}

function validatePreparedCurrentWriteFile(
  file: PreparedCurrentWriteFile,
): Effect.Effect<PreparedCurrentWriteFile, SkillsError, Crypto.Crypto> {
  return Effect.gen(function* () {
    yield* checked(() => {
      validateWriteFileInput(file)
      if (
        typeof file.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        (file.mode !== "100644" && file.mode !== "100755")
      )
        throw invalid("The prepared file identity or mode is invalid.", { path: file.path })
      const content = decodeCurrentFileContent(file.content)
      boundedContent(content)
      if (content.kind !== file.kind || content.mode !== file.mode)
        throw invalid("Prepared authority and content disagree.", { path: file.path })
      if (
        content.kind !== "native" &&
        (content.sha256 !== file.sha256 || content.bytes !== file.bytes.byteLength)
      )
        throw invalid("Prepared exact-byte metadata changed.", { path: file.path })
      if (file.kind === "native") {
        if (
          typeof file.markdown !== "string" ||
          new TextEncoder().encode(
            JSON.stringify({
              markdown_version: "v2",
              type: "replace_content",
              replace_content: { new_str: nativeFileTransport(file) },
            }),
          ).byteLength > 480000
        )
          throw invalid("Prepared native Markdown exceeds its exact text boundary.", {
            path: file.path,
          })
        validateNativeMarkdown(file.markdown)
        const original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          file.bytes,
        )
        if (file.content.frontmatter + file.markdown !== original)
          throw invalid("The prepared native body differs from its original bytes.", {
            path: file.path,
          })
      }
      if (file.kind === "source") {
        const binary = isCurrentProjectionBinary(file.path, file.bytes)
        if (
          binary
            ? file.reading_resource?.status !== "needs_attachment"
            : file.reading_resource !== null
        )
          throw invalid(
            "Source binary reading requires one current attachment; text requires no reading resource.",
            { path: file.path },
          )
      }
    })
    if ((yield* sha256(file.bytes)) !== file.sha256)
      return yield* Effect.fail(
        invalid("The prepared original bytes changed. Prepare the complete input again.", {
          path: file.path,
        }),
      )
    if (file.kind === "resource") {
      const prepared = yield* validatePreparedCurrentSharedResource(file.resource)
      if (canonicalSharedJson(prepared.content) !== canonicalSharedJson(file.content))
        return yield* Effect.fail(invalid("The prepared resource differs from its selected file."))
    }
    if (file.kind === "source" && file.reading_resource !== null) {
      const reading = yield* validatePreparedCurrentSharedResource(file.reading_resource)
      const spec = yield* checked(() => currentUploadFileSpec(file.path))
      const storage = reading.manifest.storage
      if (
        reading.content.sha256 !== file.sha256 ||
        reading.content.bytes !== file.bytes.byteLength ||
        reading.content.mode !== file.mode ||
        (storage.kind === "zip_attachment"
          ? storage.entry !== file.path
          : storage.kind !== "attachment" || spec.archiveName !== undefined)
      )
        return yield* Effect.fail(
          invalid(
            "The Source reading attachment differs from its exact original or current path.",
            { path: file.path },
          ),
        )
    }
    return file
  })
}

/** Validate a private prepared-file copy without rebuilding its attachment. */
export function copyValidatedCurrentWriteFile(
  input: PreparedCurrentWriteFile,
): Effect.Effect<PreparedCurrentWriteFile, SkillsError, Crypto.Crypto> {
  return Effect.gen(function* () {
    const file = yield* checked(() => structuredClone(input))
    return yield* validatePreparedCurrentWriteFile(file)
  })
}

/** Prepared plans cross an asynchronous API boundary. Keep a private copy and
 * recheck its current identity before any remote lookup or mutation. This does
 * not recompress an attachment or retain a second version of authored content. */
export function copyValidatedCurrentSkillWrite(input: PreparedCurrentSkillWrite) {
  return Effect.gen(function* () {
    const plan = yield* checked(() => {
      const value = structuredClone(input)
      currentWriteIdentity(value.skill_id, "Skill ID")
      decode(ContentKindSchema, value.kind)
      validateDisplayName(value.name)
      validateDescription(value.description)
      if (
        value.relations !== undefined &&
        canonicalSharedJson(value.relations) !==
          canonicalSharedJson(
            validateCurrentWriteRelations(value.relations, value.kind, value.skill_id),
          )
      )
        throw invalid("The prepared current relation selection changed.")
      if (
        value.main !== entrypointFor(value.kind) ||
        (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
        (value.default_context !== undefined && typeof value.default_context !== "boolean") ||
        !/^[a-f0-9]{64}$/u.test(value.input_sha256) ||
        !Array.isArray(value.files) ||
        value.files.length === 0 ||
        value.files.length > 10000
      )
        throw invalid("The prepared current Skill metadata is invalid.")
      planSharedFiles({ base: value.files, mounts: [], overrides: [], entrypoint: value.main })
      assertSharedFileReferences(value.files)
      const ids = new Set<string>()
      let bytes = 0
      for (const file of value.files) {
        if (!(file.bytes instanceof Uint8Array))
          throw invalid("The prepared file bytes are invalid.", { path: file.path })
        bytes += file.bytes.byteLength
        if (file.file_id !== undefined) {
          currentWriteIdentity(file.file_id, "File ID")
          if (ids.has(file.file_id)) throw invalid("The prepared tree repeats a File ID.")
          ids.add(file.file_id)
        }
      }
      if (bytes > 128 * 1024 * 1024) throw invalid("The prepared tree exceeds 128 MiB.")
      return value
    })
    for (const file of plan.files) yield* validatePreparedCurrentWriteFile(file)
    const { input_sha256, files, ...metadata } = plan
    const fingerprint = {
      ...metadata,
      files: files.map(currentWriteFileFingerprint),
    }
    if ((yield* sha256(canonicalSharedJson(fingerprint))) !== input_sha256)
      return yield* Effect.fail(
        invalid(
          "The prepared current input fingerprint changed. Prepare the complete input again.",
        ),
      )
    return plan
  })
}
