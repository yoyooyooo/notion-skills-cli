import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { fail, property, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { writeSkill } from "../src/mutation.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { fileRef } from "../src/ref.ts"
import { Store } from "../src/store.ts"
import { executeSharedCreate } from "../src/shared-create.ts"
import { applySharedSkillChanges } from "../src/shared-skill-apply-authoring.ts"
import { trashPath } from "../src/local-locks.ts"
import { fixture, library } from "./shared-source-projection-fixture.ts"
import { encode } from "./shared-snapshot-fixture.ts"

test("public body write and apply preserve complete native headers while refusing metadata changes", async () => {
  const path = "references/nested/SKILL.md"
  const header = "---\r\nname: nested-reference\r\nlicense: MIT\r\n---\r\n\r\n"
  const f = fixture([{ path, bytes: encode(header + "# Nested\n"), mode: "100755" }], {
    main: "---\nname: initial-source\ndescription: Initial complete member\nlicense: MIT\n---\n\n# Initial\n\nComplete native main.\n",
  })
  const plan = await f.prepare(true)
  const created = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
  const snapshot = await f.run(
    openSkill(created.skill_page_id, {
      database: library.skills.database_id,
      refresh: true,
      sharedReadOnly: true,
    }),
  )
  const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)!
  const originalMain = new TextDecoder().decode(f.base.objects.get(`objects/${main.sha256}`))
  expect(originalMain).toContain('"license": "MIT"')
  const originalRef = fileRef(snapshot.record.id, snapshot.entrypoint, snapshot.snapshot_id)
  const directory = mkdtempSync(join(tmpdir(), "native-header-authoring-"))
  const input = join(directory, "SKILL.md")
  const authoredMain = originalMain + "\nIntentional main edit.\n"
  writeFileSync(input, authoredMain)
  const patches: string[] = []
  const bodyWriter = <A, E, R>(action: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* action.pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (url, body, options) => {
            const match = /^v1\/pages\/([^/]+)\/markdown$/u.exec(url)
            if (options?.method !== "PATCH" || match === null)
              return api.request(url, body, options)
            return Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const page = match[1]!
              const updates = property(property(body).update_content).content_updates
              const update =
                Array.isArray(updates) && updates.length === 1 ? property(updates[0]) : {}
              if (update.old_str !== f.base.bodies.get(page) || typeof update.new_str !== "string")
                return Effect.fail(
                  fail("FIXTURE_BODY_MISMATCH", "Expected the complete current native body."),
                )
              patches.push(page)
              f.base.bodies.set(page, update.new_str)
              const row = f.skills.get(page) ?? f.files.get(page)
              if (row === undefined)
                return Effect.fail(
                  fail("FIXTURE_PAGE_MISSING", "Expected original native identity."),
                )
              row.last_edited_time = new Date(Date.now() + patches.length).toISOString()
              return Effect.succeed({
                id: page,
                markdown: update.new_str,
                truncated: false,
                unknown_block_ids: [],
              })
            })
          },
        }),
      )
    })
  try {
    const written = await f.run(bodyWriter(writeSkill(originalRef, { input })))
    expect(written.action).toBe("updated")
    expect(patches).toEqual([created.skill_page_id])
    const refreshed = await f.run(
      openSkill(created.skill_page_id, {
        database: library.skills.database_id,
        refresh: true,
        sharedReadOnly: true,
      }),
    )
    const editedMain = refreshed.files.find((file) => file.path === refreshed.entrypoint)!
    const currentMain = new TextDecoder().decode(f.base.objects.get(`objects/${editedMain.sha256}`))
    expect(currentMain).toBe(authoredMain)
    expect(editedMain.mode).toBe(main.mode)
    const support = refreshed.files.find((file) => file.path === path)!
    const oldSupport = new TextDecoder().decode(f.base.objects.get(`objects/${support.sha256}`))
    expect(oldSupport).toBe(header + "# Nested\n")
    const authoredSupport = oldSupport + "\nIntentional supporting edit."
    const applied = await f.run(
      bodyWriter(
        applySharedSkillChanges(refreshed, {
          files: [{ path, bytes: encode(authoredSupport) }],
        }),
      ),
    )
    expect(applied.status).toBe("applied")
    expect(patches).toHaveLength(2)
    const current = await f.run(
      openSkill(created.skill_page_id, {
        database: library.skills.database_id,
        refresh: true,
        sharedReadOnly: true,
      }),
    )
    const updated = current.files.find((file) => file.path === path)!
    expect(updated.mode).toBe("100755")
    expect(new TextDecoder().decode(f.base.objects.get(`objects/${updated.sha256}`))).toBe(
      authoredSupport,
    )
    f.clear()
    const historical = await f.run(readSkill(originalRef))
    expect(property(historical).content).toBe(originalMain)
    expect(f.calls).toHaveLength(0)
    writeFileSync(input, currentMain.replace('"license": "MIT"', '"license": "Apache-2.0"'))
    const rejected = await f.run(
      Effect.flip(
        bodyWriter(
          writeSkill(fileRef(current.record.id, current.entrypoint, current.snapshot_id), {
            input,
          }),
        ),
      ),
    )
    expect(rejected.code).toBe("SHARED_METADATA_CONFLICT")
    const rejectedApply = await f.run(
      Effect.flip(
        bodyWriter(
          applySharedSkillChanges(current, {
            files: [
              { path, bytes: encode(oldSupport.replace("license: MIT", "license: Apache-2.0")) },
            ],
          }),
        ),
      ),
    )
    expect(rejectedApply.code).toBe("SHARED_METADATA_CONFLICT")
    expect(patches).toHaveLength(2)
    expect(f.writes()).toHaveLength(0)
    // A fresh consumer obtains the same exact files without any writer cache.
    f.base.objects.clear()
    f.base.json.clear()
    const cold = await f.run(
      openSkill(created.skill_page_id, {
        database: library.skills.database_id,
        refresh: true,
        sharedReadOnly: true,
      }),
    )
    expect(cold.files).toEqual(current.files)
    const object = await f.run(
      Effect.gen(function* () {
        return yield* (yield* Store).readBytes(`objects/${updated.sha256}`)
      }),
    )
    expect(new TextDecoder().decode(object)).toBe(authoredSupport)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})
