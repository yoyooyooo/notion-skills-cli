import { Crypto, Effect } from "effect"
import { entrypointFor, fail, property } from "./model.ts"
import type { PortableRelations } from "./portable.ts"
import { queryCurrentSkillIndex, readCurrentSkillMetadata } from "./shared-current-index.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import { currentOperationFailure, readCurrentOperationIntent } from "./shared-current-operation.ts"
import { prepareCurrentRelations } from "./shared-current-relations.ts"
import { loadCurrentSharedResourceContent } from "./shared-current-resource.ts"
import {
  assertNoCurrentSourceContribution,
  checkedSkillManagement as checked,
  currentSkillText,
  queryCurrentSkillIdentity,
  resolveCurrentSkillPage,
} from "./shared-current-skill-target.ts"
import {
  inspectCurrentSkillPatch,
  inspectCurrentSkillWrite,
  prepareCurrentSkillPatch,
  writeCurrentSkill,
  writeCurrentSkillPatch,
  type CurrentSkillPatchInput,
} from "./shared-current-write.ts"
import {
  currentWriteIdentity,
  prepareCurrentSkillWrite,
  type PreparedCurrentSkillWrite,
} from "./shared-current-write-input.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { compareNativeMarkdown } from "./shared-native-markdown.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { formatSkillIdentity } from "./skill-ref.ts"

type ManagementOptions = { readonly operation_id?: string; readonly dry_run?: boolean }
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
const newOperation = () =>
  Effect.gen(function* () {
    return yield* (yield* Crypto.Crypto)
      .randomUUIDv4()
      .pipe(
        Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify current Skill management.")),
      )
  })

/** Agent-facing relation targets are exact pages or stable IDs, never guessed names. */
export function resolveCurrentSkillRelations(
  library: SharedLibrary,
  input: {
    readonly members?: readonly string[]
    readonly requires?: readonly string[]
  },
) {
  return Effect.gen(function* () {
    if (input.members === undefined && input.requires === undefined) return undefined
    const selected: {
      version: 1
      ownership: "notion"
      library_id: string
      members?: string[]
      requires?: string[]
    } = {
      version: 1,
      ownership: "notion",
      library_id: library.library_id,
    }
    for (const key of ["members", "requires"] as const) {
      const values = input[key]
      if (values === undefined) continue
      if (values.length === 1 && values[0] === "") {
        selected[key] = []
        continue
      }
      if (values.some((value) => value === "") || new Set(values).size !== values.length)
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Use distinct exact relation targets, or one empty value to clear the set.",
          ),
        )
      const refs: string[] = []
      for (const value of values) {
        const target = yield* resolveCurrentSkillPage(library, value)
        const id = yield* checked(() =>
          currentWriteIdentity(
            currentSkillText(library, "skills", target.raw, "Skill ID"),
            "Skill ID",
          ),
        )
        refs.push(formatSkillIdentity({ libraryId: library.library_id, skillId: id }))
      }
      if (new Set(refs).size !== refs.length)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Several relation targets identify the same current Skill."),
        )
      selected[key] = refs
    }
    return selected satisfies PortableRelations
  })
}
function matchesCreatedSkill(
  library: SharedLibrary,
  plan: PreparedCurrentSkillWrite,
  raw: unknown,
) {
  return Effect.gen(function* () {
    const page = property(raw).id
    if (typeof page !== "string")
      return yield* Effect.fail(
        fail("CURRENT_SKILL_EXISTS", "The current Skill page is unavailable."),
      )
    const index = yield* queryCurrentSkillIndex(library, page, raw)
    if (
      index.state.state !== "ready" ||
      index.kind !== plan.kind ||
      index.name !== plan.name ||
      index.description !== plan.description ||
      index.enabled !== (plan.enabled ?? true) ||
      index.default_context !== (plan.default_context ?? false) ||
      index.files.length + 1 !== plan.files.length
    )
      return undefined
    const native = { verified: 0, normalized_paths: [] as string[] }
    for (const file of plan.files) {
      const existing = [index.main, ...index.files].find((entry) => entry.path === file.path)
      if (
        existing === undefined ||
        (file.file_id !== undefined && existing.file_id !== file.file_id) ||
        !same(existing.content, file.content)
      )
        return undefined
      if (file.kind === "native") {
        const body = yield* observeSharedBody(existing.page_id)
        const comparison = yield* checked(() =>
          compareNativeMarkdown({ expected: file.markdown, observed: body.markdown }),
        )
        if (comparison === "different") return undefined
        native.verified += 1
        if (comparison === "normalized") native.normalized_paths.push(file.path)
      } else if (file.kind === "resource") {
        const resource = yield* loadCurrentSharedResourceContent(library, {
          owner: { kind: "skill", page_id: page },
          content: file.content,
        })
        if (
          resource.bytes.byteLength !== file.bytes.byteLength ||
          (yield* sha256(resource.bytes)) !== file.sha256
        )
          return undefined
      } else return undefined
    }
    const relations = yield* prepareCurrentRelations(library, {
      skill_id: plan.skill_id,
      kind: plan.kind,
      relations: plan.relations,
      owner: { page_id: page, raw },
    })
    if (relations.selections.some((selection) => !same(selection.before, selection.desired)))
      return undefined
    return { index, native }
  })
}
/** Create cannot replace an existing Skill. A complete equal repeat is observation only. */
export function createCurrentNotionSkill(
  library: SharedLibrary,
  options: ManagementOptions & {
    readonly plan: PreparedCurrentSkillWrite
    readonly metadata?: {
      readonly enabled?: boolean
      readonly default_context?: boolean
      readonly relations?: PortableRelations
    }
  },
) {
  return Effect.gen(function* () {
    const input = yield* checked(() => ({
      ...options.plan,
      ...options.metadata,
      files: options.plan.files.map((file) => {
        if (file.kind === "source")
          throw fail(
            "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
            "Native creation cannot declare Source authority.",
          )
        return {
          path: file.path,
          bytes: file.bytes,
          mode: file.mode,
          file_id: file.file_id,
          authority: { kind: file.kind },
        }
      }),
    }))
    const plan = yield* prepareCurrentSkillWrite(input)
    yield* checked(() => {
      if (options.operation_id !== undefined)
        currentWriteIdentity(options.operation_id, "Operation ID")
      if (plan.files.some((file) => file.kind === "source"))
        throw fail(
          "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
          "Native creation cannot declare Source authority.",
        )
    })
    yield* assertNoCurrentSourceContribution(library, plan.skill_id)
    const pending = yield* readCurrentOperationIntent(library, { kind: "skill", id: plan.skill_id })
    if (
      pending !== undefined &&
      ("skill_action" in pending.intent ||
        "source" in pending.intent ||
        "projection" in pending.intent ||
        "restore" in pending.intent ||
        "source_input" in pending.intent ||
        pending.intent.input_sha256 !== plan.input_sha256 ||
        options.dry_run ||
        (options.operation_id !== undefined &&
          options.operation_id !== pending.intent.operation_id))
    )
      return yield* Effect.fail(
        currentOperationFailure(
          fail(
            "CURRENT_OPERATION_PENDING",
            "The existing operation requires its original management input.",
          ),
          pending.intent,
          null,
          pending.owner_page_id,
        ),
      )
    const raw = yield* queryCurrentSkillIdentity(library, plan.skill_id)
    if (raw !== undefined && pending === undefined) {
      const matched = yield* matchesCreatedSkill(library, plan, raw)
      if (matched === undefined)
        return yield* Effect.fail(
          fail(
            "CURRENT_SKILL_EXISTS",
            "This Skill ID already exists with different current content. Use skill update for intentional changes.",
            {
              skill_id: plan.skill_id,
              page_id: property(raw).id,
            },
          ),
        )
      return {
        version: 1 as const,
        contract: "current" as const,
        action: "create" as const,
        skill_id: plan.skill_id,
        page_id: matched.index.page_id,
        state: "ready" as const,
        status: "unchanged" as const,
        input_sha256: plan.input_sha256,
        native: matched.native,
        remote_writes: 0 as const,
        ...(options.dry_run ? { dry_run: true } : {}),
      }
    }
    if (options.dry_run)
      return {
        ...(yield* inspectCurrentSkillWrite(library, plan)),
        action: "create" as const,
        dry_run: true,
      }
    return {
      ...(yield* writeCurrentSkill(library, {
        plan,
        create_only: true,
        operation_id:
          pending?.intent.operation_id ?? options.operation_id ?? (yield* newOperation()),
        mode: pending === undefined ? "apply" : "resume",
      })),
      action: "create" as const,
      status: "created" as const,
    }
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}

export function updateCurrentNotionSkill(
  library: SharedLibrary,
  options: ManagementOptions & {
    readonly target: string
    readonly metadata?: CurrentSkillPatchInput["metadata"]
    readonly files?: CurrentSkillPatchInput["files"]
    readonly main?: { readonly bytes: Uint8Array; readonly mode?: "100644" | "100755" }
    readonly remove?: readonly string[]
  },
) {
  return Effect.gen(function* () {
    yield* checked(() => {
      if (options.operation_id !== undefined)
        currentWriteIdentity(options.operation_id, "Operation ID")
      if (
        options.main === undefined &&
        !options.files?.length &&
        !options.remove?.length &&
        !Object.keys(options.metadata ?? {}).length
      )
        throw fail("INVALID_ARGUMENT", "Select content, files, relations or metadata to update.")
    })
    const target = yield* resolveCurrentSkillPage(library, options.target)
    const metadata = yield* readCurrentSkillMetadata(library, target.page_id, target.raw)
    yield* assertNoCurrentSourceContribution(library, metadata.skill_id)
    const pending = yield* readCurrentOperationIntent(library, {
      kind: "skill",
      id: metadata.skill_id,
    })
    if (
      pending !== undefined &&
      (!("skill_action" in pending.intent) ||
        pending.intent.skill_action.kind !== "update" ||
        pending.intent.skill_action.scope.page_id !== target.page_id ||
        options.dry_run ||
        (options.operation_id !== undefined &&
          options.operation_id !== pending.intent.operation_id))
    )
      return yield* Effect.fail(
        currentOperationFailure(
          fail(
            "CURRENT_OPERATION_PENDING",
            "Another current intent owns this Skill. Repeat its original management command.",
          ),
          pending.intent,
          null,
          target.page_id,
        ),
      )
    const scope =
      pending !== undefined &&
      "skill_action" in pending.intent &&
      pending.intent.skill_action.kind === "update"
        ? pending.intent.skill_action.scope
        : undefined
    const files = [
      ...(options.files ?? []),
      ...(options.main === undefined
        ? []
        : [
            {
              ...options.main,
              path: entrypointFor(metadata.kind),
              authority: { kind: "native" as const },
            },
          ]),
    ]
    const plan = yield* prepareCurrentSkillPatch(library, {
      target: target.page_id,
      metadata: options.metadata,
      files,
      remove: options.remove,
      scope,
    })
    if (pending !== undefined && plan.input_sha256 !== pending.intent.input_sha256)
      return yield* Effect.fail(
        currentOperationFailure(
          fail(
            "CURRENT_OPERATION_PENDING",
            "The unfinished update requires the same selected files and metadata.",
          ),
          pending.intent,
          null,
          target.page_id,
        ),
      )
    if (options.dry_run)
      return {
        ...(yield* inspectCurrentSkillPatch(library, plan)),
        action: "update" as const,
        dry_run: true,
      }
    return {
      ...(yield* writeCurrentSkillPatch(library, {
        plan,
        operation_id:
          pending?.intent.operation_id ?? options.operation_id ?? (yield* newOperation()),
        mode: pending === undefined ? "apply" : "resume",
      })),
      action: "update" as const,
    }
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}
