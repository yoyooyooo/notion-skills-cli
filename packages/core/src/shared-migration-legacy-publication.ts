import { Effect, Schema } from "effect"
import { portableIdentity } from "./export.ts"
import { readImportZip, type ImportFile } from "./import.ts"
import { fail, property, SkillsError, SnapshotSchema, text } from "./model.ts"
import { BUNDLE, readPortable } from "./portable.ts"
import {
  publicationGuard,
  publicationManifest,
  publicationMarker,
} from "./publication-integrity.ts"
import { materializeReferenceFiles } from "./references.ts"
import { normalizePath, pageId } from "./ref.ts"
import { composeSharedFiles } from "./shared-composition.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import { gitBlobOid } from "./shared-github-source.ts"
import {
  LegacyCatalogActivitySchema,
  resolveMigrationActivation,
} from "./shared-migration-activation.ts"
import type { SharedMigrationEntry } from "./shared-migration-plan.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { makeSourceBinding } from "./shared-source-binding.ts"
import { sha256 } from "./store.ts"
import { PublishedMembersSchema, UpstreamSourceSchema } from "./upstream-model.ts"
import { selectMembers } from "./upstream-source.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Size = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const LegacyPublicationRetainedJsonSchema = Schema.Struct({
  json: Schema.String,
  sha256: Hash,
  bytes: Size,
  retention_ref: Schema.String,
})
const Binary = Schema.Struct({
  base64: Schema.String,
  sha256: Hash,
  bytes: Size,
  retention_ref: Schema.String,
})
const AuthoredFile = Schema.Struct({ path: Schema.String, ...Binary.fields })
// This is deliberately narrower than the general migration entry: this policy
// resolves an unclassified retained ordinary publication, never a known edit.
const OriginalBody = Schema.Struct({
  complete: Schema.Literal(true),
  sha256: Hash,
  bytes: Size,
  retention_ref: Schema.String,
  retention_verified: Schema.Literal(true),
  normalization_version: Schema.Literal(1),
})
const OriginalEntry = Schema.Struct({
  legacy_id: Schema.String,
  record: Schema.Unknown,
  metadata: Schema.Unknown,
  metadata_complete: Schema.Literal(true),
  files_complete: Schema.Boolean,
  legacy_mode: Schema.Literal("tracked"),
  legacy_layout: Schema.Literal("ordinary_page"),
  files: Schema.Array(
    Schema.Struct({
      legacy_id: Schema.String,
      path: Schema.String,
      ownership: Schema.Literal("unknown"),
      body: OriginalBody,
      raw: Schema.Unknown,
    }),
  ),
})
const Native = Schema.Struct({
  path: Schema.String,
  body_retention_ref: Schema.String,
  kind: Schema.Literal("notion_page_markdown"),
  page_id: Schema.String,
  api_version: Schema.Literal("2026-03-11"),
  markdown_version: Schema.Literals(["default", "v2"]),
  request_path: Schema.String,
  retention_ref: Schema.String,
  response_json: Schema.String,
  response_sha256: Hash,
  response_bytes: Size,
  body_sha256: Hash,
})
const LegacyPublicationProofFields = {
  observation: Schema.Literal("retained"),
  current_terminal_verified: Schema.Literal(false),
  human_edit_intent_inferred: Schema.Literal(false),
  entry_before: OriginalEntry,
  parent_rows: Schema.Array(LegacyPublicationRetainedJsonSchema),
  snapshot: LegacyPublicationRetainedJsonSchema,
  fixed_source_inspection: LegacyPublicationRetainedJsonSchema,
  source_archive: Binary,
  authored_export: Schema.Struct({
    request: LegacyPublicationRetainedJsonSchema,
    receipt: LegacyPublicationRetainedJsonSchema,
    completion: LegacyPublicationRetainedJsonSchema,
    inventory: LegacyPublicationRetainedJsonSchema,
    files: Schema.Array(AuthoredFile),
  }),
  native_preimages: Schema.Array(Native),
}
export const LegacyCommittedPublicationProofSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    policy: Schema.Literal("legacy_committed_publication_v1"),
    ...LegacyPublicationProofFields,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    policy: Schema.Literal("legacy_committed_source_bundle_v2"),
    ...LegacyPublicationProofFields,
  }),
  Schema.Struct({
    version: Schema.Literal(3),
    policy: Schema.Literal("legacy_committed_current_metadata_v3"),
    ...LegacyPublicationProofFields,
  }),
])
export type LegacyCommittedPublicationProof = typeof LegacyCommittedPublicationProofSchema.Type

const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SHARED_MIGRATION_PUBLICATION_INVALID",
            "Invalid retained legacy publication evidence.",
          ),
  })
function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw fail("SHARED_MIGRATION_PUBLICATION_INVALID", message)
}
const ensure = (value: unknown, message: string) => checked(() => requireFact(value, message))
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
const utf8 = (value: string) => new TextEncoder().encode(value)
function field(row: unknown, name: string) {
  const value = property(property(property(row).properties)[name])
  requireFact(
    value.type === "rich_text" && Array.isArray(value.rich_text),
    `Retain the complete ${name} rich text.`,
  )
  return text(value.rich_text)
}
function retained(value: typeof LegacyPublicationRetainedJsonSchema.Type) {
  return Effect.gen(function* () {
    yield* ensure(
      value.retention_ref &&
        utf8(value.json).length === value.bytes &&
        (yield* sha256(value.json)) === value.sha256,
      "A retained JSON artifact differs from its exact original bytes.",
    )
    return yield* checked(() => {
      const result: unknown = JSON.parse(value.json)
      requireFact(
        result !== null && typeof result === "object" && !Array.isArray(result),
        "Retain an original object, not an extracted field summary.",
      )
      return property(result)
    })
  })
}
function binary(value: typeof Binary.Type) {
  return Effect.gen(function* () {
    const bytes = yield* checked(() => {
      const bytes = Uint8Array.from(atob(value.base64), (character) => character.charCodeAt(0))
      let raw = ""
      for (let at = 0; at < bytes.length; at += 4096)
        raw += String.fromCharCode(...bytes.subarray(at, at + 4096))
      requireFact(
        value.retention_ref && btoa(raw) === value.base64 && bytes.length === value.bytes,
        "Retain complete canonical binary evidence.",
      )
      return bytes
    })
    yield* ensure((yield* sha256(bytes)) === value.sha256, "Retained binary evidence changed.")
    return bytes
  })
}
function recordIdentity(value: unknown) {
  const record = property(value)
  return Object.fromEntries(
    [
      "id",
      "kind",
      "locator",
      "name",
      "alias",
      "description",
      "default_context",
      "entrypoint",
      "ref",
    ].map((key) => [key, record[key]]),
  )
}
const selectors = (row: unknown) => ({
  roots: Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(field(row, "Roots"))),
  include: Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(field(row, "Include"))),
  exclude: Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(field(row, "Exclude"))),
  mapping: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
    JSON.parse(field(row, "Mapping")),
  ),
})

/** A retained observation may justify a new copy. This never establishes a
 * current terminal legacy operation, human edit intent, cutover or retirement. */
export function resolveLegacyCommittedPublication(input: unknown) {
  return Effect.gen(function* () {
    const proof = yield* checked(() =>
      Schema.decodeUnknownSync(LegacyCommittedPublicationProofSchema)(
        JSON.parse(canonicalSharedJson(input)),
        { onExcessProperty: "error" },
      ),
    )
    const before = proof.entry_before
    const sourceBundle = proof.version >= 2
    const activation = yield* resolveMigrationActivation(before, "legacy_page_to_native_v2")
    const activity = yield* checked(() =>
      Schema.decodeUnknownSync(LegacyCatalogActivitySchema)(
        property(before.metadata).legacy_catalog_activity,
      ),
    )
    const row = yield* retained(activity.catalog_row)
    const snapshotRaw = yield* retained(proof.snapshot)
    const snapshot = yield* checked(() =>
      Schema.decodeUnknownSync(SnapshotSchema)(snapshotRaw, { onExcessProperty: "error" }),
    )
    const record = snapshot.record
    const pages = yield* checked(() => {
      requireFact(
        activation &&
          record.kind === "skill" &&
          record.locator.type === "notion_page" &&
          record.id === before.legacy_id &&
          same(recordIdentity(record), recordIdentity(before.record)) &&
          snapshot.entrypoint === record.entrypoint &&
          snapshot.entrypoint === "SKILL.md" &&
          !snapshot.source_files &&
          !snapshot.source_projection &&
          !snapshot.markdown_files &&
          (snapshot.router_members?.length ?? 0) === 0 &&
          snapshot.references,
        "Select an exact ordinary Skill snapshot with complete native page references.",
      )
      requireFact(
        before.files.length > 0 &&
          new Set(before.files.map((file) => file.path)).size === before.files.length &&
          new Set(before.files.map((file) => file.legacy_id)).size === before.files.length &&
          snapshot.references.length === before.files.length &&
          new Set(snapshot.references.map((page) => page.id)).size === before.files.length,
        "Retain each original native file and page once.",
      )
      const refs = property(property(row.properties).References)
      requireFact(
        refs.type === "rich_text" && Array.isArray(refs.rich_text),
        "Retain the complete original References property.",
      )
      const paths = new Map<string, string>([[record.entrypoint, record.locator.page_id]])
      for (const raw of refs.rich_text) {
        const item = property(raw),
          label = text([raw])
        if (label.trim() === "") continue
        const url = property(property(item.text).link).url
        const id = typeof url === "string" ? pageId(url) : undefined
        requireFact(
          item.type === "text" &&
            label === label.trim() &&
            normalizePath(label) === label &&
            id &&
            (item.href === undefined || item.href === url) &&
            !paths.has(label),
          "Each retained typed Reference must identify one exact file page.",
        )
        paths.set(label, id)
      }
      requireFact(
        paths.size === before.files.length &&
          snapshot.references.every((page) => paths.get(page.path) === page.id) &&
          before.files.every((file) => paths.has(file.path)),
        "References, snapshot and managed paths differ.",
      )
      const attachments = property(property(row.properties).Files)
      requireFact(
        attachments.type === "files" &&
          Array.isArray(attachments.files) &&
          attachments.files.length === 1 &&
          property(attachments.files[0]).name === BUNDLE,
        "This policy requires exactly the retained source archive and no unresolved attachment.",
      )
      return snapshot.references
    })
    const sourceArchive = yield* binary(proof.source_archive)
    const sourcePortable = yield* checked(() => {
      const value = readPortable(readImportZip(sourceArchive))
      requireFact(
        value &&
          value.kind === "skill" &&
          value.main === snapshot.entrypoint &&
          value.name === record.name &&
          value.description === record.description &&
          (sourceBundle
            ? value.files.length >= before.files.length &&
              before.files.every((original) =>
                value.files.some((file) => file.path === original.path),
              )
            : value.files.length === before.files.length &&
              value.files.every((file) =>
                before.files.some((original) => original.path === file.path),
              )),
        "The retained source archive must contain this exact complete ordinary member.",
      )
      if (sourceBundle) {
        const nativeSupports = before.files
          .filter((file) => file.path !== snapshot.entrypoint)
          .map((file) => file.path)
          .sort()
        requireFact(
          same(Object.keys(value.projection?.references ?? {}).sort(), nativeSupports),
          "A source-only resource cannot hide a missing formerly editable native reference.",
        )
      }
      return value
    })
    const archiveFile = snapshot.files.find((file) => file.path === BUNDLE)
    yield* ensure(
      snapshot.files.length ===
        (sourceBundle ? sourcePortable.files.length : before.files.length) + 1 &&
        archiveFile?.sha256 === proof.source_archive.sha256 &&
        archiveFile.bytes === sourceArchive.length &&
        new Set(snapshot.files.map((file) => file.path)).size === snapshot.files.length,
      "The original materialized manifest must retain the exact source ZIP and every native file.",
    )
    const materialized = yield* checked(() => materializeReferenceFiles(record, pages))
    for (const file of materialized) {
      const expected = snapshot.files.find((item) => item.path === file.path)
      yield* ensure(
        expected &&
          expected.bytes === file.bytes.length &&
          expected.sha256 === (yield* sha256(file.bytes)),
        "The retained native references do not reconstruct the committed materialized file hashes.",
      )
    }
    // A source-backed member can expose scripts, binary assets and Markdown
    // that never had native child pages. Match the actual legacy materializer:
    // native references win; every remaining path must come from the exact ZIP.
    // Saved v1 evidence still requires one native page per source file.
    if (sourceBundle) {
      const nativePaths = new Set(before.files.map((file) => file.path))
      for (const file of sourcePortable.files.filter((file) => !nativePaths.has(file.path))) {
        const expected = snapshot.files.find((item) => item.path === file.path)
        yield* ensure(
          expected &&
            expected.bytes === file.bytes.length &&
            expected.sha256 === (yield* sha256(file.bytes)),
          "An archive-only resource differs from the exact committed snapshot inventory.",
        )
      }
    }
    const marker = yield* checked(() => publicationMarker(row)),
      guard = yield* checked(() => publicationGuard(row))
    const manifest = yield* publicationManifest(snapshot)
    yield* ensure(
      marker?.state === "committed",
      "The retained page has no committed publication marker.",
    )
    if (marker?.state !== "committed")
      return yield* Effect.fail(
        fail("SHARED_MIGRATION_PUBLICATION_INVALID", "Missing committed marker."),
      )
    // Default Context is supply metadata, not file ownership. A legacy marker
    // included it in its guard. Policy 3 verifies the exact committed guard
    // over both possible checkbox values, while retaining today's value.
    // No other ownership/member field, file byte or historical result changes.
    let publishedDefaultContext = guard.default_context
    const currentGuardHash = yield* sha256(canonicalSharedJson(guard))
    if (proof.version === 3 && currentGuardHash !== marker.ownership_hash) {
      const otherDefault = !guard.default_context
      const otherHash = yield* sha256(
        canonicalSharedJson({ ...guard, default_context: otherDefault }),
      )
      yield* ensure(
        otherHash === marker.ownership_hash,
        "Only a Default Context checkbox change can differ from the committed tracked ownership guard.",
      )
      publishedDefaultContext = otherDefault
    }
    yield* ensure(
      (yield* sha256(canonicalSharedJson(manifest))) === marker.manifest_hash &&
        (proof.version === 3 || currentGuardHash === marker.ownership_hash) &&
        (yield* sha256(
          canonicalSharedJson([
            marker.operation_id,
            marker.intended_hash,
            marker.manifest_hash,
            marker.ownership_hash,
          ]),
        )) === marker.revision &&
        guard.ownership.mode === "tracked" &&
        guard.ownership.upstream.length === 1 &&
        guard.ownership.baseline === "",
      "The retained revision, full materialized manifest and tracked ownership guard must all match their committed marker.",
    )
    const parents = yield* Effect.forEach(proof.parent_rows, retained)
    const selected = yield* checked(() => {
      requireFact(parents.length === 2, "Retain both original parent observations.")
      const parent = parents[0]!,
        other = parents[1]!
      for (const value of parents)
        requireFact(
          value.object === "page" &&
            value.id === guard.ownership.upstream[0] &&
            pageId(String(value.id)) === value.id &&
            value.in_trash === false &&
            (value.archived === undefined || value.archived === false) &&
            (value.is_archived === undefined || value.is_archived === false) &&
            property(value.parent).type === "data_source_id",
          "The retained Source parent identity or page activity is unresolved.",
        )
      const keys = [
        "Source",
        "Source URL",
        "Ref",
        "Roots",
        "Include",
        "Exclude",
        "Mapping",
        "Published Members",
        "Target Database ID",
      ]
      requireFact(
        same(
          Object.fromEntries(keys.map((key) => [key, property(parent.properties)[key]])),
          Object.fromEntries(keys.map((key) => [key, property(other.properties)[key]])),
        ),
        "Parent selection changed between retained observations.",
      )
      const source = Schema.decodeUnknownSync(UpstreamSourceSchema)(
        JSON.parse(field(parent, "Source")),
        { onExcessProperty: "error" },
      )
      requireFact(
        source.provider.type === "git" &&
          (proof.version === 3 || source.target_mode === "manual") &&
          Object.keys(source).every((key) =>
            ["provider", "strip_prefix", "target_mode"].includes(key),
          ),
        "This fixed-member policy does not reinterpret patches, mappings, shared target sets or other source options.",
      )
      const selection = selectors(parent)
      requireFact(
        Object.keys(selection.mapping).length === 0,
        "A name mapping needs a separate explicit interpretation.",
      )
      const published = Schema.decodeUnknownSync(PublishedMembersSchema)(
        JSON.parse(field(parent, "Published Members")),
        { onExcessProperty: "error" },
      )
      const sourceManifest = published.source_manifest
      requireFact(
        sourceManifest &&
          published.publisher_subscription_id === parent.id &&
          sourceManifest.source_id === parent.id,
        "The complete selected publication must belong to this exact Source parent.",
      )
      requireFact(
        new Set(published.members.map((member) => member.member_key)).size ===
          published.members.length &&
          new Set(published.members.map((member) => member.page_id)).size ===
            published.members.length &&
          new Set(sourceManifest.members.map((member) => member.member_key)).size ===
            sourceManifest.members.length,
        "The retained publication has ambiguous member identities.",
      )
      const members = published.members.filter((member) => member.page_id === row.id)
      const member = members[0]
      requireFact(members.length === 1 && member, "Select one exact retained published member.")
      const manifests = sourceManifest.members.filter(
          (item) => item.member_key === member.member_key,
        ),
        selectedManifest = manifests[0]
      requireFact(
        manifests.length === 1 &&
          selectedManifest &&
          selectedManifest.source_path === member.member_key &&
          selectedManifest.main === snapshot.entrypoint,
        "The selected member has no exact complete source manifest.",
      )
      const eligible = selectMembers(
        { source: source.provider, ...selection, allow_empty: true, require_all_included: false },
        sourceManifest.members.map((item) => item.member_key),
        sourceManifest.members.flatMap((item) =>
          item.resources.map((file) => `${item.source_path}/${file.path}`),
        ),
      )
      requireFact(
        eligible.includes(member.member_key),
        "The retained source selectors exclude this member.",
      )
      const prefix = source.strip_prefix?.replace(/\/$/u, "")
      const ownerKey =
        prefix && member.member_key.startsWith(prefix + "/")
          ? member.member_key.slice(prefix.length + 1)
          : member.member_key
      requireFact(
        ownerKey === guard.ownership.key &&
          member.content_hash === guard.ownership.hash &&
          member.revision === guard.ownership.revision &&
          field(parent, "Ref") === source.provider.ref &&
          field(parent, "Target Database ID") === property(record.locator).database_id,
        "The selected member differs from its retained publication ownership.",
      )
      return {
        parent_id: String(parent.id),
        source,
        selection,
        published,
        sourceManifest,
        member,
        selectedManifest,
      }
    })
    const inspection = yield* retained(proof.fixed_source_inspection)
    yield* ensure(
      inspection.ok === true && inspection.metadata_only === true,
      "Retain the complete fixed Git metadata inspection.",
    )
    const binding = yield* makeSourceBinding(inspection.source)
    yield* ensure(
      selected.source.provider.type === "git" &&
        selected.source.provider.url.replace(/\.git$/u, "") === binding.url &&
        binding.commit === selected.member.revision &&
        binding.root === selected.selectedManifest.source_path &&
        binding.files.length === sourcePortable.files.length &&
        selected.selectedManifest.resources.length === sourcePortable.files.length,
      "The immutable Git selection differs from this member's own revision, root or complete file set.",
    )
    for (const file of sourcePortable.files) {
      const expected = binding.files.find((item) => item.path === file.path)
      const resource = selected.selectedManifest.resources.find((item) => item.path === file.path)
      yield* ensure(
        expected &&
          resource &&
          expected.bytes === file.bytes.length &&
          expected.git_oid === (yield* gitBlobOid(file.bytes)) &&
          resource.sha256 === (yield* sha256(file.bytes)),
        "Source manifest, retained ZIP and exact Git blob must agree for every file.",
      )
    }
    const sourceTree = yield* checked(() =>
      composeSharedFiles({
        base: sourcePortable.files,
        mounts: [],
        overrides: [],
        entrypoint: snapshot.entrypoint,
      }),
    )
    const referenceCheck = yield* checked(() => assertSharedFileReferences(sourceTree.files, 3))
    const request = yield* retained(proof.authored_export.request),
      receipt = yield* retained(proof.authored_export.receipt)
    const completion = yield* retained(proof.authored_export.completion),
      inventory = yield* retained(proof.authored_export.inventory)
    yield* checked(() => {
      const argv = request.argv
      requireFact(
        Array.isArray(argv) &&
          argv.length === 13 &&
          typeof argv[0] === "string" &&
          typeof argv[1] === "string" &&
          typeof request.cli_sha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(request.cli_sha256) &&
          same(argv.slice(2, 11), [
            "export",
            snapshot.snapshot_id,
            "--database",
            property(record.locator).database_id,
            "--offline",
            "--projection",
            "source",
            "--format",
            "directory",
          ]) &&
          argv[11] === "--output" &&
          argv[12] === receipt.output &&
          completion.exit_code === 0,
        "Retain the successful exact-pin offline source export request and completion.",
      )
      requireFact(
        receipt.ok === true &&
          receipt.operation === "export" &&
          receipt.projection === "source" &&
          receipt.format === "directory" &&
          receipt.source === "local_snapshot" &&
          property(receipt.freshness).policy === "pinned" &&
          receipt.snapshot_id === snapshot.snapshot_id &&
          receipt.version_id === snapshot.version_id &&
          receipt.scope === snapshot.scope &&
          receipt.ref === `${record.ref}?snapshot=${snapshot.snapshot_id}` &&
          same(receipt.record, snapshot.record) &&
          receipt.entrypoint === snapshot.entrypoint &&
          receipt.main_path === snapshot.entrypoint &&
          Array.isArray(receipt.files),
        "The authored export belongs to another original record or pin.",
      )
    })
    const authored: ImportFile[] = []
    for (const file of proof.authored_export.files) {
      const bytes = yield* binary(file)
      const listed = Array.isArray(receipt.files)
        ? receipt.files.filter((item) => property(item).path === file.path)
        : []
      yield* ensure(
        normalizePath(file.path) === file.path &&
          file.retention_ref === `${receipt.output}/${file.path}` &&
          listed.length === 1 &&
          property(listed[0]).hash === file.sha256 &&
          property(listed[0]).bytes === file.bytes &&
          same(inventory[file.path], { sha256: file.sha256, bytes: file.bytes }),
        "The authored export inventory or actual bytes differ.",
      )
      authored.push({ path: file.path, bytes })
    }
    yield* ensure(
      authored.length === (sourceBundle ? sourcePortable.files.length : before.files.length) + 1 &&
        new Set(authored.map((file) => file.path)).size === authored.length &&
        Object.keys(inventory).length === authored.length &&
        Array.isArray(receipt.files) &&
        receipt.files.length === authored.length,
      "The authored source export must be complete, including its portable manifest.",
    )
    const authoredPortable = yield* checked(() => {
      const value = readPortable(authored)
      requireFact(
        value &&
          value.kind === "skill" &&
          value.name === record.name &&
          value.description === record.description &&
          value.main === snapshot.entrypoint,
        "Authored export metadata changed.",
      )
      return value
    })
    const authoredIdentity = yield* portableIdentity(authoredPortable)
    yield* ensure(
      authoredIdentity === receipt.content_id && authoredIdentity === selected.member.content_hash,
      "The authored export differs from the retained member's published source content; keep the difference unresolved.",
    )
    if (sourceBundle) {
      for (const file of sourcePortable.files) {
        const exported = proof.authored_export.files.find((item) => item.path === file.path)
        yield* ensure(
          exported &&
            exported.bytes === file.bytes.length &&
            exported.sha256 === (yield* sha256(file.bytes)),
          "The complete authored source export must preserve every fixed source resource exactly.",
        )
      }
    }
    for (const file of before.files) {
      const exported = proof.authored_export.files.find((item) => item.path === file.path)
      const source = sourcePortable.files.find((item) => item.path === file.path)
      yield* ensure(
        exported &&
          source &&
          exported.sha256 === file.body.sha256 &&
          exported.bytes === file.body.bytes &&
          exported.sha256 === (yield* sha256(source.bytes)),
        "Do not classify a differing authored file as following.",
      )
    }
    yield* ensure(
      proof.native_preimages.length === before.files.length &&
        new Set(proof.native_preimages.map((item) => item.path)).size === before.files.length &&
        new Set(proof.native_preimages.map((item) => item.body_retention_ref)).size ===
          before.files.length,
      "Retain one complete original native response per managed path.",
    )
    const nativeFiles: {
      path: string
      bytes: Uint8Array
      retention_ref: string
      sha256: string
    }[] = []
    for (const file of before.files) {
      const native = proof.native_preimages.find((item) => item.path === file.path)
      yield* ensure(native, "Missing native preimage.")
      if (!native)
        return yield* Effect.fail(
          fail("SHARED_MIGRATION_PUBLICATION_INVALID", "Missing native preimage."),
        )
      const response = yield* retained({
        json: native.response_json,
        sha256: native.response_sha256,
        bytes: native.response_bytes,
        retention_ref: native.retention_ref,
      })
      const page = pages.find((item) => item.path === file.path)
      yield* checked(() => {
        const {
          path: _path,
          body_retention_ref: _bodyRef,
          response_json: _response,
          ...descriptor
        } = native
        const expectedPath = `v1/pages/${native.page_id}/markdown${native.markdown_version === "v2" ? "?markdown_version=v2" : ""}`
        requireFact(
          native.body_retention_ref &&
            native.body_retention_ref !== file.body.retention_ref &&
            native.body_retention_ref !== native.retention_ref &&
            page &&
            page.id === native.page_id &&
            native.request_path === expectedPath &&
            response.object === "page_markdown" &&
            response.id === native.page_id &&
            response.markdown === page.markdown &&
            response.truncated === false &&
            Array.isArray(response.unknown_block_ids) &&
            response.unknown_block_ids.length === 0 &&
            (response.warnings === undefined ||
              (Array.isArray(response.warnings) && response.warnings.length === 0)) &&
            same(property(file.raw).native_preimage, descriptor) &&
            property(property(file.raw).pilot_current_capture).page_id === native.page_id,
          "The complete native response is not the exact retained reference and original preimage descriptor.",
        )
      })
      const bytes = utf8(normalizeObservedBody(String(response.markdown))),
        digest = yield* sha256(bytes)
      yield* ensure(
        digest === native.body_sha256,
        "The original native normalization hash differs.",
      )
      nativeFiles.push({
        path: file.path,
        bytes,
        retention_ref: native.body_retention_ref,
        sha256: digest,
      })
    }
    const proofHash = yield* sha256(canonicalSharedJson(proof)),
      beforeHash = yield* sha256(canonicalSharedJson(before))
    const sourceLegacyId = `legacy-member-source-${yield* sha256(canonicalSharedJson([1, selected.parent_id, selected.member.member_key, binding.source_id]))}`
    const observation = {
      version: proof.version,
      policy: proof.policy,
      retained_observation: true as const,
      source_legacy_id: sourceLegacyId,
      proof_sha256: proofHash,
      before_entry_sha256: beforeHash,
      current_terminal_verified: false as const,
      human_edit_intent_inferred: false as const,
      ...(proof.version === 3
        ? {
            metadata_transition: {
              default_context: {
                published: publishedDefaultContext,
                current: guard.default_context,
              },
            },
          }
        : {}),
    }
    yield* ensure(
      !Object.hasOwn(property(before.metadata), "legacy_committed_publication"),
      "Do not replace an earlier publication interpretation.",
    )
    const entry: SharedMigrationEntry = {
      ...before,
      files_complete: true,
      metadata: { ...property(before.metadata), legacy_committed_publication: observation },
      files: before.files.map((file) => {
        const native = nativeFiles.find((item) => item.path === file.path)!
        return {
          ...file,
          ownership: "following",
          source_id: sourceLegacyId,
          projection_sha256: native.sha256,
          body: {
            complete: true,
            sha256: native.sha256,
            bytes: native.bytes.length,
            retention_ref: native.retention_ref,
            retention_verified: true,
            normalization_version: 1,
          },
          raw: {
            ...property(file.raw),
            legacy_committed_publication: {
              ...observation,
              original_authored_body: file.body,
              comparison_domain: "native_preimage_normalization_v1",
            },
          },
        }
      }),
    }
    const fixedSource = {
      url: binding.url,
      commit: binding.commit,
      root: binding.root,
      tree: binding.tree,
      files: binding.files,
    }
    const source = {
      legacy_id: sourceLegacyId,
      source_semantics: "legacy_fixed_git_member_v1" as const,
      complete: true,
      references: [before.legacy_id],
      fixed_source: fixedSource,
      raw: {
        legacy_committed_publication: proof,
        source: selected.source,
        ...selected.selection,
        parent_publication_completeness: "not_established" as const,
        original_parent_counts: {
          published: selected.published.members.length,
          source_manifest: selected.sourceManifest.members.length,
        },
        unscoped_external_resources: selected.sourceManifest.external_resources ?? [],
        reference_check: referenceCheck,
      },
    }
    return {
      proof,
      proof_sha256: proofHash,
      scope: snapshot.scope,
      entry,
      source,
      source_binding: binding,
      native_files: nativeFiles,
    }
  })
}

/** Recompute the exact interpretation before review or dispatch. Saved evidence
 * cannot silently acquire a different Source, body domain or ownership mapping. */
export function validateLegacyCommittedPublicationSource(
  source: unknown,
  entry: SharedMigrationEntry,
) {
  return Effect.gen(function* () {
    const result = yield* resolveLegacyCommittedPublication(
      property(property(source).raw).legacy_committed_publication,
    )
    yield* ensure(
      same(result.source, source) && same(result.entry, entry),
      "The derived Source or entry differs from its retained publication proof.",
    )
    return result
  })
}
