import { Effect } from "effect"
import { importDocument } from "./import.ts"
import { fail, property, SkillsError, text } from "./model.ts"
import type { Notion } from "./notion.ts"
import { normalizePath, pageId } from "./ref.ts"
import { childPageTags, pageMarkdown, rewritePageLinks, withoutChildPages } from "./references.ts"
import { samePublishedMarkdown } from "./markdown.ts"
import { publicationExternalLinksMatch } from "./publication-markdown.ts"
import { decodeReferenceLinks, type ReferenceBinding } from "./reference-links.ts"
import {
  creationMarkerBlock,
  creationMarkerProof,
  creationProofFromBody,
  creationProofMatchesIntent,
  withoutCreationMarker,
} from "./publication-create-identity.ts"
import {
  acknowledgedChildCreate,
  publicationMarkerAuthority,
  canonical,
} from "./publication-effect-proof.ts"
import { publicationMarker } from "./publication-integrity.ts"
import {
  capturePublicationRead,
  metadata,
  observation,
  publicationPropertiesMatch,
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "./publication-observation.ts"
import type { Receipt } from "./publication-model.ts"
import { sha256, Store } from "./store.ts"

type Intent = Receipt["intents"][number]
interface Child extends ReferenceBinding {
  readonly title: string
  readonly index: number
  readonly intent: Intent
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const keys = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).every((key) => allowed.includes(key))
function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw fail("PUBLICATION_UNRESOLVED", reason)
}
const bindings = (value: unknown) => decodeReferenceLinks(value, { readback: true })?.bindings
const childBindings = (children: readonly Child[]) =>
  children.map(({ path, id, url }) => ({ path, id, url }))

// A body ACK invalidates the old root inventory. This eligibility is the exact
// create/register/whole-body prefix which can stop before its first metadata ACK.
function originalSequence(receipt: Receipt) {
  const root = receipt.page_id,
    rootPath = `v1/pages/${root}`
  const inventory = `v1/blocks/${root}/children`
  if (
    receipt.operation !== "create" ||
    receipt.portable.kind !== "skill" ||
    receipt.conflict ||
    receipt.conflict_history !== undefined ||
    receipt.result !== undefined ||
    receipt.state === "completed" ||
    receipt.state === "prepared" ||
    receipt.context?.write_path !== undefined ||
    (receipt.context?.members?.length ?? 0) > 0 ||
    typeof root !== "string" ||
    !uuid.test(root) ||
    !receipt.scope ||
    !receipt.database_id ||
    !receipt.data_source_id ||
    Object.keys(receipt.guards).some(
      (path) => path === inventory || path.startsWith(inventory + "?"),
    ) ||
    !receipt.intents.length ||
    receipt.intents.some(
      (intent) =>
        intent.status !== "completed" ||
        intent.recovery !== undefined ||
        intent.artifact !== undefined ||
        intent.list_start_repair !== undefined ||
        intent.typed_links?.state === "pending" ||
        ["recovery", "superseded_by", "replayed_by_intent"].some((key) =>
          own(property(intent.response), key),
        ),
    )
  )
    return undefined
  const files = receipt.portable.files
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.filter((file) => file.path === receipt.portable.main).length !== 1 ||
    files.some(
      (file) => !hash.test(file.sha256) || !file.path || normalizePath(file.path) !== file.path,
    )
  )
    return undefined
  const references = files.filter(
    (file) => file.path !== receipt.portable.main && /^references\/.+\.md$/i.test(file.path),
  )
  const fields = property(property(receipt.guards[rootPath]).properties)
  const field = property(fields.References),
    referenceId = field.id
  const final = bindings({ rich_text: field.rich_text })
  if (
    field.type !== "rich_text" ||
    typeof referenceId !== "string" ||
    !referenceId ||
    /[/?#\\\s]/.test(referenceId) ||
    referenceId === "." ||
    referenceId === ".." ||
    field.has_more === true ||
    field.next_cursor != null ||
    !final ||
    final.length !== references.length ||
    !(rootPath + `/properties/${referenceId}?page_size=100` in receipt.guards)
  )
    return undefined
  const initial = receipt.intents[0]!,
    body = initial.body
  if (
    initial.method !== "POST" ||
    initial.path !== "v1/pages" ||
    property(initial.response).id !== root ||
    !keys(body, ["parent", "properties", "children"]) ||
    !same(body.parent, { type: "data_source_id", data_source_id: receipt.data_source_id }) ||
    !record(body.properties) ||
    !Object.keys(body.properties).length ||
    (body.children !== undefined && (!Array.isArray(body.children) || body.children.length !== 0))
  )
    return undefined
  const initialProperties = body.properties
  const initialReferenceKeys = Object.keys(initialProperties).filter(
    (key) => key === "References" || key === referenceId,
  )
  if (
    initialReferenceKeys.length > 1 ||
    initialReferenceKeys.some((key) => !same(bindings(initialProperties[key]), []))
  )
    return undefined
  const children: Child[] = [],
    bodies = new Map<string, Intent>()
  let registered = -1
  for (let index = 1; index < receipt.intents.length; index++) {
    const intent = receipt.intents[index]!,
      request = intent.body
    const id = property(intent.response).id
    if (intent.method === "POST" && intent.path === "v1/pages") {
      if (
        bodies.size ||
        (children.length && registered !== children.length) ||
        !keys(request, ["parent", "properties", "children"]) ||
        !same(request.parent, { type: "page_id", page_id: root }) ||
        !keys(request.properties, ["title"]) ||
        !keys(request.properties.title, ["title"]) ||
        !Array.isArray(request.properties.title.title) ||
        typeof id !== "string" ||
        !uuid.test(id) ||
        id === root ||
        children.some((child) => child.id === id)
      )
        return undefined
      const title = text(request.properties.title.title),
        path = "references/" + title
      if (
        !title ||
        !references.some((file) => file.path === path) ||
        children.some((child) => child.path === path)
      )
        return undefined
      children.push({
        id,
        path,
        title,
        index,
        intent,
        url: `https://www.notion.so/${id.replaceAll("-", "")}`,
      })
    } else if (intent.method === "PATCH" && intent.path === rootPath) {
      if (
        bodies.size ||
        id !== root ||
        !keys(request, ["properties"]) ||
        !record(request.properties)
      )
        return undefined
      const names = Object.keys(request.properties),
        key = names[0]
      if (
        names.length !== 1 ||
        key === undefined ||
        !["References", referenceId].includes(key) ||
        !same(bindings(request.properties[key]), childBindings(children))
      )
        return undefined
      registered = children.length
    } else {
      const owner = /^v1\/pages\/([^/]+)\/markdown$/.exec(intent.path)?.[1]
      if (
        intent.method !== "PATCH" ||
        owner === undefined ||
        id !== owner ||
        (owner !== root && !children.some((child) => child.id === owner)) ||
        bodies.has(owner) ||
        registered !== children.length ||
        children.length !== references.length ||
        !keys(request, ["markdown_version", "type", "replace_content"]) ||
        request.markdown_version !== "v2" ||
        request.type !== "replace_content" ||
        !keys(request.replace_content, ["new_str"]) ||
        typeof request.replace_content.new_str !== "string" ||
        (intent.typed_links !== undefined &&
          (intent.typed_links.page_id !== owner ||
            intent.typed_links.markdown !== request.replace_content.new_str))
      )
        return undefined
      bodies.set(owner, intent)
    }
  }
  if (
    registered !== references.length ||
    !same(final, childBindings(children)) ||
    bodies.size !== children.length + 1 ||
    receipt.intents.at(-1) !== bodies.get(root) ||
    children.some(
      (child) =>
        !bodies.has(child.id) ||
        !(`v1/blocks/${child.id}/children?page_size=100` in receipt.guards),
    )
  )
    return undefined
  return { root, rootPath, referenceId, initial, children, bodies }
}

const ordinaryTypes = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
  "column",
  "column_list",
  "divider",
  "breadcrumb",
  "table_of_contents",
  "table",
  "table_row",
  "image",
  "video",
  "audio",
  "file",
  "pdf",
  "bookmark",
  "embed",
  "equation",
  "link_preview",
  "link_to_page",
  "template",
])

/** A transient root-inventory proof for the ordinary resume preflight. The caller
 * holds the publication lock, has validated scope/source and still compares every
 * retained guard before entering the normal continuation. No receipt, guard,
 * intent, marker or recovery history is changed or persisted by this function.
 * A missing entire root inventory is supported; a partial retained chain is not.
 */
export function proveOriginalCreateRootInventory(receipt: Receipt, transport: Notion["Service"]) {
  return Effect.gen(function* () {
    const sequence = originalSequence(receipt)
    if (!sequence) return false
    const { root, rootPath, initial, children, bodies, referenceId } = sequence
    const original = canonical(receipt)
    const store = yield* Store
    const integrity = yield* store.integrity.inspect(receipt.operation_id)
    requireProof(
      integrity && integrity.marker.state === "writing",
      "Original writing integrity is unavailable.",
    )
    const files = new Map<string, Uint8Array>(),
      identities: Array<readonly [string, number, string]> = []
    for (const file of [...receipt.portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      requireProof(
        (yield* sha256(bytes)) === file.sha256,
        "An original frozen source object failed its content hash.",
      )
      files.set(file.path, bytes)
      identities.push([file.path, bytes.length, file.sha256])
    }
    requireProof(
      (yield* sha256(
        canonical([
          receipt.portable.kind,
          receipt.portable.name,
          receipt.portable.description,
          receipt.portable.main,
          identities,
        ]),
      )) === integrity.intended_hash,
      "Frozen source bytes differ from the original intended publication.",
    )
    const phase = publicationReadPhase()
    const api: Notion["Service"] = {
      ...transport,
      request: (path, body, options) => {
        if (body !== undefined || (options?.method !== undefined && options.method !== "GET"))
          return Effect.fail(
            fail("PUBLICATION_UNRESOLVED", "Root inventory proof permits GET requests only."),
          )
        return transport
          .request(path)
          .pipe(Effect.tap((raw) => Effect.sync(() => capturePublicationRead(phase, path, raw))))
      },
    }
    const pages = [
      { id: root, path: receipt.portable.main, markdown: "" },
      ...children.map((child) => ({ id: child.id, path: child.path, markdown: "" })),
    ]
    const validMetadata = (id: string, raw: unknown) => {
      const current = property(metadata(raw)),
        parent = property(current.parent)
      requireProof(
        current.id === id &&
          current.archived === false &&
          current.in_trash === false &&
          typeof current.last_edited_time === "string" &&
          current.last_edited_time.length > 0 &&
          (id === root
            ? parent.type === "data_source_id" && parent.data_source_id === receipt.data_source_id
            : parent.type === "page_id" && parent.page_id === root) &&
          record(current.properties) &&
          Object.values(current.properties).every(
            (value) =>
              record(value) &&
              value.has_more !== true &&
              (value.type !== "files" || (Array.isArray(value.files) && value.files.length === 0)),
          ),
        "A current page lacks the original complete, active metadata and empty resource checkpoint.",
      )
      if (!same(current, receipt.guards[`v1/pages/${id}`]))
        throw fail(
          "WRITE_CONFLICT",
          "Original page metadata changed during root inventory proof.",
          { path: `v1/pages/${id}` },
        )
      return current
    }
    for (const page of pages) validMetadata(page.id, yield* api.request(`v1/pages/${page.id}`))
    requireProof(
      publicationMarkerAuthority(receipt, phase.raw[rootPath], integrity, publicationMarker),
      "Original root creation and current writing marker do not have the same authority.",
    )
    const initialProperties = property(property(initial.body).properties)
    requireProof(
      publicationPropertiesMatch(
        phase.raw[rootPath],
        Object.fromEntries(
          Object.entries(initialProperties).filter(
            ([key]) => key !== "References" && key !== referenceId,
          ),
        ),
      ),
      "Original root create properties no longer match.",
    )
    for (const page of pages) {
      const path = `v1/pages/${page.id}/markdown`
      const raw = yield* api.request(path),
        actual = pageMarkdown(raw)
      if (actual !== receipt.guards[path])
        throw fail("WRITE_CONFLICT", "Original page body changed during root inventory proof.", {
          path,
        })
      if (page.id !== root) {
        const child = children.find((child) => child.id === page.id)!
        const body = property(child.intent.body),
          proof = creationProofFromBody(body)
        requireProof(
          publicationPropertiesMatch(phase.raw[`v1/pages/${page.id}`], body.properties),
          "Original child title properties no longer match.",
        )
        requireProof(
          proof
            ? proof.role === "reference" &&
                creationProofMatchesIntent(proof, receipt, child.index) &&
                proof.intended_hash === integrity.intended_hash &&
                same(body.children, [creationMarkerBlock(proof)]) &&
                same(creationMarkerProof(actual), proof)
            : (body.children === undefined ||
                (Array.isArray(body.children) && body.children.length === 0)) &&
                acknowledgedChildCreate(
                  receipt,
                  child.index,
                  phase.raw[`v1/pages/${page.id}`],
                  actual,
                  phase.raw[rootPath],
                ),
          "An original child lacks its exact creation identity and complete reference binding.",
        )
      }
    }
    const rootReferences = property(property(property(phase.raw[rootPath]).properties).References)
    requireProof(
      rootReferences.id === referenceId &&
        rootReferences.type === "rich_text" &&
        same(bindings({ rich_text: rootReferences.rich_text }), childBindings(children)),
      "The current full References field differs from all original child allocations.",
    )
    const propertyBase: string = `${rootPath}/properties/${referenceId}?page_size=100`
    const propertyPaths = Object.keys(receipt.guards).filter(
      (path) => path === propertyBase || path.startsWith(propertyBase + "&start_cursor="),
    )
    const visitedProperties = new Set<string>(),
      richText: unknown[] = []
    let itemPath: string = propertyBase
    for (;;) {
      requireProof(
        !visitedProperties.has(itemPath) &&
          visitedProperties.size < 1000 &&
          own(receipt.guards, itemPath),
        "The original References property chain is incomplete or cyclic.",
      )
      visitedProperties.add(itemPath)
      const raw: unknown = yield* api.request(itemPath)
      const response: Record<string, unknown> = property(raw)
      requireProof(
        same(observation(itemPath, raw), receipt.guards[itemPath]),
        "The complete current References property differs from its original checkpoint.",
      )
      if (response.object === "property_item") {
        requireProof(
          itemPath === propertyBase &&
            response.type === "rich_text" &&
            response.id === referenceId &&
            record(response.rich_text) &&
            response.has_more !== true &&
            response.next_cursor == null,
          "The single References property item is invalid.",
        )
        richText.push(response.rich_text)
        break
      }
      requireProof(
        response.object === "list" &&
          response.type === "property_item" &&
          Array.isArray(response.results) &&
          typeof response.has_more === "boolean",
        "The References property list is incomplete.",
      )
      for (const item of response.results) {
        requireProof(
          record(item) &&
            item.object === "property_item" &&
            item.type === "rich_text" &&
            item.id === referenceId &&
            record(item.rich_text),
          "A References property item is invalid.",
        )
        richText.push(item.rich_text)
      }
      if (!response.has_more) {
        requireProof(
          response.next_cursor == null,
          "References pagination did not terminate completely.",
        )
        break
      }
      requireProof(
        typeof response.next_cursor === "string" && response.next_cursor.length > 0,
        "References pagination lacks its next cursor.",
      )
      itemPath = propertyBase + "&start_cursor=" + encodeURIComponent(response.next_cursor)
    }
    requireProof(
      visitedProperties.size === propertyPaths.length &&
        propertyPaths.every((path) => visitedProperties.has(path)) &&
        same(bindings({ rich_text: richText }), childBindings(children)),
      "The complete original and current References property chains differ from the source binding.",
    )

    const seenBlocks = new Set<string>(pages.map((page) => page.id)),
      rootChildren: unknown[] = []
    const visit = (
      owner: string,
      parentType: "page_id" | "block_id",
      depth: number,
    ): Effect.Effect<void, SkillsError> =>
      Effect.gen(function* () {
        requireProof(depth <= 100, "Root inventory nesting exceeds the owned scope.")
        const base: string = `v1/blocks/${owner}/children?page_size=100`
        const cursors = new Set<string>()
        let path: string = base
        for (;;) {
          requireProof(
            !cursors.has(path) && cursors.size < 1000,
            "Root inventory pagination is cyclic or unbounded.",
          )
          cursors.add(path)
          const response = property(yield* api.request(path))
          requireProof(
            Array.isArray(response.results) && typeof response.has_more === "boolean",
            "Root inventory is incomplete.",
          )
          for (const block of response.results) {
            requireProof(
              record(block) &&
                typeof block.id === "string" &&
                uuid.test(block.id) &&
                typeof block.type === "string" &&
                record(block[block.type]) &&
                typeof block.has_children === "boolean" &&
                block.archived !== true &&
                block.in_trash !== true &&
                record(block.parent) &&
                same(block.parent, { type: parentType, [parentType]: owner }),
              "A current root block lacks an active exact owned parent.",
            )
            if (block.type === "child_page") {
              requireProof(
                owner === root &&
                  parentType === "page_id" &&
                  children.some((child) => child.id === block.id) &&
                  !rootChildren.some((value) => property(value).id === block.id),
                "An extra or repeated child page is outside the original create graph.",
              )
              rootChildren.push({ id: block.id, type: "child_page", child_page: block.child_page })
              continue
            }
            requireProof(
              ordinaryTypes.has(block.type) && !seenBlocks.has(block.id),
              "An unsupported or repeated block is outside the original create graph.",
            )
            seenBlocks.add(block.id)
            if (block.has_children) yield* visit(block.id, "block_id", depth + 1)
          }
          if (!response.has_more) {
            requireProof(
              response.next_cursor == null,
              "Root inventory pagination did not terminate completely.",
            )
            break
          }
          requireProof(
            typeof response.next_cursor === "string" && response.next_cursor.length > 0,
            "Root inventory lacks its next cursor.",
          )
          path = base + "&start_cursor=" + encodeURIComponent(response.next_cursor)
        }
      })
    yield* visit(root, "page_id", 0)
    requireProof(
      same(
        rootChildren,
        children.map((child) => ({
          id: child.id,
          type: "child_page",
          child_page: { title: child.title },
        })),
      ),
      "The complete fresh root inventory differs from the original ordered child allocations.",
    )
    for (const page of pages) {
      const intent = bodies.get(page.id)!,
        target = String(property(property(intent.body).replace_content).new_str)
      const authored =
        page.id === root
          ? importDocument({ path: page.path, bytes: files.get(page.path)! }, receipt.portable).body
          : new TextDecoder("utf-8", { fatal: true }).decode(files.get(page.path)!)
      requireProof(
        childPageTags(authored).length === 0,
        "Authored child-page markup cannot establish this root inventory checkpoint.",
      )
      requireProof(
        page.id !== root || creationMarkerProof(target) === undefined,
        "An original root body contains a child creation marker.",
      )
      const tags = childPageTags(target)
      requireProof(
        page.id === root
          ? tags.length === children.length &&
              tags.every((tag, index) => {
                const match =
                  /^<page url="(https:\/\/(?:www\.notion\.so|app\.notion\.com\/p)\/[a-f0-9]{32})">([^<]*)<\/page>$/.exec(
                    tag,
                  )
                return (
                  match &&
                  pageId(match[1]!) === children[index]!.id &&
                  match[2] === children[index]!.title
                )
              })
          : tags.length === 0,
        "Original whole-body child-page tags differ from the complete create graph.",
      )
      const sourceTarget = rewritePageLinks(authored, page.path, pages, "notion")
      const authoredTarget = withoutCreationMarker(tags.length ? withoutChildPages(target) : target)
      requireProof(
        samePublishedMarkdown(authoredTarget, sourceTarget) &&
          publicationExternalLinksMatch(authoredTarget, sourceTarget, (value) => value),
        "An original whole-body ACK differs from its complete frozen source.",
      )
      const map = (value: string, preserveExternalUrls = false) =>
        rewritePageLinks(withoutChildPages(value), page.path, pages, "local", [], {
          preserveExternalUrls,
        })
      requireProof(
        yield* readPublicationMarkdownMatches(
          intent,
          pageMarkdown(phase.raw[intent.path]),
          map(target),
          api,
          phase,
          { local: (value) => map(value), preserveExternal: (value) => map(value, true) },
          true,
        ),
        "An original whole-body ACK lacks the current complete structure and destination proof.",
      )
    }
    for (const page of pages) validMetadata(page.id, yield* api.request(`v1/pages/${page.id}`))
    requireProof(
      same(integrity, yield* store.integrity.inspect(receipt.operation_id)) &&
        canonical(receipt) === original,
      "Original root inventory evidence changed during the read-only proof.",
    )
    return true
  }).pipe(
    Effect.catchDefect((error) =>
      Effect.fail(
        error instanceof SkillsError
          ? error
          : fail("PUBLICATION_UNRESOLVED", "Original root inventory evidence is invalid."),
      ),
    ),
  )
}
