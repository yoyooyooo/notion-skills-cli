import { readResignedAdoptionAttachment } from "./publication-content-adoption-download.ts"
import { priorContentAdoptionGraphs } from "./publication-content-adoption-graph.ts"
import { contentAdoptionPropertyComparison } from "./publication-content-adoption-metadata.ts"
import {
  contentAdoptionDescriptionComparison,
  contentAdoptionDescriptionMatches,
  deriveContentAdoptionDescriptionMigration,
  type ContentAdoptionDescriptionPhase,
} from "./publication-content-adoption-description.ts"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { createHash } from "node:crypto"
import { authScope, explicitSource } from "./catalog.ts"
import {
  decode,
  PageSchema,
  recordFromPage,
  SnapshotSchema,
  property,
  text,
  type Snapshot,
  type SkillsError,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { Store, sha256 } from "./store.ts"
import { readImportZip } from "./import.ts"
import { BUNDLE, readPortable } from "./portable.ts"
import type { PortableSkill } from "./portable.ts"
import { portableIdentity, snapshotAuthoredPortable } from "./export.ts"
import { readReferences, childPageTags } from "./references.ts"
import { referencePagesMatch } from "./reference-mutation.ts"
import { decodeReferenceLinks } from "./reference-links.ts"
import {
  publicationMarker,
  publicationOwnership,
  verifyPublicationOwnership,
  verifyPublicationRead,
  PublicationReadOperation,
} from "./publication-integrity.ts"
import type { PublicationMarker } from "./publication-integrity-state.ts"
import { creationMarkerProof } from "./publication-create-identity.ts"
import { pageId } from "./ref.ts"
import { canonical } from "./publication-effect-proof.ts"
import { publicationPropertiesMatch } from "./publication-observation.ts"
import {
  adoptionRefusal,
  adoptionTry,
  contentAdoptionOwnershipProperties,
  type ContentAdoptionEvidence,
  type ContentAdoptionPlan,
  type ContentAdoptionSourceInstallation,
} from "./publication-content-adoption-authority.ts"
import { contentAdoptionSourceField } from "./publication-content-adoption-source.ts"
import type { Receipt } from "./publication-model.ts"
import {
  publicationMetadataProperties,
  publicationSourcePropertiesComparison,
} from "./publication-source.ts"

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const query = (base: string, cursor?: string) =>
  `${base}?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
const ownerNames = [
  "Upstream",
  "Sync Mode",
  "Upstream Key",
  "Upstream Revision",
  "Published Hash",
  "Fork Baseline",
]
const managedFieldTypes: Readonly<Record<string, string>> = {
  Publication: "rich_text",
  Upstream: "relation",
  "Sync Mode": "select",
  "Upstream Key": "rich_text",
  "Upstream Revision": "rich_text",
  "Published Hash": "rich_text",
  "Fork Baseline": "rich_text",
}
function managedFields(raw: unknown) {
  const fields = property(property(raw).properties)
  for (const [name, kind] of Object.entries(managedFieldTypes)) {
    const field = property(fields[name])
    if (typeof field.id !== "string" || !field.id || field.type !== kind)
      throw adoptionRefusal("A required managed property identity or type is missing.")
  }
  return fields
}
const transport = (raw: unknown) => {
  const { request_id: _request, ...body } = property(raw)
  return body
}
const transportIdentityCompatible = (a: unknown, b: unknown) => {
  const x = property(a).request_id,
    y = property(b).request_id
  return x === y || (typeof x === "string" && !!x && typeof y === "string" && !!y)
}
const sameTransport = (a: unknown, b: unknown) =>
  transportIdentityCompatible(a, b) && canonical(transport(a)) === canonical(transport(b))
interface Attachment {
  readonly index: number
  readonly name: string
  readonly url: string
}
function attachments(raw: unknown): Attachment[] {
  const fields = Object.values(property(property(raw).properties))
    .map(property)
    .filter((field) => field.type === "files")
  if (fields.length > 1 || fields.some((field) => !Array.isArray(field.files)))
    throw adoptionRefusal("The Files property is ambiguous.")
  const values = fields[0]?.files
  if (!Array.isArray(values)) return []
  const result = values.map((value, index) => {
    const item = property(value),
      url = property(item[String(item.type)]).url
    if (
      !["file", "external"].includes(String(item.type)) ||
      typeof item.name !== "string" ||
      !item.name ||
      typeof url !== "string"
    )
      throw adoptionRefusal("A Files attachment is invalid.")
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
      throw adoptionRefusal("Files requires an exact HTTPS download URL.")
    return { index, name: item.name, url }
  })
  if (new Set(result.map((file) => file.name)).size !== result.length)
    throw adoptionRefusal("Files names repeat.")
  return result
}
/** URL/expiry are transport only after independent complete byte verification. */
function comparableMetadata(
  raw: unknown,
  root: boolean,
  changedRoot: boolean,
  changedOwnership = false,
  installedSource = false,
  sourceBinding?: Receipt["source_binding"],
) {
  const copy = structuredClone(transport(raw))
  if (root && changedRoot) {
    delete copy.last_edited_time
    delete copy.last_edited_by
  }
  const fields = property(copy.properties)
  if (root && installedSource) delete property(fields.Files).files
  if (root && changedRoot) {
    for (const name of ["Publication", ...(changedOwnership ? ownerNames : [])]) {
      const field = property(fields[name])
      delete field[managedFieldTypes[name]!]
    }
    if (changedOwnership && sourceBinding?.status === "bound")
      for (const raw of Object.values(fields)) {
        const field = property(raw)
        if (field.id === sourceBinding.source_type_id || field.id === sourceBinding.builtin_id_id)
          delete field[String(field.type)]
      }
  }
  for (const field of Object.values(fields).map(property)) {
    if (field.type !== "files" || !Array.isArray(field.files)) continue
    for (const value of field.files) {
      const item = property(value)
      if (item.type !== "file") continue
      const file = property(item.file)
      if (typeof file.url !== "string") throw adoptionRefusal("A hosted Files URL is missing.")
      file.url = "<verified-bytes>"
      if (Object.hasOwn(file, "expiry_time")) file.expiry_time = "<signed-expiry>"
    }
  }
  if (root && sourceBinding?.status === "bound")
    copy.properties = publicationSourcePropertiesComparison(sourceBinding, fields).map(
      ([key, field]) => [
        key,
        changedRoot
          ? contentAdoptionPropertyComparison(field, property(raw).last_edited_time)
          : field,
      ],
    )
  else if (root && changedRoot)
    copy.properties = Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        contentAdoptionPropertyComparison(field, property(raw).last_edited_time),
      ]),
    )
  return canonical(copy)
}

export interface ContentAdoptionReadBounds {
  readonly page_id: string
  readonly database_id: string
  readonly data_source_id: string
  readonly scope: string
  readonly portable: PortableSkill
  readonly intended_hash: string
  readonly old_marker: PublicationMarker
  readonly marker: PublicationMarker
  readonly planned_ownership: ContentAdoptionPlan["ownership"]
  readonly ownership?: ContentAdoptionPlan["ownership"]
  readonly evidence?: ContentAdoptionEvidence
  readonly changed_root?: boolean
  readonly source_installation?: ContentAdoptionSourceInstallation
  readonly source_installed?: boolean
  readonly descriptor_migration?: ContentAdoptionDescriptionPhase
  readonly metadata?: Pick<Receipt, "context" | "source_binding">
}
export interface ContentAdoptionReadProof {
  readonly evidence: ContentAdoptionEvidence
  readonly snapshot: Snapshot
  readonly raw: Readonly<Record<string, unknown>>
  readonly source_bytes_verified: boolean
}

export interface ContentAdoptionCaptureObservation {
  readonly raw: Readonly<Record<string, unknown>>
  readonly attachments: ContentAdoptionEvidence["attachments"]
  readonly page_ids: ContentAdoptionEvidence["page_ids"]
  readonly graph_sha256: string
}

/** Capture the complete bounded graph, metadata and attachment bytes without
 * publishing. The Snapshot and byte Store are private to this read phase.
 * This is not whole-body or complete authored-source verification:
 * readContentAdoptionProof performs those strict comparisons separately. */
export function readContentAdoptionCapture(bounds: ContentAdoptionReadBounds) {
  return Effect.gen(function* () {
    const originalApi = yield* Notion,
      store = yield* Store
    if ((yield* authScope) !== bounds.scope)
      return yield* Effect.fail(adoptionRefusal("Authentication scope changed."))
    const source = yield* explicitSource(bounds.database_id)
    if (!source.data_source_ids.includes(bounds.data_source_id))
      return yield* Effect.fail(adoptionRefusal("The original data source changed."))
    const raw: Record<string, unknown> = {},
      first: Record<string, unknown> = {}
    const allowed = new Set([`v1/pages/${bounds.page_id}`, `v1/pages/${bounds.page_id}/markdown`])
    const metadataPaths = new Set([`v1/pages/${bounds.page_id}`])
    const api: Notion["Service"] = {
      ...originalApi,
      request: (path, body, options) =>
        Effect.gen(function* () {
          if (
            (options?.method ?? (body === undefined ? "GET" : "POST")) !== "GET" ||
            body !== undefined ||
            options?.file ||
            !allowed.has(path)
          )
            return yield* Effect.fail(
              adoptionRefusal("The content proof tried to leave its exact read graph.", { path }),
            )
          const value = yield* originalApi.request(path, undefined, { method: "GET" })
          if (
            Object.hasOwn(first, path) &&
            !metadataPaths.has(path) &&
            !sameTransport(first[path], value)
          )
            return yield* Effect.fail(
              adoptionRefusal("A resource changed during the complete content proof.", { path }),
            )
          first[path] ??= structuredClone(value)
          raw[path] = value
          return value
        }),
    }
    const rootPath = `v1/pages/${bounds.page_id}`
    const before = yield* api.request(rootPath)
    if (bounds.descriptor_migration) {
      const phase = bounds.descriptor_migration,
        migration = phase.migration
      const original = { ...bounds.portable, description: migration.source_description }
      const derived = yield* adoptionTry(() =>
        deriveContentAdoptionDescriptionMigration(
          original,
          migration.source_intended_hash,
          bounds.old_marker,
          bounds.evidence?.raw[rootPath] ?? before,
        ),
      )
      if (
        !bounds.source_installation ||
        phase.restored !== !!bounds.changed_root ||
        (phase.restored && !bounds.evidence) ||
        canonical(derived) !== canonical(migration) ||
        bounds.portable.description !==
          (phase.restored ? migration.source_description : migration.legacy_description) ||
        bounds.intended_hash !==
          (phase.restored ? migration.source_intended_hash : migration.legacy_intended_hash) ||
        bounds.marker.intended_hash !== bounds.intended_hash ||
        !contentAdoptionDescriptionMatches(before, phase)
      )
        return yield* Effect.fail(
          adoptionRefusal(
            "The Description phase is not the exact declared source-bound migration.",
          ),
        )
    }
    const fields = yield* adoptionTry(() => managedFields(before))
    const root = property(before),
      parent = property(root.parent)
    if (
      root.id !== bounds.page_id ||
      root.archived === true ||
      root.in_trash === true ||
      parent.type !== "data_source_id" ||
      parent.data_source_id !== bounds.data_source_id ||
      parent.database_id !== bounds.database_id ||
      typeof root.last_edited_time !== "string"
    )
      return yield* Effect.fail(
        adoptionRefusal("The existing root identity, parent or revision changed."),
      )
    const record = yield* adoptionTry(() =>
      recordFromPage(decode(PageSchema, before), source, bounds.data_source_id),
    )
    if (
      record.kind !== "skill" ||
      bounds.portable.kind !== "skill" ||
      record.name !== bounds.portable.name ||
      record.description !== bounds.portable.description ||
      canonical(publicationMarker(before)) !== canonical(bounds.marker)
    )
      return yield* Effect.fail(
        adoptionRefusal("The exact existing skill or writing identity changed."),
      )
    if (bounds.ownership) {
      yield* verifyPublicationOwnership(before, bounds.ownership)
      const requested = bounds.metadata
        ? publicationMetadataProperties(bounds.metadata)
        : contentAdoptionOwnershipProperties({ ownership: bounds.ownership })
      if (!publicationPropertiesMatch(before, requested))
        return yield* Effect.fail(
          adoptionRefusal("Managed property values contain an unrequested change."),
        )
    } else if (
      canonical(publicationOwnership(before)) !==
      canonical({ upstream: [], mode: "", key: "", hash: "", revision: "", baseline: "" })
    )
      return yield* Effect.fail(adoptionRefusal("The existing page already has managed ownership."))
    // The structured marker above supplies the value authority. This preserves
    // its exact plain-text representation while refusing added links/formatting.
    if (
      bounds.changed_root &&
      !publicationPropertiesMatch(before, {
        Publication: {
          rich_text: [
            { type: "text", text: { content: text(property(fields.Publication).rich_text) } },
          ],
        },
      })
    )
      return yield* Effect.fail(
        adoptionRefusal("The marker contains an unrequested rich-text change."),
      )
    const allBlocks = new Set<string>([bounds.page_id])
    const children = new Map<string, string>()
    function walk(id: string, owner: string, depth: number): Effect.Effect<void, SkillsError> {
      return Effect.gen(function* () {
        if (depth > 100) return yield* Effect.fail(adoptionRefusal("The block tree is too deep."))
        let cursor: string | undefined
        const cursors = new Set<string>()
        for (let count = 0; count < 1000; count++) {
          const path = query(`v1/blocks/${id}/children`, cursor)
          allowed.add(path)
          const page = property(yield* api.request(path))
          if (!Array.isArray(page.results) || typeof page.has_more !== "boolean")
            return yield* Effect.fail(adoptionRefusal("The complete block inventory is invalid."))
          for (const entry of page.results) {
            const block = property(entry),
              parent = property(block.parent)
            if (
              typeof block.id !== "string" ||
              pageId(block.id) !== block.id ||
              allBlocks.has(block.id) ||
              typeof block.type !== "string" ||
              typeof block.has_children !== "boolean" ||
              block.archived === true ||
              block.in_trash === true ||
              !["page_id", "block_id"].includes(String(parent.type)) ||
              parent[String(parent.type)] !== id ||
              ["child_database", "synced_block"].includes(block.type)
            )
              return yield* Effect.fail(
                adoptionRefusal("A physical block leaves or contradicts the original graph."),
              )
            allBlocks.add(block.id)
            if (block.type === "child_page") {
              const title = property(block.child_page).title
              if (id !== bounds.page_id || owner !== bounds.page_id || typeof title !== "string")
                return yield* Effect.fail(
                  adoptionRefusal("An unregistered nested child page is present."),
                )
              children.set(block.id, title)
            } else if (block.has_children) yield* walk(block.id, owner, depth + 1)
          }
          if (!page.has_more) {
            if (page.next_cursor !== null && page.next_cursor !== undefined)
              return yield* Effect.fail(adoptionRefusal("A terminal block cursor is invalid."))
            return
          }
          if (
            typeof page.next_cursor !== "string" ||
            !page.next_cursor ||
            cursors.has(page.next_cursor)
          )
            return yield* Effect.fail(adoptionRefusal("A block cursor repeats or is missing."))
          cursor = page.next_cursor
          cursors.add(cursor)
        }
        return yield* Effect.fail(adoptionRefusal("The block inventory did not terminate."))
      })
    }
    yield* walk(bounds.page_id, bounds.page_id, 0)
    const field = property(property(root.properties).References)
    if (
      field.type !== "rich_text" ||
      typeof field.id !== "string" ||
      !field.id ||
      /[/?#&\\\s]/.test(field.id) ||
      !Array.isArray(field.rich_text)
    )
      return yield* Effect.fail(adoptionRefusal("The complete References property is required."))
    const entries: unknown[] = []
    let cursor: string | undefined
    const cursors = new Set<string>()
    let complete = false
    for (let count = 0; count < 1000; count++) {
      const path = query(`${rootPath}/properties/${field.id}`, cursor)
      allowed.add(path)
      const page = property(yield* api.request(path))
      if (page.object === "property_item") {
        if (
          count !== 0 ||
          page.id !== field.id ||
          page.type !== "rich_text" ||
          page.has_more === true ||
          page.next_cursor != null
        )
          return yield* Effect.fail(adoptionRefusal("The single References value is invalid."))
        entries.push(page.rich_text)
        complete = true
        break
      }
      if (
        page.object !== "list" ||
        !Array.isArray(page.results) ||
        typeof page.has_more !== "boolean" ||
        page.results.some(
          (item) =>
            property(item).object !== "property_item" ||
            property(item).type !== "rich_text" ||
            property(item).id !== field.id,
        )
      )
        return yield* Effect.fail(adoptionRefusal("The complete References item chain is invalid."))
      entries.push(...page.results.map((item) => property(item).rich_text))
      if (!page.has_more) {
        if (page.next_cursor !== null && page.next_cursor !== undefined)
          return yield* Effect.fail(adoptionRefusal("The terminal References cursor is invalid."))
        complete = true
        break
      }
      if (
        typeof page.next_cursor !== "string" ||
        !page.next_cursor ||
        cursors.has(page.next_cursor)
      )
        return yield* Effect.fail(adoptionRefusal("The References cursor repeats or is missing."))
      cursor = page.next_cursor
      cursors.add(cursor)
    }
    const links = decodeReferenceLinks({ rich_text: entries }, { readback: true })
    const paths = bounds.portable.files
      .filter((file) => file.path !== bounds.portable.main && /\.md$/i.test(file.path))
      .map((file) => file.path)
      .sort()
    if (
      !complete ||
      !links ||
      canonical(links.bindings.map((item) => item.path).sort()) !== canonical(paths) ||
      children.size !== links.bindings.length ||
      field.rich_text.length > entries.length ||
      canonical(field.rich_text) !== canonical(entries.slice(0, field.rich_text.length))
    )
      return yield* Effect.fail(
        adoptionRefusal("The full reference paths and physical child pages differ."),
      )
    for (const link of links.bindings) {
      if (
        ![
          link.path,
          ...(link.path.startsWith("references/") ? [link.path.slice("references/".length)] : []),
        ].includes(String(children.get(link.id)))
      )
        return yield* Effect.fail(adoptionRefusal("A reference title or ID changed."))
      const path = `v1/pages/${link.id}`
      allowed.add(path)
      allowed.add(path + "/markdown")
      metadataPaths.add(path)
      const child = property(yield* api.request(path)),
        parent = property(child.parent)
      const title = text(
        Object.values(property(child.properties))
          .map(property)
          .find((item) => item.type === "title")?.title,
      )
      if (
        child.id !== link.id ||
        child.archived === true ||
        child.in_trash === true ||
        typeof child.last_edited_time !== "string" ||
        parent.type !== "page_id" ||
        parent.page_id !== bounds.page_id ||
        ![
          link.path,
          ...(link.path.startsWith("references/") ? [link.path.slice("references/".length)] : []),
        ].includes(title)
      )
        return yield* Effect.fail(adoptionRefusal("A reference metadata identity changed."))
      yield* walk(link.id, link.id, 0)
    }
    const downloaded = new Map<string, Uint8Array>()
    const filesBefore = yield* adoptionTry(() => attachments(before))
    const pendingSource = !!bounds.source_installation && !bounds.source_installed
    if (bounds.source_installation) {
      const field = yield* adoptionTry(() =>
        contentAdoptionSourceField(before, bounds.source_installation),
      )
      if (
        pendingSource
          ? field.files.length !== 0 || !!bounds.ownership || bounds.marker.state === "committed"
          : field.files.length !== 1 ||
            property(field.files[0]).type !== "file" ||
            property(field.files[0]).name !== BUNDLE
      )
        return yield* Effect.fail(
          adoptionRefusal("Files is not the exact before/after of this source installation."),
        )
    }
    const downloadsAllowed = new Set(filesBefore.map((file) => file.url))
    const nativeFetch = yield* FetchHttpClient.Fetch
    const boundedFetch: typeof globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        options: Parameters<typeof globalThis.fetch>[1] = {},
      ) => {
        const url = String(input)
        if (
          !downloadsAllowed.has(url) ||
          (options.method ?? "GET") !== "GET" ||
          options.body !== undefined
        )
          throw adoptionRefusal("An attachment request leaves the observed Files set.")
        const response = await nativeFetch(input, { ...options, redirect: "error" })
        if (response.status < 200 || response.status >= 300) return response
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.length > 32 * 1024 * 1024)
          throw adoptionRefusal("An attachment exceeds the supported byte limit.")
        downloaded.set(url, bytes)
        return new Response([204, 205].includes(response.status) ? null : bytes.buffer, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      },
      {
        preconnect: () => {
          throw adoptionRefusal("Attachment preconnect is outside the bounded read phase.")
        },
      },
    )
    const graph = yield* readReferences(record, before).pipe(
      Effect.provideService(Notion, api),
      Effect.provideService(FetchHttpClient.Fetch, boundedFetch),
    )
    const fingerprint = (files: PortableSkill["files"]) =>
      files
        .map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const expected = fingerprint(bounds.portable.files)
    const sourceAttachment = filesBefore.find((file) => file.name === BUNDLE)
    if (sourceAttachment) {
      // A normal export may reconstruct edited archive text from the live page.
      // Prove the original archive entries before that source/live merge can run.
      const sourceBytes = downloaded.get(sourceAttachment.url)
      const preserved = graph.files.find((file) => file.path === BUNDLE)
      if (
        !sourceBytes ||
        !preserved ||
        sourceBytes.length !== preserved.bytes.length ||
        digest(sourceBytes) !== digest(preserved.bytes)
      )
        return yield* Effect.fail(
          adoptionRefusal("The source archive is not the exact freshly downloaded attachment."),
        )
      if (
        bounds.source_installation &&
        (sourceBytes.length !== bounds.source_installation.byte_length ||
          digest(sourceBytes) !== bounds.source_installation.sha256)
      )
        return yield* Effect.fail(
          adoptionRefusal(
            "The independently downloaded source archive differs from the planned upload bytes.",
          ),
        )
      const source = yield* adoptionTry(() => readPortable(readImportZip(sourceBytes)))
      if (
        !source ||
        source.kind !== "skill" ||
        source.name !== bounds.portable.name ||
        source.description !== bounds.portable.description ||
        source.main !== bounds.portable.main ||
        canonical(fingerprint(source.files)) !== canonical(expected)
      )
        return yield* Effect.fail(
          adoptionRefusal(
            "The downloaded source bundle differs from the original frozen portable bytes.",
            { path: BUNDLE },
          ),
        )
    }
    const graphPages = graph.pages.map((page) =>
      page.id === bounds.page_id ? { ...page, path: bounds.portable.main } : page,
    )
    if (
      bounds.source_installation &&
      (graphPages.length > 100 || (!pendingSource && !sourceAttachment))
    )
      return yield* Effect.fail(
        adoptionRefusal(
          "Source installation requires the complete bounded original page graph and its exact source archive.",
        ),
      )
    if (
      graphPages.length !== links.bindings.length + 1 ||
      new Set(graphPages.map((page) => page.id)).size !== graphPages.length ||
      graphPages.some(
        (page) =>
          page.blocks === undefined ||
          (page.id !== bounds.page_id &&
            !links.bindings.some((link) => link.id === page.id && link.path === page.path)),
      )
    )
      return yield* Effect.fail(
        adoptionRefusal("Formal reader lost complete physical root evidence."),
      )
    const rootMarkdown = graphPages.find((page) => page.id === bounds.page_id)?.markdown
    if (rootMarkdown === undefined)
      return yield* Effect.fail(adoptionRefusal("Root body is missing."))
    const tags = childPageTags(rootMarkdown).map((tag) =>
      /^<page\b[^>]*\burl="([^"]+)"[^>]*>([\s\S]*?)<\/page>$/.exec(tag),
    )
    if (
      tags.length !== children.size ||
      new Set(tags.map((tag) => tag && pageId(tag[1]!))).size !== tags.length ||
      tags.some((tag) => !tag || children.get(pageId(tag[1]!) ?? "") !== tag[2])
    )
      return yield* Effect.fail(
        adoptionRefusal("Root child-page tags differ from the complete physical graph."),
      )
    for (const page of graphPages) {
      const proof =
        page.id === bounds.page_id ? bounds.old_marker.creation : creationMarkerProof(page.markdown)
      if (!proof) continue
      if (bounds.descriptor_migration)
        return yield* Effect.fail(
          adoptionRefusal(
            "Description migration cannot reinterpret a retained root or reference creation identity.",
          ),
        )
      const file = bounds.portable.files.find((file) => file.path === page.path)
      if (
        !file ||
        proof.operation_id !== bounds.old_marker.operation_id ||
        proof.intended_hash !== bounds.intended_hash ||
        proof.scope !== bounds.scope ||
        proof.database_id !== bounds.database_id ||
        proof.data_source_id !== bounds.data_source_id ||
        proof.path !== page.path ||
        proof.source_sha256 !== (yield* sha256(file.bytes)) ||
        proof.role !== (page.id === bounds.page_id ? "content_root" : "reference") ||
        proof.parent_type !== (page.id === bounds.page_id ? "data_source_id" : "page_id") ||
        proof.parent_id !== (page.id === bounds.page_id ? bounds.data_source_id : bounds.page_id) ||
        (proof.subscription_id !== undefined &&
          proof.subscription_id !== bounds.planned_ownership.subscription_id) ||
        (proof.member_key !== undefined &&
          proof.member_key !== bounds.planned_ownership.member_key) ||
        (proof.subscription_id === undefined) !== (proof.member_key === undefined)
      )
        return yield* Effect.fail(
          adoptionRefusal(
            "A preserved creation identity contradicts the original source or graph.",
          ),
        )
    }
    const observedFiles = graph.files.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: digest(file.bytes),
    }))
    const bytes = new Map(graph.files.map((file) => [`objects/${digest(file.bytes)}`, file.bytes]))
    const memoryStore: Store["Service"] = {
      ...store,
      readBytes: (key) =>
        bytes.has(key)
          ? Effect.succeed(bytes.get(key)!.slice())
          : Effect.fail(adoptionRefusal("The formal export requested unobserved bytes.")),
    }
    const snapshot = yield* adoptionTry(() =>
      decode(SnapshotSchema, {
        snapshot_id: `s_${digest(new TextEncoder().encode(canonical([bounds.scope, record.id, graph.version_id])))}`,
        scope: bounds.scope,
        record,
        entrypoint: record.entrypoint,
        version_id: graph.version_id,
        created_at: 0,
        files: observedFiles,
        references: graph.pages,
        router_members: graph.members,
      }),
    )
    for (const path of metadataPaths) {
      const after = yield* api.request(path)
      if (
        !transportIdentityCompatible(first[path], after) ||
        comparableMetadata(first[path], false, false) !== comparableMetadata(after, false, false)
      )
        return yield* Effect.fail(
          adoptionRefusal("Full metadata changed during the content read.", { path }),
        )
      if (path !== rootPath && (yield* adoptionTry(() => attachments(after))).length)
        return yield* Effect.fail(adoptionRefusal("Reference child Files are unsupported."))
    }
    const filesAfter = yield* adoptionTry(() => attachments(raw[rootPath]))
    if (filesBefore.length !== filesAfter.length)
      return yield* Effect.fail(adoptionRefusal("Files changed during verification."))
    const attachmentProof: Array<{ index: number; name: string; bytes: number; sha256: string }> =
      []
    for (const [index, file] of filesBefore.entries()) {
      const after = filesAfter[index],
        original = downloaded.get(file.url)
      if (!after || after.name !== file.name || !original)
        return yield* Effect.fail(
          adoptionRefusal("An original attachment was not completely downloaded."),
        )
      if (after.url !== file.url) {
        downloadsAllowed.add(after.url)
        yield* readResignedAdoptionAttachment(boundedFetch, after.url, after.name)
      }
      const current = downloaded.get(after.url)
      if (!current || current.length !== original.length || digest(current) !== digest(original))
        return yield* Effect.fail(
          adoptionRefusal("Files bytes changed during their metadata bracket."),
        )
      attachmentProof.push({
        index,
        name: file.name,
        bytes: original.length,
        sha256: digest(original),
      })
    }
    const observation: ContentAdoptionCaptureObservation = {
      raw,
      attachments: attachmentProof,
      page_ids: graphPages.map((page) => page.id).sort(),
      graph_sha256: yield* sha256(
        canonical(
          graphPages.map((page) => ({
            id: page.id,
            path: page.path,
            markdown: page.markdown,
            blocks: page.blocks,
          })),
        ),
      ),
    }
    // This is the complete observed graph and attachment input, not a claim that
    // the live body or its exported portable agrees with the authored source.
    return {
      body_verified: false as const,
      source_bytes_verified: false as const,
      observation,
      snapshot,
      raw,
      pendingSource,
      expected,
      graphPages,
      metadataPaths,
      memoryStore,
      api,
    }
  })
}
export type ContentAdoptionCapture = Effect.Success<ReturnType<typeof readContentAdoptionCapture>>

/** Capture alone grants no write authority. The normal adoption path still
 * requires both original strict comparisons before it returns verified bytes. */
export function readContentAdoptionProof(bounds: ContentAdoptionReadBounds) {
  return Effect.gen(function* () {
    const capture = yield* readContentAdoptionCapture(bounds)
    const {
      observation,
      snapshot,
      raw,
      pendingSource,
      expected,
      graphPages,
      metadataPaths,
      memoryStore,
      api,
    } = capture
    const rootPath = `v1/pages/${bounds.page_id}`
    if (
      !(yield* referencePagesMatch(snapshot, bounds.portable).pipe(
        Effect.provideService(Store, memoryStore),
        Effect.mapError((error) =>
          error.code === "WRITE_VERIFICATION_FAILED"
            ? adoptionRefusal(
                "Complete live bodies or external destinations differ from the frozen source.",
                { cause: error.code, details: error.details },
              )
            : error,
        ),
      ))
    )
      return yield* Effect.fail(
        adoptionRefusal(
          "Complete live bodies or external destinations differ from the frozen source.",
        ),
      )
    if (!pendingSource) {
      const portable = yield* snapshotAuthoredPortable(snapshot).pipe(
        Effect.provideService(Store, memoryStore),
      )
      const actual = portable.files
        .map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      if (
        portable.kind !== "skill" ||
        canonical(actual) !== canonical(expected) ||
        (yield* portableIdentity(portable)) !== (yield* portableIdentity(bounds.portable))
      )
        return yield* Effect.fail(
          adoptionRefusal(
            "The exported complete portable bytes differ from the original candidate.",
          ),
        )
    }
    const evidence: ContentAdoptionEvidence = {
      ...observation,
      files: pendingSource ? [] : expected,
      ...(bounds.source_installation
        ? { source_proof: pendingSource ? ("not_installed" as const) : ("verified" as const) }
        : {}),
    }
    if (bounds.evidence) {
      const sourceTransition =
        !!bounds.source_installation &&
        bounds.evidence.source_proof === "not_installed" &&
        bounds.evidence.files.length === 0 &&
        bounds.evidence.attachments.length === 0 &&
        canonical(bounds.evidence.page_ids) === canonical(evidence.page_ids)
      if (bounds.source_installation && !sourceTransition)
        return yield* Effect.fail(
          adoptionRefusal(
            "The original missing-source evidence is not the immutable installation checkpoint.",
          ),
        )
      if (
        canonical(evidence.page_ids) !== canonical(bounds.evidence.page_ids) ||
        (!sourceTransition &&
          (canonical(evidence.files) !== canonical(bounds.evidence.files) ||
            canonical(evidence.attachments) !== canonical(bounds.evidence.attachments))) ||
        canonical(Object.keys(raw).sort()) !== canonical(Object.keys(bounds.evidence.raw).sort())
      )
        return yield* Effect.fail(
          adoptionRefusal("The complete retained content graph or Files bytes changed."),
        )
      for (const path of Object.keys(raw)) {
        const migrated =
          path === rootPath && bounds.descriptor_migration?.restored
            ? bounds.descriptor_migration
            : undefined
        const actualMetadata = migrated
          ? yield* adoptionTry(() => contentAdoptionDescriptionComparison(raw[path], migrated))
          : raw[path]
        const originalMetadata = migrated
          ? yield* adoptionTry(() =>
              contentAdoptionDescriptionComparison(bounds.evidence!.raw[path], {
                ...migrated,
                restored: false,
              }),
            )
          : bounds.evidence.raw[path]
        const same = metadataPaths.has(path)
          ? transportIdentityCompatible(raw[path], bounds.evidence.raw[path]) &&
            comparableMetadata(
              actualMetadata,
              path === rootPath,
              !!bounds.changed_root,
              !!bounds.ownership,
              sourceTransition && !pendingSource,
              bounds.metadata?.source_binding,
            ) ===
              comparableMetadata(
                originalMetadata,
                path === rootPath,
                !!bounds.changed_root,
                !!bounds.ownership,
                sourceTransition && !pendingSource,
                bounds.metadata?.source_binding,
              )
          : sameTransport(raw[path], bounds.evidence.raw[path])
        if (!same)
          return yield* Effect.fail(
            adoptionRefusal("An unrequested original field or physical resource changed.", {
              path,
            }),
          )
      }
      // Physical resources (including every descendant and Markdown response)
      // above remain exact before considering this finite projection change.
      if (evidence.graph_sha256 !== bounds.evidence.graph_sha256) {
        let priorMatches = false
        for (const prior of priorContentAdoptionGraphs(graphPages) ?? []) {
          if ((yield* sha256(canonical(prior.pages))) === bounds.evidence.graph_sha256) {
            priorMatches = true
            break
          }
        }
        if (!priorMatches)
          return yield* Effect.fail(
            adoptionRefusal("The complete retained content graph or Files bytes changed."),
          )
      }
    }
    if (bounds.marker.state === "committed")
      yield* verifyPublicationRead(raw[rootPath], snapshot).pipe(
        Effect.provideService(Notion, api),
        Effect.provideService(Store, memoryStore),
        Effect.provideService(PublicationReadOperation, bounds.marker.operation_id),
      )
    return {
      evidence,
      snapshot,
      raw,
      source_bytes_verified: !pendingSource,
    } satisfies ContentAdoptionReadProof
  })
}
