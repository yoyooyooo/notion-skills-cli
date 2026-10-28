import { hasOnlyCompletedOrRetriedPlainTextEffects } from "./publication-code-language-effects.ts"
import { Effect } from "effect"
import { acknowledgedCodeLanguages } from "./acknowledged-code-languages.ts"
import { importDocument } from "./import.ts"
import { markdownStructure, projectNotionBlockTree } from "./markdown.ts"
import { fail, property, text } from "./model.ts"
import type { Notion } from "./notion.ts"
import type { PortableSkill } from "./portable.ts"
import type { Receipt } from "./publication-model.ts"
import {
  blockObservation,
  canonical,
  metadata,
  metadataContent,
  publicationGuardRoles,
  publicationMarkdownMatches,
} from "./publication-observation.ts"
import {
  publicationExternalLinksMatch,
  sameRelativeFileDestination,
} from "./publication-markdown.ts"
import { physicalReadbackTarget } from "./publication-physical-target.ts"
import { pageLocalUnicodeFragmentTarget } from "./publication-local-fragment.ts"
import { publicationMarker } from "./publication-integrity.ts"
import { publicationMarkerAuthority } from "./publication-effect-proof.ts"
import { pageMarkdown } from "./references.ts"
import { sha256, Store } from "./store.ts"
import { readLinkBlocks } from "./typed-links.ts"

type Intent = Receipt["intents"][number]
const refuse = (message: string) => Effect.fail(fail("PUBLICATION_CODE_LANGUAGE_UNPROVEN", message))
const replacement = (intent: Intent) => {
  const body = property(intent.body),
    content = property(body.replace_content)
  return intent.status === "completed" &&
    intent.method === "PATCH" &&
    /^v1\/pages\/[^/]+\/markdown$/.test(intent.path) &&
    body.markdown_version === "v2" &&
    body.type === "replace_content" &&
    Object.keys(body).length === 3 &&
    Object.keys(content).length === 1 &&
    typeof content.new_str === "string" &&
    !intent.typed_links &&
    !intent.recovery
    ? content.new_str
    : undefined
}
const plainTextTarget = (target: string) =>
  markdownStructure(target).some(
    (node) => Array.isArray(node) && node.length === 3 && node[0] === "code" && node[1] === "text",
  )

export function readAcknowledgedCodeOwner(
  pageId: string,
  target: string,
  intent: Intent,
  api: Notion["Service"],
) {
  return Effect.gen(function* () {
    const path = `v1/pages/${pageId}`
    const before = metadata(yield* api.request(path))
    const markdown = pageMarkdown(yield* api.request(`${path}/markdown`))
    const blocks = yield* readLinkBlocks(pageId, api, { structureEvidence: true })
    const after = metadata(yield* api.request(path))
    if (
      property(before).id !== pageId ||
      typeof property(before).last_edited_time !== "string" ||
      canonical(before) !== canonical(after)
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The code owner changed during its complete observation."),
      )
    const boundaries = projectNotionBlockTree(pageId, blocks)
    if (
      !boundaries ||
      !publicationMarkdownMatches(
        intent,
        markdown,
        pageLocalUnicodeFragmentTarget(physicalReadbackTarget(target, boundaries), boundaries),
        boundaries,
        sameRelativeFileDestination,
      ) ||
      !publicationExternalLinksMatch(
        markdown,
        target,
        (value) => value,
        boundaries,
        (actual, expected, blocks, sameLink) =>
          publicationMarkdownMatches(
            intent,
            actual,
            pageLocalUnicodeFragmentTarget(physicalReadbackTarget(expected, blocks), blocks),
            blocks,
            sameLink,
          ),
      )
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The original acknowledged code owner no longer matches its complete Markdown.",
        ),
      )
    // Complete descendant evidence proves the body, but only original page
    // roots may become code-language field targets.
    const rootIds = new Set(boundaries.map((block) => block.id))
    const roots = blocks.filter((block) => rootIds.has(String(block.id)))
    return { owner: before, markdown, roots, blocks }
  })
}

function blocksAfter(
  before: readonly unknown[],
  after: readonly unknown[],
  applied: ReadonlySet<string>,
) {
  if (before.length !== after.length) return false
  try {
    return before.every((raw, index) => {
      const original = property(blockObservation(raw)),
        current = property(blockObservation(after[index]))
      if (!applied.has(String(original.id))) return canonical(original) === canonical(current)
      const { last_edited_time: _beforeRevision, ...old } = original
      const { last_edited_time: _afterRevision, ...now } = current
      return (
        typeof current.last_edited_time === "string" &&
        canonical({ ...old, code: { ...property(old.code), language: "plain text" } }) ===
          canonical(now)
      )
    })
  } catch {
    return false
  }
}

/** Finish omitted postprocessing of an original full-body ACK through the
 * ordinary publication session. No old ACK, guard, fence or typed-link state is
 * rewritten. Every new field is pending-before-send and has a real readback. */
export function restoreAcknowledgedCodeLanguages(
  receipt: Receipt,
  portable: PortableSkill,
  api: Notion["Service"],
) {
  return Effect.gen(function* () {
    if (
      receipt.operation !== "create" ||
      receipt.portable.kind !== "skill" ||
      portable.kind !== "skill" ||
      receipt.context?.write_path !== undefined ||
      receipt.conflict ||
      !receipt.page_id ||
      !hasOnlyCompletedOrRetriedPlainTextEffects(receipt)
    )
      return
    const owned = publicationGuardRoles(receipt).ownedMutationTargets
    const latest = new Map<string, Intent>()
    for (const intent of receipt.intents)
      if (/^v1\/pages\/[^/]+\/markdown$/.test(intent.path)) latest.set(intent.path, intent)
    if (
      ![...latest.values()].some((intent) => {
        const target = replacement(intent)
        return target !== undefined && plainTextTarget(target)
      })
    )
      return
    const store = yield* Store
    const integrity = yield* store.integrity.inspect(receipt.operation_id)
    const rootGuard = receipt.guards[`v1/pages/${receipt.page_id}`]
    const marker = publicationMarker(rootGuard)
    const files: Array<readonly [string, number, string]> = []
    for (const file of [...portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ))
      files.push([file.path, file.bytes.length, yield* sha256(file.bytes)])
    const intended = yield* sha256(
      canonical([portable.kind, portable.name, portable.description, portable.main, files]),
    )
    if (
      !integrity ||
      integrity.marker.state !== "writing" ||
      integrity.intended_hash !== intended ||
      !publicationMarkerAuthority(receipt, rootGuard, integrity, publicationMarker) ||
      !marker ||
      marker.operation_id !== receipt.operation_id ||
      marker.state !== "writing" ||
      marker.intended_hash !== intended
    )
      return yield* refuse(
        "The original writing marker and complete frozen source no longer identify this operation.",
      )
    for (const [bodyPath, intent] of latest) {
      const target = replacement(intent)
      if (target === undefined || !plainTextTarget(target)) continue
      const ownerPath = bodyPath.slice(0, -"/markdown".length)
      const pageId = ownerPath.slice("v1/pages/".length)
      const retainedOwner = property(receipt.guards[ownerPath])
      if (
        !owned.has(ownerPath) ||
        retainedOwner.id !== pageId ||
        typeof receipt.guards[bodyPath] !== "string"
      )
        return yield* refuse("The original acknowledged code owner lacks retained edit authority.")
      const sourcePath =
        pageId === receipt.page_id
          ? portable.main
          : `references/${text(property(property(retainedOwner.properties).title).title)}`
      const source = portable.files.filter((file) => file.path === sourcePath)
      if (source.length !== 1)
        return yield* refuse("The acknowledged code owner has no unique frozen source file.")
      const authored = yield* Effect.try({
        try: () =>
          sourcePath === portable.main
            ? importDocument(source[0]!, { name: portable.name, description: portable.description })
                .body
            : new TextDecoder("utf-8", { fatal: true }).decode(source[0]!.bytes),
        catch: () =>
          fail(
            "PUBLICATION_CODE_LANGUAGE_UNPROVEN",
            "The original code source is not valid authored Markdown.",
          ),
      })
      const before = yield* readAcknowledgedCodeOwner(pageId, target, intent, api)
      // No default-JavaScript field means this finite repair has no work. Leave
      // ordinary resume in charge instead of requiring extra write evidence.
      if (
        !before.roots.some(
          (raw) =>
            property(raw).type === "code" && property(property(raw).code).language === "javascript",
        )
      )
        continue
      const plan = acknowledgedCodeLanguages(pageId, target, authored, before.roots)
      if (!plan)
        return yield* refuse(
          "The acknowledged and frozen code inventories cannot bind the same exact fields.",
        )
      if (
        plan.changes.length &&
        Object.values(property(property(before.owner).properties)).some((value) => {
          const files = property(value).files
          return (
            Array.isArray(files) &&
            files.some((file) => typeof property(file).id !== "string" || !property(file).id)
          )
        })
      )
        return yield* refuse(
          "The code owner has no stable attachment identity across its language effects.",
        )
      const applied = new Set<string>()
      for (const field of plan.changes) {
        yield* api.request(
          `v1/blocks/${field.block_id}`,
          { code: { language: "plain text" } },
          { method: "PATCH" },
        )
        applied.add(field.block_id)
        const current = yield* readAcknowledgedCodeOwner(pageId, target, intent, api)
        if (
          canonical(metadataContent(before.owner)) !== canonical(metadataContent(current.owner)) ||
          !blocksAfter(before.blocks, current.blocks, applied)
        )
          return yield* Effect.fail(
            fail(
              "WRITE_CONFLICT",
              "Code postprocessing changed fields outside its original finite language targets.",
            ),
          )
        const remaining = acknowledgedCodeLanguages(pageId, target, authored, current.roots)
        if (
          !remaining ||
          canonical(remaining.changes.map((item) => item.block_id)) !==
            canonical(
              plan.changes
                .filter((item) => !applied.has(item.block_id))
                .map((item) => item.block_id),
            )
        )
          return yield* refuse("The acknowledged code-language effect has not converged.")
      }
    }
  })
}
