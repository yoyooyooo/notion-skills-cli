import { Clock, Effect, Schema } from "effect"
import { publishSnapshotObservation } from "./cache.ts"
import { fail, property, SnapshotSchema, text, type Snapshot } from "./model.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { sharedRecordFromPage, sharedSkillProperty } from "./shared-content.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { sharedSnapshotVersion } from "./shared-snapshot-identity.ts"
import type { PlannedSharedSource } from "./shared-selected-source.ts"
import { sha256, Store } from "./store.ts"
import { pageId } from "./ref.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { assertGitOnlyAdmissionOwner, isGitOnlyProjection } from "./shared-git-only-marker.ts"

export { gitOnlyProjection } from "./shared-git-only-marker.ts"

/** The current page remains an identity/permission control, never the source
 * for an imported Markdown body. Changes to its empty native body fail closed.
 * Git-only Skills contain no native supporting Files or file-owner events. */
export function openGitOnlySharedConsumer(input: {
  readonly library: SharedLibrary
  readonly target: string
  readonly rawPage: unknown
  readonly scope: string
  readonly startedAt: number
  readonly fixedSource: PlannedSharedSource
  readonly expectedSkillId?: string
}) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const store = yield* Store
    const record = yield* Effect.try({
      try: () =>
        sharedRecordFromPage(
          input.rawPage,
          {
            alias: input.library.library_id,
            title: "",
            role: "content" as const,
            database_id: input.library.skills.database_id,
            data_source_ids: [input.library.skills.data_source_id],
            shared_library: input.library,
          },
          input.library.skills.data_source_id,
        ),
      catch: (e) => e as ReturnType<typeof fail>,
    })
    if (
      record.locator.type !== "shared_skill" ||
      record.locator.page_id !== input.target ||
      record.kind !== "skill" ||
      !record.enabled ||
      (input.expectedSkillId !== undefined && input.expectedSkillId !== record.locator.skill_id)
    )
      return yield* Effect.fail(
        fail(
          "GIT_ONLY_SCOPE",
          "Git-only current content requires one enabled exact Skill identity.",
        ),
      )
    const index = yield* querySharedSkillIndex(input.library, input.target, input.rawPage)
    const props = ["Projection", "References", "Source Member"] as const
    const values = yield* Effect.try({
      try: () =>
        props.map((name) => {
          const field = sharedSkillProperty(input.rawPage, input.library, name)
          if (
            field.type !== "rich_text" ||
            !Array.isArray(field.rich_text) ||
            field.has_more === true
          )
            throw fail("GIT_ONLY_SCOPE", "Git-only page metadata is incomplete.")
          return text(field.rich_text)
        }),
      catch: (e) => e as ReturnType<typeof fail>,
    })
    if (
      index.source_reference !== input.fixedSource.source_id ||
      index.files.length !== 0 ||
      !isGitOnlyProjection(values[0] ?? "") ||
      values[1] !== "" ||
      input.fixedSource.git_member_root === undefined ||
      values[2] !== (input.fixedSource.git_member_root || ".") ||
      input.fixedSource.manifest.length === 0 ||
      input.fixedSource.manifest.some(
        (file) => file.identity.kind !== "git" || file.identity.sha256 === undefined,
      )
    )
      return yield* Effect.fail(
        fail(
          "GIT_ONLY_SCOPE",
          "Git-only current selection requires a complete pinned Git manifest and no native File owners.",
        ),
      )
    const origin = yield* Effect.try({
      try: () => {
        const field = sharedSkillProperty(input.rawPage, input.library, "Origin")
        if (
          field.type !== "relation" ||
          field.has_more !== false ||
          !Array.isArray(field.relation) ||
          field.relation.length !== 1 ||
          pageId(property(field.relation[0]).id as string) === undefined
        )
          throw fail("GIT_ONLY_SCOPE", "Git-only current content requires one exact Source owner.")
        for (const name of ["Members", "Requires"] as const) {
          if (input.library.skills.property_ids[name] === undefined) continue
          const relation = sharedSkillProperty(input.rawPage, input.library, name)
          if (
            relation.type !== "relation" ||
            relation.has_more !== false ||
            !Array.isArray(relation.relation) ||
            relation.relation.length !== 0
          )
            throw fail(
              "GIT_ONLY_RELATION_REVIEW",
              "Authored dependency relations require an explicit reviewed Git-only integration.",
            )
        }
        return field.relation[0]
      },
      catch: (e) => e as ReturnType<typeof fail>,
    })
    yield* assertGitOnlyAdmissionOwner({
      projection: values[0]!,
      library_id: input.library.library_id,
      skill_id: record.locator.skill_id,
      origin_page_id: String(property(origin).id ?? ""),
      member: values[2]!,
    })
    // A source-only page is born with no native Markdown. A human edit is an
    // explicit takeover request, not a license to mask it with remote bytes.
    const body = property(
      yield* api.request(`v1/pages/${input.target}/markdown?markdown_version=v2`),
    )
    if (
      body.id !== input.target ||
      body.truncated !== false ||
      !Array.isArray(body.unknown_block_ids) ||
      body.unknown_block_ids.length !== 0 ||
      (body.warnings !== undefined &&
        (!Array.isArray(body.warnings) || body.warnings.length !== 0)) ||
      body.markdown !== ""
    )
      return yield* Effect.fail(
        fail(
          "GIT_ONLY_CUSTOM_TAKEOVER",
          "The Notion page body is changed or incomplete; preserve it for explicit authoring review.",
        ),
      )
    const manifest = input.fixedSource.manifest
    const main = manifest.find((file) => file.path === record.entrypoint)
    if (main === undefined)
      return yield* Effect.fail(
        fail("GIT_ONLY_SOURCE_INCOMPLETE", "The fixed source has no main SKILL.md."),
      )
    const acquired = yield* input.fixedSource.materialize([record.entrypoint])
    const original = acquired.files.find((file) => file.path === record.entrypoint)
    if (
      acquired.files.length !== 1 ||
      !original ||
      (yield* sha256(original.bytes)) !== main.identity.sha256
    )
      return yield* Effect.fail(
        fail(
          "GIT_ONLY_SOURCE_INCOMPLETE",
          "The pinned Git main bytes are missing or inconsistent.",
        ),
      )
    yield* store.writeBytes(`objects/${main.identity.sha256}`, original.bytes)
    const files: Snapshot["files"] = manifest.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.identity.sha256!,
      ...(file.mode === undefined ? {} : { mode: file.mode }),
    }))
    const acquisition: NonNullable<Snapshot["shared_acquisition"]> = {
      version: 2,
      library: input.library,
      source: {
        source_id: input.fixedSource.source_id,
        revision: input.fixedSource.revision,
      },
      files: manifest.map((file) => ({
        kind: "source" as const,
        path: file.path,
        source_path: file.path,
      })),
    }
    const version = yield* sharedSnapshotVersion({
      record,
      files,
      shared_acquisition: acquisition,
      source: acquisition.source,
      ownership: [],
    })
    const snapshotId = `s_${yield* sha256(JSON.stringify([input.scope, record.id, version]))}`
    const now = yield* Clock.currentTimeMillis
    const snapshot = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(SnapshotSchema)({
          snapshot_id: snapshotId,
          scope: input.scope,
          record,
          entrypoint: record.entrypoint,
          version_id: version,
          created_at: now,
          files,
          shared_acquisition: acquisition,
        }),
      catch: () => fail("GIT_ONLY_SOURCE_INCOMPLETE", "The pinned Git snapshot is not canonical."),
    })
    const existing = yield* store.readJson(`snapshots/${snapshotId}.json`, SnapshotSchema)
    if (
      existing &&
      canonicalSharedJson({ ...existing, created_at: snapshot.created_at }) !==
        canonicalSharedJson(snapshot)
    )
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The exact Git-only snapshot conflicts with its saved identity."),
      )
    if (!existing) yield* store.writeJson(`snapshots/${snapshotId}.json`, snapshot)
    const generation = yield* store.reserveCacheGeneration(input.scope, record.id)
    const published = yield* publishSnapshotObservation(
      existing ?? snapshot,
      input.startedAt,
      generation,
      {
        metadataOnly: true,
        sharedBodyValidUntil: now + 24 * 60 * 60 * 1000,
        sharedMaterializedPaths: [record.entrypoint],
      },
    )
    return published
  })
}
