import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { canonicalMain } from "../src/portable.ts"
import { parseTarget } from "../src/ref.ts"
import { openSkill } from "../src/snapshot.ts"
import { applySharedSkillChanges } from "../src/shared-skill-apply-authoring.ts"
import { executeSharedSkillApply } from "../src/shared-skill-apply.ts"
import { acceptCurrentSharedBodyWrite } from "../src/shared-body-current-acceptance.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  encode,
  digest,
} from "./shared-snapshot-fixture.ts"

export { library, skillPage, digest }
export const selected = { database: library.skills.database_id }
export const candidateBody =
  "# Accepted instructions\n\nPreserve the complete original operation.\n"
type Fixture = ReturnType<typeof sharedSnapshotFixture>
type Environment =
  | Notion
  | Store
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path

export function failure<A>(
  result:
    | { readonly _tag: "Success"; readonly success: A }
    | { readonly _tag: "Failure"; readonly failure: unknown },
): SkillsError {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a typed failure")
  return result.failure
}

export function withRequestHook<A, E>(
  action: Effect.Effect<A, E, Environment>,
  hook: (
    path: string,
    body: unknown,
    method: string,
    next: () => Effect.Effect<unknown, SkillsError>,
  ) => Effect.Effect<unknown, SkillsError>,
) {
  return Effect.gen(function* () {
    const original = yield* Notion
    return yield* action.pipe(
      Effect.provideService(Notion, {
        ...original,
        request: (path, body, options) =>
          hook(path, body, options?.method ?? "GET", () => original.request(path, body, options)),
      }),
    )
  })
}

export function withNativeWrites<A, E>(
  f: Fixture,
  action: Effect.Effect<A, E, Environment>,
  candidate?: string,
) {
  return Effect.gen(function* () {
    const original = yield* Notion
    return yield* action.pipe(
      Effect.provideService(Notion, {
        ...original,
        request: (path, body, options) => {
          if (options?.method !== "PATCH") return original.request(path, body, options)
          return Effect.suspend(() => {
            f.calls.push({ path, body, method: "PATCH" })
            if (path === `v1/pages/${skillPage}/markdown`) {
              const updates = property(property(body).update_content).content_updates
              if (
                !Array.isArray(updates) ||
                updates.length !== 1 ||
                property(updates[0]).old_str !== f.bodies.get(skillPage) ||
                candidate === undefined
              )
                return Effect.fail(fail("TEST_PATCH", "Expected the exact original body request"))
              f.bodies.set(skillPage, candidate)
              return Effect.succeed({
                id: skillPage,
                markdown: candidate,
                truncated: false,
                unknown_block_ids: [],
              })
            }
            if (path !== `v1/pages/${skillPage}`)
              return Effect.fail(fail("TEST_PATCH", "Unexpected page"))
            const properties = property(f.main.properties)
            for (const [id, value] of Object.entries(property(property(body).properties))) {
              const key = Object.keys(properties).find((key) => property(properties[key]).id === id)
              if (key === undefined) return Effect.fail(fail("TEST_PATCH", "Unexpected property"))
              properties[key] = { ...property(properties[key]), ...property(value) }
            }
            return Effect.succeed(structuredClone(f.main))
          })
        },
      }),
    )
  })
}

export function payloads(f: Fixture) {
  return [...f.records.values()].map(
    (row) =>
      property(JSON.parse(text(property(property(row.properties).payload).rich_text))).payload,
  )
}

export function pendingKeys(f: Fixture) {
  return [...f.json.keys()]
    .filter((key) => key.startsWith("operations/shared-observation-pending/"))
    .sort()
}

export function authoringRead(f: Fixture) {
  return f.run(
    withSharedAuthoringTarget(
      skillPage,
      openSkill(skillPage, { ...selected, refresh: true, sharedReadOnly: true }),
    ),
  )
}

/** A new local Store sees only the shared remote service, never the writer cache. */
export function coldClient(f: Fixture) {
  const cold = sharedSnapshotFixture({ fileCount: f.files.length + 1 })
  Object.assign(cold.main, structuredClone(f.main))
  cold.files.splice(0, cold.files.length, ...structuredClone(f.files))
  cold.records.clear()
  for (const [key, value] of f.records) cold.records.set(key, structuredClone(value))
  cold.bodies.clear()
  for (const [key, value] of f.bodies) cold.bodies.set(key, value)
  return cold
}

export async function pendingSingleBody(
  unknown: "event" | "parent-outcome" | "known-mismatch" = "event",
  fileCount = 1,
  mainMetadata: "retained" | "canonical" | "noncanonical" = "retained",
) {
  const f = sharedSnapshotFixture({ fileCount })
  const intendedBody =
    unknown === "known-mismatch"
      ? "# Milestone\n\nRead [Skeleton](skill://4135636c-236e-8191-8226-d828c7b44b39/SKILL.md) before implementation.\n"
      : candidateBody
  const before = f.bodies.get(skillPage)!
  const content = {
    object_id: `body-${digest(before)}`,
    sha256: digest(before),
    bytes: encode(before).byteLength,
    ...(mainMetadata === "retained"
      ? {
          mode: "100644",
          frontmatter: "---\nname: Managed Name\ndescription: Managed description\n---\n",
        }
      : {}),
  }
  f.seedFact(
    { event_id: "initial-main", file_id: "file-main", parents: [], kind: "adopted", content },
    "file_event",
    "file-main",
    "initial-main",
  )
  f.seedFact(
    { version: 1, kind: "normalized_markdown", normalization_version: 1, markdown: before },
    "object",
    content.object_id,
    content.object_id,
    `retain-${content.sha256}`,
  )
  await f.target(parseTarget(skillPage), selected)
  const baseline = await f.run(
    openSkill(skillPage, { ...selected, refresh: true, sharedReadOnly: true }),
  )
  const preview = await f.run(
    applySharedSkillChanges(baseline, {
      files: [
        {
          path: "SKILL.md",
          bytes:
            mainMetadata === "canonical"
              ? canonicalMain("Managed Name", "Managed description", intendedBody, {
                  path: "SKILL.md",
                  bytes: new Uint8Array(),
                }).bytes
              : encode(
                  `---\nname: Managed Name\ndescription: Managed description\n---\n\n${intendedBody}`,
                ),
        },
      ],
      dryRun: true,
    }),
  )
  if (
    preview.status !== "planned" ||
    preview.kind !== "skill_apply" ||
    preview.plan.version !== 1 ||
    preview.plan.bodies.length !== 1
  )
    throw new Error("Expected an exact one-body v1 parent")
  const plan = preview.plan,
    child = plan.bodies[0]!
  if (unknown === "event") f.unknownEvent()
  const stopped = await f.run(
    withRequestHook(
      withNativeWrites(
        f,
        executeSharedSkillApply(library, { plan, mode: "create" }),
        unknown === "known-mismatch"
          ? child.candidate.markdown.replace(
              "[Skeleton](skill://4135636c-236e-8191-8226-d828c7b44b39/SKILL.md)",
              "Skeleton",
            )
          : child.candidate.markdown,
      ),
      (path, body, method, next) => {
        if (unknown === "parent-outcome" && path === "v1/pages" && method === "POST") {
          const payload = text(property(property(property(body).properties).payload).rich_text)
          if (
            payload &&
            property(property(JSON.parse(payload)).payload).kind === "skill_apply_outcome"
          )
            return Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "The original final parent request has no acknowledgement.",
              ),
            )
        }
        return next()
      },
    ).pipe(Effect.result),
  )
  if (
    failure(stopped).code !==
    (unknown === "known-mismatch" ? "SHARED_BODY_WRITE_REVIEW_REQUIRED" : "WRITE_OUTCOME_UNKNOWN")
  )
    throw new Error("Expected the selected original body-write failure")
  property(property(f.main.properties).enabled).checkbox = false
  const accept = (dryRun = false) =>
    acceptCurrentSharedBodyWrite({
      library,
      skillPageId: skillPage,
      originalOperationId: child.operation_id,
      acceptedObservedSha256: digest(f.bodies.get(skillPage)!),
      scope: plan.snapshot_scope,
      dryRun,
      mode: "create",
    })
  return { f, plan, child, accept }
}
