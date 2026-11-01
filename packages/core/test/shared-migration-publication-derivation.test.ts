import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { deriveMigrationPublication } from "../../../scripts/derive-migration-publication.ts"
import { property } from "../src/model.ts"
import {
  SharedMigrationInputSchema,
  type SharedMigrationInput,
} from "../src/shared-migration-plan.ts"
import { Schema } from "effect"
import {
  legacyCommittedPublicationFixture,
  publicationHash,
} from "./shared-migration-legacy-publication-fixture.ts"

test("offline publication derivation preserves the full input and unknown history without approval or namespace promotion", async () => {
  const f = await legacyCommittedPublicationFixture()
  // Keep the entire controlled attempt for diagnosis; no permanent deletion.
  const root = await mkdtemp(join(tmpdir(), "migration-publication-derivation-"))
  const retainedFiles: { path: string; sha256: string }[] = []
  const save = async (name: string, bytes: string | Uint8Array) => {
    const path = join(root, "original", name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: "wx" })
    const retained = { path, sha256: publicationHash(bytes) }
    retainedFiles.push(retained)
    return retained
  }
  const saveJson = (name: string, value: unknown) =>
    save(name, JSON.stringify(value, null, 2) + "\n")
  const sourceDirectory = join(root, "original", "source")
  for (const file of f.proof.authored_export.files)
    await save(`source/${file.path}`, Buffer.from(file.base64, "base64"))
  const authoredRequest = property(JSON.parse(f.proof.authored_export.request.json))
  const authoredReceipt = property(JSON.parse(f.proof.authored_export.receipt.json))
  const argv = authoredRequest.argv
  if (!Array.isArray(argv)) throw new Error("Missing controlled original export request")
  const files = []
  for (const file of f.before_entry.files) {
    const source = f.source_files.find((item) => item.path === file.path)
    const native = f.proof.native_preimages.find((item) => item.path === file.path)
    if (!source || !native) throw new Error("Missing controlled original file")
    const body = await save(`authored/${file.path}`, source.bytes)
    const response = await save(`raw/${native.page_id}.json`, native.response_json)
    files.push({
      ...file,
      body: { ...file.body, retention_ref: body.path },
      raw: {
        ...property(file.raw),
        native_preimage: {
          ...property(property(file.raw).native_preimage),
          retention_ref: response.path,
        },
      },
    })
  }
  const entry = { ...f.before_entry, files }
  const unrelated = {
    ...f.before_entry,
    legacy_id: "unrelated-entry",
    files: [],
    files_complete: false,
    metadata_complete: false,
  }
  const empty = { complete: false, items: [] }
  const original: SharedMigrationInput = {
    version: 1,
    scope: f.snapshot.scope,
    target_library_id: "controlled-library",
    approved_legacy_ids: [],
    backup: { verified: false, reference: "retained:unknown-backup" },
    catalog: {
      coverage: {
        method: "explicit_database",
        exhaustive: false,
        queried_data_sources: [],
        failed_sources: [],
        search_index_limited: false,
      },
      entries: [entry, unrelated],
    },
    preservation: {
      sources: empty,
      views: empty,
      routers: empty,
      pins: empty,
      operations: {
        complete: false,
        items: [
          {
            legacy_id: "old-unknown-operation",
            raw: { phase: "unknown", original_payload: "unchanged" },
            complete: false,
            terminal_verified: false,
            references: [entry.legacy_id],
          },
        ],
      },
    },
  }
  const input = await saveJson("input.json", original)
  const parentRows = []
  for (const [index, row] of f.proof.parent_rows.entries())
    parentRows.push(await save(`parent-${index}.json`, row.json))
  const config = {
    version: 1,
    format: "migration-retained-publication",
    output: join(root, "derived"),
    input,
    legacy_id: entry.legacy_id,
    parent_rows: parentRows,
    snapshot: await save("snapshot.json", f.proof.snapshot.json),
    fixed_source_inspection: await save("fixed-source.json", f.proof.fixed_source_inspection.json),
    source_archive: await save("source.zip", Buffer.from(f.proof.source_archive.base64, "base64")),
    authored_export: {
      directory: sourceDirectory,
      request: await saveJson("export-request.json", {
        ...authoredRequest,
        argv: [...argv.slice(0, -1), sourceDirectory],
      }),
      receipt: await saveJson("export-receipt.json", {
        ...authoredReceipt,
        output: sourceDirectory,
      }),
      completion: await save("export-completion.json", f.proof.authored_export.completion.json),
      inventory: await save("export-inventory.json", f.proof.authored_export.inventory.json),
    },
  }
  const configFile = await saveJson("config.json", config)
  const summary = await deriveMigrationPublication(configFile.path)
  const draft = Schema.decodeUnknownSync(SharedMigrationInputSchema)(
    JSON.parse(await readFile(join(config.output, "draft-input.json"), "utf8")),
    { onExcessProperty: "error" },
  )
  expect(draft.approved_legacy_ids).toEqual([])
  expect(draft.preservation.sources.complete).toBe(false)
  expect(draft.preservation.sources.items.length).toBe(1)
  expect(draft.preservation.operations).toEqual(original.preservation.operations)
  expect(draft.catalog.entries[1]).toEqual(unrelated)
  expect(draft.backup).toEqual(original.backup)
  expect(draft.catalog.coverage).toEqual(original.catalog.coverage)
  expect(draft.catalog.entries[0]?.files.every((file) => file.ownership === "following")).toBe(true)
  expect(summary).toMatchObject({
    current_terminal_verified: false,
    migration_executed: false,
    remote_requests: 0,
    approved_legacy_ids: [],
  })
  for (const file of summary.native_files)
    expect(publicationHash(await readFile(file.retention_ref))).toBe(file.sha256)
  for (const file of retainedFiles)
    expect(publicationHash(await readFile(file.path))).toBe(file.sha256)
  await expect(deriveMigrationPublication(configFile.path)).rejects.toThrow("Output exists")
})
