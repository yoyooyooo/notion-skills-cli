import { createHash } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect } from "effect"
import { portableIdentity } from "../src/export.ts"
import { aliasFor, property, type Snapshot } from "../src/model.ts"
import { BUNDLE, portableFiles, portableZip, type PortableSkill } from "../src/portable.ts"
import { publicationGuard, publicationManifest } from "../src/publication-integrity.ts"
import { materializeReferenceFiles } from "../src/references.ts"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import {
  resolveLegacyCommittedPublication,
  type LegacyCommittedPublicationProof,
} from "../src/shared-migration-legacy-publication.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"

export const publicationHash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex")
export const publicationRun = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const bytes = (value: string) => new TextEncoder().encode(value)
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
export function retainPublicationJson(
  value: unknown,
  retentionRef = "retained:controlled/original.json",
) {
  const json = JSON.stringify(value, null, 2) + "\n"
  return {
    json,
    sha256: publicationHash(json),
    bytes: bytes(json).length,
    retention_ref: retentionRef,
  }
}
function retainedBinary(value: Uint8Array, retentionRef: string) {
  return {
    base64: Buffer.from(value).toString("base64"),
    sha256: publicationHash(value),
    bytes: value.length,
    retention_ref: retentionRef,
  }
}
const rich = (id: string, value: string) => ({
  id,
  type: "rich_text",
  rich_text: [
    { type: "text", text: { content: value, link: null }, plain_text: value, href: null },
  ],
})

/** Explicit old native strings and original source bytes. No new native
 * projector or mutation response is used to construct this legacy evidence. */
export async function legacyCommittedPublicationFixture() {
  const page = uuid(610),
    support = uuid(611),
    parent = uuid(620),
    database = uuid(630),
    dataSource = uuid(631)
  const name = "Retained publication",
    description = "Controlled retained publication description"
  const commit = "1".repeat(40),
    root = "skills/retained"
  const record = {
    id: `notion_page:${page}`,
    kind: "skill" as const,
    locator: {
      type: "notion_page" as const,
      page_id: page,
      database_id: database,
      data_source_id: dataSource,
    },
    name,
    alias: aliasFor(name),
    description,
    default_context: false,
    entrypoint: "SKILL.md",
    ref: `skill://${page}/SKILL.md`,
  }
  const sourceFiles = [
    {
      path: "SKILL.md",
      bytes: bytes(
        `---\nname: ${name}\ndescription: ${description}\n---\n\n# Retained\n\nRead [guide](references/guide.md).\n`,
      ),
    },
    { path: "references/guide.md", bytes: bytes("# Guide\n\nOriginal guide.\n") },
  ]
  const sourcePortable: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: sourceFiles,
    projection: {
      name,
      description,
      body: "# Retained\n\nRead [guide](references/guide.md).",
      references: { "references/guide.md": "# Guide\n\nOriginal guide." },
    },
  }
  const sourceArchive = portableZip(sourcePortable, true)
  const publishedHash = await publicationRun(portableIdentity(sourcePortable))
  const pages = [
    {
      path: "SKILL.md",
      id: page,
      markdown: `# Retained\nRead [guide](https://www.notion.so/${support.replaceAll("-", "")}#ntn-skills-path=references%2Fguide.md).`,
    },
    { path: "references/guide.md", id: support, markdown: "# Guide\nOriginal guide." },
  ]
  const current = materializeReferenceFiles(record, pages)
  const snapshot: Snapshot = {
    snapshot_id: "s_" + "4".repeat(64),
    scope: "controlled-retained-publication",
    record,
    entrypoint: "SKILL.md",
    version_id: "5".repeat(64),
    created_at: 1,
    files: [...current, { path: BUNDLE, bytes: sourceArchive }].map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: publicationHash(file.bytes),
    })),
    references: pages,
    router_members: [],
  }
  const referenceUrl = `https://www.notion.so/${support.replaceAll("-", "")}`
  const properties: Record<string, unknown> = {
    Name: { id: "title", type: "title", title: [{ plain_text: name }] },
    Description: rich("description", description),
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    "Default Context": { id: "context", type: "checkbox", checkbox: false },
    "Sync Mode": { id: "mode", type: "select", select: { name: "tracked" } },
    Upstream: { id: "upstream", type: "relation", relation: [{ id: parent }], has_more: false },
    "Upstream Key": rich("key", "retained"),
    "Upstream Revision": rich("revision", commit),
    "Published Hash": rich("hash", publishedHash),
    References: {
      id: "references",
      type: "rich_text",
      rich_text: [
        {
          type: "text",
          plain_text: "references/guide.md",
          href: referenceUrl,
          text: { content: "references/guide.md", link: { url: referenceUrl } },
        },
      ],
    },
    Files: {
      id: "files",
      type: "files",
      files: [
        {
          name: BUNDLE,
          type: "file",
          file: { url: "https://example.invalid/retained-source.zip" },
        },
      ],
    },
    Publication: rich("publication", ""),
  }
  const row = {
    object: "page",
    id: page,
    is_archived: false,
    in_trash: false,
    parent: { type: "data_source_id", database_id: database, data_source_id: dataSource },
    properties,
  }
  const manifestHash = publicationHash(
    canonicalSharedJson(await publicationRun(publicationManifest(snapshot))),
  )
  const guardHash = publicationHash(canonicalSharedJson(publicationGuard(row)))
  const marker = {
    version: 2,
    state: "committed",
    operation_id: "retained-publication-original-operation",
    intended_hash: "6".repeat(64),
    manifest_hash: manifestHash,
    ownership_hash: guardHash,
    revision: "",
  }
  marker.revision = publicationHash(
    canonicalSharedJson([
      marker.operation_id,
      marker.intended_hash,
      marker.manifest_hash,
      marker.ownership_hash,
    ]),
  )
  properties.Publication = rich("publication", JSON.stringify(marker))
  const schema = {
    object: "data_source",
    id: dataSource,
    in_trash: false,
    parent: { type: "database_id", database_id: database },
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, value]) => [
        name,
        { name, id: property(value).id, type: property(value).type },
      ]),
    ),
  }
  const nativePreimages = pages.map((page) => {
    const response = retainPublicationJson(
      {
        object: "page_markdown",
        id: page.id,
        markdown: page.markdown,
        truncated: false,
        unknown_block_ids: [],
      },
      `retained:native/${page.path}.json`,
    )
    return {
      path: page.path,
      body_retention_ref: `derived:native/${page.path}`,
      kind: "notion_page_markdown" as const,
      page_id: page.id,
      api_version: "2026-03-11" as const,
      markdown_version: "default" as const,
      request_path: `v1/pages/${page.id}/markdown`,
      retention_ref: response.retention_ref,
      response_json: response.json,
      response_sha256: response.sha256,
      response_bytes: response.bytes,
      body_sha256: publicationHash(normalizeObservedBody(page.markdown)),
    }
  })
  const entryBefore: LegacyCommittedPublicationProof["entry_before"] = {
    legacy_id: record.id,
    record,
    metadata_complete: true,
    files_complete: false,
    legacy_mode: "tracked",
    legacy_layout: "ordinary_page",
    metadata: {
      original: "keep original ordinary metadata",
      legacy_catalog_activity: {
        version: 2,
        policy: "legacy_catalog_active_page_v2",
        api_version: "2026-03-11",
        catalog_row: retainPublicationJson(row, "retained:catalog-row"),
        data_source_schema: retainPublicationJson(schema, "retained:catalog-schema"),
      },
    },
    files: sourceFiles.map((file, index) => {
      const native = nativePreimages[index]!
      const {
        path: _path,
        body_retention_ref: _body,
        response_json: _response,
        ...descriptor
      } = native
      return {
        legacy_id: `old-file-${index}`,
        path: file.path,
        ownership: "unknown",
        body: {
          complete: true,
          sha256: publicationHash(file.bytes),
          bytes: file.bytes.length,
          retention_ref: `retained:original-authored/${file.path}`,
          retention_verified: true,
          normalization_version: 1,
        },
        raw: {
          native_preimage: descriptor,
          pilot_current_capture: { page_id: native.page_id },
          original_unknown_field: "retained",
        },
      }
    }),
  }
  const resources = sourceFiles.map((file) => ({
    path: file.path,
    sha256: publicationHash(file.bytes),
  }))
  const published = {
    version: 1,
    revision: commit,
    plan_hash: "7".repeat(64),
    publisher_subscription_id: parent,
    source_manifest: {
      version: 1,
      source_id: parent,
      revision: commit,
      external_resources: [],
      members: [
        { member_key: root, source_path: root, main: "SKILL.md", resources },
        {
          member_key: "skills/other",
          source_path: "skills/other",
          main: "SKILL.md",
          resources: [{ path: "SKILL.md", sha256: "8".repeat(64) }],
        },
      ],
    },
    members: [{ member_key: root, page_id: page, content_hash: publishedHash, revision: commit }],
  }
  const parentRow = {
    object: "page",
    id: parent,
    in_trash: false,
    is_archived: false,
    parent: { type: "data_source_id", data_source_id: uuid(640), database_id: uuid(641) },
    properties: {
      Source: rich(
        "source",
        JSON.stringify({
          provider: { type: "git", url: "https://github.com/example/skills.git", ref: "main" },
          strip_prefix: "skills",
          target_mode: "manual",
        }),
      ),
      "Source URL": { id: "source-url", type: "url", url: "https://github.com/example/skills" },
      Ref: rich("ref", "main"),
      Roots: rich("roots", '["skills"]'),
      Include: rich("include", '["skills/*"]'),
      Exclude: rich("exclude", '["skills/excluded/**"]'),
      Mapping: rich("mapping", "{}"),
      "Published Members": rich("published", JSON.stringify(published)),
      "Target Database ID": rich("target", database),
    },
  }
  const fixedSource = {
    url: "https://github.com/example/skills",
    commit,
    root,
    tree: "9".repeat(40),
    files: sourceFiles.map((file) => ({
      path: file.path,
      source_path: `${root}/${file.path}`,
      bytes: file.bytes.length,
      git_oid: createHash("sha1")
        .update(`blob ${file.bytes.length}\0`)
        .update(file.bytes)
        .digest("hex"),
    })),
  }
  const output = "/controlled/retained-source-export"
  const authoredFiles = portableFiles(sourcePortable).map((file) => ({
    path: file.path,
    ...retainedBinary(file.bytes, `${output}/${file.path}`),
  }))
  const proof: LegacyCommittedPublicationProof = {
    version: 1,
    policy: "legacy_committed_publication_v1",
    observation: "retained",
    current_terminal_verified: false,
    human_edit_intent_inferred: false,
    entry_before: entryBefore,
    parent_rows: [
      retainPublicationJson(parentRow, "retained:parent/first"),
      retainPublicationJson(parentRow, "retained:parent/second"),
    ],
    snapshot: retainPublicationJson(snapshot, "retained:exact-snapshot"),
    fixed_source_inspection: retainPublicationJson(
      { ok: true, metadata_only: true, source: fixedSource },
      "retained:fixed-source-inspection",
    ),
    source_archive: retainedBinary(sourceArchive, "retained:original-source.zip"),
    native_preimages: nativePreimages,
    authored_export: {
      request: retainPublicationJson({
        argv: [
          "node",
          "/controlled/old-cli.js",
          "export",
          snapshot.snapshot_id,
          "--database",
          database,
          "--offline",
          "--projection",
          "source",
          "--format",
          "directory",
          "--output",
          output,
        ],
        cli_sha256: "a".repeat(64),
      }),
      receipt: retainPublicationJson({
        ok: true,
        record,
        scope: snapshot.scope,
        snapshot_id: snapshot.snapshot_id,
        version_id: snapshot.version_id,
        entrypoint: snapshot.entrypoint,
        main_path: snapshot.entrypoint,
        ref: `${record.ref}?snapshot=${snapshot.snapshot_id}`,
        source: "local_snapshot",
        freshness: { policy: "pinned" },
        operation: "export",
        projection: "source",
        format: "directory",
        output,
        content_id: publishedHash,
        files: authoredFiles.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          hash: file.sha256,
        })),
      }),
      completion: retainPublicationJson({ exit_code: 0 }),
      inventory: retainPublicationJson(
        Object.fromEntries(
          authoredFiles.map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes }]),
        ),
      ),
      files: authoredFiles,
    },
  }
  const derived = await publicationRun(resolveLegacyCommittedPublication(proof))
  return {
    proof,
    before_entry: entryBefore,
    derived,
    source_files: sourceFiles,
    native_files: derived.native_files,
    sourcePortable,
    row,
    parentRow,
    snapshot,
  }
}
