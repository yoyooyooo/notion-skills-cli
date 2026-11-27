import { Effect } from "effect"
import { fail } from "./model.ts"
import { Notion } from "./notion.ts"
import { relationIds } from "./shared-current-relations.ts"
import {
  materializationChecked,
  materializationRecord,
  queryMaterializationPages,
} from "./shared-source-materialization-registration.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

/** Only current metadata proves that an accepted native root Requires this target.
 * Members, names and error strings do not confer management authority. */
export function readMaterializationClosure(library: SharedLibrary, skillId: string) {
  return Effect.gen(function* () {
    const roots = yield* queryMaterializationPages(library, "skills", {
      property: library.skills.property_ids["Skill ID"],
      rich_text: { equals: skillId },
    })
    if (roots.length !== 1)
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_IDENTITY_AMBIGUOUS",
          "The authorized root must have one physical owner.",
        ),
      )
    const root = yield* materializationChecked(() => materializationRecord(library, roots[0]))
    if (root.locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail("SOURCE_MEMBER_IDENTITY_CHANGED", "The authorized root must be a registered Skill."),
      )
    const entries: { raw: unknown; record: typeof root; pages: readonly string[] }[] = []
    const seen = new Map<string, string>(),
      active = new Set<string>()
    const stack: { raw: unknown; exit?: boolean }[] = [{ raw: roots[0] }]
    while (stack.length) {
      const selected = stack.pop()!,
        record = yield* materializationChecked(() => materializationRecord(library, selected.raw))
      if (record.locator.type !== "shared_skill")
        return yield* Effect.fail(
          fail("SOURCE_MEMBER_IDENTITY_CHANGED", "Requires has a foreign content locator."),
        )
      const { page_id, skill_id } = record.locator
      if (selected.exit) {
        active.delete(page_id)
        continue
      }
      if (active.has(page_id))
        return yield* Effect.fail(
          fail("CURRENT_REQUIRES_CYCLE", "The authorized Requires closure contains a cycle."),
        )
      if (seen.has(skill_id)) {
        if (seen.get(skill_id) !== page_id)
          return yield* Effect.fail(
            fail(
              "SOURCE_MEMBER_IDENTITY_AMBIGUOUS",
              "Requires contains duplicate stable identities.",
            ),
          )
        continue
      }
      if (seen.size >= 100)
        return yield* Effect.fail(
          fail(
            "CURRENT_RELATION_GRAPH_LIMIT",
            "The authorized Requires closure exceeds its bound.",
          ),
        )
      seen.set(skill_id, page_id)
      active.add(page_id)
      const pages = [...(yield* relationIds(library, selected.raw, "Requires"))].sort()
      entries.push({ raw: selected.raw, record, pages })
      stack.push({ raw: selected.raw, exit: true })
      for (const page of [...pages].reverse())
        stack.push({ raw: yield* (yield* Notion).request(`v1/pages/${page}`) })
    }
    const digest = yield* sha256(
      canonicalSharedJson({
        root: { skill_id: root.locator.skill_id, page_id: root.locator.page_id },
        entries: entries
          .map(({ record, pages }) => ({
            skill_id: record.locator.type === "shared_skill" ? record.locator.skill_id : "",
            page_id: record.locator.type === "shared_skill" ? record.locator.page_id : "",
            enabled: record.enabled,
            requires: pages,
          }))
          .sort((a, b) => a.skill_id.localeCompare(b.skill_id)),
      }),
    )
    return {
      root,
      entries,
      authorization_root: {
        skill_id: root.locator.skill_id,
        page_id: root.locator.page_id,
        requires_digest: digest,
      },
    }
  })
}
