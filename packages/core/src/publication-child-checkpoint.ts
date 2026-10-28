import { Effect } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { fail, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId, normalizePath } from "./ref.ts"
import { childPageTags, pageMarkdown } from "./references.ts"
import {
  creationMarkerBlock,
  creationMarkerProof,
  creationProofFromBody,
  creationProofMatchesIntent,
  withoutCreationMarker,
} from "./publication-create-identity.ts"
import {
  acknowledgedRootCreate,
  canonical,
  publicationMarkerAuthority,
} from "./publication-effect-proof.ts"
import { publicationMarker } from "./publication-integrity.ts"
import { PublicationReceiptSchema, type Receipt } from "./publication-model.ts"
import {
  metadata,
  metadataContent,
  observation,
  publicationPropertiesMatch,
} from "./publication-observation.ts"
import { Store, sha256 } from "./store.ts"
import { referenceLinks } from "./reference-links.ts"

type Intent = Receipt["intents"][number]
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const blank = /^[ \t\r\n]*$/
const trimOuter = (value: string) => value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "")
function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition) throw fail("PUBLICATION_CHILD_CHECKPOINT_UNPROVEN", message)
}
const attempt = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "PUBLICATION_CHILD_CHECKPOINT_UNPROVEN",
            "Completed child checkpoint evidence is invalid.",
          ),
  })

interface Child {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly intent_index: number
  readonly intent: Intent
}

/** Audit evidence only. A stored copy must never authorize a later guard refresh. */
export interface CompletedChildCheckpointEvidence {
  readonly version: 1
  readonly operation_id: string
  readonly page_id: string
  readonly child_id: string
  readonly intent_index: number
  readonly intent_sha256: string
  readonly receipt_sha256: string
  readonly intended_hash: string
  readonly integrity_sha256: string
  readonly guard_paths: readonly string[]
  readonly guards_sha256: string
  readonly checkpoint: {
    readonly path: string
    readonly before: string
    readonly after: string
  }
  readonly inventory_sha256: string
  readonly references_sha256: string
  readonly metadata_brackets: readonly {
    readonly page_id: string
    readonly before_sha256: string
    readonly after_sha256: string
  }[]
}

export interface CompletedChildParentCheckpoint {
  readonly outcome: "needs_safe_resume"
  readonly verified: false
  readonly before_guards: Readonly<Record<string, unknown>>
  readonly checkpoint: CompletedChildCheckpointEvidence["checkpoint"]
  readonly evidence: CompletedChildCheckpointEvidence
}

function allocationSequence(receipt: Receipt) {
  const root = receipt.page_id
  requireProof(
    receipt.operation === "create" &&
      receipt.conflict === true &&
      !receipt.owner &&
      receipt.state !== "completed" &&
      receipt.state !== "prepared" &&
      receipt.result === undefined &&
      typeof root === "string" &&
      uuid.test(root) &&
      receipt.scope &&
      receipt.database_id &&
      receipt.data_source_id &&
      receipt.context?.write_path === undefined,
    "Checkpoint catch-up requires the original unfinished fenced create.",
  )
  requireProof(
    receipt.intents.length >= 2 &&
      receipt.intents.length % 2 === 0 &&
      receipt.intents.every(
        (intent) =>
          intent.status === "completed" &&
          !intent.recovery &&
          !intent.typed_links &&
          !intent.artifact &&
          !intent.list_start_repair &&
          property(intent.response).recovery === undefined &&
          property(intent.response).superseded_by === undefined &&
          property(intent.response).replayed_by_intent === undefined,
      ),
    "Only a completed create/register sequence ending at its original child ACK is supported.",
  )
  const original = receipt.intents[0]!
  const rootBody = property(original.body)
  requireProof(
    original.method === "POST" &&
      original.path === "v1/pages" &&
      property(original.response).id === root &&
      canonical(rootBody.parent) ===
        canonical({ type: "data_source_id", data_source_id: receipt.data_source_id }) &&
      Object.keys(rootBody).every((key) => ["parent", "properties", "children"].includes(key)) &&
      Object.keys(property(rootBody.properties)).length > 0 &&
      (rootBody.children === undefined ||
        (Array.isArray(rootBody.children) && rootBody.children.length === 0)),
    "The original root ACK must create this empty bound parent.",
  )
  const fields = property(property(receipt.guards[`v1/pages/${root}`]).properties)
  const references = property(fields.References)
  requireProof(
    references.type === "rich_text" &&
      typeof references.id === "string" &&
      references.id.length > 0 &&
      !/[/?#]/.test(references.id) &&
      Array.isArray(references.rich_text),
    "The original parent must retain its References field identity.",
  )
  const referenceFiles = receipt.portable.files
    .filter((file) => file.path !== receipt.portable.main && /\.md$/i.test(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const children: Child[] = []
  for (let index = 1; index < receipt.intents.length; index += 2) {
    const intent = receipt.intents[index]!
    const body = property(intent.body)
    const id = property(intent.response).id
    const props = property(body.properties)
    const titleField = property(props.title)
    const title = text(titleField.title)
    const path = receipt.portable.files.some((file) => file.path === title)
      ? title
      : `references/${title}`
    const proof = creationProofFromBody(body)
    requireProof(
      intent.method === "POST" &&
        intent.path === "v1/pages" &&
        typeof id === "string" &&
        uuid.test(id) &&
        id !== root &&
        !children.some((child) => child.id === id) &&
        canonical(body.parent) === canonical({ type: "page_id", page_id: root }) &&
        Object.keys(body).every((key) => ["parent", "properties", "children"].includes(key)) &&
        Object.keys(props).length === 1 &&
        Object.keys(titleField).length === 1 &&
        Array.isArray(titleField.title) &&
        title.length > 0 &&
        referenceFiles[children.length]?.path === path &&
        proof !== undefined &&
        proof.role === "reference" &&
        creationProofMatchesIntent(proof, receipt, index) &&
        canonical(body.children) === canonical([creationMarkerBlock(proof)]),
      "A child ACK, source path, title, parent or original creation marker differs.",
    )
    children.push({ id, title, path, intent_index: index, intent })
    if (index + 1 === receipt.intents.length) continue
    const register = receipt.intents[index + 1]!
    const registration = property(register.body)
    const requested = property(registration.properties)
    const keys = Object.keys(requested)
    requireProof(
      register.method === "PATCH" &&
        register.path === `v1/pages/${root}` &&
        property(register.response).id === root &&
        Object.keys(registration).length === 1 &&
        keys.length === 1 &&
        (keys[0] === "References" || keys[0] === references.id) &&
        canonical(requested[keys[0]!]) === canonical(referenceValue(children)),
      "Registration must bind exactly the preceding original child prefix.",
    )
  }
  requireProof(
    children.length > 0 && children.at(-1)!.intent_index === receipt.intents.length - 1,
    "There is no unique final unregistered child ACK.",
  )
  return { root, original, children, reference_id: references.id }
}

function referenceValue(children: readonly Child[]) {
  const value = referenceLinks(children)
  requireProof(
    value !== undefined,
    "The complete References prefix exceeds the supported representation.",
  )
  return value
}

function validMetadata(raw: unknown, id: string) {
  const page = property(raw)
  requireProof(
    page.id === id &&
      typeof page.last_edited_time === "string" &&
      page.last_edited_time.length > 0 &&
      page.properties !== null &&
      typeof page.properties === "object" &&
      !Array.isArray(page.properties) &&
      page.archived !== true &&
      page.in_trash !== true,
    "A page lacks complete current metadata identity.",
  )
  for (const value of Object.values(property(page.properties))) {
    const field = property(value)
    requireProof(field.has_more !== true, "A page property is incomplete.")
    if (field.type === "files" || "files" in field)
      requireProof(
        Array.isArray(field.files) &&
          field.files.every(
            (file) => typeof property(file).id === "string" && String(property(file).id).length > 0,
          ),
        "A retained attachment lacks stable identity.",
      )
  }
  return metadata(raw)
}

function parentTagCheckpoint(before: string, after: string, children: readonly Child[]) {
  const inspect = (markdown: string, expected: readonly Child[]) => {
    const tags = childPageTags(markdown)
    let remainder = markdown
    requireProof(
      tags.length === expected.length,
      "Parent child tags do not match the complete original order.",
    )
    for (const [index, tag] of tags.entries()) {
      const child = expected[index]!
      const match =
        /^<page[ \t\r\n]+url="(https:\/\/(?:(?:www\.)?notion\.so\/|app\.notion\.com\/p\/)[a-f0-9-]+)"[ \t\r\n]*>([\s\S]*)<\/page>$/.exec(
          tag,
        )
      const escaped = child.title
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
      requireProof(
        match &&
          pageId(match[1]!) === child.id &&
          (match[2] === child.title || match[2] === escaped),
        "A parent tag differs from its exact ACK child and title.",
      )
      remainder = remainder.replace(tag, "")
    }
    requireProof(blank.test(remainder), "A parent contains content beyond its original child tags.")
    return tags
  }
  const old = inspect(before, children.slice(0, -1))
  const current = inspect(after, children)
  requireProof(
    old.every((tag, index) => tag === current[index]) &&
      trimOuter(after.replace(current.at(-1)!, "")) === trimOuter(before),
    "The final ACK tag is not the sole parent change apart from outer whitespace.",
  )
}

/** Run under the original operation lock and consume immediately in that same
 * reconciliation phase. This performs GETs only and never changes a receipt,
 * guard, intent, owner or fence. It proves one checkpoint, not publication completion. */
export function proveCompletedChildParentCheckpoint(
  receipt: Receipt,
  transport: Notion["Service"],
) {
  return Effect.gen(function* () {
    const original = structuredClone(receipt)
    const retained = canonical(original)
    const sequence = yield* attempt(() => allocationSequence(original))
    const { root, children } = sequence
    const last = children.at(-1)!
    const rootPath = `v1/pages/${root}`
    const bodyPath = `${rootPath}/markdown`
    const propertyBase = `${rootPath}/properties/${sequence.reference_id}?page_size=100`
    const ids = [root, ...children.map((child) => child.id)]
    const pageIds = new Set(ids)
    const store = yield* Store
    const receiptKey = `publications/${original.operation_id}.json`
    const readApi: Notion["Service"] = {
      ...transport,
      request: (path, body, options) => {
        if (
          body !== undefined ||
          options?.file !== undefined ||
          (options?.method !== undefined && options.method !== "GET")
        )
          return Effect.fail(
            fail(
              "PUBLICATION_CHILD_CHECKPOINT_UNPROVEN",
              "Checkpoint proof permits GET requests only.",
            ),
          )
        return transport.request(path, undefined, { method: "GET" })
      },
    }
    const checkLocal = () =>
      Effect.gen(function* () {
        const current = yield* store.readJson(receiptKey, PublicationReceiptSchema)
        requireProof(
          current !== undefined &&
            canonical(current) === retained &&
            canonical(receipt) === retained,
          "The original publication receipt changed during checkpoint proof.",
        )
        const integrity = yield* store.integrity.inspect(original.operation_id)
        requireProof(
          integrity &&
            integrity.operation_id === original.operation_id &&
            integrity.marker.state === "writing",
          "The original writing integrity ledger is missing or changed.",
        )
        const files: Array<readonly [string, number, string]> = []
        const seen = new Set<string>()
        for (const file of [...original.portable.files].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        )) {
          requireProof(
            file.path.length > 0 &&
              normalizePath(file.path) === file.path &&
              !seen.has(file.path) &&
              hash.test(file.sha256),
            "Frozen source paths or object identities are invalid.",
          )
          seen.add(file.path)
          const bytes = yield* store.readBytes(`objects/${file.sha256}`)
          requireProof(
            (yield* sha256(bytes)) === file.sha256,
            "An original frozen source object failed its hash.",
          )
          files.push([file.path, bytes.length, file.sha256])
        }
        requireProof(
          seen.has(original.portable.main) &&
            (yield* sha256(
              canonical([
                original.portable.kind,
                original.portable.name,
                original.portable.description,
                original.portable.main,
                files,
              ]),
            )) === integrity.intended_hash,
          "Frozen source bytes differ from the original intended publication.",
        )
        return integrity
      }).pipe(
        Effect.catchDefect((error) =>
          Effect.fail(
            error instanceof SkillsError
              ? error
              : fail(
                  "PUBLICATION_CHILD_CHECKPOINT_UNPROVEN",
                  "Original local checkpoint evidence could not be proved.",
                ),
          ),
        ),
      )
    const integrity = yield* checkLocal()
    const scope = yield* authScope.pipe(Effect.provideService(Notion, readApi))
    const source = yield* explicitSource(original.database_id!).pipe(
      Effect.provideService(Notion, readApi),
    )
    yield* attempt(() =>
      requireProof(
        scope === original.scope && source.data_source_ids.includes(original.data_source_id!),
        "The original credential or content source no longer matches.",
      ),
    )
    const raw: Record<string, unknown> = {}
    const fetch = (path: string) =>
      Effect.gen(function* () {
        if (Object.hasOwn(raw, path)) return raw[path]
        const value = yield* readApi.request(path)
        raw[path] = value
        return value
      })
    const before: Record<string, unknown> = {}
    for (const id of ids) {
      const path = `v1/pages/${id}`
      before[id] = yield* attempt(() => validMetadata(original.guards[path], id))
      const current = yield* fetch(path)
      yield* attempt(() =>
        requireProof(
          canonical(validMetadata(current, id)) === canonical(before[id]),
          "A retained page metadata guard differs before checkpoint sampling.",
        ),
      )
    }
    const allowed = (path: string) => {
      const page = /^v1\/pages\/([a-f0-9-]+)(\/markdown)?$/.exec(path)
      if (page) return pageIds.has(page[1]!)
      const inventory =
        /^v1\/blocks\/([a-f0-9-]+)\/children\?page_size=100(?:&start_cursor=[A-Za-z0-9%_.~-]+)?$/.exec(
          path,
        )
      if (inventory) return pageIds.has(inventory[1]!)
      return (
        path === propertyBase ||
        (path.startsWith(`${propertyBase}&start_cursor=`) &&
          /^[A-Za-z0-9%_.~-]+$/.test(path.slice(`${propertyBase}&start_cursor=`.length)))
      )
    }
    yield* attempt(() =>
      requireProof(
        Object.keys(original.guards).every(allowed) &&
          ids.every(
            (id) =>
              typeof original.guards[`v1/pages/${id}/markdown`] === "string" &&
              Object.hasOwn(original.guards, `v1/blocks/${id}/children?page_size=100`),
          ),
        "Original page guards are missing or include an unrelated dependency.",
      ),
    )
    for (const path of Object.keys(original.guards)) yield* fetch(path)
    const paginate = (base: string, propertyItems = false) =>
      Effect.gen(function* () {
        const values: unknown[] = []
        const cursors = new Set<string>()
        const visited = new Set<string>()
        let path = base
        while (true) {
          visited.add(path)
          requireProof(
            !Object.hasOwn(original.guards, base) || Object.hasOwn(original.guards, path),
            "The retained graph inventory is missing a pagination guard.",
          )
          const response = property(yield* fetch(path))
          if (propertyItems && response.object === "property_item") {
            requireProof(
              path === base &&
                values.length === 0 &&
                response.type === "rich_text" &&
                response.rich_text !== undefined &&
                response.has_more !== true &&
                (response.next_cursor === null || response.next_cursor === undefined),
              "The References property has an incomplete single-item response.",
            )
            values.push(response.rich_text)
            break
          }
          requireProof(
            Array.isArray(response.results) && typeof response.has_more === "boolean",
            "A current graph inventory is incomplete.",
          )
          values.push(
            ...(propertyItems
              ? response.results.map((item) => property(item).rich_text)
              : response.results),
          )
          requireProof(
            values.length <= 10_000,
            "A current graph inventory exceeds the supported bound.",
          )
          if (!response.has_more) {
            requireProof(
              response.next_cursor === null || response.next_cursor === undefined,
              "A completed graph page retains an unexpected cursor.",
            )
            break
          }
          requireProof(
            typeof response.next_cursor === "string" &&
              response.next_cursor.length > 0 &&
              !cursors.has(response.next_cursor),
            "A current graph inventory has partial or repeated pagination.",
          )
          cursors.add(response.next_cursor)
          requireProof(
            cursors.size <= 1000,
            "A current graph inventory exceeds the pagination bound.",
          )
          path = `${base}&start_cursor=${encodeURIComponent(response.next_cursor)}`
        }
        requireProof(
          Object.keys(original.guards)
            .filter((key) => key === base || key.startsWith(`${base}&start_cursor=`))
            .every((key) => visited.has(key)),
          "A retained pagination guard is outside the complete current inventory.",
        )
        return values
      }).pipe(
        Effect.catchDefect((error) =>
          Effect.fail(
            error instanceof SkillsError
              ? error
              : fail(
                  "PUBLICATION_CHILD_CHECKPOINT_UNPROVEN",
                  "Current graph pagination could not be proved.",
                ),
          ),
        ),
      )
    const inventory = yield* paginate(`v1/blocks/${root}/children?page_size=100`)
    for (const child of children) yield* paginate(`v1/blocks/${child.id}/children?page_size=100`)
    const references = yield* paginate(propertyBase, true)
    const observed: Record<string, unknown> = {}
    yield* attempt(() => {
      for (const [path, expected] of Object.entries(original.guards)) {
        observed[path] = observation(path, raw[path])
        requireProof(
          path === bodyPath ||
            (observed[path] !== undefined && canonical(observed[path]) === canonical(expected)),
          "Another original publication guard differs from current evidence.",
        )
      }
      requireProof(
        publicationMarkerAuthority(original, raw[rootPath], integrity, publicationMarker),
        "The root no longer retains its original writing marker and allocation identity.",
      )
      const rootProof = creationProofFromBody(sequence.original.body)
      requireProof(
        rootProof
          ? rootProof.role === "content_root" &&
              creationProofMatchesIntent(rootProof, original, 0) &&
              rootProof.intended_hash === integrity.intended_hash
          : acknowledgedRootCreate(original, raw[rootPath], integrity, publicationMarker) === 0,
        "The original root creation proof differs from its frozen source.",
      )
      requireProof(
        property(property(raw[rootPath]).parent).data_source_id === original.data_source_id &&
          canonical(metadataContent(observed[rootPath])) ===
            canonical(metadataContent(original.guards[rootPath])),
        "The parent metadata or source changed alongside its child tag.",
      )
      requireProof(
        inventory.length === children.length &&
          inventory.every((item, index) => {
            const block = property(item)
            const child = children[index]!
            return (
              block.id === child.id &&
              block.type === "child_page" &&
              property(block.parent).type === "page_id" &&
              property(block.parent).page_id === root &&
              property(block.child_page).title === child.title &&
              block.archived !== true &&
              block.in_trash !== true
            )
          }),
        "The complete parent inventory differs from the original child ACK order.",
      )
      requireProof(
        publicationPropertiesMatch(raw[rootPath], {
          References: referenceValue(children.slice(0, -1)),
        }) &&
          publicationPropertiesMatch(
            { properties: { References: { rich_text: references } } },
            { References: referenceValue(children.slice(0, -1)) },
          ),
        "The parent References field is not exactly the registered original child prefix.",
      )
      const rootRequested = property(property(sequence.original.body).properties)
      const unchangedRequested = Object.fromEntries(
        Object.entries(rootRequested).filter(
          ([key]) => key !== "References" && key !== sequence.reference_id,
        ),
      )
      requireProof(
        publicationPropertiesMatch(raw[rootPath], unchangedRequested),
        "The current root differs from its originally requested fields.",
      )
      for (const child of children) {
        const page = property(raw[`v1/pages/${child.id}`])
        const titleFields = Object.values(property(page.properties))
          .map(property)
          .filter((field) => field.type === "title")
        const markdown = pageMarkdown(raw[`v1/pages/${child.id}/markdown`])
        const proof = creationProofFromBody(child.intent.body)!
        requireProof(
          page.id === child.id &&
            property(page.parent).type === "page_id" &&
            property(page.parent).page_id === root &&
            titleFields.length === 1 &&
            text(titleFields[0]!.title) === child.title &&
            proof.intended_hash === integrity.intended_hash &&
            canonical(creationMarkerProof(markdown)) === canonical(proof) &&
            blank.test(withoutCreationMarker(markdown)),
          "A current child differs from its original parent, title, marker or empty allocation body.",
        )
      }
      parentTagCheckpoint(String(original.guards[bodyPath]), pageMarkdown(raw[bodyPath]), children)
    })
    const brackets: CompletedChildCheckpointEvidence["metadata_brackets"][number][] = []
    for (const id of ids) {
      const current = yield* readApi.request(`v1/pages/${id}`)
      const after = yield* attempt(() => validMetadata(current, id))
      yield* attempt(() =>
        requireProof(
          canonical(after) === canonical(before[id]),
          "A page revision changed across checkpoint sampling.",
        ),
      )
      brackets.push({
        page_id: id,
        before_sha256: yield* sha256(canonical(before[id])),
        after_sha256: yield* sha256(canonical(after)),
      })
    }
    const finalScope = yield* authScope.pipe(Effect.provideService(Notion, readApi))
    const finalSource = yield* explicitSource(original.database_id!).pipe(
      Effect.provideService(Notion, readApi),
    )
    const finalIntegrity = yield* checkLocal()
    yield* attempt(() =>
      requireProof(
        finalScope === scope &&
          canonical(finalSource) === canonical(source) &&
          canonical(finalIntegrity) === canonical(integrity),
        "Original source authority changed during checkpoint proof.",
      ),
    )
    const checkpoint = {
      path: bodyPath,
      before: String(original.guards[bodyPath]),
      after: pageMarkdown(raw[bodyPath]),
    }
    const evidence: CompletedChildCheckpointEvidence = {
      version: 1,
      operation_id: original.operation_id,
      page_id: root,
      child_id: last.id,
      intent_index: last.intent_index,
      intent_sha256: yield* sha256(canonical(last.intent)),
      receipt_sha256: yield* sha256(retained),
      intended_hash: integrity.intended_hash,
      integrity_sha256: yield* sha256(canonical(integrity)),
      guard_paths: Object.keys(original.guards),
      guards_sha256: yield* sha256(canonical(original.guards)),
      checkpoint,
      inventory_sha256: yield* sha256(canonical(inventory)),
      references_sha256: yield* sha256(canonical(references)),
      metadata_brackets: brackets,
    }
    return {
      outcome: "needs_safe_resume",
      verified: false,
      before_guards: original.guards,
      checkpoint,
      evidence,
    } satisfies CompletedChildParentCheckpoint
  })
}
