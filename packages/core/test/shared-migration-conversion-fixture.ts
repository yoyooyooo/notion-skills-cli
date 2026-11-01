import { createHash } from "node:crypto"
import type { SharedMigrationInput } from "../src/shared-migration-plan.ts"
import type {
  MigrationConversionInput,
  MigrationNativePreimage,
} from "../src/shared-migration-conversion.ts"
import { library as baseLibrary } from "./shared-snapshot-fixture.ts"

export const migrationLibrary = {
  ...baseLibrary,
  skills: {
    ...baseLibrary.skills,
    property_ids: { ...baseLibrary.skills.property_ids, Members: "members" },
  },
}
export const migrationLegacyId = "notion_page:00000000-0000-4000-8000-000000000100"
export const migrationEncode = (text: string) => new TextEncoder().encode(text)
export const migrationHash = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex")
export function first<T>(items: readonly T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error("Missing controlled migration fixture")
  return item
}
function blobOid(bytes: Uint8Array) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

/** Independently retained legacy input and native wire response. Neither is
 * obtained from the new projector or a new mutation's response. */
export function migrationConversionFixture(
  options: {
    readonly kind?: "skill" | "router" | "prompt"
    readonly main?: string
    readonly mainNative?: string
    readonly notes?: string
    readonly following?: boolean
    readonly sourceMain?: string
    readonly sourceAsset?: Uint8Array
  } = {},
) {
  const kind = options.kind ?? "skill"
  const mainPath = kind === "router" ? "ROUTER.md" : kind === "prompt" ? "PROMPT.md" : "SKILL.md"
  const oldPage =
    kind === "router"
      ? "00000000-0000-4000-8000-000000000200"
      : kind === "prompt"
        ? "00000000-0000-4000-8000-000000000300"
        : "00000000-0000-4000-8000-000000000100"
  const legacyId = `notion_page:${oldPage}`
  const main = options.main ?? "# Migration heading\n\nUse `code`.",
    notes = options.notes ?? "Retained notes"
  const originals = [
    {
      legacy_id: "old-main",
      path: mainPath,
      page_id: oldPage,
      body: main,
      native: options.mainNative ?? main,
    },
    {
      legacy_id: "old-support",
      path: "notes.md",
      page_id: oldPage.slice(0, -1) + "1",
      body: notes,
      native: notes,
    },
  ]
  const native = originals.map(
    (file): MigrationNativePreimage => ({
      kind: "notion_page_markdown",
      page_id: file.page_id,
      api_version: "2026-03-11",
      markdown_version: "v2",
      request_path: `v1/pages/${file.page_id}/markdown?markdown_version=v2`,
      retention_ref: `backup:fixture/native/${file.legacy_id}.json`,
      response_json: JSON.stringify(
        {
          object: "page_markdown",
          id: file.page_id,
          markdown: file.native,
          truncated: false,
          unknown_block_ids: [],
        },
        null,
        2,
      ),
    }),
  )
  const entry: SharedMigrationInput["catalog"]["entries"][number] = {
    legacy_id: legacyId,
    record: {
      id: legacyId,
      kind,
      name: kind === "skill" ? "Migrated fixture" : `Migrated ${kind} fixture`,
      description: "Preserved description",
      enabled: true,
      default_context: false,
      entrypoint: mainPath,
      locator: { type: "notion_page", page_id: originals[0]!.page_id, database_id: "old-database" },
    },
    metadata: { original_properties: { retained_extra: "keep" } },
    metadata_complete: true,
    files_complete: true,
    legacy_mode: options.following ? "tracked" : "native",
    legacy_layout: "ordinary_page",
    files: originals.map((file, index) => {
      const preimage = native[index]!
      const { response_json, ...request } = preimage
      return {
        legacy_id: file.legacy_id,
        path: file.path,
        ownership: options.following && index === 0 ? "following" : "native",
        ...(options.following && index === 0
          ? { source_id: "old-fixed-source", projection_sha256: migrationHash(file.body) }
          : {}),
        body: {
          complete: true,
          sha256: migrationHash(file.body),
          bytes: migrationEncode(file.body).length,
          retention_ref: `backup:fixture/${file.legacy_id}`,
          retention_verified: true,
          normalization_version: 1,
        },
        raw: {
          native_preimage: {
            ...request,
            response_sha256: migrationHash(response_json),
            response_bytes: migrationEncode(response_json).length,
            body_sha256: migrationHash(file.native.replace(/\r\n/g, "\n")),
          },
        },
      }
    }),
  }
  const empty = { complete: true, items: [] }
  const sourceFiles = options.following
    ? [
        {
          path: mainPath,
          retention_ref: `backup:fixture/source/${mainPath}`,
          bytes: migrationEncode(options.sourceMain ?? main),
        },
        {
          path: "notes.md",
          retention_ref: "backup:fixture/source/notes.md",
          bytes: migrationEncode("Original source notes"),
        },
        {
          path: "assets/original.bin",
          retention_ref: "backup:fixture/source/assets/original.bin",
          bytes: options.sourceAsset ?? new Uint8Array([0, 255, 1]),
        },
      ]
    : []
  const migrationInput: SharedMigrationInput = {
    version: 1,
    scope: "controlled-migration-observation",
    target_library_id: migrationLibrary.library_id,
    approved_legacy_ids: [legacyId],
    backup: { verified: true, reference: "backup:fixture" },
    catalog: {
      coverage: {
        method: "explicit_database",
        exhaustive: true,
        queried_data_sources: ["fixture-ds"],
        failed_sources: [],
        search_index_limited: false,
      },
      entries: [entry],
    },
    preservation: {
      views: empty,
      routers: empty,
      pins: empty,
      operations: empty,
      sources: options.following
        ? {
            complete: true,
            items: [
              {
                legacy_id: "old-fixed-source",
                complete: true,
                references: [legacyId],
                raw: { original_selection: "retained" },
                source_semantics: "fixed_git_v1",
                fixed_source: {
                  url: "https://github.com/example/skills",
                  commit: "1".repeat(40),
                  root: "skills/example",
                  tree: "2".repeat(40),
                  files: sourceFiles.map((file) => ({
                    path: file.path,
                    source_path: `skills/example/${file.path}`,
                    git_oid: blobOid(file.bytes),
                    bytes: file.bytes.length,
                  })),
                },
              },
            ],
          }
        : empty,
    },
  }
  const input: MigrationConversionInput = {
    migration_input: migrationInput,
    library: migrationLibrary,
    legacy_id: legacyId,
    files: originals.map((file, index) => ({
      legacy_id: file.legacy_id,
      retention_ref: `backup:fixture/${file.legacy_id}`,
      bytes: migrationEncode(file.body),
      native_preimage: native[index]!,
    })),
    source_files: sourceFiles,
  }
  return { input, migrationInput, entry }
}
