import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect } from "effect"
import {
  enrichLegacyPageFacts,
  enrichPilotDraft,
} from "../../../scripts/enrich-migration-pilot-facts.ts"
import { aliasFor, property } from "../src/model.ts"
import type { SharedMigrationEntry } from "../src/shared-migration-plan.ts"
import { migrationConversionFixture } from "./shared-migration-conversion-fixture.ts"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
function factsFixture(number = 1) {
  const source = migrationConversionFixture()
  const { enabled: _enabled, ...before } = property(source.entry.record)
  const page = uuid(number * 10),
    supportingPage = uuid(number * 10 + 1),
    database = uuid(900),
    dataSource = uuid(901)
  const name = `Retained example ${number}`
  const record = {
    ...before,
    id: `notion_page:${page}`,
    alias: aliasFor(name),
    name,
    description: String(before.description),
    locator: {
      type: "notion_page",
      page_id: page,
      database_id: database,
      data_source_id: dataSource,
    },
    ref: `skill://${page}/SKILL.md`,
  }
  const url = `https://www.notion.so/${supportingPage.replaceAll("-", "")}`
  const row = {
    object: "page",
    id: page,
    is_archived: false,
    in_trash: false,
    parent: { type: "data_source_id", database_id: database, data_source_id: dataSource },
    properties: {
      "Skill name": { id: "title", type: "title", title: [{ plain_text: name }] },
      Description: {
        id: "description",
        type: "rich_text",
        rich_text: [{ plain_text: record.description }],
      },
      Kind: { id: "kind", type: "select", select: { name: "skill" } },
      "Default Context": { id: "default", type: "checkbox", checkbox: false },
      "Sync Mode": { id: "sync", type: "select", select: { name: "tracked" } },
      References: {
        id: "references",
        type: "rich_text",
        rich_text: [
          {
            type: "text",
            plain_text: "notes.md",
            href: url,
            text: { content: "notes.md", link: { url } },
          },
        ],
      },
    },
  }
  const schema = {
    object: "data_source",
    id: dataSource,
    in_trash: false,
    parent: { type: "database_id", database_id: database },
    properties: Object.fromEntries(
      Object.entries(row.properties).map(([name, field]) => [
        name,
        { name, id: field.id, type: field.type },
      ]),
    ),
  }
  const entry: SharedMigrationEntry = {
    ...source.entry,
    legacy_id: record.id,
    record,
    legacy_mode: "unknown",
    legacy_layout: "unknown",
    files_complete: false,
    metadata_complete: true,
    files: source.entry.files.map((file, index) => ({
      ...file,
      ownership: "unknown",
      raw: {
        ...property(file.raw),
        native_preimage: {
          ...property(property(file.raw).native_preimage),
          page_id: index === 0 ? page : supportingPage,
        },
        pilot_current_capture: { page_id: index === 0 ? page : supportingPage },
      },
    })),
  }
  const retain = (value: unknown) => {
    const bytes = json(value)
    return {
      json: bytes,
      sha256: hash(bytes),
      bytes: Buffer.byteLength(bytes),
      retention_ref: "retained:controlled",
    }
  }
  const activity = {
    version: 2 as const,
    policy: "legacy_catalog_active_page_v2" as const,
    api_version: "2026-03-11" as const,
    catalog_row: retain(row),
    data_source_schema: retain(schema),
  }
  return { source, row, schema, entry, activity, retain }
}

test("factual mapping proves only tracked/reference-page layout and preserves original unknown ownership and flags", async () => {
  const f = factsFixture(),
    before = structuredClone(f.entry)
  const result = await run(
    enrichLegacyPageFacts(f.entry, f.activity, { original_query: "retained:query" }),
  )
  expect(result.entry.legacy_mode).toBe("tracked")
  expect(result.entry.legacy_layout).toBe("ordinary_page")
  expect(result.activation).toMatchObject({
    policy: "legacy_catalog_active_page_v2",
    original_enabled: "absent",
    api_version: "2026-03-11",
  })
  expect(result.entry.files).toEqual(f.entry.files)
  expect(result.entry.record).toEqual(f.entry.record)
  expect(result.entry.files_complete).toBe(false)
  expect(result.entry.metadata_complete).toBe(true)
  expect(result.entry.files.map((file) => file.ownership)).toEqual(["unknown", "unknown"])
  expect(f.entry).toEqual(before)
})

test("a conflicting known mode, wrong reference page or missing native file mapping cannot inherit ordinary-page facts", async () => {
  const f = factsFixture()
  await expect(
    run(enrichLegacyPageFacts({ ...f.entry, legacy_mode: "fork" }, f.activity, {})),
  ).rejects.toThrow("conflicting known legacy mode")
  const wrongUrl = "https://www.notion.so/" + uuid(777).replaceAll("-", "")
  const changedRow = {
    ...f.row,
    properties: {
      ...f.row.properties,
      References: {
        ...f.row.properties.References,
        rich_text: [
          {
            type: "text",
            plain_text: "notes.md",
            href: wrongUrl,
            text: { content: "notes.md", link: { url: wrongUrl } },
          },
        ],
      },
    },
  }
  await expect(
    run(enrichLegacyPageFacts(f.entry, { ...f.activity, catalog_row: f.retain(changedRow) }, {})),
  ).rejects.toThrow("retained native preimages")
  const main = f.entry.files[0]
  if (!main) throw new Error("Missing controlled main")
  await expect(
    run(enrichLegacyPageFacts({ ...f.entry, files: [main] }, f.activity, {})),
  ).rejects.toThrow("supporting path set")
})

test("full offline enrichment retains all input, receipts, unselected Router and approvals while checking original row byte slices", async () => {
  // Retain the temporary evidence; no permanent cleanup of fixtures or failures.
  const root = await mkdtemp(join(tmpdir(), "ntn-migration-facts-test-"))
  const first = factsFixture(1),
    second = factsFixture(2),
    fixtures = [first, second]
  const save = async (name: string, value: unknown, raw = false) => {
    const bytes = raw ? String(value) : json(value),
      path = join(root, name)
    await writeFile(path, bytes, { flag: "wx" })
    return { path, sha256: hash(bytes) }
  }
  const schema = await save("schema.raw.json", first.schema)
  const schema_request = await save("schema-request.json", {
    argv: [
      "ntn",
      "api",
      `v1/data_sources/${first.schema.id}`,
      "--notion-version",
      "2026-03-11",
      "-X",
      "GET",
    ],
  })
  const schema_completion = await save("schema-completion.json", {
    exit_code: 0,
    requests: 1,
    notion_writes: 0,
    response_sha256: schema.sha256,
    response_bytes: Buffer.byteLength(json(first.schema)),
  })
  const origins: unknown[] = [],
    selections: unknown[] = []
  for (const [index, f] of fixtures.entries()) {
    const label = index === 0 ? "first" : "second",
      rowRaw = json(f.row)
    const row = await save(label + ".row.json", rowRaw, true)
    const queryRaw = '{"results":[' + rowRaw + '],"has_more":false,"next_cursor":null}\n'
    const query = await save(label + ".query.json", queryRaw, true)
    const query_request = await save(label + ".query.request.json", { page_size: 100 })
    const query_receipt = await save(label + ".query.receipt.json", {
      argv: [
        "ntn",
        "api",
        `v1/data_sources/${first.schema.id}/query`,
        "--method",
        "POST",
        "--notion-version",
        "2026-03-11",
        "--data",
        "@" + query_request.path,
      ],
      exit: 0,
      response_sha256: query.sha256,
    })
    origins.push({
      name: label,
      retained_row: row.path,
      row_sha256: row.sha256,
      row_bytes: Buffer.byteLength(rowRaw),
      query: query.path,
      query_sha256: query.sha256,
      array_index: 0,
      byte_start: Buffer.byteLength('{"results":['),
      byte_end: Buffer.byteLength('{"results":[' + rowRaw),
      page_id: f.row.id,
      representation: "exact extracted original query row, not a new page GET",
    })
    selections.push({ label, legacy_id: f.entry.legacy_id, row, query_request, query_receipt })
  }
  const row_origins = await save("row-origins.json", origins)
  const untouched = {
    legacy_id: "untouched-router",
    record: { kind: "router" },
    metadata_complete: false,
    files_complete: false,
    files: [],
    legacy_mode: "unknown",
    legacy_layout: "unknown",
  }
  const full = {
    ...first.source.migrationInput,
    approved_legacy_ids: [],
    catalog: {
      ...first.source.migrationInput.catalog,
      entries: [first.entry, untouched, second.entry],
    },
    preservation: {
      ...first.source.migrationInput.preservation,
      operations: {
        complete: false,
        items: [
          {
            legacy_id: "unknown-op",
            raw: { original: true },
            complete: false,
            terminal_verified: false,
            references: [],
          },
        ],
      },
    },
  }
  const original_input = await save("original-input.json", full),
    assembled_input = await save("assembled-input.json", full)
  const output = join(root, "enriched")
  const config = {
    version: 1,
    format: "migration-pilot-factual-enrichment",
    output,
    original_input,
    assembled_input,
    original_metadata_root: root,
    row_origins,
    schema,
    schema_request,
    schema_completion,
    entries: selections,
  }
  const configFile = await save("config.json", config)
  const summary = await enrichPilotDraft(configFile.path)
  expect(summary.changed_entries).toHaveLength(2)
  const result = property(JSON.parse(await readFile(join(output, "draft-input.json"), "utf8")))
  expect(result.approved_legacy_ids).toEqual([])
  expect(result.preservation).toEqual(full.preservation)
  const entries = property(result.catalog).entries
  if (!Array.isArray(entries)) throw new Error("Missing full output entries")
  expect(entries).toHaveLength(3)
  expect(entries[1]).toEqual(untouched)
  expect(hash(await readFile(original_input.path))).toBe(original_input.sha256)
  expect(hash(await readFile(assembled_input.path))).toBe(assembled_input.sha256)
  const wrong = await save("wrong.request.json", { page_size: 100, filter_properties: ["title"] })
  const firstSelection = property(selections[0])
  const badConfig = await save("bad-config.json", {
    ...config,
    output: join(root, "rejected"),
    entries: [{ ...firstSelection, query_request: wrong }, selections[1]],
  })
  await expect(enrichPilotDraft(badConfig.path)).rejects.toThrow("unfiltered full-row query")
  await expect(stat(join(root, "rejected"))).rejects.toThrow()
})
