/** Isolated platform probe. Never accepts an arbitrary production page. */
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { live } from "../../../../packages/cli/src/command-runtime.ts"
import { Notion } from "../../../../packages/core/src/notion.ts"
import { decode, fail, property, text } from "../../../../packages/core/src/model.ts"
import { loadSharedLibrary } from "../../../../packages/core/src/shared-library.ts"
import { observeSharedBody } from "../../../../packages/core/src/shared-page-body.ts"

const runArgument = process.argv[process.argv.indexOf("--run") + 1]
if (!process.argv.includes("--run") || !runArgument)
  throw Error("Use --run an existing owned shared-library-probe directory.")
const run = resolve(runArgument)
const fixture = decode(
  Schema.Struct({
    entry: Schema.String,
    fixture_id: Schema.String,
    pages: Schema.Record(Schema.String, Schema.String),
  }),
  JSON.parse(await readFile(`${run}/fixture.json`, "utf8")),
)
const page = fixture.pages["references/two.md"]
if (!page) throw Error("The owned second file has not been created.")
const evidence = await Effect.runPromise(
  Effect.gen(function* () {
    const api = yield* Notion
    const library = yield* loadSharedLibrary(fixture.entry)
    const row = property(yield* api.request(`v1/pages/${page}`))
    const identity = Object.values(property(row.properties))
      .map(property)
      .find((field) => field.id === library.files.property_ids["File ID"])
    if (
      row.id !== page ||
      row.in_trash === true ||
      property(row.parent).data_source_id !== library.files.data_source_id ||
      text(identity?.rich_text) !==
        `${fixture.fixture_id}:${Buffer.from("references/two.md").toString("hex")}`
    )
      return yield* Effect.fail(
        fail("FIXTURE_SCOPE", "Only the existing exact owned fixture may be probed."),
      )
    const before = yield* observeSharedBody(page)
    yield* Effect.promise(() =>
      writeFile(`${run}/freeze-before.json`, `${JSON.stringify(before, null, 2)}\n`, {
        mode: 0o600,
      }),
    )
    const result = yield* Effect.gen(function* () {
      yield* api.request(`v1/pages/${page}`, { in_trash: true }, { method: "PATCH" })
      const archived = property(yield* api.request(`v1/pages/${page}`))
      if (archived.in_trash !== true)
        return yield* Effect.fail(fail("FIXTURE_FAILED", "Archival was not observed."))
      const attempted = yield* api
        .request(
          `v1/pages/${page}/markdown`,
          {
            type: "replace_content",
            markdown_version: "v2",
            replace_content: {
              new_str: `# Owned archive probe\n\nChanged while archived ${randomUUID()}.\n`,
            },
          },
          { method: "PATCH" },
        )
        .pipe(Effect.result)
      return attempted._tag === "Success"
        ? { outcome: "accepted" as const }
        : {
            outcome: "rejected_or_unknown" as const,
            code: attempted.failure.code,
            details: attempted.failure.details,
          }
    }).pipe(
      Effect.ensuring(
        api
          .request(`v1/pages/${page}`, { in_trash: false }, { method: "PATCH" })
          .pipe(Effect.orDie),
      ),
    )
    const after = yield* observeSharedBody(page)
    return {
      evidence_kind: "real_notion_controlled_archive_probe",
      page_id: page,
      fixture_id: fixture.fixture_id,
      archive_write: result,
      before_sha256: before.fingerprint.sha256,
      after_sha256: after.fingerprint.sha256,
      restored_to_active: true,
      does_not_prove_inflight_edit_ordering: true,
      no_human_ui_claim: true,
      request_metrics: api.requestMetrics?.(),
    }
  }).pipe(Effect.provide(live)),
)
await writeFile(`${run}/freeze-observations.json`, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
})
console.log(JSON.stringify(evidence))
