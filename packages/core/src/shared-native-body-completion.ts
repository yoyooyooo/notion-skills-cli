import { Effect, Schema } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import type { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { referenceProse } from "./shared-file-references.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { readLinkBlocks } from "./typed-links.ts"

const Page = Schema.String.check(Schema.isUUID())
/** This is evidence about the export, never a replacement body or ownership fact. */
export const NativeBodyCompletionSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("link_to_page_blocks"),
  page_id: Page,
  body_sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Page),
  inventory_complete: Schema.Literal(true),
  inventory: Schema.Array(
    Schema.Struct({
      id: Page,
      parent_id: Page,
      parent_type: Schema.Literals(["page_id", "block_id"]),
      type: Schema.String,
      has_children: Schema.Boolean,
      target_page_id: Schema.optional(Page),
    }),
  ),
})
export type NativeBodyCompletion = typeof NativeBodyCompletionSchema.Type
type Alias = { start: number; end: number; href: string; block_id: string }

function incomplete(message: string): never {
  throw fail("BODY_INCOMPLETE", message)
}

function aliases(markdown: string, owner: string): Alias[] {
  const visible = referenceProse(markdown)
  const result: Alias[] = []
  for (const match of visible.matchAll(/<unknown\b[^>]*\/>/giu)) {
    const tag = match[0]
    const parsed = /^<unknown\s+url="([^"]+)"\s+alt="alias"\s*\/>$/u.exec(tag)
    if (parsed?.[1] === undefined) incomplete("An unknown export node is not a native page alias.")
    let url: URL
    try {
      url = new URL(parsed[1])
    } catch {
      return incomplete("An unknown export node has no exact native location.")
    }
    const id = pageId(url.hash.slice(1))
    if (
      url.protocol !== "https:" ||
      !/(?:^|\.)(?:notion\.so|notion\.com|notion\.site)$/iu.test(url.hostname) ||
      pageId(url.href.split("#")[0] ?? "") !== owner ||
      id === undefined ||
      url.search !== ""
    )
      incomplete("An unknown export node belongs to another page or block scope.")
    result.push({
      start: match.index,
      end: match.index + tag.length,
      href: parsed[1],
      block_id: id,
    })
  }
  let remainder = markdown
  for (const alias of [...result].reverse())
    remainder = remainder.slice(0, alias.start) + remainder.slice(alias.end)
  // Keep the original strict boundary for any unaccounted unknown syntax,
  // including malformed tags and literal transport placeholders.
  normalizeObservedBody(remainder)
  return result
}

/** Replay the complete physical-parent proof without consulting current Notion.
 * Child pages/databases remain separate content boundaries. Every other subtree
 * must be enumerated, including synced blocks; skipped or unread trees fail. */
export function validateNativeBodyCompletion(
  markdown: string,
  value: NativeBodyCompletion,
  expected?: { readonly page_id?: string; readonly body_sha256?: string },
): void {
  const proof = Schema.decodeUnknownSync(NativeBodyCompletionSchema)(value, {
    onExcessProperty: "error",
  })
  if (
    pageId(proof.page_id) !== proof.page_id ||
    (expected?.page_id !== undefined && proof.page_id !== expected.page_id) ||
    (expected?.body_sha256 !== undefined && proof.body_sha256 !== expected.body_sha256) ||
    proof.unknown_block_ids.length === 0 ||
    proof.unknown_block_ids.length > 100 ||
    proof.inventory.length === 0 ||
    proof.inventory.length > 4096
  )
    incomplete("Native alias completion has an invalid identity or inventory bound.")
  const unknown = new Set(proof.unknown_block_ids)
  if (
    unknown.size !== proof.unknown_block_ids.length ||
    [...unknown].some((id) => pageId(id) !== id)
  )
    incomplete("Native alias completion repeats or changes an unknown block identity.")
  const byId = new Map<string, NativeBodyCompletion["inventory"][number]>()
  const childCounts = new Map<string, number>()
  const depths = new Map<string, number>([[proof.page_id, 0]])
  for (const block of proof.inventory) {
    const parent = byId.get(block.parent_id)
    const depth = depths.get(block.parent_id)
    if (
      pageId(block.id) !== block.id ||
      pageId(block.parent_id) !== block.parent_id ||
      block.id === proof.page_id ||
      byId.has(block.id) ||
      depth === undefined ||
      depth >= 32 ||
      (block.parent_id !== proof.page_id &&
        (block.parent_type !== "block_id" ||
          parent?.has_children !== true ||
          parent.type === "child_page" ||
          parent.type === "child_database")) ||
      block.type === "unsupported" ||
      !block.type
    )
      incomplete("Native alias inventory has an incomplete, cyclic or foreign parent tree.")
    if (
      block.target_page_id !== undefined &&
      (block.type !== "link_to_page" || pageId(block.target_page_id) !== block.target_page_id)
    )
      incomplete("Only a typed page-link block can establish a native alias target.")
    if (
      unknown.has(block.id) &&
      (block.type !== "link_to_page" || block.has_children || block.target_page_id === undefined)
    )
      incomplete("An unknown export node is not a complete native Link to page block.")
    byId.set(block.id, block)
    depths.set(block.id, depth + 1)
    childCounts.set(block.parent_id, (childCounts.get(block.parent_id) ?? 0) + 1)
  }
  for (const block of proof.inventory)
    if (
      block.has_children &&
      block.type !== "child_page" &&
      block.type !== "child_database" &&
      !childCounts.has(block.id)
    )
      incomplete("A native alias inventory contains an unread physical subtree.")
  const placeholders = aliases(markdown, proof.page_id)
  const seen = new Set(placeholders.map((alias) => alias.block_id))
  if (
    seen.size !== placeholders.length ||
    seen.size !== unknown.size ||
    [...unknown].some((id) => !seen.has(id) || !byId.has(id))
  )
    incomplete("Unknown export nodes and fully read native page aliases do not match exactly.")
}

/** Only CRLF transport normalization changes the bytes, even for a completed alias. */
export function normalizeCompletedNativeBody(
  markdown: string,
  proof?: NativeBodyCompletion,
): string {
  if (proof === undefined) return normalizeObservedBody(markdown)
  validateNativeBodyCompletion(markdown, proof)
  return markdown.replace(/\r\n/g, "\n")
}

export function completeNativeAliasBody(
  page: string,
  body: {
    readonly markdown: string
    readonly truncated: boolean
    readonly unknown_block_ids: readonly string[]
  },
  api: Notion["Service"],
) {
  return Effect.gen(function* () {
    // Do not scan ordinary files. This path is justified only by actual unknown
    // export nodes. Pagination, parent ownership and cycle checks are shared
    // with the existing native reference reader.
    const unknown = yield* Effect.try({
      try: () => {
        const found = aliases(body.markdown, page)
        if (!body.unknown_block_ids.length || found.length !== body.unknown_block_ids.length)
          incomplete("A truncated export cannot be completed by native aliases alone.")
        return body.unknown_block_ids.map((id) => {
          const canonical = pageId(id)
          if (canonical === undefined) incomplete("An unknown block has no exact identity.")
          return canonical
        })
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("BODY_INCOMPLETE", "Invalid native alias export."),
    })
    const blocks = yield* readLinkBlocks(page, api, {
      structureEvidence: true,
      completeBodyEvidence: true,
    }).pipe(
      Effect.mapError((error) =>
        fail("BODY_INCOMPLETE", "The physical block inventory for native aliases is incomplete.", {
          page_id: page,
          cause_code: error.code,
        }),
      ),
    )
    const proof = yield* Effect.try({
      try: () => ({
        version: 1 as const,
        kind: "link_to_page_blocks" as const,
        page_id: page,
        body_sha256: "",
        truncated: body.truncated,
        unknown_block_ids: unknown,
        inventory_complete: true as const,
        inventory: blocks.map((block): NativeBodyCompletion["inventory"][number] => {
          const parent = property(block.parent)
          const parentType = parent.type
          if (
            block.object !== "block" ||
            block.archived === true ||
            block.in_trash === true ||
            typeof block.has_children !== "boolean" ||
            (parentType !== "page_id" && parentType !== "block_id")
          )
            incomplete("The physical inventory contains an unavailable or invalid block.")
          const link = property(block.link_to_page)
          const target =
            block.type === "link_to_page" && link.type === "page_id"
              ? pageId(String(link.page_id))
              : undefined
          return {
            id: pageId(String(block.id)) ?? "",
            parent_id: pageId(String(parent[parentType])) ?? "",
            parent_type: parentType,
            type: String(block.type),
            has_children: block.has_children,
            ...(target === undefined ? {} : { target_page_id: target }),
          }
        }),
      }),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("BODY_INCOMPLETE", "Invalid native alias inventory."),
    })
    proof.body_sha256 = yield* sha256(body.markdown.replace(/\r\n/g, "\n"))
    yield* Effect.try({
      try: () => validateNativeBodyCompletion(body.markdown, proof, { page_id: page }),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("BODY_INCOMPLETE", "Invalid native alias completion."),
    })
    return proof
  })
}

export function nativeAliasTargets(markdown: string, proof: NativeBodyCompletion) {
  const byId = new Map(proof.inventory.map((block) => [block.id, block]))
  return aliases(markdown, proof.page_id).map((alias) => {
    const page = byId.get(alias.block_id)?.target_page_id
    if (page === undefined) incomplete("A verified native alias lost its exact target.")
    return { ...alias, page_id: page }
  })
}

/** Materialization is derived. The retained body and its SHA keep the original
 * unknown tag; only this consumer projection resolves the verified page target. */
export function materializeNativeAliases(
  markdown: string,
  proof: NativeBodyCompletion,
  change: (href: string, page: string) => string,
): string {
  let result = markdown
  for (const alias of nativeAliasTargets(markdown, proof).reverse()) {
    const mapped = change(alias.href, alias.page_id)
    const href =
      mapped === alias.href ? `https://www.notion.so/${alias.page_id.replaceAll("-", "")}` : mapped
    result = result.slice(0, alias.start) + `[Link to page](${href})` + result.slice(alias.end)
  }
  return result
}

/** A target can change while the exporter keeps the same unknown tag. Retained
 * identities therefore include the proof hash only when that evidence exists. */
export function nativeObservedObjectIdentity(hash: string, proof?: NativeBodyCompletion) {
  return Effect.gen(function* () {
    const suffix =
      proof === undefined ? hash : `${hash}.${yield* sha256(canonicalSharedJson(proof))}`
    return { object_id: `body-${suffix}`, operation_id: `retain-${suffix}` }
  })
}
