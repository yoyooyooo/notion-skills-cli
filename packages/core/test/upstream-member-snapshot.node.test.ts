import { expect, test } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { trashPath } from "../src/local-locks.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authScope } from "../src/catalog.ts"
import { portableIdentity, snapshotAuthoredPortable, snapshotPortable } from "../src/export.ts"
import { fail, SnapshotSchema, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { BUNDLE, bodyIdentity, portableZip, type PortableSkill } from "../src/portable.ts"
import {
  PublicationInspectDivergence,
  PublicationReadOperation,
} from "../src/publication-integrity.ts"
import { fileRef, resolveRef } from "../src/ref.ts"
import { Store, StoreLive } from "../src/store.ts"
import { type SourceMemberManifest } from "../src/upstream-member-links.ts"
import {
  projectUpstreamMemberSnapshot,
  resolveUpstreamMemberRelative,
} from "../src/upstream-member-snapshot.ts"
import { type PublishedMembers } from "../src/upstream-model.ts"
import { resolvePublishedSubscription } from "../src/upstream-router.ts"

const subscription = "11111111-1111-4111-8111-111111111111"
const otherSubscription = "99999999-9999-4999-8999-999999999999"
const database = "22222222-2222-4222-8222-222222222222"
const dataSource = "33333333-3333-4333-8333-333333333333"
const targetDatabase = "44444444-4444-4444-8444-444444444444"
const targetDataSource = "55555555-5555-4555-8555-555555555555"
const alphaPage = "66666666-6666-4666-8666-666666666666"
const betaPage = "77777777-7777-4777-8777-777777777777"
const replacementPage = "88888888-8888-4888-8888-888888888888"
const revision = "a".repeat(40)
const alphaKey = "skills/alpha"
const betaKey = "skills/beta"
const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const rich = (value: string, type = "rich_text") => ({ type, [type]: [{ plain_text: value }] })
const description = "Exercise authenticated cross-member source links"
const mainBody = [
  "# Alpha",
  "[beta](../../beta/docs/ENTRY.md)",
  "[beta guide](../../beta/references/deep/target.md)",
  "![beta asset](../../beta/assets/%E5%9B%BE%20%E5%83%8F.bin)",
  "[own guide](../references/nested/guide.md#section)",
  "![own asset](../assets/raw.bin)",
  "`[example](../../beta/docs/ENTRY.md)`",
  "```md\n[example](../../beta/missing.md)\n```",
].join("\n\n")
const mainMarkdown = `---\nname: alpha\ndescription: ${description}\n---\n\n${mainBody}\n`
const nestedMarkdown = [
  "# Guide",
  "[beta](../../../beta/docs/ENTRY.md)",
  "[beta resource](../../../beta/references/deep/target.md)",
  "![beta asset](../../../beta/assets/%E5%9B%BE%20%E5%83%8F.bin)",
  "[own main](../../docs/MAIN.md)",
  "![own asset](../../assets/raw.bin)",
].join("\n\n")
const binary = new Uint8Array([0, 255, 128, 1, 13, 10, 0])
const alpha: PortableSkill = {
  kind: "skill",
  name: "alpha",
  description,
  main: "docs/MAIN.md",
  files: [
    { path: "docs/MAIN.md", bytes: encode(mainMarkdown) },
    { path: "references/nested/guide.md", bytes: encode(nestedMarkdown) },
    { path: "assets/raw.bin", bytes: binary },
  ],
  projection: { name: "alpha", description, body: bodyIdentity(mainBody) },
}
const betaFiles = [
  { path: "docs/ENTRY.md", bytes: encode("# Beta\n") },
  { path: "references/deep/target.md", bytes: encode("# Target\n") },
  { path: "assets/图 像.bin", bytes: new Uint8Array([37, 0, 254, 10, 255]) },
]

interface Fixture {
  readonly snapshot: Snapshot
  readonly requests: string[]
  readonly sourceZip: Uint8Array
  sourceId: string
  published: PublishedMembers
  credential: string
  deniedPath?: string
  ownerRevision?: string
  noPublishedMap?: boolean
  queryPageSize?: number
  repeatQueryCursor?: boolean
  mode: "tracked" | "fork"
  readonly rawPage: () => unknown
}

async function fixture(
  operation: (
    state: Fixture,
  ) => Effect.Effect<unknown, unknown, Store | Notion | NodeServices.NodeServices>,
) {
  const root = await mkdtemp(join(tmpdir(), "ntn-member-snapshot-"))
  const sourceZip = portableZip(alpha, true)
  const sourceManifest: SourceMemberManifest = {
    version: 1,
    source_id: subscription,
    revision,
    members: [
      {
        member_key: alphaKey,
        source_path: alphaKey,
        main: alpha.main,
        resources: alpha.files.map((file) => ({ path: file.path, sha256: digest(file.bytes) })),
      },
      {
        member_key: betaKey,
        source_path: betaKey,
        main: "docs/ENTRY.md",
        resources: betaFiles.map((file) => ({ path: file.path, sha256: digest(file.bytes) })),
      },
    ],
  }
  const memberEntries = [
    { member_key: alphaKey, page_id: alphaPage, content_hash: digest(sourceZip), revision },
    { member_key: betaKey, page_id: betaPage, content_hash: digest("beta publication"), revision },
  ]
  const state: Fixture = {
    sourceId: subscription,
    credential: "member-snapshot-credential",
    mode: "tracked",
    requests: [],
    sourceZip,
    published: {
      version: 1,
      revision,
      plan_hash: digest("plan"),
      publisher_subscription_id: subscription,
      source_manifest: sourceManifest,
      members: memberEntries,
    },
    snapshot: {
      snapshot_id: `s_${digest("original snapshot")}`,
      scope: "",
      version_id: "original-version",
      created_at: 1,
      entrypoint: "SKILL.md",
      record: {
        id: `notion_page:${alphaPage}`,
        kind: "skill",
        name: "alpha",
        alias: "alpha",
        description,
        default_context: false,
        entrypoint: "SKILL.md",
        ref: fileRef(alphaPage, "SKILL.md"),
        locator: {
          type: "notion_page",
          page_id: alphaPage,
          database_id: targetDatabase,
          data_source_id: targetDataSource,
        },
      },
      files: [],
    },
    rawPage: () => memberPage(alphaPage, alphaKey, memberEntries[0]!.content_hash),
  }
  function memberPage(id: string, key: string, hash: string) {
    return {
      id,
      parent: { database_id: targetDatabase, data_source_id: targetDataSource },
      properties: {
        Name: rich(key.split("/").at(-1)!, "title"),
        Kind: { type: "select", select: { name: "skill" } },
        Upstream: { type: "relation", relation: [{ id: state.sourceId }], has_more: false },
        "Sync Mode": { type: "select", select: { name: state.mode } },
        "Upstream Key": rich(key),
        "Upstream Revision": rich(
          state.ownerRevision ??
            state.published.members.find((member) => member.page_id === id)?.revision ??
            state.published.revision,
        ),
        "Published Hash": rich(hash),
        Publication: rich(
          JSON.stringify({
            version: 2,
            operation_id: `publication-${id}`,
            state: "committed",
            intended_hash: hash,
            revision: digest(`publication-${id}`),
            manifest_hash: digest(`manifest-${id}`),
            ownership_hash: digest(`owner-${id}`),
          }),
        ),
      },
    }
  }
  const api = Notion.of({
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.sync(() => state.credential),
    request: (path, body, options) =>
      Effect.gen(function* () {
        state.requests.push(path)
        const query = path === `v1/data_sources/${targetDataSource}/query`
        if ((body && !query) || (options?.method && options.method !== (query ? "POST" : "GET")))
          return yield* Effect.fail(
            fail("UNEXPECTED", "Source projection must only read remote metadata."),
          )
        if (path === state.deniedPath)
          return yield* Effect.fail(fail("ACCESS_DENIED", "Fixture scope denied."))
        if (path === "v1/users/me") return { id: "member-snapshot-user", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: "skills",
            title: [],
            data_sources: [{ id: dataSource, name: "Upstreams" }],
          }
        if (path === `v1/databases/${targetDatabase}`)
          return {
            id: targetDatabase,
            database_type: "skills",
            title: [],
            data_sources: [{ id: targetDataSource, name: "Skills" }],
          }
        if (path === `v1/pages/${state.sourceId}`)
          return {
            id: state.sourceId,
            parent: { database_id: database, data_source_id: dataSource },
            properties: {
              Name: rich("Two Skills", "title"),
              Description: rich(description),
              Source: rich(
                JSON.stringify({
                  provider: {
                    type: "git",
                    url: "https://github.com/example/two-skills.git",
                    ref: "main",
                  },
                }),
              ),
              "Published Members": rich(
                state.noPublishedMap ? "" : JSON.stringify(state.published),
              ),
              "Target Database ID": rich(targetDatabase),
              "Default Context": { type: "checkbox", checkbox: true },
              Status: { type: "select", select: { name: "partial" } },
            },
          }
        if (query) {
          const offset = Number((body as { start_cursor?: string }).start_cursor ?? 0)
          const rows = state.published.members
            .filter((member) => `v1/pages/${member.page_id}` !== state.deniedPath)
            .map((member) =>
              member.page_id === alphaPage
                ? state.rawPage()
                : memberPage(member.page_id, member.member_key, member.content_hash),
            )
          const end = offset + (state.queryPageSize ?? 100)
          const more = end < rows.length || (state.repeatQueryCursor && offset > 0)
          return {
            results: rows.slice(offset, end),
            has_more: Boolean(more),
            next_cursor: more ? String(state.repeatQueryCursor && offset > 0 ? offset : end) : null,
          }
        }
        if (path === `v1/pages/${alphaPage}`) return state.rawPage()
        const member = state.published.members.find((entry) => path === `v1/pages/${entry.page_id}`)
        if (member) return memberPage(member.page_id, member.member_key, member.content_hash)
        return yield* Effect.fail(fail("UNEXPECTED", `Unexpected metadata request: ${path}`))
      }),
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store
          // Published Hash is the public portable content identity, not the ZIP container hash.
          memberEntries[0]!.content_hash = yield* portableIdentity(alpha)
          yield* store.writeJson("config.json", { upstream_database: database, sources: [] })
          const files = [
            ...alpha.files.map((file) => ({
              ...file,
              path: file.path === alpha.main ? "SKILL.md" : file.path,
            })),
            { path: BUNDLE, bytes: sourceZip },
          ]
          const entries: Snapshot["files"][number][] = []
          for (const file of files) {
            const hash = digest(file.bytes)
            yield* store.writeBytes(`objects/${hash}`, file.bytes)
            entries.push({ path: file.path, bytes: file.bytes.length, sha256: hash })
          }
          const scope = yield* authScope
          const snapshot: Snapshot = {
            ...state.snapshot,
            files: entries,
            scope,
            snapshot_id: `s_${digest(JSON.stringify([scope, state.snapshot.record.id, state.snapshot.version_id]))}`,
          }
          Object.assign(state, { snapshot })
          yield* store.writeJson(`snapshots/${snapshot.snapshot_id}.json`, snapshot)
          state.requests.length = 0
          yield* operation(state)
        }),
      ).pipe(
        Effect.provideService(Notion, api),
        Effect.provide(StoreLive),
        Effect.provide(NodeServices.layer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              NTN_SKILLS_HOME: join(root, "state"),
              NTN_SKILLS_CONFIG_HOME: join(root, "config"),
              NTN_SKILLS_CACHE_HOME: join(root, "cache"),
            }),
          ),
        ),
      ),
    )
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}

const failure = <A, E, R>(operation: Effect.Effect<A, E, R>, code: string) =>
  operation.pipe(
    Effect.result,
    Effect.map((result) => {
      expect(result).toMatchObject({ _tag: "Failure", failure: { code } })
      return result
    }),
  )

const mainProjected = mainMarkdown
  .replace("[beta](../../beta/docs/ENTRY.md)", `[beta](${fileRef(betaPage, "SKILL.md")})`)
  .replace("../../beta/references/deep/target.md", fileRef(betaPage, "references/deep/target.md"))
  .replace("../../beta/assets/%E5%9B%BE%20%E5%83%8F.bin", fileRef(betaPage, "assets/图 像.bin"))
const nestedProjected = nestedMarkdown
  .replace("../../../beta/docs/ENTRY.md", fileRef(betaPage, "SKILL.md"))
  .replace(
    "../../../beta/references/deep/target.md",
    fileRef(betaPage, "references/deep/target.md"),
  )
  .replace("../../../beta/assets/%E5%9B%BE%20%E5%83%8F.bin", fileRef(betaPage, "assets/图 像.bin"))

test("the official Router resolver authenticates the complete map using page metadata alone", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      f.queryPageSize = 1
      const map = yield* resolvePublishedSubscription(subscription)
      expect(map.revision).toBe(revision)
      expect(map.default_context).toBe(true)
      expect(map.members).toEqual([{ page_id: alphaPage }, { page_id: betaPage }])
      expect(map.published.source_manifest).toEqual(f.published.source_manifest)
    }),
  )
})

test("a selected Skill remains readable when an unrelated sibling is unavailable", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      f.deniedPath = `v1/pages/${betaPage}`
      yield* failure(resolvePublishedSubscription(subscription), "UPSTREAM_ROUTER_UNAVAILABLE")
      f.requests.length = 0
      const projected = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      expect(projected.source_projection?.source_id).toBe(subscription)
      expect(f.requests).toContain(`v1/pages/${alphaPage}`)
      expect(f.requests).not.toContain(`v1/pages/${betaPage}`)
      expect(f.requests).not.toContain(`v1/data_sources/${targetDataSource}/query`)
    }),
  )
})

test("member isolation does not waive the selected member's exact published hash", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      f.published = {
        ...f.published,
        members: f.published.members.map((member) =>
          member.page_id === alphaPage ? { ...member, content_hash: "0".repeat(64) } : member,
        ),
      }
      yield* failure(
        resolvePublishedSubscription(subscription, { type: "member", pageId: alphaPage }),
        "UPSTREAM_ROUTER_UNAVAILABLE",
      )
    }),
  )
})

test("an inaccessible selected member still fails without a sibling fallback", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      f.deniedPath = `v1/pages/${alphaPage}`
      yield* failure(
        resolvePublishedSubscription(subscription, { type: "member", pageId: alphaPage }),
        "ACCESS_DENIED",
      )
      expect(f.requests).not.toContain(`v1/pages/${betaPage}`)
    }),
  )
})

test("member pagination cannot accept a repeating cursor", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      f.queryPageSize = 1
      f.repeatQueryCursor = true
      yield* failure(resolvePublishedSubscription(subscription), "INVALID_RESPONSE")
    }),
  )
})

test("fresh member query results must retain the active published hash", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      f.published = {
        ...f.published,
        members: f.published.members.map((member) =>
          member.page_id === alphaPage ? { ...member, content_hash: "0".repeat(64) } : member,
        ),
      }
      yield* failure(resolvePublishedSubscription(subscription), "UPSTREAM_ROUTER_UNAVAILABLE")
    }),
  )
})

test("current authored edits remain readable without borrowing the old source projection", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      const store = yield* Store
      const bytes = encode(mainMarkdown + "\nHuman edit.\n")
      const hash = digest(bytes)
      yield* store.writeBytes(`objects/${hash}`, bytes)
      const current = {
        ...f.snapshot,
        files: f.snapshot.files.map((file) =>
          file.path === "SKILL.md" ? { ...file, bytes: bytes.length, sha256: hash } : file,
        ),
      }
      const observed = yield* projectUpstreamMemberSnapshot(current, f.rawPage(), {
        optional: true,
      })
      expect(observed).toEqual(current)
      expect(observed.source_projection).toBeUndefined()
      expect(f.requests).not.toContain(`v1/pages/${subscription}`)
    }),
  )
})

test("projection persists real derived objects and source proof without changing source ZIP or own assets", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      const store = yield* Store
      const before = yield* snapshotAuthoredPortable(f.snapshot)
      const projected = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      expect(projected.snapshot_id).not.toBe(f.snapshot.snapshot_id)
      expect(projected.version_id).not.toBe(f.snapshot.version_id)
      expect(projected.source_files).toEqual(f.snapshot.files)
      expect(projected.source_projection).toEqual({
        source_id: subscription,
        revision,
        manifest_hash: digest(JSON.stringify([f.published.source_manifest, f.published.members])),
        unavailable: [],
        files: ["SKILL.md", "references/nested/guide.md"].map((path) => ({
          path,
          source_hash: f.snapshot.files.find((file) => file.path === path)!.sha256,
          derived_hash: digest(path === "SKILL.md" ? mainProjected : nestedProjected),
        })),
      })
      for (const file of projected.files) {
        const bytes = yield* store.readBytes(`objects/${file.sha256}`)
        expect(digest(bytes)).toBe(file.sha256)
        expect(bytes.length).toBe(file.bytes)
        if (file.path === "SKILL.md") expect(decode(bytes)).toBe(mainProjected)
        if (file.path === "references/nested/guide.md") expect(decode(bytes)).toBe(nestedProjected)
        if (file.path === BUNDLE) expect([...bytes]).toEqual([...f.sourceZip])
        if (file.path === "assets/raw.bin") expect([...bytes]).toEqual([...binary])
      }
      for (const file of projected.source_files!) {
        const bytes = yield* store.readBytes(`objects/${file.sha256}`)
        expect(digest(bytes)).toBe(file.sha256)
        if (file.path === "SKILL.md") expect(decode(bytes)).toBe(mainMarkdown)
        if (file.path === "references/nested/guide.md") expect(decode(bytes)).toBe(nestedMarkdown)
      }
      expect(
        yield* store.readJson(`snapshots/${projected.snapshot_id}.json`, SnapshotSchema),
      ).toEqual(projected)
      expect(
        yield* store.readJson(`snapshots/${f.snapshot.snapshot_id}.json`, SnapshotSchema),
      ).toEqual(f.snapshot)
      expect(portableZip(yield* snapshotAuthoredPortable(projected))).toEqual(portableZip(before))
      const generated = yield* snapshotPortable(projected)
      expect(decode(generated.files.find((file) => file.path === "SKILL.md")!.bytes)).toBe(
        mainProjected,
      )
    }),
  )
})

test("--from resolves canonical custom main and nested source resources to exact active target refs", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      const projected = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      expect(
        yield* resolveUpstreamMemberRelative(projected, "SKILL.md", "../../beta/docs/ENTRY.md"),
      ).toBe(fileRef(betaPage, "SKILL.md"))
      expect(
        yield* resolveUpstreamMemberRelative(
          projected,
          "references/nested/guide.md",
          "../../../beta/references/deep/target.md",
        ),
      ).toBe(fileRef(betaPage, "references/deep/target.md"))
      expect(
        yield* resolveUpstreamMemberRelative(
          projected,
          "references/nested/guide.md",
          "../../../beta/assets/%E5%9B%BE%20%E5%83%8F.bin",
        ),
      ).toBe(fileRef(betaPage, "assets/图 像.bin"))
      const relative = "../../assets/raw.bin"
      expect(
        yield* resolveUpstreamMemberRelative(projected, "references/nested/guide.md", relative),
      ).toBe(
        resolveRef(
          fileRef(alphaPage, "references/nested/guide.md", projected.snapshot_id),
          relative,
        ),
      )
      expect(f.requests.some((path) => /markdown|blocks|ai\/skills/.test(path))).toBe(false)
    }),
  )
})

test("ordinary snapshots resolve locally without Notion and internal publication reads skip projection", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      f.deniedPath = `v1/pages/${alphaPage}`
      expect(
        yield* resolveUpstreamMemberRelative(
          f.snapshot,
          "references/nested/guide.md",
          "../../assets/raw.bin",
        ),
      ).toBe(
        resolveRef(
          fileRef(alphaPage, "references/nested/guide.md", f.snapshot.snapshot_id),
          "../../assets/raw.bin",
        ),
      )
      expect(
        yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage()).pipe(
          Effect.provideService(PublicationReadOperation, "own-publication"),
        ),
      ).toBe(f.snapshot)
      expect(
        yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage()).pipe(
          Effect.provideService(PublicationInspectDivergence, true),
        ),
      ).toBe(f.snapshot)
      f.mode = "fork"
      expect(yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())).toBe(f.snapshot)
      expect(f.requests).toEqual([])
    }),
  )
})

test.each(["scope", "source", "revision", "ownership revision", "map", "mode"] as const)(
  "pinned --from rejects a changed %s instead of silently resolving against another authority",
  async (change) => {
    await fixture((f) =>
      Effect.gen(function* () {
        const projected = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
        if (change === "scope") f.credential = "another-credential"
        if (change === "source") {
          f.sourceId = otherSubscription
          f.published = {
            ...f.published,
            publisher_subscription_id: otherSubscription,
            source_manifest: { ...f.published.source_manifest!, source_id: otherSubscription },
          }
        }
        if (change === "revision") {
          const next = "b".repeat(40)
          f.published = {
            ...f.published,
            revision: next,
            source_manifest: { ...f.published.source_manifest!, revision: next },
          }
        }
        if (change === "ownership revision") f.ownerRevision = "b".repeat(40)
        if (change === "map")
          f.published = {
            ...f.published,
            members: f.published.members.map((member) =>
              member.member_key === betaKey ? { ...member, page_id: replacementPage } : member,
            ),
          }
        if (change === "mode") f.mode = "fork"
        yield* failure(
          resolveUpstreamMemberRelative(
            projected,
            "references/nested/guide.md",
            "../../../beta/references/deep/target.md",
          ),
          change === "scope" ? "ACCESS_DENIED" : "SOURCE_REVISION_UNAVAILABLE",
        )
      }),
    )
  },
)

test.each([
  { path: "v1/users/me", relative: "ACCESS_DENIED", projection: "ACCESS_DENIED" },
  { path: `v1/pages/${alphaPage}`, relative: "ACCESS_DENIED", projection: "ACCESS_DENIED" },
  { path: `v1/pages/${betaPage}`, relative: "ACCESS_DENIED", projection: undefined },
])(
  "inaccessible metadata at $path cannot fall back to cached or local refs",
  async ({ path, relative, projection }) => {
    await fixture((f) =>
      Effect.gen(function* () {
        const projected = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
        f.deniedPath = path
        yield* failure(
          resolveUpstreamMemberRelative(
            projected,
            "references/nested/guide.md",
            "../../../beta/references/deep/target.md",
          ),
          relative,
        )
        if (projection)
          yield* failure(projectUpstreamMemberSnapshot(f.snapshot, f.rawPage()), projection)
        else
          expect(
            (yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())).source_projection
              ?.source_id,
          ).toBe(subscription)
      }),
    )
  },
)

test("independent member and selected dependency reads do not require a whole-series query", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      f.deniedPath = `v1/data_sources/${targetDataSource}/query`
      const projected = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      expect(
        yield* resolveUpstreamMemberRelative(
          projected,
          "references/nested/guide.md",
          "../../../beta/references/deep/target.md",
        ),
      ).toBe(fileRef(betaPage, "references/deep/target.md"))
      expect(f.requests).not.toContain(f.deniedPath)
      expect(f.requests).toContain(`v1/pages/${betaPage}`)
    }),
  )
})

test("an unpublished target remains explicit while own resources stay readable and same-commit mapping recovers", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      const complete = f.published
      f.published = {
        ...complete,
        members: complete.members.filter((member) => member.member_key !== betaKey),
      }
      const pending = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      expect(pending.source_projection!.unavailable!.length).toBeGreaterThan(0)
      expect(
        pending.source_projection!.unavailable!.every(
          (entry) => entry.reason === "target_unavailable",
        ),
      ).toBe(true)
      const store = yield* Store
      expect(
        decode(
          yield* store.readBytes(
            `objects/${pending.files.find((file) => file.path === "SKILL.md")!.sha256}`,
          ),
        ),
      ).toBe(mainMarkdown)
      yield* failure(
        resolveUpstreamMemberRelative(
          pending,
          "references/nested/guide.md",
          "../../../beta/references/deep/target.md",
        ),
        "SOURCE_MEMBER_UNAVAILABLE",
      )
      f.published = complete
      const ready = yield* projectUpstreamMemberSnapshot(pending, f.rawPage())
      expect(ready.snapshot_id).not.toBe(pending.snapshot_id)
      expect(ready.source_projection!.unavailable).toEqual([])
      expect(
        yield* resolveUpstreamMemberRelative(
          ready,
          "references/nested/guide.md",
          "../../../beta/references/deep/target.md",
        ),
      ).toBe(fileRef(betaPage, "references/deep/target.md"))
    }),
  )
})

test("removing a target from the subscribed manifest cannot become a repository URL fallback", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      const pinned = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      f.published = {
        ...f.published,
        members: f.published.members.filter((member) => member.member_key !== betaKey),
        source_manifest: {
          ...f.published.source_manifest!,
          members: f.published.source_manifest!.members.filter(
            (member) => member.member_key !== betaKey,
          ),
        },
      }
      const removed = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      expect(
        removed.source_projection!.unavailable!.every(
          (entry) => entry.reason === "target_unavailable",
        ),
      ).toBe(true)
      yield* failure(
        resolveUpstreamMemberRelative(
          pinned,
          "references/nested/guide.md",
          "../../../beta/references/deep/target.md",
        ),
        "SOURCE_REVISION_UNAVAILABLE",
      )
    }),
  )
})

test("fresh projection uses original bytes when exact published IDs change at the same commit", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      const first = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      f.published = {
        ...f.published,
        members: f.published.members.map((member) =>
          member.member_key === betaKey ? { ...member, page_id: replacementPage } : member,
        ),
      }
      const fresh = yield* projectUpstreamMemberSnapshot(first, f.rawPage())
      expect(fresh.source_files).toEqual(f.snapshot.files)
      expect(fresh.source_projection!.revision).toBe(first.source_projection!.revision)
      expect(fresh.source_projection!.manifest_hash).not.toBe(
        first.source_projection!.manifest_hash,
      )
      const store = yield* Store
      const main = fresh.files.find((file) => file.path === "SKILL.md")!
      expect(decode(yield* store.readBytes(`objects/${main.sha256}`))).toBe(
        mainProjected.replaceAll(betaPage, replacementPage),
      )
      yield* failure(
        resolveUpstreamMemberRelative(
          first,
          "references/nested/guide.md",
          "../../../beta/references/deep/target.md",
        ),
        "SOURCE_REVISION_UNAVAILABLE",
      )
      expect(
        yield* resolveUpstreamMemberRelative(
          fresh,
          "references/nested/guide.md",
          "../../../beta/references/deep/target.md",
        ),
      ).toBe(fileRef(replacementPage, "references/deep/target.md"))
    }),
  )
})

test("the source scan revision remains independent of an unchanged member's inspected publication revision", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      const memberRevision = "c".repeat(40)
      f.published = {
        ...f.published,
        members: f.published.members.map((member) => ({ ...member, revision: memberRevision })),
      }
      const projected = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      expect(projected.source_projection!.revision).toBe(revision)
      expect(
        yield* resolveUpstreamMemberRelative(
          projected,
          "references/nested/guide.md",
          "../../../beta/references/deep/target.md",
        ),
      ).toBe(fileRef(betaPage, "references/deep/target.md"))
    }),
  )
})

test("a committed member retains exact own resources without a Router map and recovers when the map appears", async () => {
  await fixture((f) =>
    Effect.gen(function* () {
      f.noPublishedMap = true
      yield* failure(resolvePublishedSubscription(subscription), "UPSTREAM_ROUTER_UNAVAILABLE")
      const own = yield* projectUpstreamMemberSnapshot(f.snapshot, f.rawPage())
      expect(own.files).toEqual(f.snapshot.files)
      expect(own.source_files).toEqual(f.snapshot.files)
      expect(own.source_projection!.unavailable!.length).toBeGreaterThan(0)
      expect(
        own.source_projection!.unavailable!.every(
          (entry) => entry.reason === "published_map_unavailable",
        ),
      ).toBe(true)
      const store = yield* Store
      for (const file of own.files)
        expect(digest(yield* store.readBytes(`objects/${file.sha256}`))).toBe(file.sha256)
      yield* failure(
        resolveUpstreamMemberRelative(
          own,
          "references/nested/guide.md",
          "../../../beta/references/deep/target.md",
        ),
        "SOURCE_MEMBER_UNAVAILABLE",
      )
      const raw = f.rawPage() as {
        properties: { Publication: { rich_text: { plain_text: string }[] } }
      }
      raw.properties.Publication.rich_text[0]!.plain_text = JSON.stringify({
        version: 2,
        operation_id: "writing-member",
        intended_hash: digest("intent"),
        state: "writing",
      })
      yield* failure(projectUpstreamMemberSnapshot(f.snapshot, raw), "PUBLICATION_INCOMPLETE")
      f.noPublishedMap = false
      const ready = yield* projectUpstreamMemberSnapshot(own, f.rawPage())
      expect(ready.snapshot_id).not.toBe(own.snapshot_id)
      expect(ready.source_projection!.unavailable).toEqual([])
    }),
  )
})
