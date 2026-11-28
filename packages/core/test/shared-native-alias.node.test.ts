import { afterAll, expect, test } from "vitest"
import { ConfigProvider, Crypto, Effect } from "effect"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { exportSkill } from "../src/export.ts"
import { withNotionChangeEvidence } from "../src/current-evidence.ts"
import { trashPath } from "../src/local-locks.ts"
import { readImportZip } from "../src/import.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { readSkill } from "../src/snapshot.ts"
import { Store, StoreLive } from "../src/store.ts"
import {
  currentDigest as digest,
  currentBytes as encode,
  currentId as id,
  currentLibrary as library,
  currentSnapshotFixture,
  currentSkillPage as skillPage,
} from "./shared-current-fixture.ts"

const owner = "skill://demo?library=00000000-0000-4000-8000-000000000002"
const roots: string[] = []
afterAll(async () => {
  if (process.platform === "darwin")
    for (const root of roots) await Effect.runPromise(trashPath(root))
})
const aliasId = id(700)
const paragraphId = id(701)
const nativeUrl = (page: string) => "https://app.notion.com/p/" + page.replaceAll("-", "")
const aliasHref = nativeUrl(skillPage) + "#" + aliasId.replaceAll("-", "")
const raw = `# Native forms

<code>😀</code>

[Ordinary](${nativeUrl(id(100))})

<p>
<mention url="${nativeUrl(id(100))}" />
</p>

<unknown url="${aliasHref}" alt="alias" />`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ntn-native-alias-"))
  roots.push(root)
  const f = currentSnapshotFixture()
  f.bodies.set(skillPage, raw)
  let target = id(100)
  let aliasType = "link_to_page"
  const blockCalls: string[] = []
  const program = Effect.gen(function* () {
    const api = yield* Notion
    const store = yield* Store
    const crypto = yield* Crypto.Crypto
    const credential = yield* api.credentialIdentity
    const native: Notion["Service"] = {
      ...api,
      request: (path, body, options) => {
        if (path === `v1/blocks/${skillPage}/children?page_size=100`) {
          blockCalls.push(path)
          return Effect.succeed({
            object: "list",
            results: [
              {
                object: "block",
                id: paragraphId,
                type: "paragraph",
                has_children: false,
                parent: { type: "page_id", page_id: skillPage },
              },
              {
                object: "block",
                id: aliasId,
                type: aliasType,
                has_children: false,
                parent: { type: "page_id", page_id: skillPage },
                link_to_page: { type: "page_id", page_id: target },
              },
            ],
            has_more: false,
            next_cursor: null,
          })
        }
        return api
          .request(path, body, options)
          .pipe(
            Effect.map((response) =>
              path === `v1/pages/${skillPage}/markdown?markdown_version=v2`
                ? { ...property(response), truncated: true, unknown_block_ids: [aliasId] }
                : response,
            ),
          )
      },
    }
    // Alias rewriting still passes through production evidence capture for the real Store.
    const observed: Notion["Service"] = {
      ...native,
      request: (path, body, options) =>
        withNotionChangeEvidence(
          credential,
          api.apiOrigin ?? "https://api.notion.com",
          path,
          native.request(path, body, options),
        ).pipe(Effect.provideService(Store, store), Effect.provideService(Crypto.Crypto, crypto)),
    }
    return observed
  })
  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      NTN_SKILLS_HOME: join(root, "state"),
      NTN_SKILLS_CONFIG_HOME: join(root, "config"),
      NTN_SKILLS_CACHE_HOME: join(root, "cache"),
    }),
  )
  return {
    f,
    root,
    blockCalls,
    program,
    config,
    setTarget: (value: string) => {
      target = value
    },
    setAliasType: (value: string) => {
      aliasType = value
    },
  }
}

test("public Node read/export with real SQLite completes current native forms and retains a selected local artifact", async () => {
  const x = await fixture()
  await x.f.run(
    Effect.gen(function* () {
      const api = yield* x.program
      return yield* Effect.gen(function* () {
        const store = yield* Store
        const first = yield* readSkill(skillPage, {
          library: library.library_id,
          refresh: true,
        })
        if (!("content" in first)) throw new Error("Expected the selected current main text")
        expect(first.content).toContain("<code>😀</code>\n\n[Ordinary](references/0.md)")
        expect(first.content).toContain("<p>\n[Notion page](references/0.md)\n</p>")
        expect(first.content.endsWith("\n\n[Link to page](references/0.md)")).toBe(true)
        const alias = first.native_references?.entries.find((entry) => entry.block_id === aliasId)
        expect(alias).toMatchObject({
          source_form: "link_to_page",
          href: aliasHref,
          file_id: "support-0",
          page_id: id(100),
        })
        expect(first.native_references?.parser_version).toBe(2)
        expect(
          first.native_references?.source_files.find((file) => file.path === "SKILL.md"),
        ).toMatchObject({
          body_sha256: digest(raw),
          input_sha256: digest(raw),
        })
        expect(
          first.native_references?.source_files.find((file) => file.path === "SKILL.md")
            ?.completion_sha256,
        ).toMatch(/^[a-f0-9]{64}$/u)
        expect(new Uint8Array(yield* store.readBytes("objects/" + digest(raw)))).toEqual(
          encode(raw),
        )
        expect(x.blockCalls).toHaveLength(1)

        expect(x.f.records.size).toBe(0)
        expect(x.f.semanticWrites()).toHaveLength(0)

        const firstPin = fileRef(owner, "SKILL.md", first.snapshot_id)
        const exported = yield* exportSkill(firstPin, {
          output: join(x.root, "first.zip"),
          format: "zip",
          offline: true,
        })
        expect(exported.native_references).toEqual(first.native_references)
        x.f.clearCalls()
        x.blockCalls.length = 0
        const cached = yield* readSkill(skillPage, { library: library.library_id })
        expect(cached.snapshot_id).toBe(first.snapshot_id)
        expect(x.f.bodyCalls()).toHaveLength(0)
        expect(x.blockCalls).toHaveLength(0)

        x.setTarget(id(101))
        x.f.main.last_edited_time = new Date(Date.now() - 100).toISOString()
        const current = yield* readSkill(skillPage, {
          library: library.library_id,
          refresh: true,
        })
        expect(current.snapshot_id).not.toBe(first.snapshot_id)
        expect(
          current.native_references?.entries.find((entry) => entry.block_id === aliasId)?.file_id,
        ).toBe("support-1")
        expect(
          current.native_references?.source_files.find((file) => file.path === "SKILL.md")
            ?.body_sha256,
        ).toBe(digest(raw))
        expect("content" in current && current.content).toContain("[Link to page](references/1.md)")
        expect(x.f.semanticWrites()).toHaveLength(0)
        x.f.clearCalls()
        x.blockCalls.length = 0
        const old = yield* readSkill(firstPin, { offline: true })
        expect(old.native_references).toEqual(first.native_references)
        expect("content" in old && old.content).toBe("content" in first && first.content)
        expect(x.f.calls).toHaveLength(0)
        expect(x.blockCalls).toHaveLength(0)
        expect(x.f.records.size).toBe(0)
      }).pipe(Effect.provideService(Notion, api))
    }).pipe(Effect.provide(StoreLive), Effect.provide(x.config)),
  )
  const archive = new Uint8Array(await readFile(join(x.root, "first.zip")))
  const main = readImportZip(archive).find((file) => file.path.endsWith("SKILL.md"))
  expect(main && new TextDecoder().decode(main.bytes)).toContain("[Link to page](references/0.md)")
  expect((await readdir(join(x.root, "state"))).some((entry) => entry.includes(".sqlite"))).toBe(
    true,
  )
})

test("public Node/SQLite read rejects an unknown non-page alias before publishing a local snapshot", async () => {
  const x = await fixture()
  x.setAliasType("bookmark")
  const result = await x.f.run(
    Effect.gen(function* () {
      const api = yield* x.program
      const result = yield* Effect.result(
        readSkill(skillPage, { library: library.library_id, refresh: true }).pipe(
          Effect.provideService(Notion, api),
        ),
      )
      const store = yield* Store
      expect(yield* store.listKeys("snapshots/")).toEqual([])
      return result
    }).pipe(Effect.provide(StoreLive), Effect.provide(x.config)),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("BODY_INCOMPLETE")
  expect(x.f.semanticWrites()).toHaveLength(0)
  expect(x.f.records.size).toBe(0)
})
