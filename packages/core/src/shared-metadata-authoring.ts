import { Effect } from "effect"
import { authScope, catalog } from "./catalog.ts"
import { fail, property, SkillsError, type Snapshot } from "./model.ts"
import { pageId, parseTarget } from "./ref.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  executeSharedMetadataWriteWithJournal,
  prepareSharedMetadataWrite,
  type SharedMetadataChange,
} from "./shared-metadata-write.ts"

export type SharedMetadataUpdateOptions = {
  readonly name?: string
  readonly description?: string
  readonly defaultContext?: boolean
  readonly members?: readonly string[]
  readonly dryRun?: boolean
}

/** Exact native page IDs and same-library stable entrypoint refs; never names or bodies. */
export function resolveSharedMetadataMembers(library: SharedLibrary, members: readonly string[]) {
  return Effect.gen(function* () {
    const selected = yield* Effect.try({
      try: () =>
        members.map((input) => {
          const target = parseTarget(input)
          if (target.snapshot || (target.path && target.path !== "SKILL.md"))
            throw fail(
              "INVALID_MEMBERS",
              "Members require current exact Skill page IDs or unpinned main refs.",
            )
          const page = pageId(target.selector)
          if (page !== null && page !== undefined) return { page }
          if (
            !target.selector.startsWith(`shared_skill:${encodeURIComponent(library.library_id)}:`)
          )
            throw fail(
              "INVALID_MEMBERS",
              "A stable Member ref must belong to this exact shared library.",
            )
          return { stable: target.selector }
        }),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_MEMBERS", "A Member target is invalid."),
    })
    const directory = selected.some((entry) => entry.stable !== undefined)
      ? yield* catalog({ database: library.skills.database_id, refresh: true })
      : undefined
    const resolved: string[] = []
    for (const entry of selected) {
      if (entry.page !== undefined) {
        resolved.push(entry.page)
        continue
      }
      const matches = directory?.records.filter((record) => record.id === entry.stable) ?? []
      const record = matches[0]
      if (
        matches.length !== 1 ||
        record?.locator.type !== "shared_skill" ||
        record.kind !== "skill" ||
        !record.enabled ||
        record.locator.library_id !== library.library_id
      )
        return yield* Effect.fail(
          fail(
            "INVALID_MEMBERS",
            "A stable Member has no unique enabled Skill in this shared library.",
          ),
        )
      resolved.push(record.locator.page_id)
    }
    if (new Set(resolved).size !== resolved.length)
      return yield* Effect.fail(
        fail("INVALID_MEMBERS", "Members repeat an exact shared Skill identity."),
      )
    return resolved.sort()
  })
}

/** Prepare and execute the standard update entry through the shared native property contract. */
export function updateSharedSkillMetadata(current: Snapshot, options: SharedMetadataUpdateOptions) {
  return Effect.gen(function* () {
    const locator = current.record.locator
    if (locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail("CONTENT_NOT_MUTABLE", "Select a shared Skill for native metadata authoring."),
      )
    if (current.scope !== (yield* authScope))
      return yield* Effect.fail(
        fail(
          "SNAPSHOT_CONFLICT",
          "The metadata baseline belongs to another authenticated account scope.",
        ),
      )
    const library = yield* loadSharedLibrary(locator.database_id)
    if (
      library.library_id !== locator.library_id ||
      library.skills.data_source_id !== locator.data_source_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_METADATA_WRITE_SCOPE",
          "The current descriptor differs from the pinned shared identity.",
        ),
      )
    const changes: SharedMetadataChange[] = []
    const before: SharedMetadataChange[] = []
    let members: readonly string[] | undefined
    if (options.name !== undefined) {
      changes.push({ field: "Name", value: options.name })
      before.push({ field: "Name", value: current.record.name })
    }
    if (options.description !== undefined) {
      changes.push({ field: "Description", value: options.description })
      before.push({ field: "Description", value: current.record.description })
    }
    if (options.defaultContext !== undefined) {
      changes.push({ field: "Default Context", value: options.defaultContext })
      before.push({ field: "Default Context", value: current.record.default_context })
    }
    if (options.members !== undefined) {
      if (current.record.kind !== "router" || current.router_members === undefined)
        return yield* Effect.fail(
          fail("INVALID_MEMBERS", "Native Members changes require a fresh complete shared Router."),
        )
      const previous: string[] = []
      for (const member of current.router_members) {
        const id = property(member.metadata).page_id
        if (typeof id !== "string" || pageId(id) !== id)
          return yield* Effect.fail(
            fail(
              "INVALID_MEMBERS",
              "The previous frozen Members index has an invalid native page identity.",
            ),
          )
        previous.push(id)
      }
      before.push({ field: "Members", value: previous.sort() })
      members = yield* resolveSharedMetadataMembers(library, options.members)
      changes.push({ field: "Members", value: members })
    }
    if (changes.length === 0)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Choose at least one explicit native metadata field."),
      )
    const plan = yield* prepareSharedMetadataWrite({
      library,
      skillPageId: locator.page_id,
      changes,
      expected: { record_id: current.record.id, values: before },
    })
    const result = yield* executeSharedMetadataWriteWithJournal({
      library,
      plan,
      mode: "create",
      dryRun: options.dryRun,
    })
    return {
      ...result,
      metadata_operation_id: plan.operation_id,
      changed_fields: plan.changes.map((change) => change.field),
      ...(members === undefined ? {} : { requested_members: members }),
    }
  })
}
