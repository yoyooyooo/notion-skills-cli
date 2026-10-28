import { expect, test, vi } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { ConfigProvider, Crypto, Effect, FileSystem, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SqlClient } from "effect/sql"
import { sha256, Store, StoreLive } from "../src/store.ts"
import { Notion } from "../src/notion.ts"
import { portableIdentity } from "../src/export.ts"
import { fail, property, SkillsError } from "../src/model.ts"
import { sqliteState } from "../src/sqlite-state.ts"
import {
  UpstreamPublisher,
  type PublishRequest,
  type VerifiedPublication,
} from "../src/upstream-model.ts"
import type { UpstreamBinding, PublishedMembers } from "../src/upstream-model.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { getSubscription } from "../src/upstream-subscription.ts"
import {
  rebuildUpstream,
  restoreDeletedUpstream,
  restoreDeletedUpstreamMembers,
} from "../src/upstream-rebuild.ts"

const sub = "11111111-1111-4111-8111-111111111111"
const db = "22222222-2222-4222-8222-222222222222"
const ds = "33333333-3333-4333-8333-333333333333"
const target = "44444444-4444-4444-8444-444444444444"
const targetDs = "55555555-5555-4555-8555-555555555555"
const alphaPage = "66666666-6666-4666-8666-666666666661"
const betaPage = "66666666-6666-4666-8666-666666666662"
const operation = "p_selected-rebuild"
const markerHashes = {
  revision: "1".repeat(64),
  manifest_hash: "2".repeat(64),
  ownership_hash: "3".repeat(64),
}
const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use for selected upstream rebuild\n---\n\n${body}\n`
const rich = (value: string, type = "rich_text") => ({
  type,
  [type]: [{ type: "text", text: { content: value }, plain_text: value }],
})

test.each(["rebuild", "restore-deleted", "daily-restore"] as const)(
  "real Git and SQLite %s only the selected member from current main",
  async (mode) => {
    const rebuild = mode === "rebuild" ? rebuildUpstream : restoreDeletedUpstream
    const root = await mkdtemp(join(tmpdir(), "ntn-upstream-rebuild-"))
    const repo = join(root, "repo")
    await mkdir(join(repo, "skills/alpha/references"), { recursive: true })
    await mkdir(join(repo, "skills/beta"), { recursive: true })
    await writeFile(join(repo, "skills/alpha/references/guide.md"), "Accepted guide\n")
    await writeFile(join(repo, "skills/beta/SKILL.md"), skill("beta", "beta stays"))
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.test",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.test",
        },
      }).trim()
    git("init", "-b", "main")
    const commit = async (body: string) => {
      await writeFile(join(repo, "skills/alpha/SKILL.md"), skill("alpha", body))
      git("add", ".")
      git("commit", "--no-gpg-sign", "-m", body)
      return git("rev-parse", "HEAD")
    }
    const accepted = await commit("accepted")
    const current = await commit("current main")
    vi.stubEnv("NTN_SKILLS_HOME", join(root, "state"))
    vi.stubEnv("NTN_SKILLS_CONFIG_HOME", join(root, "config"))
    vi.stubEnv("NTN_SKILLS_CACHE_HOME", join(root, "cache"))

    let clock = 0
    const pages = new Map<string, Record<string, unknown>>()
    let mapPatches = 0
    let mapLosses = 0
    let loseMap = false
    let oldPageError: string | undefined
    let oldPageWrites = 0
    let tagWrites = 0
    let loseTags = false
    const published = {
      version: 1,
      revision: accepted,
      plan_hash: "a".repeat(64),
      publisher_subscription_id: sub,
      members: [
        {
          member_key: "skills/alpha",
          page_id: alphaPage,
          content_hash: "b".repeat(64),
          revision: accepted,
        },
        {
          member_key: "skills/beta",
          page_id: betaPage,
          content_hash: "c".repeat(64),
          revision: accepted,
        },
      ],
    }
    const props: Record<string, unknown> = {
      Name: { ...rich("controlled", "title"), id: "title" },
      Description: rich("controlled source"),
      Source: rich(
        JSON.stringify({
          provider: { type: "git", url: repo, ref: "main" },
          shared_target_set: "selected-rebuild",
          publisher_subscription_id: sub,
          accepted_ref: accepted,
        }),
      ),
      Ref: rich("main"),
      Roots: rich('["skills"]'),
      Include: rich("[]"),
      Exclude: rich("[]"),
      Mapping: rich("{}"),
      "Published Members": rich(JSON.stringify(published)),
      "Target Database ID": rich(target),
      "Source URL": { type: "url", url: null },
      "Sync Status": { type: "select", select: null },
      "Last Sync Attempt": { type: "date", date: null },
      "Last Synced": { type: "date", date: null },
      "Sync Summary": rich(""),
      Enabled: { type: "checkbox", checkbox: true },
      "Default Context": { type: "checkbox", checkbox: true },
      Status: { type: "select", select: { name: "verified" } },
    }
    const ownedPage = (id: string, member: string, inTrash = false) => ({
      id,
      parent: { type: "data_source_id", database_id: target, data_source_id: targetDs },
      in_trash: inTrash,
      properties: {
        Upstream: { type: "relation", relation: [{ id: sub }] },
        "Sync Mode": { type: "select", select: { name: "tracked" } },
        "Upstream Key": rich(member),
        "Default Context": { type: "checkbox", checkbox: true },
        Tags: {
          type: "multi_select",
          multi_select: [{ name: "coding" }, { name: "architecture" }],
        },
      },
    })
    pages.set(alphaPage, ownedPage(alphaPage, "skills/alpha"))
    const row = () => ({
      id: sub,
      parent: { data_source_id: ds },
      last_edited_time: String(clock),
      properties: props,
    })
    const notion = Notion.of({
      version: Effect.succeed("fixture"),
      credentialIdentity: Effect.succeed("fixture"),
      request: (path, body, options) =>
        Effect.try({
          try: () => {
            if (path === "v1/users/me") return { id: "fixture-user", object: "user" }
            if (path === `v1/databases/${db}` || path === `v1/databases/${target}`)
              return {
                id: path.endsWith(db) ? db : target,
                database_type: null,
                title: [],
                data_sources: [{ id: path.endsWith(db) ? ds : targetDs, name: "fixture" }],
              }
            if (path === `v1/data_sources/${ds}` || path === `v1/data_sources/${targetDs}`)
              return {
                id: path.endsWith(ds) ? ds : targetDs,
                parent: { database_id: path.endsWith(ds) ? db : target },
                title: [],
                properties: Object.fromEntries(
                  Object.keys(props).map((name) => [
                    name,
                    { id: name === "Name" ? "title" : name, type: property(props[name]).type },
                  ]),
                ),
              }
            if (path === `v1/pages/${sub}`) {
              if (options?.method === "PATCH") {
                if (loseMap) {
                  mapLosses++
                  throw fail("WRITE_OUTCOME_UNKNOWN", "Controlled map PATCH lost")
                }
                mapPatches++
                for (const [name, raw] of Object.entries(property(property(body).properties))) {
                  const value = property(raw)
                  const type = Object.keys(value)[0]!
                  const parts = value[type]
                  props[name === "title" ? "Name" : name] = {
                    type,
                    ...value,
                    ...(Array.isArray(parts)
                      ? {
                          [type]: parts.map((part: unknown) => ({
                            plain_text: String(property(property(part).text).content ?? ""),
                          })),
                        }
                      : {}),
                  }
                }
                clock++
              }
              return row()
            }
            if (path.startsWith("v1/pages/")) {
              const id = path.slice("v1/pages/".length)
              if (id === alphaPage && oldPageError)
                throw fail(oldPageError, "Controlled original page read failure")
              const page = pages.get(id)
              if (!page) throw fail("NOT_FOUND", "Missing controlled page")
              if (options?.method === "PATCH" && property(body).in_trash === true) {
                oldPageWrites++
                pages.set(id, { ...page, in_trash: true })
                return pages.get(id)
              }
              if (
                options?.method === "PATCH" &&
                property(property(body).properties).Tags !== undefined
              ) {
                tagWrites++
                pages.set(id, {
                  ...page,
                  properties: {
                    ...property(page.properties),
                    Tags: {
                      type: "multi_select",
                      ...property(property(property(body).properties).Tags),
                    },
                  },
                })
                if (loseTags) {
                  loseTags = false
                  throw fail("WRITE_OUTCOME_UNKNOWN", "Controlled Tags response lost after apply")
                }
                return pages.get(id)
              }
              return page
            }
            throw new Error(`Unexpected Notion request: ${path}`)
          },
          catch: (error) =>
            error instanceof SkillsError ? error : fail("NOTION_REQUEST_FAILED", String(error)),
        }),
    })

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* Store
            const crypto = yield* Crypto.Crypto
            yield* store.writeJson("config.json", { upstream_database: db })
            const opened = yield* sqliteState(store.root, yield* FileSystem.FileSystem)
            const record = (
              page: string,
              request: PublishRequest,
              hash: string,
              files: readonly { readonly path: string; readonly sha256: string }[],
            ) => {
              const receipt = {
                format: 1,
                operation_id: request.operation_id,
                operation: "create",
                state: "completed",
                page_id: page,
                context: {
                  source_intent: { mode: "set", value: { type: "upstream" } },
                  ownership: request.ownership,
                },
                portable: {
                  kind: "skill",
                  name: request.portable.name,
                  description: request.portable.description,
                  main: request.portable.main,
                  files,
                },
                guards: {},
                intents: [],
                stages: [],
              }
              const integrity = {
                version: 1,
                operation_id: request.operation_id,
                intended_hash: hash,
                page_id: page,
                marker: {
                  version: 2,
                  operation_id: request.operation_id,
                  intended_hash: hash,
                  state: "committed",
                  ...markerHashes,
                },
              }
              return opened.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient
                  yield* sql`INSERT INTO publications(id,operation,state,scope,page_id,payload) VALUES(${receipt.operation_id},${receipt.operation},${receipt.state},${null},${page},${JSON.stringify(receipt)})`
                  yield* sql`INSERT INTO integrity_operations(operation_id,publication_operation_id,intended_hash,state,page_id,payload) VALUES(${integrity.operation_id},${integrity.operation_id},${hash},${integrity.marker.state},${page},${JSON.stringify(integrity)})`
                }),
              )
            }
            const publisher = UpstreamPublisher.of({
              inspect: () => Effect.die("Rebuild does not inspect old content"),
              publish: (request) => {
                const existing = [...pages.values()].find(
                  (page) => property(page).publication_operation_id === request.operation_id,
                )
                if (existing)
                  return Effect.succeed(property(existing).receipt as VerifiedPublication)
                const hashed = portableIdentity(request.portable).pipe(
                  Effect.flatMap((hash) =>
                    Effect.gen(function* () {
                      const files = []
                      for (const file of request.portable.files)
                        files.push({ path: file.path, sha256: yield* sha256(file.bytes) })
                      return { hash, files }
                    }),
                  ),
                  Effect.provideService(Crypto.Crypto, crypto),
                )
                return hashed.pipe(
                  Effect.flatMap(({ hash, files }) => {
                    const id = `77777777-7777-4777-8777-${String(pages.size).padStart(12, "0")}`
                    const verified: VerifiedPublication = {
                      page_id: id,
                      version: "1",
                      content_hash: hash,
                      publication_operation_id: request.operation_id,
                      verified: true,
                    }
                    const owned = ownedPage(id, request.ownership.member_key)
                    return record(id, request, hash, files).pipe(
                      Effect.map(() => {
                        pages.set(id, {
                          ...owned,
                          publication_operation_id: request.operation_id,
                          properties: {
                            ...owned.properties,
                            "Default Context": {
                              type: "checkbox",
                              checkbox: request.default_context ?? false,
                            },
                            Tags: { type: "multi_select", multi_select: [] },
                            Publication: {
                              type: "rich_text",
                              rich_text: [
                                {
                                  plain_text: JSON.stringify({
                                    version: 2,
                                    operation_id: request.operation_id,
                                    intended_hash: hash,
                                    state: "committed",
                                    ...markerHashes,
                                  }),
                                },
                              ],
                            },
                          },
                          receipt: verified,
                        })
                        return verified
                      }),
                    )
                  }),
                )
              },
              reconcile: () => Effect.die("Unused"),
              setMode: () => Effect.die("Unused"),
              recoverableBaseline: () => Effect.die("Unused"),
              readBaseline: () => Effect.die("Unused"),
            })
            const state = opened.upstream
            yield* state.savePlan({
              version: 1,
              plan_id: "up_rebuild",
              plan_hash: "d".repeat(64),
              created_at: 1,
              subscription_id: sub,
              subscription_version: "v1",
              config_hash: "config",
              revision: accepted,
              provenance: {},
              publisher_subscription_id: sub,
              target_database_id: target,
              items: [],
            })
            const alpha: UpstreamBinding = yield* binding("skills/alpha", alphaPage, accepted)
            const beta: UpstreamBinding = yield* binding("skills/beta", betaPage, accepted)
            const selected = operationFor([alpha, beta])
            yield* state.advance(alpha, 0, sub, selected)
            yield* state.advance(beta, 0, sub, selected)

            const exercise = Effect.gen(function* () {
              if (mode === "daily-restore") {
                pages.set(betaPage, ownedPage(betaPage, "skills/beta"))
                pages.set(alphaPage, ownedPage(alphaPage, "skills/alpha", true))
                oldPageError = "ACCESS_DENIED"
                const denied = yield* restoreDeletedUpstreamMembers(sub).pipe(Effect.result)
                expect(denied._tag === "Failure" && denied.failure.code).toBe("ACCESS_DENIED")
                expect(pages.size).toBe(2)
                oldPageError = undefined
                props.Exclude = rich('["skills/alpha"]')
                expect(yield* restoreDeletedUpstreamMembers(sub)).toEqual([])
                expect(pages.size).toBe(2)
                props.Exclude = rich("[]")
                loseTags = true
                const lost = yield* restoreDeletedUpstreamMembers(sub).pipe(Effect.result)
                expect(lost._tag === "Failure" && lost.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
                expect(pages.size).toBe(3)
                const restored = yield* restoreDeletedUpstreamMembers(sub)
                expect(restored).toHaveLength(1)
                expect(restored[0]).toMatchObject({
                  member_key: "skills/alpha",
                  previous_page_id: alphaPage,
                  verified: true,
                })
                expect(restored[0]!.operation_id).toMatch(/^p_restore-/)
                expect(pages.size).toBe(3)
                expect(yield* restoreDeletedUpstreamMembers(sub)).toEqual([])
                expect(pages.size).toBe(3)
                expect(oldPageWrites).toBe(0)
                expect(
                  (yield* state.bindings(sub)).find((item) => item.member_key === "skills/beta"),
                ).toEqual(beta)
                return
              }
              if (mode === "restore-deleted") {
                const refuse = (code: string) =>
                  Effect.gen(function* () {
                    const result = yield* rebuild(sub, "skills/alpha", operation).pipe(
                      Effect.result,
                    )
                    expect(result._tag).toBe("Failure")
                    if (result._tag === "Failure") expect(result.failure.code).toBe(code)
                    expect(pages.size).toBe(1)
                    expect(oldPageWrites).toBe(0)
                    expect(mapPatches).toBe(0)
                    expect(
                      (yield* state.bindings(sub)).find(
                        (item) => item.member_key === "skills/alpha",
                      ),
                    ).toEqual(alpha)
                  })
                yield* refuse("UPSTREAM_TARGET_CONFLICT")
                for (const code of ["NOT_FOUND", "ACCESS_DENIED", "RATE_LIMITED"]) {
                  oldPageError = code
                  yield* refuse(code)
                }
                oldPageError = undefined
                pages.set(alphaPage, ownedPage(alphaPage, "foreign-member", true))
                yield* refuse("UPSTREAM_TARGET_CONFLICT")
                const moved = ownedPage(alphaPage, "skills/alpha", true)
                pages.set(alphaPage, { ...moved, parent: { ...moved.parent, database_id: db } })
                yield* refuse("UPSTREAM_TARGET_CONFLICT")
                pages.set(alphaPage, ownedPage(alphaPage, "skills/alpha", true))
                const mismatch = yield* rebuildUpstream(sub, "skills/alpha", operation).pipe(
                  Effect.result,
                )
                expect(mismatch._tag).toBe("Failure")
                if (mismatch._tag === "Failure")
                  expect(mismatch.failure.code).toBe("UPSTREAM_OPERATION_MISMATCH")
              }
              const beforePublish = pages.size
              const rebuiltId = `77777777-7777-4777-8777-${String(beforePublish).padStart(12, "0")}`
              loseTags = true
              const lostTags = yield* rebuild(sub, "skills/alpha", operation).pipe(Effect.result)
              expect(lostTags._tag).toBe("Failure")
              if (lostTags._tag === "Failure")
                expect(lostTags.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
              expect(tagWrites).toBe(1)
              expect(
                (yield* state.bindings(sub)).find((item) => item.member_key === "skills/alpha"),
              ).toEqual(alpha)
              const tagPage = pages.get(rebuiltId)!
              const copiedTags = property(property(tagPage.properties).Tags)
              expect(copiedTags.multi_select).toEqual([
                { name: "architecture" },
                { name: "coding" },
              ])
              // A user edit after the uncertain write must not be silently overwritten.
              pages.set(rebuiltId, {
                ...tagPage,
                properties: {
                  ...property(tagPage.properties),
                  Tags: { type: "multi_select", multi_select: [{ name: "user-choice" }] },
                },
              })
              const conflict = yield* rebuild(sub, "skills/alpha", operation).pipe(Effect.result)
              expect(conflict._tag).toBe("Failure")
              if (conflict._tag === "Failure") expect(conflict.failure.code).toBe("WRITE_CONFLICT")
              expect(tagWrites).toBe(1)
              // Clearing the tags is also a possible user edit. Unknown outcome must
              // not be treated as proof that the earlier write never happened.
              pages.set(rebuiltId, {
                ...tagPage,
                properties: {
                  ...property(tagPage.properties),
                  Tags: { type: "multi_select", multi_select: [] },
                },
              })
              const cleared = yield* rebuild(sub, "skills/alpha", operation).pipe(Effect.result)
              expect(cleared._tag).toBe("Failure")
              if (cleared._tag === "Failure")
                expect(cleared.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
              expect(tagWrites).toBe(1)
              pages.set(rebuiltId, tagPage)
              loseMap = true
              const lost = yield* rebuild(sub, "skills/alpha", operation).pipe(Effect.result)
              expect(lost._tag).toBe("Failure")
              if (lost._tag === "Failure") expect(lost.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
              expect(tagWrites).toBe(1)
              expect(mapLosses).toBe(1)
              expect(property(pages.get(alphaPage)).in_trash).toBe(true)
              expect(oldPageWrites).toBe(mode === "rebuild" ? 1 : 0)
              expect(pages.has(rebuiltId)).toBe(true)
              const committed = (yield* state.bindings(sub)).find(
                (item) => item.member_key === "skills/alpha",
              )!
              expect(committed.page_id).toBe(rebuiltId)
              expect(committed.generation).toBe(2)
              expect(committed.revision).toBe(current)
              expect(committed.published_hash).not.toBe(alpha.published_hash)
              expect(
                (yield* state.bindings(sub)).find((item) => item.member_key === "skills/beta"),
              ).toEqual(beta)
              expect((yield* getSubscription(sub)).published).toEqual(published)
              expect((yield* getSubscription(sub)).default_context).toBe(true)
              expect((yield* getSubscription(sub)).source.accepted_ref).toBe(accepted)
              const frozenUnknown = property(yield* state.command(`upstream-rebuild:${operation}`))
              expect(frozenUnknown.state).toBe("unknown")
              expect(frozenUnknown.map).toBeDefined()

              const stillUnknown = yield* rebuild(sub, "skills/alpha", operation).pipe(
                Effect.result,
              )
              expect(stillUnknown._tag).toBe("Failure")
              if (stillUnknown._tag === "Failure")
                expect(stillUnknown.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
              expect(mapLosses).toBe(1)
              expect(mapPatches).toBe(0)
              expect(property(yield* state.command(`upstream-rebuild:${operation}`))).toEqual(
                frozenUnknown,
              )
              expect((yield* getSubscription(sub)).published).toEqual(published)

              const betaUpdated = {
                ...published.members[1]!,
                content_hash: "e".repeat(64),
                revision: current,
              }
              const frozenMap = frozenUnknown.map as PublishedMembers
              const confirmed = {
                ...frozenMap,
                members: frozenMap.members.map((member: { member_key: string }) =>
                  member.member_key === "skills/beta" ? betaUpdated : member,
                ),
              }
              props["Published Members"] = rich(JSON.stringify(confirmed))
              const rebuilt = yield* rebuild(sub, "skills/alpha", operation)
              expect(rebuilt).toMatchObject({
                operation_id: operation,
                member_key: "skills/alpha",
                previous_page_id: alphaPage,
                page_id: rebuiltId,
                publication_operation_id: operation,
                revision: current,
                verified: true,
              })
              expect([...pages.keys()].filter((id) => id !== alphaPage && id !== betaPage)).toEqual(
                [rebuiltId],
              )
              expect(mapPatches).toBe(0)
              const after = yield* getSubscription(sub)
              expect(after.default_context).toBe(true)
              expect(
                property(property(property(pages.get(rebuiltId)).properties)["Default Context"])
                  .checkbox,
              ).toBe(true)
              expect(
                property(property(property(pages.get(rebuiltId)).properties).Tags).multi_select,
              ).toEqual([{ name: "architecture" }, { name: "coding" }])
              expect(after.published).toEqual(confirmed)
              expect(after.published?.source_manifest?.revision).toBe(current)
              expect(
                after.published?.source_manifest?.members.find(
                  (member) => member.member_key === "skills/alpha",
                )?.resources,
              ).toEqual(
                expect.arrayContaining([
                  { path: "SKILL.md", sha256: expect.any(String) },
                  { path: "references/guide.md", sha256: expect.any(String) },
                ]),
              )
              expect(after.source.accepted_ref).toBe(accepted)
              expect(after.status).toBe("verified")
              expect(
                after.published?.members.find((member) => member.member_key === "skills/beta"),
              ).toEqual(betaUpdated)
              expect(
                after.published?.members.find((member) => member.member_key === "skills/alpha"),
              ).toMatchObject({
                page_id: rebuiltId,
                revision: current,
              })
              const repeated = yield* rebuild(sub, "skills/alpha", operation)
              expect(repeated).toEqual(rebuilt)
              expect([...pages.keys()].filter((id) => id !== alphaPage && id !== betaPage)).toEqual(
                [rebuiltId],
              )
              expect(mapPatches).toBe(0)
              expect(
                (yield* state.bindings(sub)).find((item) => item.member_key === "skills/beta"),
              ).toEqual(beta)

              const command = property(yield* state.command(`upstream-rebuild:${operation}`))
              expect(command.state).toBe("verified")
              expect(command.map).toEqual(confirmed)
              const laterBeta = { ...betaUpdated, content_hash: "f".repeat(64) }
              props["Published Members"] = rich(
                JSON.stringify({
                  ...confirmed,
                  members: confirmed.members.map((member: { member_key: string }) =>
                    member.member_key === "skills/beta" ? laterBeta : member,
                  ),
                }),
              )
              yield* state.saveCommand(`upstream-rebuild:${operation}`, {
                ...frozenUnknown,
                state: "committed",
                page_id: rebuiltId,
                map: confirmed,
                map_status: "verified",
              })
              const preserved = yield* rebuild(sub, "skills/alpha", operation).pipe(Effect.result)
              expect(preserved._tag).toBe("Success")
              if (preserved._tag === "Success")
                expect(preserved.success).toMatchObject({ page_id: rebuiltId, verified: true })
              expect(mapPatches).toBe(0)
              const retained = yield* getSubscription(sub)
              expect(
                retained.published?.members.find((member) => member.member_key === "skills/beta"),
              ).toEqual(laterBeta)
              expect(
                retained.published?.members.find((member) => member.member_key === "skills/alpha"),
              ).toEqual(
                confirmed.members.find(
                  (member: { member_key: string }) => member.member_key === "skills/alpha",
                ),
              )
              expect(
                (yield* state.bindings(sub)).find((item) => item.member_key === "skills/beta"),
              ).toEqual(beta)
              const rows = yield* opened.run(
                Effect.flatMap(
                  SqlClient.SqlClient,
                  (sql) =>
                    sql<{
                      state: string
                      page_id: string
                    }>`SELECT state,page_id FROM publications WHERE id=${operation}`,
                ),
              )
              const integrity = yield* opened.run(
                Effect.flatMap(
                  SqlClient.SqlClient,
                  (sql) =>
                    sql<{
                      state: string
                      page_id: string
                    }>`SELECT state,page_id FROM integrity_operations WHERE operation_id=${operation}`,
                ),
              )
              expect(rows).toEqual([{ state: "completed", page_id: rebuiltId }])
              expect(integrity).toEqual([{ state: "committed", page_id: rebuiltId }])
            })
            yield* exercise.pipe(
              Effect.provideService(UpstreamState)(state),
              Effect.provideService(Notion)(notion),
              Effect.provideService(UpstreamPublisher)(publisher),
            )
          }).pipe(
            Effect.provide(StoreLive),
            Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch)),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
          ),
        ),
      )
    } finally {
      vi.unstubAllEnvs()
      if (process.platform === "darwin") execFileSync("/usr/bin/trash", [root])
    }

    function binding(member: string, page: string, revision: string) {
      return Effect.gen(function* () {
        const text = member.endsWith("beta")
          ? skill("beta", "beta stays")
          : skill("alpha", "accepted")
        const hash = yield* sha256(text)
        const frozen = {
          kind: "skill" as const,
          name: member.endsWith("beta") ? "beta" : "alpha",
          description: "Use for selected upstream rebuild",
          main: "SKILL.md",
          files: [{ path: "SKILL.md", hash }],
        }
        return {
          subscription_id: sub,
          member_key: member,
          target_key: JSON.stringify([target, "selected-rebuild", member]),
          page_id: page,
          generation: 1,
          mode: "tracked" as const,
          active: true,
          revision,
          published_hash: "b".repeat(64),
          accepted: frozen,
          materialized: frozen,
        }
      })
    }
    function operationFor(items: readonly { member_key: string; page_id: string }[]) {
      return {
        operation_id: "uo_selected",
        plan_id: "up_rebuild",
        subscription_id: sub,
        state: "verified" as const,
        items: items.map((item) => ({
          member_key: item.member_key,
          status: "verified" as const,
          page_id: item.page_id,
        })),
      }
    }
  },
  120_000,
)
