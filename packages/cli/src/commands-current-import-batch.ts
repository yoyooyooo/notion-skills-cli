import { Crypto, Effect, Option, Path, Schema } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { loadSkillUpdateFile } from "../../core/src/import.ts"
import { lstatNoFollow } from "../../core/src/local-locks.ts"
import { fail, property, SkillsError, type ContentKind } from "../../core/src/model.ts"
import {
  MANIFEST,
  validatePortableRelations,
  type PortableRelations,
} from "../../core/src/portable.ts"
import { normalizePath } from "../../core/src/ref.ts"
import {
  bindSkillRef,
  formatSkillIdentity,
  formatSkillRef,
  parseSkillRef,
} from "../../core/src/skill-ref.ts"
import { readCurrentSkillMetadata } from "../../core/src/shared-current-index.ts"
import {
  freezeCurrentImportValue,
  thawCurrentImportSkill,
  thawCurrentImportPatch,
  withCurrentImportPlan,
  type CurrentImportDefinition,
  type CurrentImportSession,
} from "../../core/src/shared-current-import-plan.ts"
import { withCurrentInvocationBudget } from "../../core/src/shared-current-invocation.ts"
import {
  bindCurrentImportOrigin,
  planCurrentMembers,
  type CurrentMemberInput,
} from "../../core/src/shared-current-member-discovery.ts"
import { prepareCurrentBatchRelations } from "../../core/src/shared-current-relations.ts"
import { queryCurrentSkillIdentity } from "../../core/src/shared-current-skill-target.ts"
import {
  inspectCurrentSkillWrite,
  prepareCurrentSkillPatch,
  prepareCurrentSkillWrite,
  writeCurrentSkill,
  writeCurrentSkillPatch,
} from "../../core/src/shared-current-write.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import type { SharedLibrary } from "../../core/src/shared-library-model.ts"
import { canonicalSharedJson } from "../../core/src/shared-records.ts"
import { sha256 } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import {
  currentImportBudgetFlag,
  currentImportLimits,
  loadCurrentImportInput,
} from "./commands-current-import.ts"

const ManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  root: Schema.optional(Schema.String),
  skills: Schema.Array(
    Schema.Struct({
      root: Schema.String,
      skill_id: Schema.String,
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      native: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_IMPORT_BATCH_INVALID", message, details)
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Invalid explicit import batch."),
  })
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** Admit only roots the manifest names. A neighbouring directory is never
 * inspected to guess a Skill identity or expand the batch. */
export function loadCurrentImportBatch(manifestPath: string, rebindFrom?: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path
    const file = yield* loadSkillUpdateFile(manifestPath)
    const manifest = yield* checked(() => {
      if (file.bytes.byteLength > 2 * 1024 * 1024)
        throw invalid("The batch manifest exceeds 2 MiB.")
      const value = Schema.decodeUnknownSync(ManifestSchema)(
        JSON.parse(decoder.decode(file.bytes)),
        { onExcessProperty: "error" },
      )
      if (value.skills.length === 0 || value.skills.length > 100)
        throw invalid("Select between 1 and 100 explicit Skill roots.")
      if (rebindFrom !== undefined) formatSkillIdentity({ libraryId: rebindFrom, skillId: "probe" })
      const roots = new Set<string>(),
        ids = new Set<string>()
      for (const entry of value.skills) {
        formatSkillIdentity({ libraryId: "batch-admission", skillId: entry.skill_id })
        if (
          !entry.root ||
          normalizePath(entry.root) !== entry.root ||
          /[\p{Cc}\p{Cf}\p{Cs}*?<>#]/u.test(entry.root)
        )
          throw invalid("Each batch Skill root must be an exact relative POSIX directory.")
        if (
          ids.has(entry.skill_id) ||
          [...roots].some(
            (root) =>
              root === entry.root ||
              root.startsWith(entry.root + "/") ||
              entry.root.startsWith(root + "/"),
          )
        )
          throw invalid("Batch roots must be disjoint and stable Skill IDs must be distinct.")
        ids.add(entry.skill_id)
        roots.add(entry.root)
      }
      return value
    })
    const root = path.resolve(path.dirname(path.resolve(manifestPath)), manifest.root ?? ".")
    const items = []
    const physicalRoots: { readonly identity: string; readonly ancestors: ReadonlySet<string> }[] =
      []
    let totalBytes = 0,
      totalFiles = 0
    for (const entry of manifest.skills) {
      const directory = path.join(root, ...entry.root.split("/"))
      const before = yield* lstatNoFollow(directory)
      if (before === undefined || !before.isDirectory())
        return yield* Effect.fail(
          invalid("A batch root must be one ordinary directory.", { root: entry.root }),
        )
      const physical = `${before.dev}:${before.ino}`
      const ancestors = new Set<string>()
      const segments = entry.root.split("/")
      for (let length = 1; length < segments.length; length++) {
        const ancestor = yield* lstatNoFollow(path.join(root, ...segments.slice(0, length)))
        if (ancestor === undefined || !ancestor.isDirectory())
          return yield* Effect.fail(
            invalid("Every batch root ancestor must be an ordinary directory."),
          )
        ancestors.add(`${ancestor.dev}:${ancestor.ino}`)
      }
      if (
        physicalRoots.some(
          (previous) =>
            previous.identity === physical ||
            ancestors.has(previous.identity) ||
            previous.ancestors.has(physical),
        )
      )
        return yield* Effect.fail(
          invalid("Declared roots must select disjoint physical directories.", {
            root: entry.root,
            reason: "physical_root_reused",
          }),
        )
      physicalRoots.push({ identity: physical, ancestors })
      const input = yield* loadCurrentImportInput(directory, {
        skillId: entry.skill_id,
        name: entry.name,
        description: entry.description,
      })
      const after = yield* lstatNoFollow(directory)
      if (
        after === undefined ||
        !after.isDirectory() ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      )
        return yield* Effect.fail(
          invalid("A batch directory changed identity while its files were admitted.", {
            root: entry.root,
          }),
        )
      if (input.loaded.kind !== "directory")
        return yield* Effect.fail(invalid("A batch entry must name one complete directory."))
      const native = yield* checked(() => {
        const selected = new Set(entry.native ?? [])
        if (
          selected.size !== (entry.native?.length ?? 0) ||
          [...selected].some((name) => !input.admitted.files.some((file) => file.path === name))
        )
          throw invalid("Native selections must be distinct exact admitted paths.", {
            skill_id: entry.skill_id,
          })
        return selected
      })
      const portable = input.loaded.files.find((file) => file.path === MANIFEST)
      const rawRelations = yield* checked(() =>
        portable === undefined
          ? undefined
          : property(JSON.parse(decoder.decode(portable.bytes))).relations,
      )
      const originals = []
      for (const file of input.loaded.files)
        originals.push({
          path: file.path,
          mode: file.mode ?? "100644",
          sha256: yield* sha256(file.bytes),
        })
      const original_input_sha256 = yield* sha256(canonicalSharedJson({ entry, files: originals }))
      totalBytes += input.loaded.files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
      totalFiles += input.loaded.files.length
      if (totalBytes > 128 * 1024 * 1024 || totalFiles > 10000)
        return yield* Effect.fail(
          invalid("One batch is bounded to 10,000 files and 128 MiB total."),
        )
      items.push({
        root: entry.root,
        admitted: input.admitted,
        native,
        rawRelations,
        original_input_sha256,
      })
    }
    const request_sha256 = yield* sha256(
      canonicalSharedJson({
        manifest_sha256: yield* sha256(file.bytes),
        root,
        rebind_from: rebindFrom ?? null,
        inputs: items.map((item) => ({ root: item.root, sha256: item.original_input_sha256 })),
      }),
    )
    return { items, request_sha256, rebind_from: rebindFrom }
  })
}
type LoadedBatch = Effect.Success<ReturnType<typeof loadCurrentImportBatch>>
type Rewrite = CurrentImportDefinition["rewrites"][number]

function rebindRelations(
  input: unknown,
  library: SharedLibrary,
  rebindFrom: string | undefined,
  mapping: ReadonlyMap<string, string>,
  skillId: string,
  rewrites: Rewrite[],
): PortableRelations | undefined {
  if (input === undefined) return undefined
  const validated = validatePortableRelations(input)
  const original = property(input)
  const fields: { members?: string[]; requires?: string[] } = {}
  for (const field of ["members", "requires"] as const) {
    const source = original[field]
    if (source === undefined) continue
    if (!Array.isArray(source) || source.some((ref) => typeof ref !== "string"))
      throw invalid("Invalid original relationship syntax.")
    fields[field] = source.map((raw: string, index) => {
      const parsed = parseSkillRef(raw)
      const before = bindSkillRef(parsed, validated.library_id)
      const identity = formatSkillIdentity(before.owner)
      const rebound = rebindFrom === undefined ? undefined : mapping.get(identity)
      const after = rebound ?? identity
      if (rebound !== undefined && rebound !== identity)
        rewrites.push({
          skill_id: skillId,
          from: `relations.${field}[${index}]`,
          before: raw,
          after,
        })
      return after
    })
  }
  return validatePortableRelations({
    version: 1,
    ownership: "notion",
    library_id: library.library_id,
    ...fields,
  })
}

export function compileCurrentImportBatch(library: SharedLibrary, loaded: LoadedBatch) {
  return Effect.gen(function* () {
    const mapping = loaded.items.map((item) => ({
      root: item.root,
      identity: formatSkillIdentity({
        libraryId: library.library_id,
        skillId: item.admitted.skill_id,
      }),
    }))
    const rebound = new Map(
      loaded.rebind_from === undefined
        ? []
        : loaded.items.map((item) => [
            formatSkillIdentity({
              libraryId: loaded.rebind_from!,
              skillId: item.admitted.skill_id,
            }),
            formatSkillIdentity({ libraryId: library.library_id, skillId: item.admitted.skill_id }),
          ]),
    )
    const rewrites: Rewrite[] = []
    const owners = new Map<string, { readonly raw: unknown; readonly enabled: boolean }>()
    const targets: CurrentMemberInput[] = []
    for (const item of loaded.items) {
      const raw = yield* queryCurrentSkillIdentity(library, item.admitted.skill_id)
      if (raw !== undefined) {
        const page = property(raw).id
        if (typeof page !== "string")
          return yield* Effect.fail(invalid("The batch owner has no physical identity."))
        const metadata = yield* readCurrentSkillMetadata(library, page, raw)
        owners.set(item.admitted.skill_id, { raw, enabled: metadata.enabled })
        if (metadata.enabled) targets.push(item.admitted)
      } else targets.push(item.admitted)
    }
    const bindings = loaded.items.flatMap((item) => [
      {
        path: "batch/" + item.root,
        ref: formatSkillIdentity({
          libraryId: library.library_id,
          skillId: item.admitted.skill_id,
        }),
      },
      ...item.admitted.files.map((file) => ({
        path: "batch/" + item.root + "/" + file.path,
        ref: formatSkillRef({
          ...bindSkillRef(parseSkillRef("skill://" + item.admitted.skill_id), library.library_id),
          path: file.path,
        }),
      })),
    ])
    const compiled: (CurrentImportDefinition["items"][number] & {
      readonly kind: ContentKind
      readonly enabled: boolean
      readonly owner: unknown
    })[] = []
    for (const item of loaded.items) {
      const admitted = yield* checked(() => {
        const relations = rebindRelations(
          item.rawRelations,
          library,
          loaded.rebind_from,
          rebound,
          item.admitted.skill_id,
          rewrites,
        )
        const bound = bindCurrentImportOrigin(
          library.library_id,
          item.admitted,
          rebound.size === 0
            ? undefined
            : (owner) => {
                const identity = formatSkillIdentity(owner.owner)
                const mapped = rebound.get(identity)
                if (mapped === undefined || mapped === identity) return undefined
                const target = loaded.items.find(
                  (item) => item.admitted.skill_id === owner.owner.skillId,
                )
                if (
                  target === undefined ||
                  (owner.path !== "" &&
                    !target.admitted.files.some((file) => file.path === owner.path))
                )
                  return undefined
                return { ...bindSkillRef(parseSkillRef(mapped)), path: owner.path }
              },
        )
        rewrites.push(...bound.rewrites)
        const files = bound.files
        return { ...item.admitted, files, ...(relations === undefined ? {} : { relations }) }
      })
      const discovered = yield* planCurrentMembers(library, admitted, {
        existing: owners.has(admitted.skill_id),
        bindings: { version: 1, root: "batch/" + item.root, targets: bindings },
        plannedTargets: targets,
      })
      if (!discovered.importable)
        return yield* Effect.fail(
          fail(
            "CURRENT_IMPORT_BATCH_UNRESOLVED",
            "The batch has unresolved cross-root references. No Skill was written.",
            { skill_id: admitted.skill_id, unresolved: discovered.unresolved },
          ),
        )
      for (const rewrite of discovered.confirmed.filter((entry) => entry.rewritten)) {
        const ref = parseSkillRef(rewrite.ref)
        rewrites.push({
          skill_id: admitted.skill_id,
          from: rewrite.from + ":" + rewrite.line,
          before: rewrite.href,
          after: formatSkillRef({ ...ref, scope: { kind: "context" } }),
        })
      }
      const {
        portable,
        relations,
        importable: _importable,
        skill_id: _skillId,
        ...members_discovery
      } = discovered
      // Validate the final relation syntax before stripping it for the body phase.
      const prepared = yield* prepareCurrentSkillWrite({
        ...admitted,
        ...(relations === undefined ? {} : { relations }),
        files: portable.files.map((file) => ({
          ...file,
          authority: { kind: item.native.has(file.path) ? "native" : "resource" },
        })),
      })
      const { relations: _relations, ...bodyInput } = prepared
      const body = yield* prepareCurrentSkillWrite({
        ...bodyInput,
        files: prepared.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          mode: file.mode,
          authority: { kind: file.kind === "native" ? "native" : "resource" },
        })),
      })
      yield* inspectCurrentSkillWrite(library, body)
      compiled.push({
        skill_id: admitted.skill_id,
        kind: admitted.kind,
        enabled: owners.get(admitted.skill_id)?.enabled ?? true,
        owner: owners.get(admitted.skill_id)?.raw,
        original_input_sha256: item.original_input_sha256,
        body: yield* freezeCurrentImportValue(body),
        body_input_sha256: body.input_sha256,
        create_only: !owners.has(admitted.skill_id),
        ...(relations === undefined ? {} : { relations }),
        members_discovery,
      })
    }
    const order = yield* prepareCurrentBatchRelations(library, compiled)
    const items = order.map((id) => {
      const {
        kind: _kind,
        enabled: _enabled,
        owner: _owner,
        ...item
      } = compiled.find((item) => item.skill_id === id)!
      return item
    })
    return { version: 1, kind: "batch", mapping, rewrites, items } satisfies CurrentImportDefinition
  })
}

export function applyCurrentImportBatch(
  library: SharedLibrary,
  operation: string,
  session: CurrentImportSession,
) {
  return Effect.gen(function* () {
    // Every body is ready before any Members/Requires patch, including cycles.
    for (const item of session.definition.items) {
      const key = "body:" + item.skill_id
      if (session.step(key)?.phase === "complete") continue
      const plan = yield* thawCurrentImportSkill(item.body)
      const operation_id =
        "batch-body-" + (yield* sha256(canonicalSharedJson([operation, item.skill_id])))
      const phase = yield* session.start(key, {
        skill_id: item.skill_id,
        operation_id,
        input_sha256: item.body_input_sha256,
        prepared: item.body,
      })
      const result = yield* writeCurrentSkill(library, {
        plan,
        operation_id,
        mode: phase.mode,
        frozen_import: phase.proof,
        ...(item.create_only ? { create_only: true } : {}),
      })
      yield* session.complete(key, result)
    }
    for (const item of session.definition.items) {
      if (
        item.relations === undefined ||
        (item.relations.members === undefined && item.relations.requires === undefined)
      )
        continue
      const key = "relations:" + item.skill_id
      const previous = session.step(key)
      if (previous?.phase === "complete") continue
      const operation_id =
        "batch-relations-" + (yield* sha256(canonicalSharedJson([operation, item.skill_id])))
      const plan =
        previous === undefined
          ? yield* Effect.gen(function* () {
              const body = property(session.step("body:" + item.skill_id)?.result)
              if (typeof body.page_id !== "string")
                return yield* Effect.fail(invalid("The completed body has no exact owner."))
              return yield* prepareCurrentSkillPatch(library, {
                target: body.page_id,
                metadata: { relations: item.relations },
              })
            })
          : yield* thawCurrentImportPatch(previous.prepared)
      const prepared = previous?.prepared ?? (yield* freezeCurrentImportValue(plan))
      const phase = yield* session.start(key, {
        skill_id: item.skill_id,
        operation_id,
        input_sha256: plan.input_sha256,
        prepared,
      })
      const result = yield* writeCurrentSkillPatch(library, {
        plan,
        operation_id,
        mode: phase.mode,
        frozen_import: phase.proof,
      })
      yield* session.complete(key, result)
    }
    return {
      contract: "current",
      status: "applied",
      operation_id: operation,
      mapping: session.definition.mapping,
      rewrites: session.definition.rewrites,
      skills: session.definition.items.map((item) => ({
        skill_id: item.skill_id,
        body: session.step("body:" + item.skill_id)?.result,
        relations: session.step("relations:" + item.skill_id)?.result ?? null,
        members_discovery: item.members_discovery,
      })),
    }
  })
}

export const currentImportBatchCommand = defineCommand(
  "import-batch",
  {
    manifest: Argument.String("manifest"),
    entry: requiredSingleton("entry", "Current Skills database ID, URL or exact registered alias"),
    operation: singleton("operation", "Exact batch identity; required with --resume"),
    resume: switchFlag(
      "resume",
      "Resume the exact frozen batch without rediscovering relationships",
    ),
    dryRun: switchFlag(
      "dry-run",
      "Review exact mapping, rewrites and inferred relations without writing",
    ),
    rebindFrom: singleton(
      "rebind-from",
      "Explicitly copy the batch-owned current identities from this Library into the destination",
    ),
    maxRequests: currentImportBudgetFlag(
      "max-requests",
      "Positive maximum HTTP attempts for the invocation; default 1000",
    ),
    maxBytes: currentImportBudgetFlag(
      "max-bytes",
      "Positive maximum total HTTP payload bytes; default 536870912",
    ),
    timeout: currentImportBudgetFlag(
      "timeout",
      "Positive invocation deadline in ms; default 600000",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const limits = yield* currentImportLimits(options)
      const selected = Option.getOrUndefined(options.operation)
      if (options.resume && selected === undefined)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Batch resume requires the original --operation."),
        )
      const loaded = yield* loadCurrentImportBatch(
        options.manifest,
        Option.getOrUndefined(options.rebindFrom),
      )
      const invocation = yield* withCurrentInvocationBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
          if (options.dryRun) {
            const definition = yield* compileCurrentImportBatch(library, loaded)
            return {
              dry_run: true,
              request_sha256: loaded.request_sha256,
              mapping: definition.mapping,
              rewrites: definition.rewrites,
              skills: definition.items.map((item) => ({
                skill_id: item.skill_id,
                relations: item.relations ?? null,
                members_discovery: item.members_discovery,
                input_sha256: item.body_input_sha256,
              })),
            }
          }
          const operation =
            selected ??
            (yield* (yield* Crypto.Crypto)
              .randomUUIDv4()
              .pipe(
                Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify the import batch.")),
              ))
          return yield* withCurrentImportPlan(
            library,
            {
              operation_id: operation,
              request_sha256: loaded.request_sha256,
              mode: options.resume ? "resume" : "apply",
            },
            compileCurrentImportBatch(library, loaded),
            (session) => applyCurrentImportBatch(library, operation, session),
          )
        }),
        limits,
      )
      yield* emit({ ...invocation.result, budget: invocation.budget })
    }),
).pipe(
  withConstraints([exclusiveFlags(["resume", "dryRun"])]),
  Command.withDescription(
    "Import an explicit version 1 JSON batch: { root, skills: [{ root, skill_id, native? }] }. Roots are disjoint directories relative to the manifest's root; no neighbours are scanned. Exact admitted file mappings compile cross-root Markdown links into contextual skill:// references in a frozen derived copy. Original files stay unchanged. All bodies become ready before relation patches, so Members may be cyclic. Requires is explicit and must form an acyclic final graph. Omitted Members is inferred only for first creation; [] and existing omissions retain their meaning. A portable origin first qualifies active short body refs with its original Library, including external and fixed refs; plain local input without an origin uses the destination. This binding runs even without --rebind-from and never queries the external Library for Members. --rebind-from explicitly authorizes rewriting current full references and relations for batch-owned identities only; unmatched external and fixed-snapshot body refs retain their original identity. Foreign relations are rejected before any write. --dry-run reports mapping and every rewrite. Resume uses the same manifest, files, options and --operation ID --resume; changed inputs fail before writing and unknown CREATE is never replayed.",
  ),
)
