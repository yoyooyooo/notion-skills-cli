import { Effect } from "effect"
import { Lexer, type Token } from "marked"
import { authScope, explicitSource } from "./catalog.ts"
import { importDocument } from "./import.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath } from "./ref.ts"
import { pageMarkdown } from "./references.ts"
import { acknowledgedCodeLanguages } from "./acknowledged-code-languages.ts"
import { exactPlainTextLanguageBodyEffect } from "./publication-code-language-effects.ts"
import { creationProofFromBody, creationProofMatchesIntent } from "./publication-create-identity.ts"
import { canonical, publicationMarkerAuthority } from "./publication-effect-proof.ts"
import { publicationMarker } from "./publication-integrity.ts"
import {
  PublicationReceiptSchema,
  type CompletedCodeLanguageCheckpoint,
  type Receipt,
} from "./publication-model.ts"
import {
  blockObservation,
  blockPatchRecovery,
  capturePublicationRead,
  metadata,
  observation,
  publicationPropertiesMatch,
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "./publication-observation.ts"
import { Store, sha256 } from "./store.ts"
import { codeLanguage } from "./markdown.ts"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const exactKeys = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition) throw fail("PUBLICATION_CODE_LANGUAGE_CHECKPOINT_UNPROVEN", message)
}
const proofError = (error: unknown) =>
  error instanceof SkillsError
    ? error
    : fail(
        "PUBLICATION_CODE_LANGUAGE_CHECKPOINT_UNPROVEN",
        "Completed language checkpoint evidence is invalid.",
      )
const attempt = <A>(run: () => A) => Effect.try({ try: run, catch: proofError })
function activeObject(raw: unknown) {
  const value = property(raw)
  return (
    value.in_trash === false &&
    ["archived", "is_archived"].every((key) => value[key] === undefined || value[key] === false)
  )
}
function completeBody(raw: unknown, root: string) {
  const value = property(raw)
  requireProof(
    typeof value.markdown === "string" &&
      value.truncated === false &&
      Array.isArray(value.unknown_block_ids) &&
      value.unknown_block_ids.length === 0 &&
      (value.id === undefined || value.id === root),
    "The current owner Markdown is incomplete or outside its page.",
  )
  return pageMarkdown(raw)
}

interface InlineAtom {
  readonly text: string
  readonly bold: boolean
  readonly italic: boolean
  readonly code: boolean
  readonly link: string | null
}
const plain = { bold: false, italic: false, code: false, link: null } as const
function inlineAtoms(
  tokens: readonly Token[],
  style: Omit<InlineAtom, "text"> = plain,
): InlineAtom[] | undefined {
  const result: InlineAtom[] = []
  for (const token of tokens) {
    if (token.type === "strong" || token.type === "em" || (token.type === "text" && token.tokens)) {
      const children = inlineAtoms(token.tokens ?? [], {
        ...style,
        ...(token.type === "strong" ? { bold: true } : token.type === "em" ? { italic: true } : {}),
      })
      if (!children) return
      result.push(...children)
    } else if (token.type === "text" || token.type === "escape")
      result.push({ ...style, text: token.text })
    else if (token.type === "codespan") result.push({ ...style, code: true, text: token.text })
    else if (token.type === "link" && style.link === null && !token.title) {
      if (!Array.isArray(token.tokens)) return
      const children = inlineAtoms(token.tokens, { ...style, link: token.href })
      if (!children) return
      result.push(...children)
    } else return
  }
  return result
}
function richAtoms(value: unknown): InlineAtom[] | undefined {
  if (!Array.isArray(value) || !value.length) return
  const result: InlineAtom[] = []
  for (const entry of value) {
    const rich = property(entry),
      text = property(rich.text),
      annotations = property(rich.annotations)
    const link = text.link == null ? null : property(text.link).url
    if (
      rich.type !== "text" ||
      typeof text.content !== "string" ||
      (rich.plain_text !== undefined && rich.plain_text !== text.content) ||
      (link !== null && typeof link !== "string") ||
      (rich.href !== undefined && rich.href !== link) ||
      Object.keys(annotations).some(
        (key) => !["bold", "italic", "code", "strikethrough", "underline", "color"].includes(key),
      ) ||
      ["bold", "italic", "code", "strikethrough", "underline"].some(
        (key) => annotations[key] !== undefined && typeof annotations[key] !== "boolean",
      ) ||
      annotations.strikethrough === true ||
      annotations.underline === true ||
      (annotations.color !== undefined && annotations.color !== "default")
    )
      return
    result.push({
      text: text.content,
      link,
      code: annotations.code === true,
      bold: annotations.bold === true,
      italic: annotations.italic === true,
    })
  }
  return result
}
function normalizedAtoms(atoms: readonly InlineAtom[]) {
  const result: InlineAtom[] = []
  for (const atom of atoms) {
    const text = atom.code ? atom.text : atom.text.replace(/\s+/g, " ")
    const prior = result.at(-1)
    if (
      prior &&
      prior.bold === atom.bold &&
      prior.italic === atom.italic &&
      prior.code === atom.code &&
      prior.link === atom.link
    ) {
      const combined = prior.text + text
      result[result.length - 1] = {
        ...atom,
        text: atom.code ? combined : combined.replace(/\s+/g, " "),
      }
    } else if (text) result.push({ ...atom, text })
  }
  const first = result[0],
    last = result.at(-1)
  if (first && !first.code && first.link === null)
    result[0] = { ...first, text: first.text.trimStart() }
  if (last && !last.code && last.link === null) {
    const current = result.at(-1)!
    result[result.length - 1] = { ...current, text: current.text.trimEnd() }
  }
  return result.filter((atom) => atom.text)
}

/** Unlike Markdown equivalence, this binds every physical flat root, in order,
 * to one authored leaf. It rejects invisible/unsupported roots and preserves
 * code bytes, inline code, emphasis and exact link destinations. */
export function completedCodeLanguageRootsMatch(source: string, roots: readonly unknown[]) {
  const wanted: unknown[] = []
  for (const token of Lexer.lex(source)) {
    if (token.type === "space" || token.type === "def") continue
    if (token.type === "code") {
      wanted.push(["code", codeLanguage(token.lang), token.text])
      continue
    }
    if (token.type === "paragraph" || token.type === "heading") {
      if (!Array.isArray(token.tokens)) return false
      const atoms = inlineAtoms(token.tokens)
      if (!atoms) return false
      wanted.push([
        token.type === "heading" ? `heading_${token.depth}` : "paragraph",
        normalizedAtoms(atoms),
      ])
    } else if (token.type === "list" && !token.ordered) {
      for (const item of token.items) {
        if (!Array.isArray(item.tokens)) return false
        const leaves: Token[] = item.tokens.filter((part: Token) => part.type !== "space")
        const leaf = leaves[0]
        if (
          item.task ||
          leaves.length !== 1 ||
          !leaf ||
          !["text", "paragraph"].includes(leaf.type) ||
          !("text" in leaf)
        )
          return false
        const atoms = inlineAtoms(
          "tokens" in leaf && leaf.tokens ? leaf.tokens : Lexer.lexInline(String(leaf.text)),
        )
        if (!atoms) return false
        wanted.push(["bulleted_list_item", normalizedAtoms(atoms)])
      }
    } else return false
  }
  const actual: unknown[] = []
  for (const raw of roots) {
    const root = property(raw),
      type = String(root.type),
      body = property(root[type])
    if (
      !["heading_1", "heading_2", "heading_3", "paragraph", "bulleted_list_item", "code"].includes(
        type,
      )
    )
      return false
    const allowed =
      type === "code"
        ? ["rich_text", "language", "caption"]
        : type.startsWith("heading_")
          ? ["rich_text", "color", "is_toggleable"]
          : type === "paragraph"
            ? ["rich_text", "color", "icon"]
            : ["rich_text", "color"]
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      (body.color !== undefined && body.color !== "default") ||
      body.icon != null ||
      (body.is_toggleable !== undefined && body.is_toggleable !== false)
    )
      return false
    const atoms = richAtoms(body.rich_text)
    if (!atoms) return false
    if (type === "code") {
      if (
        typeof body.language !== "string" ||
        atoms.some((atom) => atom.bold || atom.italic || atom.code || atom.link !== null) ||
        (body.caption !== undefined && (!Array.isArray(body.caption) || body.caption.length !== 0))
      )
        return false
      actual.push(["code", codeLanguage(body.language), atoms.map((atom) => atom.text).join("")])
    } else actual.push([type, normalizedAtoms(atoms)])
  }
  return canonical(actual) === canonical(wanted)
}

/** The first root-body repair has no children, uploads or earlier block effects.
 * More complex journals need their own proof; a terminal ACK alone is insufficient. */
function originalSequence(receipt: Receipt) {
  const root = receipt.page_id
  requireProof(
    receipt.operation === "create" &&
      receipt.portable.kind === "skill" &&
      receipt.conflict === true &&
      receipt.state === "failed" &&
      !receipt.owner &&
      receipt.result === undefined &&
      typeof root === "string" &&
      uuid.test(root) &&
      receipt.scope &&
      receipt.database_id &&
      receipt.data_source_id &&
      receipt.context?.write_path === undefined &&
      receipt.context?.content_adoption === undefined &&
      !receipt.context?.members?.length &&
      receipt.intents.length === 4 &&
      !receipt.conflict_history?.some((entry) => entry.completed_code_language_checkpoint),
    "Checkpoint catch-up requires the original fenced first root-body publication.",
  )
  requireProof(
    receipt.intents.every(
      (intent) =>
        intent.status === "completed" &&
        !intent.recovery &&
        !intent.typed_links &&
        !intent.list_start_repair &&
        !intent.zero_list_repair &&
        !intent.artifact &&
        exactKeys(intent.response, ["id"]),
    ),
    "Only the four original unambiguous ACKs can prove this checkpoint.",
  )
  const rootPath = `v1/pages/${root}`,
    bodyPath = `${rootPath}/markdown`
  const inventoryPath = `v1/blocks/${root}/children?page_size=100`
  const [create, references, body, repair] = receipt.intents
  const creation = property(create!.body),
    referenceBody = property(references!.body)
  const bodyRequest = property(body!.body),
    target = property(bodyRequest.replace_content).new_str
  const rootGuard = property(receipt.guards[rootPath])
  const fields = property(rootGuard.properties),
    field = property(fields.References)
  const files = property(fields.Files),
    members = property(fields.Members)
  requireProof(
    files.type === "files" &&
      Array.isArray(files.files) &&
      files.files.length === 0 &&
      (fields.Members === undefined ||
        (members.type === "relation" &&
          Array.isArray(members.relation) &&
          members.relation.length === 0 &&
          members.has_more === false)),
    "The first root-body checkpoint cannot include published files or member relations.",
  )
  requireProof(
    field.type === "rich_text" &&
      typeof field.id === "string" &&
      field.id &&
      !/[/?#\\\s]/.test(field.id) &&
      field.id !== "." &&
      field.id !== ".." &&
      Array.isArray(field.rich_text) &&
      field.rich_text.length === 0 &&
      Object.entries(fields).filter(
        ([name, value]) =>
          ["References", field.id].includes(name) ||
          ["References", field.id].includes(String(property(value).id)),
      ).length === 1,
    "The original empty References field has no complete retained identity.",
  )
  const referencePath = `${rootPath}/properties/${field.id}?page_size=100`
  requireProof(
    create!.method === "POST" &&
      create!.path === "v1/pages" &&
      property(create!.response).id === root &&
      canonical(creation.parent) ===
        canonical({ type: "data_source_id", data_source_id: receipt.data_source_id }) &&
      Object.keys(creation).every((key) => ["parent", "properties", "children"].includes(key)) &&
      Object.keys(property(creation.properties)).length > 0 &&
      (creation.children === undefined ||
        (Array.isArray(creation.children) && creation.children.length === 0)) &&
      references!.method === "PATCH" &&
      references!.path === rootPath &&
      property(references!.response).id === root &&
      exactKeys(referenceBody, ["properties"]) &&
      Object.keys(property(referenceBody.properties)).length === 1 &&
      ["References", field.id].includes(Object.keys(property(referenceBody.properties))[0]!) &&
      canonical(Object.values(property(referenceBody.properties))[0]) ===
        canonical({ rich_text: [] }) &&
      body!.method === "PATCH" &&
      body!.path === bodyPath &&
      property(body!.response).id === root &&
      exactKeys(bodyRequest, ["markdown_version", "type", "replace_content"]) &&
      bodyRequest.markdown_version === "v2" &&
      bodyRequest.type === "replace_content" &&
      exactKeys(bodyRequest.replace_content, ["new_str"]) &&
      typeof target === "string",
    "The original root, empty References and complete body ACK sequence differs.",
  )
  const blockId = repair!.path.split("/")[2]
  requireProof(
    repair!.method === "PATCH" &&
      typeof blockId === "string" &&
      uuid.test(blockId) &&
      repair!.path === `v1/blocks/${blockId}` &&
      property(repair!.response).id === blockId &&
      exactKeys(repair!.body, ["code"]) &&
      exactKeys(property(repair!.body).code, ["language"]) &&
      property(property(repair!.body).code).language === "plain text" &&
      repair!.guards,
    "The terminal ACK is not the original exact plain-text field repair.",
  )
  const paths = [rootPath, bodyPath, referencePath, inventoryPath, repair!.path]
  requireProof(
    exactKeys(receipt.guards, paths) &&
      exactKeys(repair!.guards, paths) &&
      paths.every(
        (path) =>
          path === repair!.path ||
          canonical(receipt.guards[path]) === canonical(repair!.guards![path]),
      ) &&
      typeof receipt.guards[bodyPath] === "string" &&
      canonical(receipt.guards[inventoryPath]) ===
        canonical({ results: [], has_more: false, next_cursor: null }) &&
      !receipt.portable.files.some(
        (file) => file.path !== receipt.portable.main && /^references\/.*\.md$/i.test(file.path),
      ),
    "The missing owner checkpoint is not the sole unfinished guard in this root-only sequence.",
  )
  const prior = property(repair!.guards![repair!.path]),
    applied = property(receipt.guards[repair!.path])
  const expected = { ...prior, code: { ...property(prior.code), language: "plain text" } }
  const withoutRevision = (value: Record<string, unknown>) => {
    const { last_edited_time: _revision, ...content } = value
    return content
  }
  requireProof(
    prior.id === blockId &&
      prior.type === "code" &&
      prior.has_children === false &&
      prior.archived === false &&
      prior.in_trash === false &&
      typeof prior.last_edited_time === "string" &&
      canonical(prior.parent) === canonical({ type: "page_id", page_id: root }) &&
      property(prior.code).language === "javascript" &&
      typeof applied.last_edited_time === "string" &&
      canonical(withoutRevision(applied)) === canonical(withoutRevision(expected)),
    "The final block guard is not exactly the acknowledged field effect.",
  )
  return {
    root,
    rootPath,
    bodyPath,
    referencePath,
    inventoryPath,
    blockId,
    paths,
    create: create!,
    body: body!,
    repair: repair!,
    target,
  }
}

/** Run inside the original publication lock. This makes fresh GETs only, proves
 * one interrupted ACK checkpoint, and never supplies publication completion or
 * permission for another request. The returned certificate is audit evidence. */
export function proveCompletedCodeLanguageCheckpoint(
  receipt: Receipt,
  transport: Notion["Service"],
) {
  return Effect.gen(function* () {
    const original = structuredClone(receipt),
      retained = canonical(original)
    const sequence = yield* attempt(() => originalSequence(original))
    const { root, rootPath, bodyPath, referencePath, inventoryPath, paths, repair, target } =
      sequence
    const store = yield* Store,
      receiptKey = `publications/${original.operation_id}.json`
    const checkLocal = () =>
      Effect.gen(function* () {
        const durable = yield* store.readJson(receiptKey, PublicationReceiptSchema)
        requireProof(
          durable && canonical(durable) === retained && canonical(receipt) === retained,
          "The original publication receipt changed during checkpoint proof.",
        )
        const integrity = yield* store.integrity.inspect(original.operation_id)
        requireProof(
          integrity &&
            integrity.operation_id === original.operation_id &&
            integrity.marker.state === "writing",
          "The original writing integrity ledger is missing or changed.",
        )
        const files: Array<readonly [string, number, string]> = [],
          seen = new Set<string>()
        let main: Uint8Array | undefined, sourceHash: string | undefined
        for (const file of [...original.portable.files].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        )) {
          requireProof(
            file.path &&
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
          if (file.path === original.portable.main) {
            main = bytes
            sourceHash = file.sha256
          }
        }
        requireProof(
          main &&
            sourceHash &&
            (yield* sha256(
              canonical([
                original.portable.kind,
                original.portable.name,
                original.portable.description,
                original.portable.main,
                files,
              ]),
            )) === integrity.intended_hash,
          "Frozen source differs from the original intended publication.",
        )
        const document = importDocument(
          { path: original.portable.main, bytes: main },
          {
            name: original.portable.name,
            description: original.portable.description,
          },
        )
        requireProof(
          document.body === target,
          "The original body ACK is not the exact frozen authored body.",
        )
        return { integrity, sourceHash, source: document.body }
      }).pipe(Effect.catchDefect((error) => Effect.fail(proofError(error))))
    const local = yield* checkLocal()
    const phase = publicationReadPhase()
    const readApi: Notion["Service"] = {
      ...transport,
      request: (path, body, options) => {
        if (
          body !== undefined ||
          options?.file !== undefined ||
          (options?.method && options.method !== "GET")
        )
          return Effect.fail(
            fail(
              "PUBLICATION_CODE_LANGUAGE_CHECKPOINT_UNPROVEN",
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
        "The original credential or bound source differs.",
      ),
    )
    const beforeRaw = yield* readApi.request(rootPath),
      before = metadata(beforeRaw)
    yield* attempt(() => {
      const page = property(beforeRaw)
      requireProof(
        page.id === root &&
          typeof page.last_edited_time === "string" &&
          page.last_edited_time &&
          activeObject(page) &&
          property(page.parent).type === "data_source_id" &&
          property(page.parent).data_source_id === original.data_source_id &&
          canonical(before) === canonical(original.guards[rootPath]) &&
          Object.values(property(page.properties)).every(
            (value) => property(value).has_more !== true,
          ),
        "The original owner metadata is incomplete, changed or outside its bound source.",
      )
    })
    for (const path of paths.filter((path) => path !== rootPath)) yield* readApi.request(path)
    const first = structuredClone(phase.raw)
    const observed = Object.fromEntries(paths.map((path) => [path, observation(path, first[path])]))
    const current = yield* attempt(() => completeBody(first[bodyPath], root))
    const roots = property(first[inventoryPath]).results
    yield* attempt(() => {
      requireProof(
        paths.every(
          (path) =>
            path === bodyPath || canonical(observed[path]) === canonical(original.guards[path]),
        ),
        "Another retained guard changed alongside the missing owner checkpoint.",
      )
      const references = property(first[referencePath])
      requireProof(
        references.object === "list" &&
          Array.isArray(references.results) &&
          references.results.length === 0 &&
          references.has_more === false &&
          references.next_cursor === null &&
          publicationPropertiesMatch(beforeRaw, { References: { rich_text: [] } }),
        "The complete References property is not the original empty field.",
      )
      requireProof(
        publicationMarkerAuthority(original, beforeRaw, local.integrity, publicationMarker),
        "The original writing marker or intended identity changed.",
      )
      const creation = creationProofFromBody(sequence.create.body)
      requireProof(
        creation &&
          creation.role === "content_root" &&
          creationProofMatchesIntent(creation, original, 0) &&
          creation.intended_hash === local.integrity.intended_hash &&
          creation.source_sha256 === local.sourceHash &&
          publicationPropertiesMatch(beforeRaw, property(sequence.create.body).properties),
        "The original root ACK differs from its frozen source or current properties.",
      )
      const effect = blockPatchRecovery(repair, original, observed)
      requireProof(
        effect.outcome === "success" &&
          effect.ownerPath === rootPath &&
          exactPlainTextLanguageBodyEffect(repair, original.guards[bodyPath], current),
        "The current complete block and owner body do not prove the exact language-only effect.",
      )
      requireProof(
        Array.isArray(roots) &&
          roots.every((raw) => {
            const block = property(raw)
            return block.has_children === false && activeObject(block)
          }),
        "This checkpoint requires a complete flat original root body.",
      )
      requireProof(
        completedCodeLanguageRootsMatch(local.source, roots),
        "The complete ordered physical roots differ from the original authored body.",
      )
      const codes = acknowledgedCodeLanguages(root, target, local.source, roots)
      const currentBlock = roots.filter((raw) => property(raw).id === sequence.blockId)
      requireProof(
        codes &&
          codes.changes.length === 0 &&
          currentBlock.length === 1 &&
          canonical(blockObservation(currentBlock[0])) === canonical(observed[repair.path]),
        "The complete source code order or acknowledged physical block differs.",
      )
    })
    const bodyMatches = yield* readPublicationMarkdownMatches(
      sequence.body,
      current,
      target,
      readApi,
      phase,
      undefined,
      true,
    )
    yield* attempt(() =>
      requireProof(
        bodyMatches,
        "The complete physical body does not match its original source ACK.",
      ),
    )
    // Notion edit times can be coarse. Re-read body, complete inventory and the
    // whole block as well as metadata, rather than relying on an unchanged clock.
    for (const path of paths.filter((path) => path !== rootPath)) {
      const again = yield* readApi.request(path)
      yield* attempt(() =>
        requireProof(
          canonical(observation(path, again)) === canonical(observed[path]) &&
            (path !== bodyPath || completeBody(again, root) === current) &&
            (path !== inventoryPath || canonical(property(again).results) === canonical(roots)),
          "Current publication content changed during checkpoint sampling.",
        ),
      )
    }
    const afterRaw = yield* readApi.request(rootPath),
      after = metadata(afterRaw)
    yield* attempt(() =>
      requireProof(
        activeObject(afterRaw) && canonical(after) === canonical(before),
        "The owner metadata changed across checkpoint sampling.",
      ),
    )
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
    const checkpoint = { path: bodyPath, before: String(original.guards[bodyPath]), after: current }
    const evidence: CompletedCodeLanguageCheckpoint = {
      version: 1,
      operation_id: original.operation_id,
      page_id: root,
      block_id: sequence.blockId,
      intent_index: 3,
      acknowledged_body_intent_index: 2,
      receipt_sha256: yield* sha256(retained),
      journal_sha256: yield* sha256(canonical(original.intents)),
      intended_hash: local.integrity.intended_hash,
      integrity_sha256: yield* sha256(canonical(local.integrity)),
      guards_sha256: yield* sha256(canonical(original.guards)),
      intent_guards_sha256: yield* sha256(canonical(repair.guards)),
      source_sha256: local.sourceHash,
      target_sha256: yield* sha256(target),
      checkpoint,
      inventory_sha256: yield* sha256(canonical(roots)),
      references_sha256: yield* sha256(canonical(observed[referencePath])),
      block_before_sha256: yield* sha256(canonical(repair.guards![repair.path])),
      block_after_sha256: yield* sha256(canonical(observed[repair.path])),
      metadata_before_sha256: yield* sha256(canonical(before)),
      metadata_after_sha256: yield* sha256(canonical(after)),
    }
    return {
      outcome: "needs_safe_resume" as const,
      verified: false as const,
      before_guards: original.guards,
      checkpoint,
      evidence,
    }
  }).pipe(Effect.catchDefect((error) => Effect.fail(proofError(error))))
}
