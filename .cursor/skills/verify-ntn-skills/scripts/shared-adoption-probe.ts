/** Real owned API fixture; this does not substitute for a human UI or physical-machine test. */
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { live } from "../../../../packages/cli/src/command-runtime.ts"
import { Notion } from "../../../../packages/core/src/notion.ts"
import { decode, fail } from "../../../../packages/core/src/model.ts"
import { loadSharedLibrary } from "../../../../packages/core/src/shared-library.ts"
import { querySharedSkillIndex } from "../../../../packages/core/src/shared-skill-index.ts"
import { observeSharedBody } from "../../../../packages/core/src/shared-page-body.ts"
import {
  observeSharedFile,
  loadRetainedBody,
} from "../../../../packages/core/src/shared-file-observer.ts"
import {
  querySharedRecords,
  appendSharedRecord,
} from "../../../../packages/core/src/shared-records.ts"
import {
  FileEventSchema,
  resolveFileState,
} from "../../../../packages/core/src/shared-file-state.ts"
import { sha256 } from "../../../../packages/core/src/store.ts"

const at = process.argv.indexOf("--run"),
  argument = process.argv[at + 1]
if (at < 0 || !argument) throw Error("Use --run an existing owned shared-library-probe directory.")
const run = resolve(argument)
const fixture = decode(
  Schema.Struct({
    entry: Schema.String,
    fixture_id: Schema.String,
    pages: Schema.Record(Schema.String, Schema.String),
  }),
  JSON.parse(await readFile(`${run}/fixture.json`, "utf8")),
)
const skillPage = fixture.pages.main
if (!skillPage) throw Error("The owned Skill fixture is missing.")
// This journal is exclusive: a restarted probe must inspect the original remote effects.
await writeFile(
  `${run}/adoption-started.json`,
  `${JSON.stringify({ fixture_id: fixture.fixture_id, started_at: new Date().toISOString() })}\n`,
  { flag: "wx", mode: 0o600 },
)

const first = await Effect.runPromise(
  Effect.gen(function* () {
    const api = yield* Notion
    const library = yield* loadSharedLibrary(fixture.entry)
    const index = yield* querySharedSkillIndex(library, skillPage)
    if (!index.skill_id.startsWith(`${fixture.fixture_id}:`))
      return yield* Effect.fail(
        fail("FIXTURE_SCOPE", "The selected Skill is not owned by this probe."),
      )
    const selected = index.files.find((file) => file.path === "references/one.md")
    const untouched = index.files.find((file) => file.path === "references/two.md")
    if (!selected || !untouched)
      return yield* Effect.fail(fail("FIXTURE_SCOPE", "The owned support files are missing."))
    const all = yield* querySharedRecords(library, { skillPageId: skillPage, kind: "file_event" })
    const events = all.map((record) => decode(FileEventSchema, record.payload))
    for (const file of [selected, untouched]) {
      if (events.some((event) => event.file_id === file.file_id))
        return yield* Effect.fail(
          fail(
            "FIXTURE_ALREADY_INITIALIZED",
            "Use a new owned fixture to replay first adoption; do not overwrite prior facts.",
          ),
        )
      const body = yield* observeSharedBody(file.page_id)
      const event = {
        kind: "projected" as const,
        event_id: `projection-${yield* sha256(file.file_id)}`,
        file_id: file.file_id,
        parents: [],
        source_revision: "fixture-source-v1",
        projection: body.fingerprint,
      }
      yield* appendSharedRecord(library, {
        mode: "create",
        recordId: event.event_id,
        operationId: event.event_id,
        skillPageId: skillPage,
        kind: "file_event",
        entityId: file.file_id,
        payload: event,
      })
      events.push(event)
    }
    const original = yield* observeSharedBody(selected.page_id)
    const unchanged = yield* observeSharedBody(untouched.page_id)
    const replacement = `# Shared adoption fixture\n\nUser instruction ${randomUUID()}.\n`
    yield* Effect.promise(() =>
      writeFile(
        `${run}/adoption-input.json`,
        `${JSON.stringify({ selected, untouched, original_markdown: original.markdown, replacement }, null, 2)}\n`,
        { mode: 0o600 },
      ),
    )
    yield* api.request(
      `v1/pages/${selected.page_id}/markdown`,
      {
        type: "replace_content",
        markdown_version: "v2",
        replace_content: { new_str: replacement },
      },
      { method: "PATCH" },
    )
    const adopted = yield* observeSharedFile({
      library,
      skillPageId: skillPage,
      fileId: selected.file_id,
      pageId: selected.page_id,
      events: events.filter((event) => event.file_id === selected.file_id),
    })
    if (!adopted.changed || adopted.state.ownership.kind !== "custom")
      return yield* Effect.fail(
        fail("FIXTURE_FAILED", "A changed following body was not persisted as custom."),
      )
    const pinned = adopted.state.ownership.content
    yield* api.request(
      `v1/pages/${selected.page_id}/markdown`,
      {
        type: "replace_content",
        markdown_version: "v2",
        replace_content: { new_str: original.markdown },
      },
      { method: "PATCH" },
    )
    const returned = yield* observeSharedFile({
      library,
      skillPageId: skillPage,
      fileId: selected.file_id,
      pageId: selected.page_id,
      events: [...events.filter((event) => event.file_id === selected.file_id), adopted.event],
    })
    if (returned.state.ownership.kind !== "custom")
      return yield* Effect.fail(
        fail(
          "FIXTURE_FAILED",
          "Returning the body to upstream text released persistent ownership.",
        ),
      )
    const other = yield* observeSharedFile({
      library,
      skillPageId: skillPage,
      fileId: untouched.file_id,
      pageId: untouched.page_id,
      events: events.filter((event) => event.file_id === untouched.file_id),
    })
    if (
      other.changed ||
      other.state.ownership.kind !== "following" ||
      other.body.fingerprint.sha256 !== unchanged.fingerprint.sha256
    )
      return yield* Effect.fail(
        fail("FIXTURE_FAILED", "The untouched file stopped following or changed bytes."),
      )
    return {
      selected,
      untouched,
      pinned,
      adopted_state: adopted.state,
      returned_state: returned.state,
      untouched_state: other.state,
      first_client_metrics: api.requestMetrics?.(),
    }
  }).pipe(Effect.provide(live)),
)

// A new service runtime reconstructs state and history solely from shared Notion facts.
const second = await Effect.runPromise(
  Effect.gen(function* () {
    const api = yield* Notion
    const library = yield* loadSharedLibrary(fixture.entry)
    const facts = yield* querySharedRecords(library, { skillPageId: skillPage, kind: "file_event" })
    const events = facts.map((record) => decode(FileEventSchema, record.payload))
    const state = resolveFileState(
      first.selected.file_id,
      events.filter((event) => event.file_id === first.selected.file_id),
    )
    const history = yield* loadRetainedBody(library, skillPage, first.pinned)
    if (state.ownership.kind !== "custom" || history.fingerprint.sha256 !== first.pinned.sha256)
      return yield* Effect.fail(
        fail(
          "FIXTURE_FAILED",
          "A fresh client failed to recover ownership or exact retained content.",
        ),
      )
    return {
      reconstructed_state: state,
      history_sha256: history.fingerprint.sha256,
      second_client_metrics: api.requestMetrics?.(),
    }
  }).pipe(Effect.provide(live)),
)
const result = {
  evidence_kind: "real_notion_controlled_adoption",
  fixture_id: fixture.fixture_id,
  skill_page_id: skillPage,
  ...first,
  ...second,
  source_binding: "fixture-only-no-git-proof",
  no_human_ui_claim: true,
  no_second_physical_machine_claim: true,
}
await writeFile(`${run}/adoption-observations.json`, `${JSON.stringify(result, null, 2)}\n`, {
  mode: 0o600,
})
console.log(JSON.stringify(result))
