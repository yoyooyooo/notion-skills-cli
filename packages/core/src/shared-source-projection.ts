import { Effect } from "effect"
import { fail, property } from "./model.ts"
import { importDocument } from "./import.ts"
import { parseYaml } from "./yaml.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { prepareSharedCreate } from "./shared-create.ts"
import { createChecked } from "./shared-create-model.ts"
import { prepareSharedCreateLocal, validateSharedCreateLocal } from "./shared-create-local.ts"
import { prepareSharedCreateRetained } from "./shared-create-retained.ts"
import { readSourceDefinition, listSourceMembers } from "./shared-source-definitions.ts"
import { prepareSourceMember } from "./shared-source-member.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  portableRelationSelection,
  type PortableRelations,
  type PortableSkill,
} from "./portable.ts"
import type { SourceDefinition } from "./shared-sources-model.ts"
import type { SourceSnapshot } from "./upstream-source.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

export interface SharedSourceProjectionInput {
  readonly library: SharedLibrary
  readonly definition: SourceDefinition
  readonly acquired: SourceSnapshot
  readonly member: string
  readonly skillId?: string
  readonly enabled?: boolean
  readonly markdownImport?: true
  readonly local?: {
    readonly baseline: SourceSnapshot
    readonly files: PortableSkill["files"]
    readonly relations?: PortableRelations
  }
}
/** New pages only. The returned original creation plan uses the existing dispatcher and journal. */
export function prepareSharedSourceProjection(input: SharedSourceProjectionInput) {
  return Effect.gen(function* () {
    const current = yield* readSourceDefinition(input.library, input.definition.page_id)
    if (
      !current.enabled ||
      current.source_id !== input.definition.source_id ||
      current.fingerprint !== input.definition.fingerprint
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SOURCE_CHANGED",
          "The acquired source no longer matches the enabled live definition.",
        ),
      )
    const membership = yield* listSourceMembers(input.library, current.page_id)
    if (membership.items.some((bound) => bound.member === input.member))
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_ALREADY_BOUND",
          "The exact Source member already has an enabled or disabled Skill; admission cannot create a second binding.",
        ),
      )
    const prepared = yield* prepareSourceMember(current, input.acquired, input.member)
    const files = prepared.files.filter(
      (file) => file.path === prepared.member.portable.main || /\.(md|markdown)$/iu.test(file.path),
    )
    const common = {
      ...(input.skillId === undefined ? {} : { skill_id: input.skillId }),
      ...(input.acquired.provenance.committed_at === undefined
        ? {}
        : { provider_committed_at: input.acquired.provenance.committed_at }),
      definition: {
        page_id: current.page_id,
        source_id: current.source_id,
        fingerprint: current.fingerprint,
        member: input.member,
      },
    }
    const relations =
      input.local?.relations === undefined
        ? {}
        : yield* createChecked(() =>
            portableRelationSelection(input.local!.relations!, input.library.library_id),
          )
    if (prepared.kind === "retained") {
      const effectiveFiles = prepared.files.map((file) => ({
        ...file,
        mode: file.mode ?? ("100644" as const),
      }))
      if (input.local !== undefined) {
        const identities = (files: PortableSkill["files"]) =>
          Effect.forEach(
            [...files].sort((a, b) => a.path.localeCompare(b.path)),
            (file) =>
              Effect.gen(function* () {
                return {
                  path: file.path,
                  sha256: yield* sha256(file.bytes),
                  bytes: file.bytes.length,
                  ...(file.mode === undefined ? {} : { mode: file.mode }),
                }
              }),
          )
        if (
          canonicalSharedJson(yield* identities(input.local.files)) !==
          canonicalSharedJson(yield* identities(effectiveFiles))
        )
          return yield* Effect.fail(
            fail(
              "SOURCE_LOCAL_BASELINE_UNSUPPORTED",
              "Modified local input requires a proven complete fixed Git C1; unmodified retained input may retain explicit same-library relations.",
            ),
          )
      }
      return yield* prepareSharedCreate(input.library, {
        portable: {
          ...prepared.member.portable,
          files: effectiveFiles.filter(
            (file) =>
              file.path === prepared.member.portable.main || /\.(md|markdown)$/iu.test(file.path),
          ),
        },
        enabled: input.enabled ?? false,
        ...relations,
        sourceProjection: {
          ...common,
          version: 2,
          provider_revision: prepared.revision,
          retained: yield* prepareSharedCreateRetained(
            prepared.files,
            prepared.member.portable.main,
          ),
        },
      })
    }
    const customized =
      input.local === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            const baseline = yield* prepareSourceMember(
              current,
              input.local!.baseline,
              input.member,
              "fixed-git",
            )
            if (baseline.kind !== "fixed_git")
              return yield* Effect.fail(
                fail(
                  "SOURCE_LOCAL_BASELINE_INVALID",
                  "Local customization requires an exact complete immutable C1 member.",
                ),
              )
            const frozen = yield* prepareSharedCreateLocal({
              baseline: baseline.binding,
              baselineFiles: baseline.files,
              files: input.local!.files,
              selected: prepared.binding,
            })
            const verified = yield* validateSharedCreateLocal(frozen, prepared.binding)
            const documents = new Map<string, PortableSkill["files"][number]>(
              files.map((file) => [file.path, file]),
            )
            for (const [path, kind] of verified.changes) {
              const file = (kind === "custom" ? input.local!.files : baseline.files).find(
                (file) => file.path === path,
              )
              if (file === undefined)
                return yield* Effect.fail(
                  fail(
                    "SOURCE_LOCAL_IMPORT_INVALID",
                    "A changed or deleted original file has no exact frozen bytes.",
                    { path },
                  ),
                )
              documents.set(path, file)
            }
            const metadata =
              verified.changes.get(prepared.member.portable.main) !== "custom"
                ? {}
                : yield* createChecked(() => {
                    const main = input.local!.files.find(
                      (file) => file.path === prepared.member.portable.main,
                    )!
                    const source = new TextDecoder("utf-8", { fatal: true }).decode(main.bytes)
                    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)
                    const fields = header === null ? {} : property(parseYaml(header[1]!))
                    const parsed = importDocument(main, {
                      ...(fields.name === undefined ? { name: baseline.member.portable.name } : {}),
                      ...(fields.description === undefined
                        ? { description: baseline.member.portable.description }
                        : {}),
                    })
                    return { name: parsed.name, description: parsed.description }
                  })
            return {
              local: frozen,
              files: [...documents.values()].sort((a, b) => a.path.localeCompare(b.path)),
              metadata,
            }
          })
    return yield* prepareSharedCreate(input.library, {
      portable: {
        ...prepared.member.portable,
        ...customized?.metadata,
        files: customized?.files ?? files,
      },
      enabled: input.enabled ?? false,
      ...(customized === undefined ? {} : { completeResources: true }),
      ...(input.markdownImport === true && customized === undefined
        ? { markdownImport: true as const }
        : {}),
      ...relations,
      sourceProjection: {
        version: 1,
        ...common,
        binding: prepared.binding,
        ...(customized === undefined ? {} : { local: customized.local }),
      },
    })
  }).pipe(withReadOnlyNotion)
}
