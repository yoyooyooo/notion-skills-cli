/** Owned API fixtures. These observations do not claim a human UI edit or a second physical machine. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { live } from "../../../../packages/cli/src/command-runtime.ts"
import { Notion } from "../../../../packages/core/src/notion.ts"
import { decode, fail, listSchema, property } from "../../../../packages/core/src/model.ts"
import { Schema } from "effect"
import { loadSharedLibrary } from "../../../../packages/core/src/shared-library.ts"
import { observeSharedBody } from "../../../../packages/core/src/shared-page-body.ts"
import { querySkillFiles } from "../../../../packages/core/src/skill-file-index.ts"

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const entry = option("--entry"),
  directory = option("--run")
if (!entry || !directory)
  throw Error("Use --entry LIBRARY_ID --run ABSOLUTE_OWNED_EVIDENCE_DIRECTORY.")
const fileCount = Number(option("--files") ?? "2")
if (!Number.isInteger(fileCount) || fileCount < 2 || fileCount > 300)
  throw Error("--files must be an integer from 2 to 300.")
const run = resolve(directory)
await mkdir(run, { recursive: true, mode: 0o700 })
const statePath = `${run}/fixture.json`
const StateSchema = Schema.Struct({
  entry: Schema.String,
  fixture_id: Schema.String,
  pages: Schema.Record(Schema.String, Schema.String),
  pending: Schema.optional(Schema.String),
})
let state: typeof StateSchema.Type
try {
  state = decode(StateSchema, JSON.parse(await readFile(statePath, "utf8")))
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
    throw error
  state = { entry, fixture_id: randomUUID(), pages: {} }
}
if (state.entry !== entry) throw Error("The run belongs to another exact library entry.")
const save = () => writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
await save()
const rich = (content: string) => ({
  rich_text: content ? [{ type: "text", text: { content } }] : [],
})
const title = (content: string) => ({ title: [{ type: "text", text: { content } }] })
const trace: Array<{
  path: string
  method: string
  started_at: number
  elapsed_ms: number
  response_bytes: number
  outcome: string
}> = []
const editMarker = randomUUID()
const startedAt = performance.now()

const program = Effect.gen(function* () {
  const original = yield* Notion
  const api: Notion["Service"] = {
    ...original,
    request: (path, body, options) =>
      Effect.suspend(() => {
        const started = Date.now(),
          method = options?.method ?? (body === undefined ? "GET" : "POST")
        return original.request(path, body, options).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              trace.push({
                path,
                method,
                started_at: started,
                elapsed_ms: Date.now() - started,
                response_bytes: Buffer.byteLength(JSON.stringify(value)),
                outcome: "success",
              })
            }),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              trace.push({
                path,
                method,
                started_at: started,
                elapsed_ms: Date.now() - started,
                response_bytes: 0,
                outcome: error.code,
              })
            }),
          ),
        )
      }),
  }
  return yield* Effect.gen(function* () {
    const library = yield* loadSharedLibrary(entry)
    const ensurePage = (
      key: string,
      dataSourceId: string,
      identityProperty: string,
      properties: Record<string, unknown>,
      markdown: string,
    ) =>
      Effect.gen(function* () {
        if (state.pages[key]) return state.pages[key]!
        const identity = `${state.fixture_id}:${Buffer.from(key).toString("hex")}`
        const raw = yield* api.request(`v1/data_sources/${dataSourceId}/query`, {
          page_size: 100,
          filter: { property: identityProperty, rich_text: { equals: identity } },
        })
        const found = decode(listSchema(Schema.Unknown), raw)
        if (found.has_more || found.results.length > 1)
          return yield* Effect.fail(fail("FIXTURE_AMBIGUOUS", "Fixture identity is not unique."))
        let page = property(found.results[0])
        if (!found.results.length) {
          if (state.pending === key)
            return yield* Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "An original fixture creation remains unobserved; do not replay it.",
                { fixture_id: state.fixture_id, key },
              ),
            )
          state = { ...state, pending: key }
          yield* Effect.promise(save)
          page = property(
            yield* api.request("v1/pages", {
              parent: { type: "data_source_id", data_source_id: dataSourceId },
              properties: { ...properties, [identityProperty]: rich(identity) },
              markdown,
              markdown_version: "v2",
            }),
          )
        }
        if (typeof page.id !== "string")
          return yield* Effect.fail(
            fail("WRITE_OUTCOME_UNKNOWN", "Fixture creation has no confirmed page identity."),
          )
        state = {
          entry: state.entry,
          fixture_id: state.fixture_id,
          pages: { ...state.pages, [key]: page.id },
        }
        yield* Effect.promise(save)
        return page.id
      })
    const skill = yield* ensurePage(
      "main",
      library.skills.data_source_id,
      library.skills.property_ids["Skill ID"]!,
      {
        [library.skills.property_ids.Name!]: title(`ah498-${state.fixture_id}`),
        [library.skills.property_ids.Description!]: rich("Owned shared-library acceptance fixture"),
        [library.skills.property_ids.Kind!]: { select: { name: "skill" } },
        [library.skills.property_ids.Enabled!]: { checkbox: true },
        [library.skills.property_ids["Main File ID"]!]: rich(`${state.fixture_id}:main-file`),
      },
      "# Shared library fixture\n\nRead the selected file only.\n",
    )
    const paths = [
      "references/one.md",
      "references/two.md",
      ...Array.from(
        { length: fileCount - 2 },
        (_, index) => `references/file-${String(index + 3).padStart(3, "0")}.md`,
      ),
    ]
    for (const path of paths) {
      yield* ensurePage(
        path,
        library.files.data_source_id,
        library.files.property_ids["File ID"]!,
        {
          [library.files.property_ids.Name!]: title(path),
          [library.files.property_ids.Path!]: rich(path),
          [library.files.property_ids.Status!]: { select: { name: "custom" } },
          [library.files.property_ids.Skill!]: { relation: [{ id: skill }] },
        },
        `# ${path}\n\nOriginal fixture instruction.\n`,
      )
    }
    const before = yield* querySkillFiles({
      dataSourceId: library.files.data_source_id,
      skillPageId: skill,
      propertyIds: library.files.property_ids,
    })
    const first = before.find((file) => file.path === "references/one.md")
    if (!first)
      return yield* Effect.fail(
        fail("FIXTURE_MISSING", "Flat file query did not return the owned first file."),
      )
    const bodyBefore = yield* observeSharedBody(first.page_id)
    yield* api.request(
      `v1/pages/${first.page_id}`,
      {
        properties: { [library.files.property_ids.Name!]: title("Renamed fixture display label") },
      },
      { method: "PATCH" },
    )
    const metadataAfter = yield* querySkillFiles({
      dataSourceId: library.files.data_source_id,
      skillPageId: skill,
      propertyIds: library.files.property_ids,
    })
    const bodyAfterMetadata = yield* observeSharedBody(first.page_id)
    if (bodyBefore.fingerprint.sha256 !== bodyAfterMetadata.fingerprint.sha256)
      return yield* Effect.fail(
        fail("FIXTURE_FAILED", "Metadata update changed the observed body."),
      )
    // Only this script's owned fixture is replaced. This is not a production conditional-write protocol.
    yield* api.request(
      `v1/pages/${first.page_id}/markdown`,
      {
        type: "replace_content",
        markdown_version: "v2",
        replace_content: {
          new_str: `# references/one.md\n\nChanged fixture instruction ${editMarker}.\n`,
        },
      },
      { method: "PATCH" },
    )
    const bodyAfterEdit = yield* observeSharedBody(first.page_id)
    const filesAfter = yield* querySkillFiles({
      dataSourceId: library.files.data_source_id,
      skillPageId: skill,
      propertyIds: library.files.property_ids,
    })
    if (bodyBefore.fingerprint.sha256 === bodyAfterEdit.fingerprint.sha256)
      return yield* Effect.fail(fail("FIXTURE_FAILED", "Body mutation was not observable."))
    return {
      evidence_kind: "real_notion_controlled_api_fixture",
      library_entry: entry,
      fixture_id: state.fixture_id,
      skill_page_id: skill,
      files_before: before,
      files_after_metadata: metadataAfter,
      files_after_body: filesAfter,
      body_hashes: {
        before: bodyBefore.fingerprint.sha256,
        metadata: bodyAfterMetadata.fingerprint.sha256,
        edited: bodyAfterEdit.fingerprint.sha256,
      },
      request_metrics: original.requestMetrics?.(),
      metrics_boundary: "ntn_api_invocations_and_json_payload_bytes",
      elapsed_ms: performance.now() - startedAt,
      independent_samples: 1,
      no_human_ui_claim: true,
      no_second_machine_claim: true,
    }
  }).pipe(Effect.provideService(Notion, api))
})
try {
  const result = await Effect.runPromise(program.pipe(Effect.provide(live)))
  await writeFile(
    `${run}/observations-${editMarker}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  )
  await writeFile(`${run}/observations.json`, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  })
  console.log(JSON.stringify({ ok: true, ...result }))
} finally {
  await writeFile(
    `${run}/request-trace-${editMarker}.json`,
    `${JSON.stringify(trace, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  )
  await writeFile(`${run}/request-trace.json`, `${JSON.stringify(trace, null, 2)}\n`, {
    mode: 0o600,
  })
}
