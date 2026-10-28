import { publicationZeroListCandidates } from "./publication-zero-list-history.ts"
import { verifyCompletedZeroListRepair } from "./publication-zero-list-repair.ts"
import { publicationMarkdownReplayCandidates } from "./publication-markdown-replay.ts"
import { observedMarkdownCorrectionCoverage } from "./publication-markdown-history.ts"
import { exactPlainTextLanguageBodyEffect } from "./publication-code-language-effects.ts"
import {
  retainedUnusableUploadCandidate,
  retainedUploadCertificates,
  retainedUploadReplacementCandidates,
  retainedUploadRecovery,
  retainedUploadDigest,
  type RetainedUploadSequence,
} from "./publication-retained-upload.ts"
import { importDocument, readImportZip } from "./import.ts"
import { terminalPublicationCommitCandidate } from "./publication-terminal-commit.ts"
import { Effect } from "effect"
import { fail, property, text, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { sha256, Store } from "./store.ts"
import { pageMarkdown, rewritePageLinks, withoutChildPages } from "./references.ts"
import { bodyIdentity, portableZip, readPortable } from "./portable.ts"
import { pageId } from "./ref.ts"
import { publicationGuardComparison, verifyPublicationMetadata } from "./publication-source.ts"
import {
  codeLanguage,
  fromNotionMarkdown,
  notionMarkdownForComparison,
  projectNotionBlockTree,
  samePublishedMarkdown,
  type MarkdownLinkDestinationMatch,
  type NotionBlockBoundary,
} from "./markdown.ts"
import {
  publicationExternalLinksMatch,
  publicationSourceDestination,
  type PublicationMarkdownMapping,
} from "./publication-markdown.ts"
import {
  publicationMarker,
  publicationManifest,
  publicationGuard,
  verifyPublicationOwnership,
  verifyCreatedPublicationPage,
  PublicationReadOperation,
} from "./publication-integrity.ts"
import { openSkill } from "./snapshot.ts"
import {
  isUploadIntent,
  observeUpload,
  retainedTerminalUploadOrphan,
  verifyAttachedUpload,
} from "./publication-upload.ts"
import type { Receipt } from "./publication-model.ts"
import { mapMarkdownLinks } from "./typed-links.ts"
import {
  creationMarkerProof,
  withoutCreationMarker,
  creationProofFromBody,
  creationProofMatchesIntent,
} from "./publication-create-identity.ts"
import { decodeReferenceLinks } from "./reference-links.ts"
import {
  acknowledgedChildCreate,
  acknowledgedRootCreate,
  canonical,
  publicationBlockReplacementCandidates,
  publicationGuardRoles,
  publicationJournalSettled,
  publicationMarkerAuthority,
  publicationPropertyReplacementCandidates,
  completedBlockOwnerPropertiesMatch,
  type PublicationVerifiedProperties,
  publicationListStartRepairCandidates,
} from "./publication-effect-proof.ts"
import { verifyCompletedListStartRepair } from "./publication-list-repair.ts"
import { hasOriginalEmptyReferencesCheckpoint } from "./publication-empty-references.ts"
import { hasOriginalAcknowledgedReferencesCheckpoint } from "./publication-acknowledged-references.ts"
import {
  retainedChildTableComparison,
  retainedChildTableRootBlocks,
} from "./retained-child-table.ts"
import { retainedChildListComparison } from "./retained-child-list.ts"
import { physicalReadbackTarget } from "./publication-physical-target.ts"
import { pageLocalUnicodeFragmentTarget } from "./publication-local-fragment.ts"

export { canonical, publicationGuardRoles } from "./publication-effect-proof.ts"

import {
  terminalCanonicalCodeAliasCandidate,
  verifyTerminalCanonicalCodeAlias,
  canonicalCodeLanguageCheckpoint,
  certifiedCanonicalCodeAliasCandidate,
  verifyCertifiedCanonicalCodeAlias,
} from "./publication-code-language-checkpoint.ts"

type Intent = Receipt["intents"][number]

export const keyFor = (id: string) => `publications/${id}.json`
export const copy = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A

/** Markdown convergence remains provisional until journaled block repairs finish. */
export function publicationMarkdownMatches(
  intent: Intent,
  actual: string,
  target: string,
  blocks?: readonly NotionBlockBoundary[],
  sameLinkDestination?: MarkdownLinkDestinationMatch,
) {
  const actualMarker = creationMarkerProof(actual)
  const targetMarker = creationMarkerProof(target)
  if (actualMarker !== undefined || targetMarker !== undefined) {
    if (!actualMarker || !targetMarker || canonical(actualMarker) !== canonical(targetMarker))
      return false
    if (blocks !== undefined) {
      const first = blocks[0]
      if (
        !first ||
        first.type !== "paragraph" ||
        first.has_children ||
        typeof first.text !== "string" ||
        canonical(creationMarkerProof(first.text)) !== canonical(actualMarker)
      )
        return false
      blocks = blocks.slice(1)
    }
    actual = withoutCreationMarker(actual)
    target = withoutCreationMarker(target)
  }
  actual = notionMarkdownForComparison(actual, target, blocks) ?? fromNotionMarkdown(actual, blocks)
  if (samePublishedMarkdown(actual, target, sameLinkDestination, blocks)) return true
  if (intent.typed_links?.state !== "pending") return false
  const destinations: string[] = []
  const expected = mapMarkdownLinks(target, (url) => {
    destinations.push(url)
    const id = pageId(url)
    if (!id || !/^https?:\/\//.test(url)) return url
    const parsed = new URL(url)
    if (!parsed.hash.startsWith("#ntn-skills-path=")) return url
    return `https://www.notion.so/${id.replaceAll("-", "")}${parsed.search}${parsed.hash}`
  })
  let index = 0
  const provisional = mapMarkdownLinks(actual, (url) => {
    const destination = destinations[index++]
    const id = pageId(url)
    if (!destination || !id || id !== pageId(destination) || !/^https?:\/\//.test(url)) return url
    const saved = new URL(destination)
    const parsed = new URL(url)
    if (!saved.hash.startsWith("#ntn-skills-path=") || (parsed.hash && parsed.hash !== saved.hash))
      return url
    return `https://www.notion.so/${id.replaceAll("-", "")}${parsed.search}${saved.hash}`
  })
  return samePublishedMarkdown(provisional, expected, sameLinkDestination, blocks)
}

export interface PublicationReadPhase {
  readonly raw: Record<string, unknown>
  sequence: number
  readonly order: Map<string, number>
  readonly before: Map<string, { sequence: number; value: unknown }>
  readonly proofs: Map<
    string,
    {
      actual: string
      blocks: readonly NotionBlockBoundary[]
      raw_root_blocks?: readonly unknown[]
      strict_structure?: boolean
    }
  >
}

/** Transient responses belong to one read phase and never extend receipt authority. */
export function publicationReadPhase(raw: Record<string, unknown> = {}): PublicationReadPhase {
  return {
    raw,
    sequence: 0,
    order: new Map<string, number>(),
    before: new Map<string, { sequence: number; value: unknown }>(),
    proofs: new Map<
      string,
      {
        actual: string
        blocks: readonly NotionBlockBoundary[]
        raw_root_blocks?: readonly unknown[]
      }
    >(),
  }
}

export function capturePublicationRead(phase: PublicationReadPhase, path: string, raw: unknown) {
  const sequence = ++phase.sequence
  phase.raw[path] = raw
  phase.order.set(path, sequence)
  const page = /^v1\/pages\/([^/]+)(?:\/markdown)?$/.exec(path)?.[1]
  const owner = page ?? /^v1\/blocks\/([^/?]+)(?:\/children\?|$)/.exec(path)?.[1]
  if (!owner) return
  const identity = pageId(owner) ?? owner
  const matchesId = (id: unknown) => typeof id === "string" && (pageId(id) ?? id) === identity
  for (const [root, proof] of phase.proofs) {
    // Unchanged metadata for the root itself can retain its bracket. A new
    // child-page observation, like any descendant read, invalidates its parent.
    if (page && matchesId(root)) continue
    if (
      proof.blocks.some(
        (block) =>
          matchesId(block.id) ||
          block.descendants?.some((child) => matchesId(child.id)) ||
          block.quote_descendants?.some((child) => matchesId(child.id)) ||
          block.list_table_descendants?.some((child) => matchesId(child.id)) ||
          block.table_evidence?.rows.some((row) => matchesId(row.id)),
      ) ||
      proof.raw_root_blocks?.some((block) => matchesId(property(block).id))
    ) {
      phase.proofs.delete(root)
      // A changed descendant cannot retain a cached parent inventory from an
      // older bracket, even when the Markdown body has the same bytes.
      phase.before.delete(root)
    }
  }
  if (path === `v1/pages/${owner}`) {
    const value = metadata(raw)
    const before = phase.before.get(owner)
    if (!before || canonical(before.value) !== canonical(value)) {
      phase.before.set(owner, { sequence, value })
      phase.proofs.delete(owner)
    }
  } else phase.proofs.delete(owner)
}

/** Root order and bounded list/quote/table descendants stay inside this page's own tree. */
export function readPublicationRootBlocks(
  page: string,
  api: Notion["Service"],
  raw: Record<string, unknown>,
  strictStructure = false,
) {
  return Effect.gen(function* () {
    const owner = pageId(page)
    if (!owner)
      return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid publication root page."))
    const blocks: unknown[] = [],
      ids = new Set<string>([owner])
    const listTypes = new Set(["numbered_list_item", "bulleted_list_item"])
    function children(
      parentId: string,
      depth: number,
      tableOwner?: string,
      rootTableRows = false,
    ): Effect.Effect<void, SkillsError> {
      return Effect.gen(function* () {
        const parentOwner = pageId(parentId)
        if (!parentOwner || depth > 32)
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Invalid publication descendant scope."),
          )
        const cursors = new Set<string>()
        let cursor: string | undefined,
          pages = 0
        do {
          if (++pages > 50)
            return yield* Effect.fail(
              fail("INVALID_RESPONSE", "Publication block pagination exceeds the supported scope."),
            )
          const path = `v1/blocks/${parentId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
          if (!(path in raw)) raw[path] = yield* api.request(path)
          const result = property(raw[path])
          if (!Array.isArray(result.results) || typeof result.has_more !== "boolean")
            return yield* Effect.fail(
              fail("INVALID_RESPONSE", "Invalid publication block inventory."),
            )
          for (const block of result.results) {
            const value = property(block),
              id = value.id,
              parent = property(value.parent)
            const type = String(value.type)
            if (rootTableRows && (type !== "table_row" || value.has_children !== false))
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "A root table requires complete direct leaf rows."),
              )
            if (
              strictStructure &&
              (!publicationBlockTypes[type] ||
                typeof value[type] !== "object" ||
                value[type] === null ||
                Array.isArray(value[type]))
            )
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "Unsupported publication block evidence."),
              )
            if (
              !(depth === 0
                ? ["page_id", "block_id"].includes(String(parent.type))
                : parent.type === "block_id") ||
              typeof parent[String(parent.type)] !== "string" ||
              pageId(String(parent[String(parent.type)])) !== parentOwner
            )
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "Publication block belongs to another parent."),
              )
            if (typeof id !== "string" || !id || ids.has(pageId(id) ?? id) || blocks.length >= 4096)
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "Invalid publication block order or scope."),
              )
            ids.add(pageId(id) ?? id)
            blocks.push(block)
            // Child pages, databases and synced blocks are separate boundaries.
            // A root table owns only its direct leaf rows. Tables under a root
            // quote/list still require that existing exact container owner;
            // nested or sibling tables cannot impersonate that subtree.
            const quote = depth === 0 && type === "quote"
            const rootTable = depth === 0 && type === "table"
            const container = depth === 0 && (quote || listTypes.has(type))
            if (
              value.has_children === true &&
              (listTypes.has(type) ||
                quote ||
                rootTable ||
                (type === "table" && tableOwner === parentId))
            )
              yield* children(id, depth + 1, container ? id : tableOwner, rootTable)
          }
          if (!result.has_more) {
            if (result.next_cursor !== null && result.next_cursor !== undefined)
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "Invalid publication block pagination."),
              )
            break
          }
          if (
            typeof result.next_cursor !== "string" ||
            !result.next_cursor ||
            cursors.has(result.next_cursor)
          )
            return yield* Effect.fail(
              fail("INVALID_RESPONSE", "Invalid publication block pagination."),
            )
          cursor = result.next_cursor
          cursors.add(cursor)
        } while (cursor)
      })
    }
    yield* children(page, 0)
    const projected = projectNotionBlockTree(page, blocks)
    if (!projected)
      return yield* Effect.fail(
        fail("INVALID_RESPONSE", "Invalid publication root block evidence."),
      )
    return projected
  })
}
const publicationBlockTypes: Record<string, true> = {
  paragraph: true,
  heading_1: true,
  heading_2: true,
  heading_3: true,
  bulleted_list_item: true,
  numbered_list_item: true,
  to_do: true,
  toggle: true,
  quote: true,
  callout: true,
  code: true,
  child_page: true,
  child_database: true,
  column: true,
  column_list: true,
  divider: true,
  breadcrumb: true,
  table_of_contents: true,
  table: true,
  table_row: true,
  image: true,
  video: true,
  audio: true,
  file: true,
  pdf: true,
  bookmark: true,
  embed: true,
  equation: true,
  link_preview: true,
  link_to_page: true,
  synced_block: true,
  template: true,
}

/** A metadata bracket binds current Markdown and root evidence to the same revision. */
export function readPublicationMarkdownMatches(
  intent: Intent,
  actual: string,
  target: string,
  api: Notion["Service"],
  phase: PublicationReadPhase,
  mapping?: PublicationMarkdownMapping,
  requireStructure = false,
) {
  return Effect.gen(function* () {
    const mapActual = mapping?.local ?? ((markdown: string) => markdown)
    const body = property(intent.body)
    const originalTarget =
      body.type === "replace_content" ? property(body.replace_content).new_str : undefined
    const beforeTarget = intent.guards?.[intent.path]
    const updates = property(body.update_content).content_updates
    const retainedTarget =
      typeof originalTarget === "string"
        ? originalTarget
        : body.type === "update_content" &&
            typeof beforeTarget === "string" &&
            Array.isArray(updates) &&
            updates.length === 1 &&
            property(updates[0]).old_str === beforeTarget
          ? property(updates[0]).new_str
          : undefined
    const page = /^v1\/pages\/([^/]+)\/markdown$/.exec(intent.path)?.[1]
    const matchesMapped = (
      blocks?: readonly NotionBlockBoundary[],
      rawRoots?: readonly unknown[],
    ) => {
      const retainedComparison = (markdown: string) =>
        page !== undefined && rawRoots !== undefined
          ? (retainedChildTableComparison(page, markdown, rawRoots) ??
            retainedChildListComparison(page, markdown, rawRoots))
          : undefined
      // The caller must first name the original retained target. Framing may
      // clarify its proven child suffix, never establish that target identity.
      const callerNamesRetained =
        typeof retainedTarget === "string" && mapActual(retainedTarget) === target
      const framedRetained =
        callerNamesRetained && page !== undefined && blocks !== undefined && rawRoots !== undefined
          ? retainedComparison(retainedTarget)
          : undefined
      const frame = (markdown: string) =>
        framedRetained !== undefined && page !== undefined && rawRoots !== undefined
          ? (retainedComparison(markdown) ?? markdown)
          : markdown
      const comparisonActual = frame(actual)
      const comparisonTarget = framedRetained === undefined ? target : mapActual(framedRetained)
      const compare = (
        readback: string,
        expected: string,
        evidence?: readonly NotionBlockBoundary[],
        sameLink?: MarkdownLinkDestinationMatch,
      ) =>
        publicationMarkdownMatches(
          intent,
          frame(readback),
          pageLocalUnicodeFragmentTarget(
            physicalReadbackTarget(frame(expected), evidence),
            evidence,
          ),
          evidence,
          sameLink,
        )
      const sameSourceDestination = publicationSourceDestination(mapping?.source, blocks)
      if (callerNamesRetained && typeof retainedTarget === "string") {
        // The caller names this exact retained request once. Physical helpers
        // then use its frozen raw text; mapping cannot select another target.
        const rawRetained = framedRetained ?? retainedTarget
        const physicalRetained = pageLocalUnicodeFragmentTarget(
          physicalReadbackTarget(rawRetained, blocks),
          blocks,
        )
        const candidate = notionMarkdownForComparison(comparisonActual, physicalRetained, blocks)
        if (
          ((blocks !== undefined &&
            publicationMarkdownMatches(
              intent,
              comparisonActual,
              physicalRetained,
              blocks,
              sameSourceDestination,
            )) ||
            (candidate !== undefined &&
              publicationMarkdownMatches(
                intent,
                candidate,
                physicalRetained,
                blocks,
                sameSourceDestination,
              ))) &&
          publicationExternalLinksMatch(
            actual,
            retainedTarget,
            (markdown) => markdown,
            blocks,
            compare,
            sameSourceDestination,
          )
        )
          return true
      }
      if (
        !publicationMarkdownMatches(intent, mapActual(comparisonActual), comparisonTarget, blocks)
      )
        return false
      if (!mapping) return true
      if (!callerNamesRetained || typeof retainedTarget !== "string") return false
      // Keep the original external destinations at aligned AST links. The old
      // mapping must also match, so this proof can only narrow acceptance.
      return publicationExternalLinksMatch(
        actual,
        retainedTarget,
        mapping.preserveExternal,
        blocks,
        compare,
        sameSourceDestination,
      )
    }
    // Compare the retained spelling before URL policy rewrites Notion's automatic
    // filename autolinks as relative links. The caller must name this same target.
    if (
      !requireStructure &&
      typeof originalTarget === "string" &&
      mapActual(originalTarget) === target &&
      publicationMarkdownMatches(intent, actual, originalTarget)
    )
      return true
    if (!requireStructure && matchesMapped()) return true
    if (!page) return false
    const proof = phase.proofs.get(page)
    if (proof?.actual === actual && (!requireStructure || proof.strict_structure))
      return matchesMapped(proof.blocks, proof.raw_root_blocks)
    const pagePath = `v1/pages/${page}`
    const markdownPath = `${pagePath}/markdown`
    let before = phase.before.get(page)
    if (
      !before ||
      (phase.order.get(markdownPath) ?? 0) <= before.sequence ||
      pageMarkdown(phase.raw[markdownPath]) !== actual
    ) {
      const raw = yield* api.request(pagePath)
      capturePublicationRead(phase, pagePath, raw)
      before = { sequence: phase.sequence, value: metadata(raw) }
      phase.before.set(page, before)
      const markdown = yield* api.request(markdownPath)
      capturePublicationRead(phase, markdownPath, markdown)
      if (pageMarkdown(markdown) !== actual)
        return yield* Effect.fail(
          fail("WRITE_CONFLICT", "Publication Markdown changed during structure proof.", {
            path: markdownPath,
          }),
        )
    }
    const version = property(before.value)
    if (
      typeof version.id !== "string" ||
      pageId(version.id) !== pageId(page) ||
      typeof version.last_edited_time !== "string" ||
      version.archived === true ||
      version.in_trash === true
    )
      return false
    const raw: Record<string, unknown> = {}
    for (const [path, sequence] of phase.order)
      if (sequence > before.sequence && path.startsWith(`v1/blocks/${page}/children?`))
        raw[path] = phase.raw[path]
    const blocks = yield* readPublicationRootBlocks(page, api, raw, requireStructure)
    const after = yield* api.request(pagePath)
    capturePublicationRead(phase, pagePath, after)
    if (canonical(metadata(after)) !== canonical(before.value))
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "Publication revision changed during structure proof.", {
          path: pagePath,
        }),
      )
    const rawRootBlocks = retainedChildTableRootBlocks(page, raw)
    const retainedRoots = rawRootBlocks === undefined ? undefined : structuredClone(rawRootBlocks)
    phase.proofs.set(page, {
      actual,
      blocks,
      ...(retainedRoots === undefined ? {} : { raw_root_blocks: retainedRoots }),
      ...(requireStructure ? { strict_structure: true } : {}),
    })
    return matchesMapped(blocks, retainedRoots)
  })
}

/** Compare only requested fields against Notion's authored property values. */
export function publicationPropertiesMatch(raw: unknown, requested: unknown) {
  const fields = property(property(raw).properties)
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => {
          if (["type", "plain_text", "href"].includes(key)) return false
          if (key === "annotations")
            return Object.entries(property(item)).some(
              ([name, flag]) => flag !== (name === "color" ? "default" : false),
            )
          if (key === "link" && item === null) return false
          return true
        })
        .map(([key, item]) => [key, clean(item)]),
    )
  }
  return Object.entries(property(requested)).every(([key, value]) => {
    const field = property(fields[key] ?? Object.values(fields).find((v) => property(v).id === key))
    return Object.entries(property(value)).every(([kind, target]) => {
      if (kind !== "select") return canonical(clean(field[kind])) === canonical(clean(target))
      const actual = field.select
      if (target === null) return actual === null
      if (
        !target ||
        typeof target !== "object" ||
        Array.isArray(target) ||
        !actual ||
        typeof actual !== "object" ||
        Array.isArray(actual)
      )
        return false
      const requested = Object.entries(target)
      return (
        requested.length > 0 &&
        requested.every(
          ([key, item]) =>
            item !== undefined &&
            Object.hasOwn(actual, key) &&
            canonical(property(actual)[key]) === canonical(item),
        )
      )
    })
  })
}
export function metadata(raw: unknown) {
  const value = property(raw)
  // Signed download URLs and server-generated presentation fields are not edit authority.
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(clean)
    if (!item || typeof item !== "object") return item
    const value = property(item)
    if (
      (value.type === "file" || value.type === "external") &&
      ("file" in value || "external" in value)
    )
      return { name: value.name, type: value.type, id: value.id }
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !["href", "expiry_time"].includes(key))
        .map(([key, child]) => [key, clean(child)]),
    )
  }
  return clean({
    id: value.id,
    parent: value.parent,
    properties: value.properties,
    last_edited_time: value.last_edited_time,
    archived: value.archived ?? false,
    in_trash: value.in_trash ?? false,
  })
}
export function metadataContent(raw: unknown) {
  const { last_edited_time: _revision, properties, ...content } = property(raw)
  return {
    ...content,
    properties: Object.fromEntries(
      Object.entries(property(properties)).map(([key, raw]) => {
        const value = property(raw)
        if (value.type !== "last_edited_time") return [key, value]
        const { last_edited_time: _propertyRevision, ...definition } = value
        return [key, definition]
      }),
    ),
  }
}

/** Retain edit authority, not response-only rich-text rendering or envelope fields. */
export function blockObservation(raw: unknown) {
  const block = property(raw)
  if (typeof block.id !== "string" || typeof block.type !== "string" || !block[block.type])
    throw fail("INVALID_RESPONSE", "Invalid publication block observation.")
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries({
        ...(typeof property(property(value).text).content === "string" ? { type: "text" } : {}),
        ...value,
      })
        .filter(([key, item]) => {
          if (["plain_text", "href"].includes(key)) return false
          if (key === "link" && item === null) return false
          if (key === "annotations")
            return Object.entries(property(item)).some(
              ([name, flag]) => flag !== (name === "color" ? "default" : false),
            )
          return true
        })
        .map(([key, item]) => [
          key,
          key === "annotations"
            ? Object.fromEntries(
                Object.entries(property(item)).filter(
                  ([name, flag]) => flag !== (name === "color" ? "default" : false),
                ),
              )
            : clean(item),
        ]),
    )
  }
  return {
    id: block.id,
    type: block.type,
    parent: block.parent,
    has_children: block.has_children ?? false,
    archived: block.archived ?? false,
    in_trash: block.in_trash ?? false,
    last_edited_time: block.last_edited_time,
    [block.type]: clean(block[block.type]),
  }
}

function blockContent(raw: unknown) {
  const { last_edited_time: _revision, ...content } = property(blockObservation(raw))
  return content
}

/** A block response is not authority: require the saved ancestor chain and owned page. */
export function blockPatchRecovery(
  intent: Intent,
  receipt: Receipt,
  observed: Record<string, unknown>,
  allowOriginal = false,
) {
  return blockPatchProof(intent, receipt, observed, { phase: "pending", allowOriginal })
}

function blockPatchProof(
  intent: Intent,
  receipt: Receipt,
  observed: Record<string, unknown>,
  checkpoint:
    | { phase: "pending"; allowOriginal: boolean }
    | {
        phase: "completed"
        verifiedBodies: ReadonlySet<string>
        verifiedProperties: readonly PublicationVerifiedProperties[]
      },
) {
  const unknown = (reason: string) => ({ outcome: "unknown" as const, reason, guards: {} })
  const conflict = (reason: string) => ({ outcome: "conflict" as const, reason, guards: {} })
  if (checkpoint.phase === "completed" && intent.status !== "completed")
    return unknown("A completed block checkpoint requires an acknowledged mutation.")
  const allowOriginal = checkpoint.phase === "pending" && checkpoint.allowOriginal
  const saved = intent.guards
  const before = saved?.[intent.path]
  const actual = observed[intent.path]
  if (intent.method !== "PATCH" || !/^v1\/blocks\/[^/]+$/.test(intent.path) || !saved || !before)
    return unknown("Block mutation has no retained original block guard.")
  if (actual === undefined) return unknown("Block mutation readback is unavailable.")
  const prior = property(blockContent(before))
  if (prior.id !== intent.path.split("/")[2])
    return unknown("Block mutation locator does not match its retained block identity.")
  const body = property(intent.body)
  const type = String(prior.type)
  const keys = Object.keys(body)
  if (
    keys.length === 0 ||
    keys.some((key) => ![type, "archived", "in_trash"].includes(key)) ||
    (type in body && Object.keys(property(body[type])).length === 0)
  )
    return unknown("Block mutation has no deterministic whole-field target.")
  const target = blockContent({
    ...prior,
    ...body,
    ...(type in body ? { [type]: { ...property(prior[type]), ...property(body[type]) } } : {}),
  })
  const content = blockContent(actual)
  const original = canonical(content) === canonical(prior)
  const applied = canonical(content) === canonical(target)
  if (!applied && (!original || !allowOriginal))
    return original
      ? unknown("Exact saved block content has not converged.")
      : conflict("Block differs from both its original content and whole supplied fields.")
  if (!applied)
    for (const [path, value] of Object.entries(saved)) {
      if (!(path in observed))
        return unknown("Original block retry has incomplete readback guards.")
      if (canonical(value) !== canonical(observed[path]))
        return conflict("Remote state changed before the original block could be retried.")
    }
  const guards: Record<string, unknown> = { [intent.path]: actual }
  const roles = publicationGuardRoles(receipt)
  const seen = new Set<string>([intent.path])
  let parent = property(prior.parent)
  while (parent.type === "block_id" && typeof parent.block_id === "string") {
    const path = `v1/blocks/${parent.block_id}`
    if (seen.has(path)) return unknown("Block ownership chain is cyclic.")
    seen.add(path)
    if (saved[path] === undefined || observed[path] === undefined)
      return unknown("Block ownership chain has incomplete retained observations.")
    if (canonical(blockContent(saved[path])) !== canonical(blockContent(observed[path])))
      return conflict("An ancestor block changed alongside the pending block write.")
    guards[path] = observed[path]
    parent = property(property(saved[path]).parent)
  }
  if (parent.type !== "page_id" || typeof parent.page_id !== "string")
    return unknown("Block mutation has no retained owning page.")
  const pagePath = `v1/pages/${parent.page_id}`
  const bodyPath = `${pagePath}/markdown`
  if (!roles.ownedMutationTargets.has(pagePath))
    return unknown("A read-only dependency is not a block mutation target.")
  if (
    saved[pagePath] === undefined ||
    typeof saved[bodyPath] !== "string" ||
    observed[pagePath] === undefined ||
    typeof observed[bodyPath] !== "string"
  )
    return unknown("Block mutation has no retained original owner body and metadata.")
  const languageBodyEffect =
    checkpoint.phase === "pending" &&
    applied &&
    saved[bodyPath] !== observed[bodyPath] &&
    exactPlainTextLanguageBodyEffect(intent, saved[bodyPath], observed[bodyPath])
  if (checkpoint.phase === "completed") {
    // An acknowledged block repair can change its owner's Markdown. Its final
    // checkpoint must still be the original journal's exact retained snapshot;
    // pending effects have no authority to replace their pre-mutation guards.
    if (receipt.guards[pagePath] === undefined || typeof receipt.guards[bodyPath] !== "string")
      return unknown("A completed block lacks its retained owner checkpoint.")
    if (saved[bodyPath] !== observed[bodyPath] && !checkpoint.verifiedBodies.has(bodyPath))
      return unknown("A changed owner body lacks a verified complete Markdown replacement.")
    if (
      publicationGuardComparison(receipt, pagePath, metadataContent(saved[pagePath])) !==
        publicationGuardComparison(receipt, pagePath, metadataContent(observed[pagePath])) &&
      !completedBlockOwnerPropertiesMatch(
        intent,
        receipt,
        pagePath,
        metadataContent(saved[pagePath]),
        metadataContent(observed[pagePath]),
        checkpoint.verifiedProperties,
      )
    )
      return conflict("Owner metadata changed alongside the completed block write.")
    if (
      publicationGuardComparison(receipt, pagePath, receipt.guards[pagePath]) !==
        publicationGuardComparison(receipt, pagePath, observed[pagePath]) ||
      receipt.guards[bodyPath] !== observed[bodyPath]
    )
      return conflict("Owner body or metadata changed after the completed block checkpoint.")
  } else if (
    publicationGuardComparison(receipt, pagePath, metadataContent(saved[pagePath])) !==
      publicationGuardComparison(receipt, pagePath, metadataContent(observed[pagePath])) ||
    (saved[bodyPath] !== observed[bodyPath] && !languageBodyEffect)
  )
    return conflict("Owner body or metadata changed alongside the pending block write.")
  for (const field of Object.values(property(property(saved[pagePath]).properties)).map(property))
    if (
      Array.isArray(field.files) &&
      field.files.some((file) => typeof property(file).id !== "string")
    )
      return unknown("An owner attachment lacks stable identity across the pending block write.")
  guards[pagePath] = observed[pagePath]
  if (languageBodyEffect) guards[bodyPath] = observed[bodyPath]
  if (!applied) {
    const language = property(body.code).language
    const canonicalLanguage = typeof language === "string" ? codeLanguage(language) : undefined
    const staleLanguage =
      type === "code" &&
      keys.length === 1 &&
      Object.keys(property(body.code)).length === 1 &&
      canonicalLanguage !== language &&
      canonicalLanguage === property(prior.code).language
    return { outcome: "retry" as const, guards, ownerPath: pagePath, skip: staleLanguage }
  }
  return { outcome: "success" as const, guards, ownerPath: pagePath }
}
export function observation(path: string, raw: unknown): unknown {
  if (/^v1\/pages\/[^/]+$/.test(path)) return metadata(raw)
  if (/^v1\/pages\/[^/]+\/markdown$/.test(path)) return pageMarkdown(raw)
  if (/^v1\/blocks\/[^/]+$/.test(path)) return blockObservation(raw)
  if (/^v1\/blocks\/[^/]+\/children\?/.test(path)) {
    const value = property(raw)
    if (!Array.isArray(value.results) || typeof value.has_more !== "boolean")
      throw fail("INVALID_RESPONSE", "Invalid publication child-page observation.")
    return {
      results: value.results
        .map(property)
        .filter((block) => block.type === "child_page")
        .map((block) => ({ id: block.id, type: block.type, child_page: block.child_page })),
      has_more: value.has_more,
      next_cursor: value.next_cursor,
    }
  }
  if (/^v1\/pages\/[^/]+\/properties\//.test(path)) {
    const { request_id: _requestId, ...content } = property(raw)
    return content
  }
  return undefined
}

/** This proof never repairs a journal. Only the latest owned effect of each field is current. */
export function completedPublicationProof(
  receipt: Receipt,
  raw: Record<string, unknown>,
  api: Notion["Service"],
  phase: PublicationReadPhase,
  pendingUpload?: RetainedUploadSequence,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const refuse = (reason: string) => ({ outcome: "unknown" as const, reason })
    const integrity = yield* store.integrity.inspect(receipt.operation_id)
    const rootPath = `v1/pages/${receipt.page_id}`
    const terminalCommit = terminalPublicationCommitCandidate(
      receipt,
      integrity,
      metadata(raw[rootPath]),
      publicationMarker,
    )
    const retainedUploads = retainedUploadReplacementCandidates(receipt)
    if (!retainedUploads)
      return refuse("An unusable-upload certificate no longer binds its original history.")
    const retainedPending =
      pendingUpload &&
      (retainedUploads[0]?.sequence ??
        retainedUnusableUploadCandidate(receipt, metadata(raw[rootPath])))
    if (pendingUpload && canonical(retainedPending) !== canonical(pendingUpload))
      return refuse("The upload proof input differs from the exact original sequence.")
    if (
      retainedUploads.some(
        (item) => !integrity || item.certificate.intended_hash !== integrity.intended_hash,
      )
    )
      return refuse("A retained upload differs from the original frozen intended source.")
    const retainedCovered = new Set(
      retainedUploads
        .filter((item) => item.replacement)
        .flatMap((item) => item.sequence.covered_indices),
    )
    for (const index of retainedPending?.covered_indices ?? []) retainedCovered.add(index)
    const verifiedUploadAttachments = new Set<number>()
    const terminalAlias = terminalCanonicalCodeAliasCandidate(receipt)
    const certifiedAlias = certifiedCanonicalCodeAliasCandidate(receipt)
    const alias = terminalAlias ?? certifiedAlias?.candidate
    if (
      !receipt.page_id ||
      receipt.intents.length === 0 ||
      (!publicationJournalSettled(receipt) && !alias && !terminalCommit && !retainedPending)
    )
      return refuse(
        "Fence reassessment requires completed effects or formally settled no-effect history.",
      )
    if (
      !integrity ||
      (!terminalCommit &&
        !publicationMarkerAuthority(receipt, raw[rootPath], integrity, publicationMarker))
    )
      return refuse("Current marker and original intended identity are not identical.")
    const acknowledgedRoot =
      acknowledgedRootCreate(receipt, raw[rootPath], integrity, publicationMarker) ??
      terminalCommit?.acknowledged_root_create
    const files: Array<readonly [string, number, string]> = []
    for (const file of [...receipt.portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      if ((yield* sha256(bytes)) !== file.sha256)
        return refuse("An original frozen source object failed its content hash.")
      files.push([file.path, bytes.length, file.sha256])
    }
    if (
      (yield* sha256(
        canonical([
          receipt.portable.kind,
          receipt.portable.name,
          receipt.portable.description,
          receipt.portable.main,
          files,
        ]),
      )) !== integrity.intended_hash
    )
      return refuse("Frozen publication content differs from its original intended hash.")
    // Final ownership may still be pending at this checkpoint. Prove each
    // acknowledged field below against its intent and the retained guards;
    // require final ownership before recognizing a committed publication.
    const roles = publicationGuardRoles(receipt)
    const referenceBindings = (page: unknown) => {
      const field = property(property(property(page).properties).References)
      return field.type === "rich_text" && Array.isArray(field.rich_text)
        ? decodeReferenceLinks({ rich_text: field.rich_text }, { readback: true })?.bindings
        : undefined
    }
    const sourcePath = (pagePath: string) => {
      if (pagePath === rootPath) return receipt.portable.main
      const id = pagePath.slice("v1/pages/".length)
      const title = text(property(property(property(raw[pagePath]).properties).title).title)
      const bound = new Set<string>()
      for (const owner of roles.ownedMutationTargets) {
        const bindings = referenceBindings(raw[owner])
        if (!bindings) continue
        for (const entry of bindings) if (entry.id === id) bound.add(entry.path)
      }
      if (bound.size > 1) return undefined
      const proofPaths = new Set<string>()
      for (const [index, intent] of receipt.intents.entries()) {
        if (
          intent.method !== "POST" ||
          intent.path !== "v1/pages" ||
          intent.recovery ||
          property(intent.response).id !== id
        )
          continue
        const proof = creationProofFromBody(intent.body)
        if (
          !proof ||
          proof.role !== "reference" ||
          !creationProofMatchesIntent(proof, receipt, index) ||
          proof.intended_hash !== integrity.intended_hash ||
          !receipt.portable.files.some(
            (file) => file.path === proof.path && file.sha256 === proof.source_sha256,
          )
        )
          continue
        proofPaths.add(proof.path)
      }
      if (proofPaths.size > 1) return undefined
      const proved = [...proofPaths][0]
      if (bound.size === 1) {
        const path = [...bound][0]!
        return proved !== undefined && proved !== path ? undefined : path
      }
      if (proved !== undefined) return proved
      const legacy = receipt.portable.files.some((file) => file.path === title)
        ? title
        : `references/${title}`
      return receipt.portable.files.some((file) => file.path === legacy) ? legacy : undefined
    }
    const pages: Array<{ id: string; path: string; markdown: string }> = []
    const claimed = new Set<string>()
    for (const path of roles.ownedMutationTargets) {
      const source = sourcePath(path)
      if (!source || claimed.has(source))
        return refuse("An owned page has no unique exact source path.")
      claimed.add(source)
      pages.push({ id: path.slice("v1/pages/".length), path: source, markdown: "" })
    }
    for (const path of roles.ownedMutationTargets) {
      const page = property(raw[path])
      if (page.id !== path.split("/")[2] || !(path + "/markdown" in receipt.guards))
        return refuse("An owned page lacks complete original body and metadata guards.")
      if (path === rootPath && property(page.parent).data_source_id !== receipt.data_source_id)
        return refuse("The current content root differs from its bound source.")
      const fields = property(page.properties)
      if ("References" in fields) {
        const inventory = `v1/blocks/${page.id}/children?page_size=100`
        if (!(inventory in receipt.guards))
          return refuse("An owned page lacks its retained child inventory.")
        const reference = property(fields.References)
        const propertyPath = `v1/pages/${page.id}/properties/${reference.id}?page_size=100`
        if (
          !(propertyPath in receipt.guards) &&
          !hasOriginalEmptyReferencesCheckpoint(receipt, path, metadata(page), raw)
        ) {
          if (
            path !== rootPath ||
            typeof reference.id !== "string" ||
            !/^[^/?#\\\s]+$/.test(reference.id) ||
            reference.id === "." ||
            reference.id === ".."
          )
            return refuse("An owned page lacks its complete retained References property.")
          // These are actual readApi responses in this existing transient phase.
          // They provide no new retained guard or authority for any other field.
          const referencesBefore = metadata(yield* api.request(rootPath))
          if (canonical(referencesBefore) !== canonical(receipt.guards[rootPath]))
            return refuse("The full root metadata changed before References observation.")
          const cursors = new Set<string>()
          let itemPath = propertyPath
          let referencesComplete = false
          for (let pages = 0; pages < 1000; pages++) {
            const response = property(yield* api.request(itemPath))
            if (response.object === "property_item") {
              referencesComplete =
                itemPath === propertyPath &&
                response.has_more !== true &&
                (response.next_cursor === null || response.next_cursor === undefined)
              break
            }
            if (!Array.isArray(response.results) || typeof response.has_more !== "boolean") break
            if (!response.has_more) {
              referencesComplete =
                response.next_cursor === null || response.next_cursor === undefined
              break
            }
            if (
              typeof response.next_cursor !== "string" ||
              !response.next_cursor ||
              cursors.has(response.next_cursor)
            )
              break
            cursors.add(response.next_cursor)
            let cursor: string
            try {
              cursor = encodeURIComponent(response.next_cursor)
            } catch {
              break
            }
            itemPath = propertyPath + "&start_cursor=" + cursor
          }
          const referencesAfter = metadata(yield* api.request(rootPath))
          if (
            !referencesComplete ||
            canonical(referencesBefore) !== canonical(referencesAfter) ||
            canonical(referencesAfter) !== canonical(receipt.guards[rootPath]) ||
            !hasOriginalAcknowledgedReferencesCheckpoint(
              receipt,
              path,
              raw,
              Object.fromEntries(
                [...roles.ownedMutationTargets].map((ownedPath) => [
                  ownedPath,
                  metadata(raw[ownedPath]),
                ]),
              ),
              integrity.intended_hash,
            )
          )
            return refuse("An owned page lacks its complete retained References property.")
        }
      }
      for (const [guardPath, guard] of Object.entries(receipt.guards)) {
        if (
          !guardPath.startsWith(`v1/blocks/${page.id}/children?`) &&
          !guardPath.startsWith(`v1/pages/${page.id}/properties/`)
        )
          continue
        const result = property(guard)
        if (
          result.has_more === true &&
          (typeof result.next_cursor !== "string" ||
            !Object.keys(receipt.guards).some(
              (path) =>
                path.startsWith(guardPath.split("?")[0]! + "?") &&
                path.includes(`start_cursor=${encodeURIComponent(String(result.next_cursor))}`),
            ))
        )
          return refuse("A retained graph inventory is missing its next page.")
      }
      for (const field of Object.values(property(page.properties)).map(property)) {
        if (field.has_more === true) return refuse("A current property is incomplete.")
        if (
          Array.isArray(field.files) &&
          field.files.some((file) => typeof property(file).id !== "string") &&
          typeof page.last_edited_time !== "string"
        )
          return refuse(
            "A current resource has neither stable identity nor an exact server revision.",
          )
      }
    }
    const seenProperties = new Set<string>()
    const seenBodies = new Set<string>()
    const verifiedBodies = new Set<string>()
    const verifiedProperties: PublicationVerifiedProperties[] = []
    const seenBlocks = new Set<string>()
    const coverage = publicationBlockReplacementCandidates(receipt)
    const validatedReplacements = new Set<number>()
    const propertyCoverage = publicationPropertyReplacementCandidates(receipt)
    const listRepairCoverage = publicationListStartRepairCandidates(receipt)
    const zeroListCoverage = publicationZeroListCandidates(receipt)
    const verifiedZeroRepairs = new Set<number>()
    const markdownCoverage = publicationMarkdownReplayCandidates(receipt)
    const correctionCoverage = observedMarkdownCorrectionCoverage(receipt)
    const validatedProperties = new Set<number>()
    const acknowledgedChildren: number[] = []
    const completedBlocks: Intent[] = []
    for (let index = receipt.intents.length - 1; index >= 0; index--) {
      const intent = receipt.intents[index]!
      if (retainedCovered.has(index)) continue
      if (correctionCoverage?.intent_index === index) {
        if (validatedReplacements.has(correctionCoverage.covered_by_intent_index)) continue
        return refuse("The corrected observation lacks its independently proved successor body.")
      }
      if (intent.status !== "completed") {
        if (retainedTerminalUploadOrphan(receipt, intent, index)) continue
        // Eligibility defers this single original failure until its independent
        // current proof below. It does not manufacture an ACK or response.
        if (alias?.intent_index === index || terminalCommit?.intent_index === index) continue
        const covered = propertyCoverage.find((item) => item.intent_index === index)
        if (covered && validatedProperties.has(covered.covered_by_intent_index)) continue
        if (listRepairCoverage.some((item) => item.intent_index === index)) continue
        if (
          zeroListCoverage.some(
            (item) =>
              item.intent_index === index && verifiedZeroRepairs.has(item.covered_by_intent_index),
          )
        )
          continue
        const markdown = markdownCoverage.find((item) => item.intent_index === index)
        if (markdown && validatedReplacements.has(markdown.covered_by_intent_index)) continue
        return refuse("A failed property intent lacks a later verified whole-field replacement.")
      }
      if (isUploadIntent(intent)) {
        if (intent.method !== "POST" || intent.recovery)
          return refuse("An upload lifecycle intent is unsupported or unresolved.")
        if (terminalCommit) {
          const upload = copy(intent)
          const lifecycle = yield* observeUpload(upload).pipe(Effect.provideService(Notion, api))
          if (lifecycle.outcome !== "success" || property(upload.response).status !== "uploaded")
            return refuse("The terminal commit lacks current uploaded lifecycle proof.")
        }
        continue // The existing lifecycle observation must also have succeeded.
      }
      const body = property(intent.body)
      const created = intent.method === "POST" && intent.path === "v1/pages"
      const path = created ? `v1/pages/${String(property(intent.response).id)}` : intent.path
      if (created || (intent.method === "PATCH" && /^v1\/pages\/[^/]+$/.test(path))) {
        if (!roles.ownedMutationTargets.has(path) || !raw[path])
          return refuse("A completed page mutation has no proven owned target.")
        if (!created && (Object.keys(body).length !== 1 || !body.properties))
          return refuse("A completed page mutation has unsupported effects.")
        if (created) {
          const proof = creationProofFromBody(body)
          const current =
            path === rootPath
              ? publicationMarker(raw[path])?.creation
              : creationMarkerProof(pageMarkdown(raw[path + "/markdown"]))
          const acknowledgedChild =
            !proof &&
            !current &&
            path !== rootPath &&
            acknowledgedChildCreate(
              receipt,
              index,
              raw[path],
              pageMarkdown(raw[path + "/markdown"]),
              raw[rootPath],
            )
          if (acknowledgedChild) acknowledgedChildren.push(index)
          if (
            !(path === rootPath && acknowledgedRoot === index) &&
            !acknowledgedChild &&
            (!proof ||
              !creationProofMatchesIntent(proof, receipt, index) ||
              proof.intended_hash !== integrity.intended_hash ||
              canonical(current) !== canonical(proof))
          )
            return refuse("A completed create lacks its exact original creation identity.")
          const parent = property(body.parent)
          if (
            Object.entries(parent).some(
              ([key, value]) =>
                canonical(property(property(raw[path]).parent)[key]) !== canonical(value),
            )
          )
            return refuse("A created page no longer has its original parent.")
        }
        for (const [key, value] of Object.entries(property(body.properties))) {
          const fields = property(property(raw[path]).properties)
          const name = Object.keys(fields).find(
            (name) => name === key || property(fields[name]).id === key,
          )
          if (name !== "Publication") continue
          const saved = publicationMarker({
            properties: { Publication: { type: "rich_text", ...property(value) } },
          })
          if (
            !saved ||
            saved.operation_id !== receipt.operation_id ||
            saved.intended_hash !== integrity.intended_hash
          )
            return refuse("A retained marker differs from the original intended identity.")
        }
        const fields = property(property(raw[path]).properties)
        const latest: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(property(body.properties))) {
          const [name, field] =
            Object.entries(fields).find(
              ([name, field]) => name === key || property(field).id === key,
            ) ?? []
          if (!name || !field) return refuse("A requested property is unavailable.")
          const identity = `${path}:${String(property(field).id ?? name)}`
          if (seenProperties.has(identity)) continue
          seenProperties.add(identity)
          latest[key] = value
        }
        const ordinary = Object.fromEntries(
          Object.entries(latest).filter(([, value]) => !Array.isArray(property(value).files)),
        )
        if (created) yield* verifyCreatedPublicationPage(raw[path], { properties: ordinary })
        else if (!publicationPropertiesMatch(raw[path], ordinary))
          return {
            outcome: "conflict" as const,
            reason: "Completed requested properties have not converged.",
          }
        for (const [key, value] of Object.entries(latest).filter(([, value]) =>
          Array.isArray(property(value).files),
        )) {
          const attachment = { ...intent, body: { properties: { [key]: value } } }
          const verifiedBytes = yield* verifyAttachedUpload(raw[path], attachment, receipt)
          if (!verifiedBytes && !publicationPropertiesMatch(raw[path], { [key]: value }))
            return refuse("A completed attachment lacks current resource proof.")
          if (retainedUploads.some((item) => item.replacement?.attachment_index === index)) {
            if (!verifiedBytes)
              return refuse("The retained-upload replacement lacks exact current attachment bytes.")
            verifiedUploadAttachments.add(index)
          }
        }
        // This evidence exists only after the original property and attachment
        // verifiers have proved the latest current values in this read phase.
        verifiedProperties.push({
          intent_index: index,
          path,
          keys: Object.keys(latest),
          owner: metadataContent(metadata(raw[path])),
        })
        if (propertyCoverage.some((item) => item.covered_by_intent_index === index)) {
          if (!publicationPropertiesMatch(raw[path], body.properties))
            return {
              outcome: "conflict" as const,
              reason: "The covering whole References replacement has not converged.",
            }
          validatedProperties.add(index)
        }
      } else if (intent.method === "PATCH" && /^v1\/pages\/[^/]+\/markdown$/.test(path)) {
        if (seenBodies.has(path)) continue
        seenBodies.add(path)
        const owner = path.slice(0, -"/markdown".length)
        if (!roles.ownedMutationTargets.has(owner))
          return refuse("A completed body has no owned target.")
        const before = intent.guards?.[path]
        const updates = property(body.update_content).content_updates
        const target =
          body.type === "replace_content"
            ? property(body.replace_content).new_str
            : typeof before === "string" &&
                Array.isArray(updates) &&
                updates.length === 1 &&
                property(updates[0]).old_str === before
              ? property(updates[0]).new_str
              : undefined
        if (typeof target !== "string")
          return refuse("A completed body has no deterministic retained replacement.")
        const source = pages.find((page) => page.id === owner.split("/")[2])!
        if (
          !(yield* readPublicationMarkdownMatches(
            intent,
            pageMarkdown(raw[path]),
            rewritePageLinks(withoutChildPages(target), source.path, pages, "local"),
            api,
            phase,
            {
              local: (markdown) =>
                rewritePageLinks(withoutChildPages(markdown), source.path, pages, "local"),
              preserveExternal: (markdown) =>
                rewritePageLinks(withoutChildPages(markdown), source.path, pages, "local", [], {
                  preserveExternalUrls: true,
                }),
              source: { path: source.path, files: receipt.portable.files },
            },
            coverage.some((item) => item.covered_by_intent_index === index),
          ))
        )
          return {
            outcome: "conflict" as const,
            reason: "Completed Markdown replacement has not converged.",
            path,
            intent_index: index,
          }
        validatedReplacements.add(index)
        verifiedBodies.add(path)
        if (intent.zero_list_repair)
          verifiedZeroRepairs.add(
            yield* verifyCompletedZeroListRepair(receipt, intent, integrity.intended_hash, api),
          )
      } else if (intent.method === "PATCH" && /^v1\/blocks\/[^/]+$/.test(path)) {
        const covered = coverage.find((item) => item.intent_index === index)
        if (covered && validatedReplacements.has(covered.covered_by_intent_index)) continue
        if (seenBlocks.has(path))
          return refuse(
            "Multiple completed block mutations require a field projection unavailable here.",
          )
        seenBlocks.add(path)
        completedBlocks.push(intent)
      } else return refuse("A completed intent has no recognized convergence rule.")
    }
    // Prove final bodies and properties before using their retained checkpoint
    // to validate block repairs that legitimately changed the owner's body.
    const observed = Object.fromEntries(
      Object.entries(raw).map(([path, value]) => [path, observation(path, value)]),
    )
    const verifiedListRepairs = new Set<number>()
    for (const intent of completedBlocks) {
      if (intent.list_start_repair) {
        yield* verifyCompletedListStartRepair(
          receipt,
          intent,
          integrity.intended_hash,
          api,
          verifiedBodies,
        )
        verifiedListRepairs.add(receipt.intents.indexOf(intent))
        continue
      }
      if (
        blockPatchProof(intent, receipt, observed, {
          phase: "completed",
          verifiedBodies,
          verifiedProperties,
        }).outcome !== "success"
      )
        return refuse("A completed block mutation lacks current owner and effect proof.")
    }
    if (listRepairCoverage.some((item) => !verifiedListRepairs.has(item.covered_by_intent_index)))
      return refuse(
        "No-effect list repair history lacks its independently proven completed successor.",
      )
    if (zeroListCoverage.some((item) => !verifiedZeroRepairs.has(item.covered_by_intent_index)))
      return refuse("Literal-zero history lacks its independently verified whole-page successor.")
    if (
      markdownCoverage.some((item) => !validatedReplacements.has(item.covered_by_intent_index)) ||
      (correctionCoverage && !validatedReplacements.has(correctionCoverage.covered_by_intent_index))
    )
      return refuse(
        "No-effect Markdown history lacks its independently proved completed successor.",
      )
    const terminalAliasProof =
      terminalAlias &&
      verifyTerminalCanonicalCodeAlias(receipt, observed, verifiedBodies, blockPatchRecovery)
    const certifiedAliasProof =
      certifiedAlias &&
      verifyCertifiedCanonicalCodeAlias(receipt, observed, verifiedBodies, integrity.intended_hash)
    if (alias && !terminalAliasProof && !certifiedAliasProof)
      return refuse(
        "Original code-language alias lacks its exact current no-effect checkpoint proof.",
      )
    if (
      retainedUploads.some(
        (item) =>
          item.replacement && !verifiedUploadAttachments.has(item.replacement.attachment_index),
      )
    )
      return refuse(
        "The old upload history lacks a later independently verified whole Files replacement.",
      )
    if (!retainedPending && retainedUploads.some((item) => !item.replacement))
      return refuse("Retained unusable upload history is not completed by a new resource yet.")
    if (terminalCommit) {
      // The durable commit describes already-verified business content. Rebuild
      // its exact manifest and ownership identity from the current normal reader.
      const ownership = receipt.context?.ownership
      if (!ownership) return refuse("Terminal commit has no original managed ownership.")
      yield* verifyPublicationOwnership(raw[rootPath], ownership)
      yield* verifyPublicationMetadata(receipt, api)
      const snapshot = yield* openSkill(receipt.page_id, {
        database: receipt.database_id,
        refresh: true,
      }).pipe(
        Effect.provideService(Notion, api),
        Effect.provideService(PublicationReadOperation, receipt.operation_id),
      )
      const manifestHash = yield* sha256(canonical(yield* publicationManifest(snapshot)))
      const ownershipHash = yield* sha256(canonical(publicationGuard(raw[rootPath])))
      const revision = yield* sha256(
        canonical([receipt.operation_id, integrity.intended_hash, manifestHash, ownershipHash]),
      )
      if (
        terminalCommit.marker.manifest_hash !== manifestHash ||
        terminalCommit.marker.ownership_hash !== ownershipHash ||
        terminalCommit.marker.revision !== revision
      )
        return refuse(
          "The original terminal commit does not describe the fully verified current snapshot.",
        )
      for (const path of Object.keys(receipt.guards)) yield* api.request(path)
      const currentIntegrity = yield* store.integrity.inspect(receipt.operation_id)
      if (
        canonical(currentIntegrity) !== canonical(integrity) ||
        !terminalPublicationCommitCandidate(
          receipt,
          currentIntegrity,
          metadata(raw[rootPath]),
          publicationMarker,
        )
      )
        return refuse("Terminal commit authority changed during its complete read proof.")
    }
    for (const [path, expected] of Object.entries(receipt.guards))
      if (
        !(path in raw) ||
        publicationGuardComparison(receipt, path, observation(path, raw[path])) !==
          publicationGuardComparison(receipt, path, expected)
      )
        return {
          outcome: "conflict" as const,
          reason: "Retained publication guards changed during completed proof.",
        }
    const aliasCheckpoint = terminalAliasProof
      ? canonicalCodeLanguageCheckpoint(receipt, integrity.intended_hash, terminalAliasProof)
      : undefined
    if (terminalAliasProof && !aliasCheckpoint)
      return refuse("Original alias proof cannot bind its immutable journal and guards.")
    return {
      outcome: "success" as const,
      intended_hash: integrity.intended_hash,
      terminal_commit: terminalCommit,
      canonical_code_language_checkpoint: aliasCheckpoint,
      code_alias_coverage: alias,
      block_coverage: coverage,
      markdown_coverage: markdownCoverage,
      observed_markdown_correction_coverage: correctionCoverage,
      property_coverage: propertyCoverage,
      list_repair_coverage: listRepairCoverage,
      zero_list_coverage: zeroListCoverage,
      acknowledged_root_create: acknowledgedRoot,
      acknowledged_child_creates: acknowledgedChildren,
    }
  })
}

/** A pending terminal commit never grants partial business-write recovery. */
export function proveUnappliedPublicationCommit(
  receipt: Receipt,
  api: Notion["Service"],
  phase: PublicationReadPhase,
) {
  return Effect.gen(function* () {
    const proof = yield* completedPublicationProof(receipt, phase.raw, api, phase)
    if (proof.outcome !== "success" || !proof.terminal_commit)
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UNRESOLVED",
          "The original terminal commit lacks complete current effect proof.",
        ),
      )
    return proof.terminal_commit
  })
}

/** Only this read-only wrapper can mint a retained-resource replacement. The
 * optional completed-proof input cannot be supplied by a saved receipt flag. */
export function proveRetainedUploadReplacement(
  receipt: Receipt,
  api: Notion["Service"],
  phase: PublicationReadPhase,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const refuse = (message: string) =>
      Effect.fail(fail("PUBLICATION_UPLOAD_RECOVERY_REQUIRED", message))
    const certificates = retainedUploadCertificates(receipt)
    if (!certificates)
      return yield* refuse("The retained upload certificate does not bind its original history.")
    const rootPath = `v1/pages/${receipt.page_id}`
    const rootBefore = metadata(yield* api.request(rootPath))
    const original = certificates[0]
    const sequence = original?.sequence ?? retainedUnusableUploadCandidate(receipt, rootBefore)
    if (
      !sequence ||
      receipt.conflict ||
      canonical(rootBefore) !== canonical(receipt.guards[rootPath])
    )
      return yield* refuse("The unusable upload lacks its exact current destination preimage.")
    const rootField = property(
      property(property(rootBefore).properties)[sequence.files_property_name],
    )
    const replacements = retainedUploadReplacementCandidates(receipt)
    const replacement = replacements?.[0]?.replacement
    const priorAttachment = replacement === undefined
    if (
      rootField.type !== "files" ||
      rootField.id !== sequence.files_property_id ||
      rootField.has_more === true ||
      rootField.next_cursor != null ||
      (priorAttachment && canonical(rootField.files) !== "[]")
    )
      return yield* refuse("The exact Files destination is incomplete or already occupied.")
    const integrity = yield* store.integrity.inspect(receipt.operation_id)
    if (!integrity || (original && original.certificate.intended_hash !== integrity.intended_hash))
      return yield* refuse("The upload replacement does not bind its durable intended source.")
    if (
      original &&
      receipt.intents.length === sequence.original_intent_count &&
      original.certificate.original_guards_sha256 !== retainedUploadDigest(receipt.guards)
    )
      return yield* refuse(
        "The original upload checkpoint guards changed before replacement began.",
      )
    // No response is written to an original allocation or send. Null expiry is
    // ambiguous attachment history; it never authorizes abandoning that object.
    const oldPath = `v1/file_uploads/${sequence.upload_id}`
    const oldBefore = property(yield* api.request(oldPath))
    if (
      oldBefore.id !== sequence.upload_id ||
      !["expired", "failed"].includes(String(oldBefore.status))
    )
      return yield* refuse("The original upload is not an observed unusable resource.")
    const artifactKey = `uploads/${sequence.artifact.sha256}/${sequence.artifact.filename}`
    const bytes = yield* store.readBytes(artifactKey)
    if (
      bytes.length !== sequence.artifact.byte_length ||
      (yield* sha256(bytes)) !== sequence.artifact.sha256
    )
      return yield* refuse(
        "The original staged upload bytes do not match their allocation identity.",
      )
    const frozen: { path: string; bytes: Uint8Array }[] = []
    for (const file of receipt.portable.files) {
      const content = yield* store.readBytes(`objects/${file.sha256}`)
      if ((yield* sha256(content)) !== file.sha256)
        return yield* refuse("A frozen source object changed before upload replacement.")
      frozen.push({ path: file.path, bytes: content })
    }
    const archived = yield* Effect.try({
      try: () => readPortable(readImportZip(bytes)),
      catch: () =>
        fail(
          "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
          "The original artifact is not a complete portable source archive.",
        ),
    })
    if (
      !archived ||
      archived.kind !== receipt.portable.kind ||
      archived.name !== receipt.portable.name ||
      archived.description !== receipt.portable.description ||
      archived.main !== receipt.portable.main ||
      archived.files.length !== frozen.length ||
      archived.files.some((file) => {
        const wanted = frozen.find((item) => item.path === file.path)
        return (
          !wanted ||
          file.bytes.length !== wanted.bytes.length ||
          file.bytes.some((byte, index) => byte !== wanted.bytes[index])
        )
      })
    )
      return yield* refuse("The original upload is not the complete frozen publication source.")
    for (const path of Object.keys(receipt.guards)) yield* api.request(path)
    // This finite input defers only the original allocation/send/optional Files
    // request. Every other current ACK, source, body, URL and guard is unchanged.
    const proof = yield* completedPublicationProof(receipt, phase.raw, api, phase, sequence)
    if (proof.outcome !== "success" || proof.intended_hash !== integrity.intended_hash)
      return yield* refuse("The retained upload lacks complete current publication-effect proof.")
    const snapshot = yield* openSkill(receipt.page_id!, {
      database: receipt.database_id,
      refresh: true,
    }).pipe(
      Effect.provideService(Notion, api),
      Effect.provideService(PublicationReadOperation, receipt.operation_id),
    )
    const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
    if (!main)
      return yield* refuse("The current normal reader did not return its complete entrypoint.")
    const currentMain = yield* store.readBytes(`objects/${main.sha256}`)
    const document = yield* Effect.try({
      try: () =>
        importDocument(
          { path: snapshot.entrypoint, bytes: currentMain },
          {
            name: receipt.portable.name,
            description: receipt.portable.description,
          },
        ),
      catch: () =>
        fail(
          "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
          "The current source projection cannot be decoded.",
        ),
    })
    const references: Record<string, string> = {}
    for (const page of snapshot.references?.slice(1) ?? []) {
      const file = snapshot.files.find((file) => file.path === page.path)
      if (!file)
        return yield* refuse("A current reference projection has no complete source bytes.")
      references[page.path] = bodyIdentity(
        new TextDecoder().decode(yield* store.readBytes(`objects/${file.sha256}`)),
      )
    }
    const rebuilt = yield* Effect.try({
      try: () =>
        portableZip(
          {
            ...receipt.portable,
            files: frozen,
            projection: {
              name: receipt.portable.name,
              description: receipt.portable.description,
              body: bodyIdentity(document.body),
              references,
            },
          },
          true,
        ),
      catch: () =>
        fail(
          "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
          "The original upload cannot be reconstructed from the current normal projection.",
        ),
    })
    if (
      rebuilt.length !== sequence.artifact.byte_length ||
      (yield* sha256(rebuilt)) !== sequence.artifact.sha256
    )
      return yield* refuse("The current continuation would produce different source archive bytes.")
    // Files is a whole property_item response, unlike paginated rich_text.
    const fieldPath = `${rootPath}/properties/${sequence.files_property_id}`
    const fieldRaw = property(yield* api.request(fieldPath))
    if (
      fieldRaw.object !== "property_item" ||
      fieldRaw.type !== "files" ||
      fieldRaw.id !== sequence.files_property_id ||
      fieldRaw.has_more === true ||
      fieldRaw.next_cursor != null ||
      !Array.isArray(fieldRaw.files) ||
      canonical(
        metadata({
          properties: {
            field: {
              id: fieldRaw.id,
              type: fieldRaw.type,
              files: fieldRaw.files,
            },
          },
        }),
      ) !==
        canonical(
          metadata({
            properties: {
              field: {
                id: rootField.id,
                type: rootField.type,
                files: rootField.files,
              },
            },
          }),
        )
    )
      return yield* refuse("The complete current Files property differs from its metadata bracket.")
    const oldAfter = property(yield* api.request(oldPath))
    if (oldAfter.id !== oldBefore.id || oldAfter.status !== oldBefore.status)
      return yield* refuse("The original unusable upload lifecycle changed during observation.")
    for (const path of Object.keys(receipt.guards)) yield* api.request(path)
    if (
      canonical(metadata(yield* api.request(rootPath))) !== canonical(rootBefore) ||
      Object.entries(receipt.guards).some(
        ([path, value]) =>
          !(path in phase.raw) ||
          canonical(observation(path, phase.raw[path])) !== canonical(value),
      )
    )
      return yield* refuse("Publication guards changed during retained upload proof.")
    if (
      canonical(yield* store.integrity.inspect(receipt.operation_id)) !== canonical(integrity) ||
      (yield* sha256(yield* store.readBytes(artifactKey))) !== sequence.artifact.sha256
    )
      return yield* refuse("The retained local upload authority changed during observation.")
    return (
      original?.certificate ??
      retainedUploadRecovery(receipt, sequence, integrity.intended_hash, rootBefore)
    )
  })
}
