import { Effect } from "effect"
import { Lexer, type Token, type Tokens } from "marked"
import { authScope, explicitSource } from "./catalog.ts"
import { fail, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath } from "./ref.ts"
import { pageMarkdown } from "./references.ts"
import { referenceLinks } from "./reference-links.ts"
import {
  creationMarkerBlock,
  creationMarkerProof,
  creationProofFromBody,
  creationProofMatchesIntent,
  withoutCreationMarker,
  withoutCreationMarkerWithBlocks,
} from "./publication-create-identity.ts"
import {
  canonical,
  publicationGuardRoles,
  publicationMarkerAuthority,
} from "./publication-effect-proof.ts"
import { publicationMarker } from "./publication-integrity.ts"
import { markdownRichText, markdownTableCells } from "./markdown-blocks.ts"
import { projectNotionBlockTree } from "./markdown.ts"
import {
  PublicationReceiptSchema,
  type CompletedTableRowCheckpoint,
  type Receipt,
} from "./publication-model.ts"
import {
  blockObservation,
  capturePublicationRead,
  metadata,
  metadataContent,
  observation,
  publicationPropertiesMatch,
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "./publication-observation.ts"
import { Store, sha256 } from "./store.ts"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const exactKeys = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition) throw fail("PUBLICATION_TABLE_ROW_CHECKPOINT_UNPROVEN", message)
}
const proofError = (error: unknown) =>
  error instanceof SkillsError
    ? error
    : fail("PUBLICATION_TABLE_ROW_CHECKPOINT_UNPROVEN", "Completed table-row evidence is invalid.")
const attempt = <A>(run: () => A) => Effect.try({ try: run, catch: proofError })
const active = (raw: unknown) => {
  const value = property(raw)
  return (
    value.in_trash === false &&
    ["archived", "is_archived"].every((key) => value[key] === undefined || value[key] === false)
  )
}
type Intent = Receipt["intents"][number]
interface Child {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly intent_index: number
  readonly intent: Intent
}

/** Only the initial create/register/body sequence, with one terminal row ACK.
 * This audit path cannot adopt arbitrary block edits or later replacements. */
function originalSequence(receipt: Receipt) {
  const root = receipt.page_id
  requireProof(
    receipt.operation === "create" &&
      receipt.portable.kind === "skill" &&
      receipt.state === "failed" &&
      receipt.conflict === true &&
      !receipt.owner &&
      !receipt.result &&
      typeof root === "string" &&
      uuid.test(root) &&
      receipt.scope &&
      receipt.database_id &&
      receipt.data_source_id &&
      !receipt.context?.write_path &&
      !receipt.context?.content_adoption &&
      !receipt.context?.members?.length &&
      !receipt.conflict_history?.length &&
      receipt.intents.length >= 5,
    "Table checkpoint recovery requires an original unfinished fenced create.",
  )
  requireProof(
    receipt.intents.every(
      (intent) =>
        intent.status === "completed" &&
        !intent.recovery &&
        !intent.typed_links &&
        !intent.artifact &&
        !intent.list_start_repair &&
        !intent.zero_list_repair &&
        exactKeys(intent.response, ["id"]),
    ),
    "Every original effect must retain its unambiguous real ACK.",
  )
  const first = receipt.intents[0]!,
    rootBody = property(first.body),
    rootPath = `v1/pages/${root}`
  requireProof(
    first.method === "POST" &&
      first.path === "v1/pages" &&
      property(first.response).id === root &&
      canonical(rootBody.parent) ===
        canonical({ type: "data_source_id", data_source_id: receipt.data_source_id }) &&
      Object.keys(rootBody).every((key) => ["parent", "properties", "children"].includes(key)) &&
      Object.keys(property(rootBody.properties)).length > 0 &&
      (rootBody.children === undefined ||
        (Array.isArray(rootBody.children) && rootBody.children.length === 0)),
    "The original root ACK does not bind the empty original source parent.",
  )
  const fields = property(property(receipt.guards[rootPath]).properties),
    references = property(fields.References)
  requireProof(
    references.type === "rich_text" &&
      typeof references.id === "string" &&
      references.id &&
      !/[/?#\\\s]/.test(references.id) &&
      references.id !== "." &&
      references.id !== ".." &&
      Array.isArray(references.rich_text) &&
      property(fields.Files).type === "files" &&
      Array.isArray(property(fields.Files).files) &&
      (property(fields.Files).files as unknown[]).length === 0 &&
      (fields.Members === undefined ||
        (property(fields.Members).type === "relation" &&
          Array.isArray(property(fields.Members).relation) &&
          (property(fields.Members).relation as unknown[]).length === 0 &&
          property(fields.Members).has_more === false)),
    "This checkpoint cannot include files, router members or an incomplete References field.",
  )
  const files = receipt.portable.files
    .filter((file) => file.path !== receipt.portable.main && /\.md$/i.test(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  requireProof(
    files.length > 0 && files.length <= 100,
    "The reference graph is outside this checkpoint's scope.",
  )
  const children: Child[] = []
  let index = 1
  for (const file of files) {
    const intent = receipt.intents[index],
      register = receipt.intents[index + 1]
    requireProof(intent && register, "The original reference allocation prefix is incomplete.")
    const body = property(intent.body),
      id = property(intent.response).id,
      props = property(body.properties)
    const title = text(property(props.title).title),
      proof = creationProofFromBody(body)
    requireProof(
      intent.method === "POST" &&
        intent.path === "v1/pages" &&
        typeof id === "string" &&
        uuid.test(id) &&
        id !== root &&
        !children.some((child) => child.id === id) &&
        canonical(body.parent) === canonical({ type: "page_id", page_id: root }) &&
        exactKeys(body, ["parent", "properties", "children"]) &&
        exactKeys(props, ["title"]) &&
        exactKeys(props.title, ["title"]) &&
        title &&
        file.path ===
          (receipt.portable.files.some((file) => file.path === title)
            ? title
            : `references/${title}`) &&
        proof?.role === "reference" &&
        creationProofMatchesIntent(proof, receipt, index) &&
        canonical(body.children) === canonical([creationMarkerBlock(proof)]),
      "An original child ACK, source, marker or parent differs.",
    )
    children.push({ id, title, path: file.path, intent_index: index, intent })
    const registered = property(property(register.body).properties),
      keys = Object.keys(registered)
    const value = referenceLinks(children)
    requireProof(
      value &&
        register.method === "PATCH" &&
        register.path === rootPath &&
        property(register.response).id === root &&
        exactKeys(register.body, ["properties"]) &&
        keys.length === 1 &&
        ["References", references.id].includes(keys[0]!) &&
        canonical(registered[keys[0]!]) === canonical(value),
      "Reference registration is not the exact original child prefix.",
    )
    index += 2
  }
  const bodies: Array<{ intent: Intent; index: number; child: Child; target: string }> = []
  for (let ordinal = 0; index < receipt.intents.length - 1; index++, ordinal++) {
    const child = children[ordinal],
      intent = receipt.intents[index]!,
      body = property(intent.body)
    const target = property(body.replace_content).new_str
    requireProof(
      child &&
        intent.method === "PATCH" &&
        intent.path === `v1/pages/${child.id}/markdown` &&
        property(intent.response).id === child.id &&
        exactKeys(body, ["markdown_version", "type", "replace_content"]) &&
        body.markdown_version === "v2" &&
        body.type === "replace_content" &&
        exactKeys(body.replace_content, ["new_str"]) &&
        typeof target === "string" &&
        canonical(creationMarkerProof(target)) ===
          canonical(creationProofFromBody(child.intent.body)),
      "A reference body ACK is not the ordered original complete source replacement.",
    )
    bodies.push({ intent, index, child, target })
  }
  const body = bodies.at(-1),
    repair = receipt.intents.at(-1)!,
    blockId = repair.path.split("/")[2]
  requireProof(
    body &&
      repair.method === "PATCH" &&
      typeof blockId === "string" &&
      uuid.test(blockId) &&
      repair.path === `v1/blocks/${blockId}` &&
      property(repair.response).id === blockId &&
      exactKeys(repair.body, ["table_row"]) &&
      exactKeys(property(repair.body).table_row, ["cells"]) &&
      Array.isArray(property(property(repair.body).table_row).cells) &&
      repair.guards &&
      canonical(repair.guards) === canonical(receipt.guards),
    "The terminal real ACK is not a table row with its untouched original checkpoint.",
  )
  const ownerPath = `v1/pages/${body.child.id}`,
    bodyPath = `${ownerPath}/markdown`
  const before = property(repair.guards[repair.path]),
    parent = property(before.parent)
  requireProof(
    before.id === blockId &&
      before.type === "table_row" &&
      before.has_children === false &&
      parent.type === "block_id" &&
      typeof parent.block_id === "string" &&
      uuid.test(parent.block_id),
    "The original row has no exact retained table parent.",
  )
  const tablePath = `v1/blocks/${parent.block_id}`,
    table = property(repair.guards[tablePath])
  requireProof(
    table.id === parent.block_id &&
      table.type === "table" &&
      table.has_children === true &&
      canonical(table.parent) === canonical({ type: "page_id", page_id: body.child.id }) &&
      typeof receipt.guards[bodyPath] === "string" &&
      receipt.guards[ownerPath] !== undefined &&
      receipt.failure?.code === "WRITE_PARTIAL" &&
      property(property(receipt.failure.details).cause_details).path === repair.path &&
      property(receipt.failure.details).stage === `body:${body.child.path}`,
    "The interruption is not the original row readback within its original child body.",
  )
  const roles = publicationGuardRoles(receipt),
    pages = [root, ...children.map((child) => child.id)]
  requireProof(
    roles.readOnlyDependencies.size === 0 &&
      roles.ownedMutationTargets.size === pages.length &&
      pages.every(
        (id) =>
          roles.ownedMutationTargets.has(`v1/pages/${id}`) &&
          receipt.guards[`v1/pages/${id}`] !== undefined &&
          typeof receipt.guards[`v1/pages/${id}/markdown`] === "string",
      ),
    "The original complete owned page graph differs.",
  )
  return {
    root,
    rootPath,
    children,
    bodies,
    body,
    repair,
    blockId,
    tableId: parent.block_id,
    tablePath,
    ownerPath,
    bodyPath,
    pages,
    referenceId: references.id,
    checkpointPaths: [repair.path, ownerPath, bodyPath],
  }
}

export function completedTableRowCheckpointCandidate(receipt: Receipt) {
  try {
    return originalSequence(receipt)
  } catch {
    return undefined
  }
}

/** Literal parser corruption only; no link, code, annotation or other cell edit. */
export function tableLiteralBodyEffect(intent: Intent, beforeBody: unknown, afterBody: unknown) {
  if (typeof beforeBody !== "string" || typeof afterBody !== "string") return false
  try {
    const prior = property(intent.guards?.[intent.path])
    const before = property(blockObservation(prior).table_row).cells
    const after = property(blockObservation({ ...prior, ...property(intent.body) }).table_row).cells
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length)
      return false
    let projected = beforeBody,
      changed = 0
    for (const [column, values] of before.entries()) {
      const target = after[column]
      if (!Array.isArray(values) || !Array.isArray(target) || values.length !== target.length)
        return false
      for (const [index, value] of values.entries()) {
        const old = property(value),
          next = property(target[index]),
          a = property(old.text),
          b = property(next.text)
        if (
          old.type !== "text" ||
          next.type !== "text" ||
          typeof a.content !== "string" ||
          typeof b.content !== "string" ||
          canonical({ ...old, text: { ...a, content: b.content } }) !== canonical(next)
        )
          return false
        if (a.content === b.content) continue
        if (
          property(old.annotations).code === true ||
          a.link != null ||
          !b.content.includes(" + ") ||
          a.content !== b.content.replaceAll(" + ", "  • ") ||
          projected.split(a.content).length !== 2
        )
          return false
        projected = projected.replace(a.content, b.content)
        changed++
      }
    }
    return changed > 0 && projected === afterBody
  } catch {
    return false
  }
}

interface RootShape {
  readonly type: string
  readonly table?: Tokens.Table
  readonly checked?: boolean
  readonly inline?: readonly Token[]
}
function tokenArray(value: unknown): value is Token[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof property(item).type === "string" && typeof property(item).raw === "string",
    )
  )
}
function tableCell(value: unknown): value is Tokens.TableCell {
  const cell = property(value)
  return (
    typeof cell.text === "string" &&
    typeof cell.header === "boolean" &&
    (cell.align === null ||
      cell.align === "left" ||
      cell.align === "center" ||
      cell.align === "right") &&
    tokenArray(cell.tokens)
  )
}
function tableToken(value: unknown): value is Tokens.Table {
  const table = property(value),
    header = table.header,
    rows = table.rows,
    align = table.align
  return (
    table.type === "table" &&
    typeof table.raw === "string" &&
    Array.isArray(align) &&
    align.every(
      (value) => value === null || value === "left" || value === "center" || value === "right",
    ) &&
    Array.isArray(header) &&
    header.length > 0 &&
    header.every(tableCell) &&
    align.length === header.length &&
    Array.isArray(rows) &&
    rows.every((row) => Array.isArray(row) && row.length === header.length && row.every(tableCell))
  )
}
function sourceRootShapes(markdown: string): RootShape[] {
  const roots: RootShape[] = []
  const leaf = (tokens: readonly Token[]) => {
    const body = tokens.filter((token) => token.type !== "space" && token.type !== "checkbox")
    requireProof(
      body.length === 1 && ["text", "paragraph"].includes(body[0]!.type),
      "Nested or multi-block list/quote bodies are outside this checkpoint proof.",
    )
    const first = body[0]!
    requireProof(
      "text" in first && typeof first.text === "string",
      "An original leaf has no complete text.",
    )
    return "tokens" in first && Array.isArray(first.tokens)
      ? first.tokens
      : Lexer.lexInline(first.text)
  }
  for (const token of Lexer.lex(markdown)) {
    if (token.type === "space" || token.type === "def") continue
    if (token.type === "heading")
      roots.push({ type: `heading_${token.depth}`, inline: token.tokens })
    else if (token.type === "paragraph") roots.push({ type: "paragraph", inline: token.tokens })
    else if (token.type === "hr") roots.push({ type: "divider" })
    else if (token.type === "table") {
      requireProof(tableToken(token), "The original table token has incomplete cell structure.")
      roots.push({ type: "table", table: token })
    } else if (token.type === "blockquote") {
      requireProof(tokenArray(token.tokens), "The original quote token has incomplete children.")
      roots.push({ type: "quote", inline: leaf(token.tokens) })
    } else if (token.type === "list") {
      requireProof(
        !token.ordered || token.start === 1,
        "Non-default ordered-list starts need their own source proof.",
      )
      for (const item of token.items) {
        roots.push({
          type: item.task ? "to_do" : token.ordered ? "numbered_list_item" : "bulleted_list_item",
          inline: leaf(item.tokens),
          ...(item.task ? { checked: item.checked === true } : {}),
        })
      }
    } else requireProof(false, "The complete owner contains an unsupported physical root shape.")
  }
  return roots
}

function normalizedCells(cells: unknown) {
  const clean = property(
    blockObservation({ id: "source-cells", type: "table_row", table_row: { cells } }).table_row,
  ).cells
  requireProof(Array.isArray(clean), "Table cell evidence is incomplete.")
  return clean.map((values) => {
    requireProof(Array.isArray(values), "Table rich text is incomplete.")
    const result: Array<{ key: string; content: string }> = []
    for (const raw of values) {
      const value = property(raw),
        body = property(value.text),
        { content, ...other } = body
      requireProof(
        value.type === "text" && typeof content === "string",
        "Unsupported table rich text.",
      )
      const key = canonical({ ...value, text: other }),
        last = result.at(-1)
      if (last?.key === key) last.content += content
      else result.push({ key, content })
    }
    return result
  })
}

/** Extra physical text/style cannot hide behind a matching Markdown response.
 * URL policy stays in the existing complete source-bound Markdown proof below;
 * table cells (including every destination) use their complete strict values. */
function rootPresentation(values: unknown) {
  requireProof(Array.isArray(values), "A physical text leaf is incomplete.")
  return normalizedCells([
    values.map((raw) => {
      const value = property(raw),
        body = property(value.text)
      requireProof(
        value.type === "text" &&
          typeof body.content === "string" &&
          (value.plain_text === undefined || value.plain_text === body.content),
        "A physical leaf has inconsistent rich text.",
      )
      const { link: _link, ...text } = body
      return { ...value, text }
    }),
  ])[0]
}

/** GET-only proof. The returned certificate is audit evidence, never future authority. */
export function proveCompletedTableRowCheckpoint(receipt: Receipt, transport: Notion["Service"]) {
  return Effect.gen(function* () {
    const original = structuredClone(receipt),
      retained = canonical(original)
    const sequence = yield* attempt(() => originalSequence(original))
    const {
      root,
      rootPath,
      children,
      bodies,
      body,
      repair,
      blockId,
      tableId,
      tablePath,
      ownerPath,
      bodyPath,
      pages,
    } = sequence
    const store = yield* Store,
      receiptKey = `publications/${original.operation_id}.json`
    const checkLocal = () =>
      Effect.gen(function* () {
        const durable = yield* store.readJson(receiptKey, PublicationReceiptSchema)
        requireProof(
          durable && canonical(durable) === retained && canonical(receipt) === retained,
          "The original publication changed during checkpoint proof.",
        )
        const integrity = yield* store.integrity.inspect(original.operation_id)
        requireProof(
          integrity &&
            integrity.operation_id === original.operation_id &&
            integrity.marker.state === "writing",
          "The original writing integrity ledger is missing or changed.",
        )
        const files: Array<readonly [string, number, string]> = [],
          source = new Map<string, string>(),
          seen = new Set<string>()
        let total = 0
        for (const file of [...original.portable.files].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        )) {
          requireProof(
            file.path &&
              normalizePath(file.path) === file.path &&
              !seen.has(file.path) &&
              hash.test(file.sha256),
            "Frozen file paths or identities are invalid.",
          )
          seen.add(file.path)
          const bytes = yield* store.readBytes(`objects/${file.sha256}`)
          total += bytes.length
          requireProof(
            bytes.length <= 1024 * 1024 &&
              total <= 5 * 1024 * 1024 &&
              (yield* sha256(bytes)) === file.sha256,
            "A complete frozen source object failed its bounds or checksum.",
          )
          source.set(file.path, new TextDecoder("utf-8", { fatal: true }).decode(bytes))
          files.push([file.path, bytes.length, file.sha256])
        }
        requireProof(
          (yield* sha256(
            canonical([
              original.portable.kind,
              original.portable.name,
              original.portable.description,
              original.portable.main,
              files,
            ]),
          )) === integrity.intended_hash,
          "The complete frozen manifest differs from the original intended publication.",
        )
        for (const entry of bodies)
          requireProof(
            withoutCreationMarker(entry.target) === source.get(entry.child.path),
            "An original complete reference ACK is not its exact frozen source bytes.",
          )
        for (const index of [0, ...children.map((child) => child.intent_index)]) {
          const proof = creationProofFromBody(original.intents[index]!.body)
          requireProof(
            proof &&
              creationProofMatchesIntent(proof, original, index) &&
              proof.intended_hash === integrity.intended_hash,
            "An original creation marker differs from the complete frozen intended identity.",
          )
        }
        return { integrity, files }
      }).pipe(Effect.catchDefect((error) => Effect.fail(proofError(error))))
    const local = yield* checkLocal(),
      phase = publicationReadPhase()
    const readApi: Notion["Service"] = {
      ...transport,
      request: (path, requestBody, options) => {
        if (
          requestBody !== undefined ||
          options?.file !== undefined ||
          (options?.method && options.method !== "GET")
        )
          return Effect.fail(
            fail(
              "PUBLICATION_TABLE_ROW_CHECKPOINT_UNPROVEN",
              "Checkpoint proof permits GET requests only.",
            ),
          )
        return transport
          .request(path, undefined, { method: "GET" })
          .pipe(Effect.tap((raw) => Effect.sync(() => capturePublicationRead(phase, path, raw))))
      },
    }
    const scope = yield* authScope.pipe(Effect.provideService(Notion, readApi))
    const source = yield* explicitSource(original.database_id!).pipe(
      Effect.provideService(Notion, readApi),
    )
    yield* attempt(() =>
      requireProof(
        scope === original.scope && source.data_source_ids.includes(original.data_source_id!),
        "The current credential or original bound source differs.",
      ),
    )
    const pagePaths = pages.map((id) => `v1/pages/${id}`)
    for (const path of pagePaths) yield* readApi.request(path)
    const metadataBefore = Object.fromEntries(
      pagePaths.map((path) => [path, metadata(phase.raw[path])]),
    )
    for (const path of Object.keys(original.guards).filter((path) => !pagePaths.includes(path)))
      yield* readApi.request(path)
    const observed = Object.fromEntries(
      Object.keys(original.guards).map((path) => [path, observation(path, phase.raw[path])]),
    )
    const current = yield* attempt(() => pageMarkdown(phase.raw[bodyPath]))
    yield* attempt(() => {
      requireProof(
        Object.keys(original.guards).every(
          (path) =>
            sequence.checkpointPaths.includes(path) ||
            canonical(observed[path]) === canonical(original.guards[path]),
        ),
        "Another retained guard changed alongside the terminal table ACK.",
      )
      for (const path of pagePaths) {
        const raw = property(phase.raw[path])
        requireProof(
          active(raw) &&
            raw.id === path.split("/")[2] &&
            typeof raw.last_edited_time === "string" &&
            Object.values(property(raw.properties)).every(
              (field) => property(field).has_more !== true,
            ),
          "A current owned page is incomplete, inactive or outside its original identity.",
        )
        pageMarkdown(phase.raw[`${path}/markdown`])
      }
      requireProof(
        publicationMarkerAuthority(
          original,
          phase.raw[rootPath],
          local.integrity,
          publicationMarker,
        ) &&
          publicationPropertiesMatch(
            phase.raw[rootPath],
            property(original.intents[0]!.body).properties,
          ) &&
          publicationPropertiesMatch(phase.raw[rootPath], { References: referenceLinks(children) }),
        "The original root marker, fields or complete reference registry differs.",
      )
      for (const child of children) {
        const path = `v1/pages/${child.id}`,
          proof = creationProofFromBody(child.intent.body)
        requireProof(
          canonical(property(phase.raw[path]).parent) ===
            canonical({ type: "page_id", page_id: root }) &&
            publicationPropertiesMatch(phase.raw[path], property(child.intent.body).properties) &&
            canonical(creationMarkerProof(pageMarkdown(phase.raw[`${path}/markdown`]))) ===
              canonical(proof),
          "An original child marker, title or parent changed.",
        )
        if (!bodies.some((entry) => entry.child.id === child.id))
          requireProof(
            withoutCreationMarker(pageMarkdown(phase.raw[`${path}/markdown`])).trim() === "",
            "An unwritten child acquired content outside its original ACK sequence.",
          )
      }
      requireProof(
        canonical(metadataContent(observed[ownerPath])) ===
          canonical(metadataContent(original.guards[ownerPath])) &&
          tableLiteralBodyEffect(repair, original.guards[bodyPath], current),
        "The owner changed beyond the exact original non-code table literal effect.",
      )
      const expected = blockObservation({
        ...property(repair.guards![repair.path]),
        ...property(repair.body),
        last_edited_time: property(observed[repair.path]).last_edited_time,
      })
      requireProof(
        active(phase.raw[repair.path]) &&
          canonical(expected) === canonical(observed[repair.path]) &&
          canonical(blockObservation(phase.raw[tablePath])) ===
            canonical(original.guards[tablePath]),
        "The current complete row or retained table ancestor does not match the original ACK.",
      )
    })
    const inventoryPaths = new Set<string>(),
      allIds = new Set<string>(pages)
    const readChildren = (id: string) =>
      Effect.gen(function* () {
        const blocks: unknown[] = [],
          cursors = new Set<string>()
        let cursor: string | undefined
        for (let count = 0; count < 50; count++) {
          const path = `v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
          const raw = property(yield* readApi.request(path))
          inventoryPaths.add(path)
          requireProof(
            Array.isArray(raw.results) && typeof raw.has_more === "boolean",
            "Incomplete physical block inventory.",
          )
          for (const item of raw.results) {
            const block = property(item),
              parent = property(block.parent)
            requireProof(
              typeof block.id === "string" &&
                uuid.test(block.id) &&
                !allIds.has(block.id) &&
                active(block) &&
                typeof block.has_children === "boolean" &&
                canonical(parent) ===
                  canonical(
                    id === body.child.id
                      ? { type: "page_id", page_id: id }
                      : { type: "block_id", block_id: id },
                  ),
              "A physical block has an invalid, repeated or unrelated identity.",
            )
            allIds.add(block.id)
            blocks.push(item)
            requireProof(allIds.size <= 4096, "The physical graph exceeds the bounded proof scope.")
          }
          if (!raw.has_more) {
            requireProof(raw.next_cursor == null, "Invalid terminal inventory cursor.")
            return blocks
          }
          requireProof(
            typeof raw.next_cursor === "string" && raw.next_cursor && !cursors.has(raw.next_cursor),
            "Physical block pagination is cyclic or incomplete.",
          )
          cursor = raw.next_cursor
          cursors.add(cursor)
        }
        return yield* Effect.fail(
          fail(
            "PUBLICATION_TABLE_ROW_CHECKPOINT_UNPROVEN",
            "Physical pagination exceeds the proof scope.",
          ),
        )
      }).pipe(Effect.catchDefect((error) => Effect.fail(proofError(error))))
    const roots = yield* readChildren(body.child.id),
      shapes = yield* attempt(() => sourceRootShapes(body.target))
    const tables: Array<{ id: string; rows: unknown[] }> = []
    let tableOrdinal = -1,
      rowOrdinal = -1
    yield* attempt(() => {
      requireProof(
        roots.length === shapes.length,
        "Extra or missing physical roots differ from the frozen owner.",
      )
      for (const [index, raw] of roots.entries()) {
        const block = property(raw),
          shape = shapes[index]!,
          value = property(block[shape.type])
        requireProof(
          block.type === shape.type &&
            block.has_children === (shape.type === "table") &&
            (value.color === undefined || value.color === "default") &&
            value.icon == null &&
            (value.is_toggleable === undefined || value.is_toggleable === false) &&
            (shape.checked === undefined || value.checked === shape.checked),
          "The complete ordered physical root shapes or authored presentation differ.",
        )
        if (shape.inline)
          requireProof(
            canonical(rootPresentation(value.rich_text)) ===
              canonical(rootPresentation(markdownRichText(shape.inline))),
            "A complete physical leaf differs from its frozen text or formatting.",
          )
      }
      const boundaries = projectNotionBlockTree(body.child.id, roots)
      requireProof(boundaries, "The owner root tree is invalid.")
      withoutCreationMarkerWithBlocks(current, boundaries)
    })
    for (const [index, shape] of shapes.entries()) {
      if (!shape.table) continue
      const table = property(roots[index]),
        expected = [shape.table.header, ...shape.table.rows]
      const rows = yield* readChildren(String(table.id))
      yield* attempt(() => {
        requireProof(
          exactKeys(table.table, ["table_width", "has_column_header", "has_row_header"]) &&
            property(table.table).table_width === shape.table!.header.length &&
            property(table.table).has_column_header === true &&
            property(table.table).has_row_header === false &&
            rows.length === expected.length,
          "The complete table structure differs from its frozen authored table.",
        )
        if (table.id === tableId)
          requireProof(
            canonical(blockObservation(table)) === canonical(observed[tablePath]),
            "The owner inventory and retained table GET disagree.",
          )
        for (const [ordinal, raw] of rows.entries()) {
          const row = property(raw)
          requireProof(
            row.type === "table_row" &&
              row.has_children === false &&
              exactKeys(row.table_row, ["cells"]) &&
              canonical(normalizedCells(property(row.table_row).cells)) ===
                canonical(normalizedCells(markdownTableCells(expected[ordinal]!))),
            "A complete physical table row differs from the frozen cells, formatting or destinations.",
          )
          if (row.id === blockId) {
            requireProof(
              table.id === tableId &&
                tableOrdinal === -1 &&
                canonical(blockObservation(row)) === canonical(observed[repair.path]) &&
                canonical({ table_row: { cells: markdownTableCells(expected[ordinal]!) } }) ===
                  canonical(repair.body),
              "The original row payload is not the exact original source serializer output at this position.",
            )
            tableOrdinal = tables.length
            rowOrdinal = ordinal
          }
        }
      })
      tables.push({ id: String(table.id), rows })
    }
    yield* attempt(() =>
      requireProof(
        tableOrdinal >= 0 && rowOrdinal >= 0,
        "The terminal row does not occur exactly once in its complete original table.",
      ),
    )
    for (const entry of bodies) {
      const matches = yield* readPublicationMarkdownMatches(
        entry.intent,
        pageMarkdown(phase.raw[entry.intent.path]),
        entry.target,
        readApi,
        phase,
        undefined,
        entry === body,
      )
      yield* attempt(() =>
        requireProof(
          matches,
          "A complete original acknowledged body no longer matches its exact frozen source.",
        ),
      )
    }
    const fingerprint = (path: string, raw: unknown) => {
      if (/^v1\/blocks\/[^/]+\/children\?/.test(path)) {
        const page = property(raw)
        requireProof(Array.isArray(page.results), "A sampled inventory became incomplete.")
        return {
          results: page.results.map(blockObservation),
          has_more: page.has_more,
          next_cursor: page.next_cursor,
        }
      }
      return observation(path, raw)
    }
    const sampledPaths = [...new Set([...Object.keys(original.guards), ...inventoryPaths])]
    const sampled = yield* attempt(() =>
      Object.fromEntries(sampledPaths.map((path) => [path, fingerprint(path, phase.raw[path])])),
    )
    for (const path of sampledPaths.filter((path) => !pagePaths.includes(path))) {
      const again = yield* readApi.request(path)
      yield* attempt(() =>
        requireProof(
          canonical(fingerprint(path, again)) === canonical(sampled[path]),
          "Current content changed during checkpoint sampling.",
        ),
      )
    }
    const brackets: Array<{ page_id: string; before_sha256: string; after_sha256: string }> = []
    for (const path of pagePaths) {
      const again = yield* readApi.request(path),
        after = metadata(again)
      yield* attempt(() =>
        requireProof(
          active(again) && canonical(after) === canonical(metadataBefore[path]),
          "An owned page changed across the complete physical proof.",
        ),
      )
      brackets.push({
        page_id: path.split("/")[2]!,
        before_sha256: yield* sha256(canonical(metadataBefore[path])),
        after_sha256: yield* sha256(canonical(after)),
      })
    }
    const finalScope = yield* authScope.pipe(Effect.provideService(Notion, readApi))
    const finalSource = yield* explicitSource(original.database_id!).pipe(
      Effect.provideService(Notion, readApi),
    )
    const finalLocal = yield* checkLocal()
    yield* attempt(() =>
      requireProof(
        finalScope === scope &&
          canonical(finalSource) === canonical(source) &&
          canonical(finalLocal) === canonical(local),
        "Original source authority changed during checkpoint proof.",
      ),
    )
    const checkpoints = sequence.checkpointPaths.map((path) => ({
      path,
      before: original.guards[path],
      after: observed[path],
    }))
    const sourceHash = original.portable.files.find((file) => file.path === body.child.path)!.sha256
    const evidence: CompletedTableRowCheckpoint = {
      version: 1,
      operation_id: original.operation_id,
      page_id: root,
      owner_page_id: body.child.id,
      table_id: tableId,
      block_id: blockId,
      intent_index: original.intents.length - 1,
      acknowledged_body_intent_index: body.index,
      table_ordinal: tableOrdinal,
      row_ordinal: rowOrdinal,
      receipt_sha256: yield* sha256(retained),
      journal_sha256: yield* sha256(canonical(original.intents)),
      intended_hash: local.integrity.intended_hash,
      integrity_sha256: yield* sha256(canonical(local.integrity)),
      guards_sha256: yield* sha256(canonical(original.guards)),
      intent_guards_sha256: yield* sha256(canonical(repair.guards)),
      source_sha256: sourceHash,
      target_sha256: yield* sha256(body.target),
      checkpoints,
      root_inventory_sha256: yield* sha256(canonical(roots)),
      table_inventories_sha256: yield* sha256(canonical(tables)),
      sampled_guards_sha256: yield* sha256(canonical(sampled)),
      metadata_brackets: brackets,
    }
    return {
      outcome: "needs_safe_resume" as const,
      verified: false as const,
      before_guards: original.guards,
      checkpoints,
      evidence,
    }
  }).pipe(Effect.catchDefect((error) => Effect.fail(proofError(error))))
}
