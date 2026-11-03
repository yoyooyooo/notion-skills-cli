import { expect, test } from "vitest"
import { ConfigProvider, Effect } from "effect"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { exportSkill } from "../src/export.ts"
import { readImportZip } from "../src/import.ts"
import { property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { loadRetainedBody } from "../src/shared-file-observer.ts"
import { readSkill } from "../src/snapshot.ts"
import { Store, StoreLive } from "../src/store.ts"
import {
  digest,
  encode,
  id,
  library,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

const owner = "shared_skill:library-snapshot:stable-skill"
const aliasId = id(700)
const paragraphId = id(701)
const nativeUrl = (page: string) => "https://app.notion.com/p/" + page.replaceAll("-", "")
const aliasHref = nativeUrl(skillPage) + "#" + aliasId.replaceAll("-", "")
const raw = `# Native forms

[Ordinary](${nativeUrl(id(11))})

<p>
<mention url="${nativeUrl(id(11))}" />
</p>

<unknown url="${aliasHref}" alt="alias" />`

async function fixture() {
  const root = await mkdtemp(join(process.env.NTN_ALIAS_EVIDENCE ?? tmpdir(), "ntn-native-alias-"))
  const f = sharedSnapshotFixture()
  f.bodies.set(skillPage, raw)
  let target = id(11)
  let aliasType = "link_to_page"
  const blockCalls: string[] = []
  const program = Effect.gen(function* () {
    const api = yield* Notion
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
    return native
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

test("public Node read/export with real SQLite completes native forms, retains raw proof and preserves historical pins", async () => {
  const x = await fixture()
  const result = await x.f.run(
    Effect.gen(function* () {
      const api = yield* x.program
      return yield* Effect.gen(function* () {
        const store = yield* Store
        const first = yield* readSkill(skillPage, {
          database: library.skills.database_id,
          refresh: true,
        })
        expect("content" in first && first.content).toContain("[Link to page](references/1.md)")
        expect("content" in first && first.content).toContain("[Ordinary](references/1.md)")
        const alias = first.native_references?.entries.find((entry) => entry.block_id === aliasId)
        expect(alias).toMatchObject({
          source_form: "link_to_page",
          href: aliasHref,
          file_id: "file-1",
          page_id: id(11),
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

        const retained = [...x.f.records.values()].find((record) => {
          const envelope = JSON.parse(
            text(
              property(record.properties).payload &&
                property(property(record.properties).payload).rich_text,
            ),
          )
          return property(envelope.payload).kind === "native_completed_markdown"
        })
        expect(retained).toBeDefined()
        const retainedId = text(property(property(retained!.properties).record).rich_text)
        const content = {
          object_id: retainedId,
          sha256: digest(raw),
          bytes: encode(raw).byteLength,
        }
        const restoredRaw = yield* loadRetainedBody(library, skillPage, content)
        expect(restoredRaw.markdown).toBe(raw)
        expect(
          restoredRaw.native_body_completion?.inventory.find((block) => block.id === aliasId)
            ?.target_page_id,
        ).toBe(id(11))

        const firstPin = fileRef(owner, "SKILL.md", first.snapshot_id)
        const exported = yield* exportSkill(firstPin, {
          output: join(x.root, "first.zip"),
          format: "zip",
          projection: "snapshot",
          offline: true,
        })
        expect(exported.native_references).toEqual(first.native_references)
        x.f.clearCalls()
        x.blockCalls.length = 0
        const cached = yield* readSkill(skillPage, { database: library.skills.database_id })
        expect(cached.snapshot_id).toBe(first.snapshot_id)
        expect(x.f.readBodyCount()).toBe(0)
        expect(x.blockCalls).toHaveLength(0)

        x.setTarget(id(12))
        x.f.main.last_edited_time = new Date(Date.now() - 100).toISOString()
        const current = yield* readSkill(skillPage, {
          database: library.skills.database_id,
          refresh: true,
        })
        expect(current.snapshot_id).not.toBe(first.snapshot_id)
        expect(
          current.native_references?.entries.find((entry) => entry.block_id === aliasId)?.file_id,
        ).toBe("file-2")
        expect(
          current.native_references?.source_files.find((file) => file.path === "SKILL.md")
            ?.body_sha256,
        ).toBe(digest(raw))
        expect("content" in current && current.content).toContain("[Link to page](references/2.md)")
        x.f.clearCalls()
        x.blockCalls.length = 0
        const old = yield* readSkill(firstPin, { offline: true })
        expect(old.native_references).toEqual(first.native_references)
        expect("content" in old && old.content).toBe("content" in first && first.content)
        expect(x.f.calls).toHaveLength(0)
        expect(x.blockCalls).toHaveLength(0)
        return { first, current, old, exported, retained_id: retainedId }
      }).pipe(Effect.provideService(Notion, api))
    }).pipe(Effect.provide(StoreLive), Effect.provide(x.config)),
  )
  const archive = new Uint8Array(await readFile(join(x.root, "first.zip")))
  const main = readImportZip(archive).find((file) => file.path.endsWith("SKILL.md"))
  expect(main && new TextDecoder().decode(main.bytes)).toContain("[Link to page](references/1.md)")
  expect((await readdir(join(x.root, "state"))).some((entry) => entry.includes(".sqlite"))).toBe(
    true,
  )
  await writeFile(join(x.root, "public-receipts.json"), JSON.stringify(result, null, 2))
})

test("public Node/SQLite read rejects an unknown non-page alias before any observation record or snapshot write", async () => {
  const x = await fixture()
  x.setAliasType("bookmark")
  const result = await x.f.run(
    Effect.gen(function* () {
      const api = yield* x.program
      const result = yield* Effect.result(
        readSkill(skillPage, { database: library.skills.database_id, refresh: true }).pipe(
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
  expect(x.f.writeCount()).toBe(0)
  expect(x.f.records.size).toBe(0)
})
