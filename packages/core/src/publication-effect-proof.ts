import { publicationZeroListCandidates } from "./publication-zero-list-history.ts"
import { publicationMarkdownReplayCandidates } from "./publication-markdown-replay.ts"
import {
  hasObservedMarkdownCorrection,
  observedMarkdownCorrectionCoverage,
} from "./publication-markdown-history.ts"
import { retainedUploadReplacementCandidates } from "./publication-retained-upload.ts"
import { retainedTerminalUploadOrphan } from "./publication-upload.ts"
import { property, text } from "./model.ts"
import { pageId, parseTarget } from "./ref.ts"
import type { PublicationMarker } from "./publication-integrity-state.ts"
import {
  creationMarkerProof,
  creationProofFromBody,
  creationProofMatchesIntent,
} from "./publication-create-identity.ts"
import type { Receipt } from "./publication-model.ts"
import type { IntegrityIntent } from "./publication-integrity-state.ts"
import { decodeReferenceLinks } from "./reference-links.ts"
import { legacyReferencesLimitPrefix } from "./reference-links-history.ts"

type Intent = Receipt["intents"][number]
type MarkerReader = (raw: unknown) => PublicationMarker | undefined
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
/** Reads are dependencies, not grants to mutate a page. Authority comes from the bound
 * root, its registered References/child graph, or this operation's proven creates. */
export function publicationGuardRoles(receipt: Receipt) {
  const ownedMutationTargets = new Set<string>()
  if (receipt.page_id) ownedMutationTargets.add(`v1/pages/${receipt.page_id}`)
  for (const intent of receipt.intents) {
    if (intent.path !== "v1/pages" || intent.status !== "completed") continue
    const id = pageId(String(property(intent.response).id))
    if (id) ownedMutationTargets.add(`v1/pages/${id}`)
  }
  const root = property(receipt.guards[`v1/pages/${receipt.page_id}`])
  const references = property(property(root.properties).References)
  for (const entry of Array.isArray(references.rich_text) ? references.rich_text : []) {
    const mention = property(property(entry).mention)
    const url = property(property(property(entry).text).link).url
    const id =
      mention.type === "page"
        ? pageId(String(property(mention.page).id))
        : typeof url === "string"
          ? pageId(url)
          : undefined
    if (id) ownedMutationTargets.add(`v1/pages/${id}`)
  }
  // Members never become writable merely because another property links to them.
  const members = property(property(root.properties).Members).relation
  const dependencyIds = [
    ...(Array.isArray(members) ? members.map((member) => pageId(String(property(member).id))) : []),
    ...(receipt.context?.members ?? []).map((member) => {
      const selector = member.startsWith("skill://") ? parseTarget(member).selector : member
      return pageId(selector)
    }),
  ]
  for (const id of dependencyIds)
    if (id && id !== receipt.page_id) ownedMutationTargets.delete(`v1/pages/${id}`)
  let expanded = true
  while (expanded) {
    expanded = false
    for (const [path, raw] of Object.entries(receipt.guards)) {
      const parent = /^v1\/blocks\/([^/]+)\/children\?/.exec(path)?.[1]
      if (!parent || !ownedMutationTargets.has(`v1/pages/${parent}`)) continue
      if (dependencyIds.includes(parent) && parent !== receipt.page_id) continue
      const children = property(raw).results
      for (const item of Array.isArray(children) ? children : []) {
        if (property(item).type !== "child_page") continue
        const id = pageId(String(property(item).id))
        const target = id && `v1/pages/${id}`
        if (target && !dependencyIds.includes(id) && !ownedMutationTargets.has(target)) {
          ownedMutationTargets.add(target)
          expanded = true
        }
      }
    }
  }
  const readOnlyDependencies = new Set(
    Object.keys(receipt.guards).filter((path) => {
      const page = /^v1\/pages\/[^/]+/.exec(path)?.[0]
      return page !== undefined && !ownedMutationTargets.has(page)
    }),
  )
  return { ownedMutationTargets, readOnlyDependencies }
}
/** A root create binds its page through the original POST until commit binds the ledger. */
/** A known root allocation can bind an unchanged full marker without discovery metadata. */
export function acknowledgedRootCreate(
  receipt: Receipt,
  raw: unknown,
  integrity: IntegrityIntent,
  publicationMarker: MarkerReader,
): number | undefined {
  if (
    receipt.operation !== "create" ||
    integrity.page_id !== undefined ||
    integrity.operation_id !== receipt.operation_id
  )
    return undefined
  const roots = receipt.intents.flatMap((intent, index) =>
    intent.method === "POST" &&
    intent.path === "v1/pages" &&
    typeof property(property(intent.body).parent).data_source_id === "string"
      ? [{ intent, index }]
      : [],
  )
  if (roots.length !== 1) return undefined
  const { intent, index } = roots[0]!
  const body = property(intent.body)
  const parent = property(body.parent)
  if (!Array.isArray(property(property(body.properties).Publication).rich_text)) return undefined
  const marker = publicationMarker(raw)
  const posted = publicationMarker({
    properties: {
      Publication: { type: "rich_text", ...property(property(body.properties).Publication) },
    },
  })
  if (
    intent.status !== "completed" ||
    intent.recovery ||
    !receipt.page_id ||
    property(intent.response).id !== receipt.page_id ||
    property(raw).id !== receipt.page_id ||
    !body.properties ||
    Object.keys(property(body.properties)).length === 0 ||
    Object.keys(body).some((key) => !["parent", "properties", "children"].includes(key)) ||
    parent.data_source_id !== receipt.data_source_id ||
    Object.entries(parent).some(
      ([key, value]) => canonical(property(property(raw).parent)[key]) !== canonical(value),
    ) ||
    !marker ||
    marker.state !== "writing" ||
    marker.creation !== undefined ||
    !posted ||
    posted.state !== "writing" ||
    posted.creation !== undefined ||
    marker.operation_id !== receipt.operation_id ||
    marker.intended_hash !== integrity.intended_hash ||
    canonical(posted) !== canonical(marker) ||
    canonical(marker) !== canonical(integrity.marker)
  )
    return undefined
  return index
}

export function publicationMarkerAuthority(
  receipt: Receipt,
  raw: unknown,
  integrity: IntegrityIntent,
  publicationMarker: MarkerReader,
) {
  const marker = publicationMarker(raw)
  if (
    !marker ||
    integrity.operation_id !== receipt.operation_id ||
    marker.operation_id !== receipt.operation_id ||
    marker.intended_hash !== integrity.intended_hash
  )
    return false
  if (integrity.page_id !== undefined)
    return (
      integrity.page_id === receipt.page_id && canonical(marker) === canonical(integrity.marker)
    )
  if (acknowledgedRootCreate(receipt, raw, integrity, publicationMarker) !== undefined) return true
  const roots = receipt.intents.flatMap((intent, index) =>
    intent.method === "POST" &&
    intent.path === "v1/pages" &&
    typeof property(property(intent.body).parent).data_source_id === "string"
      ? [{ intent, index }]
      : [],
  )
  if (
    roots.length !== 1 ||
    receipt.operation !== "create" ||
    marker.state !== "writing" ||
    integrity.marker.state !== "writing"
  )
    return false
  const { intent, index } = roots[0]!
  const proof = creationProofFromBody(intent.body)
  if (!Array.isArray(property(property(property(intent.body).properties).Publication).rich_text))
    return false
  const posted = publicationMarker({
    properties: {
      Publication: {
        type: "rich_text",
        ...property(property(property(intent.body).properties).Publication),
      },
    },
  })
  const { creation: _creation, ...base } = marker
  return (
    intent.status === "completed" &&
    property(intent.response).id === receipt.page_id &&
    property(raw).id === receipt.page_id &&
    property(property(intent.body).parent).data_source_id === receipt.data_source_id &&
    proof !== undefined &&
    creationProofMatchesIntent(proof, receipt, index) &&
    proof.intended_hash === integrity.intended_hash &&
    canonical(marker.creation) === canonical(proof) &&
    canonical(marker) === canonical(posted) &&
    canonical(base) === canonical(integrity.marker)
  )
}
export interface PublicationBlockReplacementCoverage {
  readonly path: string
  readonly intent_index: number
  readonly covered_by_intent_index: number
  readonly owner_path: string
}
export interface PublicationPropertyReplacementCoverage {
  readonly path: string
  readonly intent_index: number
  readonly covered_by_intent_index: number
  readonly property_id: string
  readonly basis?: "oversized_legacy_references"
}

export interface PublicationListStartRepairCoverage {
  readonly path: string
  readonly intent_index: number
  readonly covered_by_intent_index: number
  readonly source_intent_index: number
}

/** A list repair retry is a new journal entry, never a reset of the old entry.
 * Only consecutive, byte-identical requests and preimages can form this chain.
 * The completed proof must independently verify the terminal body's and roots'
 * exact effects before accepting any of these no-effect history candidates. */
export function publicationListStartRepairHistory(receipt: Receipt) {
  const repairs = receipt.intents.flatMap((intent, index) =>
    intent.list_start_repair ? [{ intent, index }] : [],
  )
  for (const [position, { intent, index }] of repairs.entries()) {
    const repair = intent.list_start_repair!
    const source = receipt.intents[repair.source_intent_index]
    const sourceBody = property(source?.body)
    if (
      !Number.isSafeInteger(repair.source_intent_index) ||
      repair.source_intent_index < 0 ||
      repair.source_intent_index >= index ||
      !Number.isSafeInteger(repair.list_ordinal) ||
      repair.list_ordinal < 0 ||
      repair.version !== 1 ||
      repair.list_start_index !== 0 ||
      intent.path !== `v1/blocks/${repair.block_id}` ||
      intent.method !== "PATCH" ||
      intent.recovery ||
      intent.typed_links ||
      !intent.guards ||
      canonical(intent.body) !== canonical({ numbered_list_item: { list_start_index: 0 } }) ||
      !source ||
      source.method !== "PATCH" ||
      source.status !== "completed" ||
      source.path !== `v1/pages/${repair.page_id}/markdown` ||
      sourceBody.markdown_version !== "v2" ||
      sourceBody.type !== "replace_content" ||
      typeof property(sourceBody.replace_content).new_str !== "string"
    )
      return false
    const next = repairs[position + 1]
    const response = property(intent.response)
    if (next) {
      if (
        next.index !== index + 1 ||
        intent.status !== "failed" ||
        !["pending", "unknown", "failed"].includes(String(response.prior_status)) ||
        response.recovery !== "known_not_applied" ||
        response.replayed_by_intent !== next.index ||
        response.superseded_by !== undefined ||
        canonical(intent.list_start_repair) !== canonical(next.intent.list_start_repair) ||
        canonical(intent.guards) !== canonical(next.intent.guards)
      )
        return false
    } else if (
      response.recovery === "known_not_applied" &&
      (intent.status !== "failed" ||
        response.replayed_by_intent !== receipt.intents.length ||
        index !== receipt.intents.length - 1 ||
        !["pending", "unknown", "failed"].includes(String(response.prior_status)))
    )
      return false
  }
  return true
}

export function publicationListStartRepairCandidates(
  receipt: Receipt,
): PublicationListStartRepairCoverage[] {
  if (!publicationListStartRepairHistory(receipt)) return []
  const repairs = receipt.intents.flatMap((intent, index) =>
    intent.list_start_repair ? [{ intent, index }] : [],
  )
  const terminal = repairs.at(-1)
  if (
    !terminal ||
    terminal.intent.status !== "completed" ||
    property(terminal.intent.response).id !== terminal.intent.list_start_repair!.block_id
  )
    return []
  return repairs.slice(0, -1).map(({ intent, index }) => ({
    path: intent.path,
    intent_index: index,
    covered_by_intent_index: terminal.index,
    source_intent_index: intent.list_start_repair!.source_intent_index,
  }))
}

/** A failed References write remains history; only a verified whole-field replacement can cover it. */
export function publicationPropertyReplacementCandidates(
  receipt: Receipt,
): PublicationPropertyReplacementCoverage[] {
  const rootPath = `v1/pages/${receipt.page_id}`
  const root = property(receipt.guards[rootPath])
  const fields = property(root.properties)
  const reference = property(fields.References)
  if (
    !receipt.page_id ||
    root.id !== receipt.page_id ||
    property(root.parent).data_source_id !== receipt.data_source_id ||
    reference.type !== "rich_text" ||
    typeof reference.id !== "string"
  )
    return []
  const fieldId = reference.id
  const references = (intent: Intent) => {
    if (intent.method !== "PATCH" || intent.path !== rootPath) return undefined
    const properties = property(property(intent.body).properties)
    const entry = Object.entries(properties).find(
      ([key]) => key === fieldId || property(fields[key]).id === fieldId,
    )
    return entry && { key: entry[0], value: property(entry[1]) }
  }
  const entries = (value: Record<string, unknown>, oversizedLegacy = false) =>
    decodeReferenceLinks(value, { oversizedLegacy })?.bindings
  const candidates: PublicationPropertyReplacementCoverage[] = []
  for (const [index, intent] of receipt.intents.entries()) {
    const response = property(intent.response)
    const original = references(intent)
    if (
      intent.status !== "failed" ||
      intent.recovery ||
      intent.typed_links ||
      !original ||
      Object.keys(property(intent.body)).length !== 1 ||
      Object.keys(property(property(intent.body).properties)).length !== 1
    )
      continue
    const knownNoEffect =
      response.prior_status === "unknown" && response.recovery === "known_not_applied"
    const oversizedLegacy = legacyReferencesLimitPrefix(receipt, index, fieldId)
    if (!knownNoEffect && !oversizedLegacy) continue
    const prior = entries(original.value, true)
    const laterIndex = receipt.intents.findLastIndex((later) => references(later) !== undefined)
    if (!prior || laterIndex <= index) continue
    const later = receipt.intents[laterIndex]!
    const replacement = references(later)!
    const current = entries(replacement.value)
    if (
      later.status !== "completed" ||
      later.recovery ||
      property(later.response).id !== receipt.page_id ||
      !current
    )
      continue
    const files = receipt.portable.files.filter(
      (file) => file.path !== receipt.portable.main && /\.md$/i.test(file.path),
    )
    if (
      current.length !== files.length ||
      current.some((entry) => !files.some((file) => file.path === entry.path)) ||
      (oversizedLegacy &&
        current.some((entry, entryIndex) => files[entryIndex]?.path !== entry.path)) ||
      prior.some((entry) => !current.some((item) => canonical(item) === canonical(entry)))
    )
      continue
    if (
      current
        .filter((entry) => !prior.some((item) => canonical(item) === canonical(entry)))
        .some(
          (entry) =>
            !receipt.intents.some(
              (created, createdIndex) =>
                createdIndex > index &&
                createdIndex < laterIndex &&
                created.status === "completed" &&
                created.method === "POST" &&
                created.path === "v1/pages" &&
                property(created.response).id === entry.id &&
                property(property(created.body).parent).page_id === receipt.page_id &&
                [
                  entry.path,
                  ...(entry.path.startsWith("references/")
                    ? [entry.path.slice("references/".length)]
                    : []),
                ].includes(text(property(property(property(created.body).properties).title).title)),
            ),
        )
    )
      continue
    candidates.push({
      path: rootPath,
      intent_index: index,
      covered_by_intent_index: laterIndex,
      property_id: fieldId,
      ...(oversizedLegacy ? { basis: "oversized_legacy_references" as const } : {}),
    })
  }
  return candidates
}

export function publicationJournalSettled(
  receipt: Receipt,
  coverage = publicationPropertyReplacementCandidates(receipt),
) {
  const listRepairs = publicationListStartRepairCandidates(receipt)
  const zeroRepairs = publicationZeroListCandidates(receipt)
  const markdown = publicationMarkdownReplayCandidates(receipt)
  if (hasObservedMarkdownCorrection(receipt) && !observedMarkdownCorrectionCoverage(receipt))
    return false
  const uploads = retainedUploadReplacementCandidates(receipt)
  if (!uploads) return false
  const uploadCoverage = new Set(
    uploads.filter((item) => item.replacement).flatMap((item) => item.sequence.covered_indices),
  )
  return receipt.intents.every(
    (intent, index) =>
      intent.typed_links?.state !== "pending" &&
      (intent.status === "completed" ||
        retainedTerminalUploadOrphan(receipt, intent, index) ||
        coverage.some((item) => item.intent_index === index) ||
        listRepairs.some((item) => item.intent_index === index) ||
        zeroRepairs.some((item) => item.intent_index === index) ||
        markdown.some((item) => item.intent_index === index) ||
        uploadCoverage.has(index)),
  )
}

/** Candidates defer obsolete block reads; only the completed proof can establish coverage. */
export function publicationBlockReplacementCandidates(
  receipt: Receipt,
): PublicationBlockReplacementCoverage[] {
  if (!receipt.page_id || !receipt.data_source_id || !publicationJournalSettled(receipt)) return []
  const rootPath = `v1/pages/${receipt.page_id}`
  const roles = publicationGuardRoles(receipt)
  const candidates: PublicationBlockReplacementCoverage[] = []
  for (const [index, intent] of receipt.intents.entries()) {
    if (
      intent.method !== "PATCH" ||
      !/^v1\/blocks\/[^/]+$/.test(intent.path) ||
      intent.path in receipt.guards ||
      property(intent.response).id !== intent.path.split("/")[2]
    )
      continue
    const saved = intent.guards
    if (!saved) continue
    const root = property(saved[rootPath])
    if (
      root.id !== receipt.page_id ||
      property(root.parent).data_source_id !== receipt.data_source_id
    )
      continue
    let path = intent.path
    const seen = new Set<string>()
    let owner: string | undefined
    while (!seen.has(path)) {
      seen.add(path)
      const block = property(saved[path])
      if (block.id !== path.split("/")[2] || typeof block.type !== "string" || !block[block.type])
        break
      const parent = property(block.parent)
      if (parent.type === "page_id" && typeof parent.page_id === "string") {
        owner = `v1/pages/${parent.page_id}`
        break
      }
      if (parent.type !== "block_id" || typeof parent.block_id !== "string") break
      path = `v1/blocks/${parent.block_id}`
    }
    if (
      !owner ||
      property(saved[owner]).id !== owner.split("/")[2] ||
      typeof saved[`${owner}/markdown`] !== "string"
    )
      continue
    const originalRoles = publicationGuardRoles({
      ...receipt,
      guards: saved,
      intents: receipt.intents.slice(0, index + 1),
    })
    if (!roles.ownedMutationTargets.has(owner) || !originalRoles.ownedMutationTargets.has(owner))
      continue
    const prior = property(saved[intent.path])
    const body = property(intent.body)
    const type = String(prior.type)
    const keys = Object.keys(body)
    if (
      type !== "table_row" ||
      keys.length !== 1 ||
      keys[0] !== "table_row" ||
      Object.keys(property(body.table_row)).length !== 1 ||
      !Array.isArray(property(body.table_row).cells)
    )
      continue
    const replacementIndex = receipt.intents.findLastIndex(
      (later) => later.path === `${owner}/markdown`,
    )
    if (replacementIndex <= index) continue
    const replacement = receipt.intents[replacementIndex]!
    const replacementBody = property(replacement.body)
    if (
      replacement.method !== "PATCH" ||
      property(replacement.response).id !== owner.split("/")[2] ||
      replacementBody.markdown_version !== "v2" ||
      replacementBody.type !== "replace_content" ||
      Object.keys(replacementBody).some(
        (key) => !["markdown_version", "type", "replace_content"].includes(key),
      ) ||
      Object.keys(property(replacementBody.replace_content)).length !== 1 ||
      typeof property(replacementBody.replace_content).new_str !== "string"
    )
      continue
    candidates.push({
      path: intent.path,
      intent_index: index,
      covered_by_intent_index: replacementIndex,
      owner_path: owner,
    })
  }
  return candidates
}
/** A completed whole-page Markdown replacement owns the child inventory it produced. */
export function markdownReplacementInventoryPaths(receipt: Receipt, settled: readonly Intent[]) {
  const pages = new Set<string>()
  for (const intent of settled) {
    const body = property(intent.body)
    const page = /^v1\/pages\/([^/]+)\/markdown$/.exec(intent.path)?.[1]
    if (
      !page ||
      intent.method !== "PATCH" ||
      intent.status !== "completed" ||
      body.markdown_version !== "v2" ||
      body.type !== "replace_content"
    )
      continue
    pages.add(page)
  }
  return new Set(
    Object.keys(receipt.guards).filter((path) => {
      const page = /^v1\/blocks\/([^/]+)\/children\?/.exec(path)?.[1]
      return page !== undefined && pages.has(page)
    }),
  )
}

/** Known child identities require the original allocation and complete current References binding. */
export function acknowledgedChildCreate(
  receipt: Receipt,
  index: number,
  raw: unknown,
  markdown: string,
  root: unknown,
) {
  const intent = receipt.intents[index]!
  const body = property(intent.body)
  const id = property(intent.response).id
  if (
    intent.method !== "POST" ||
    intent.path !== "v1/pages" ||
    intent.status !== "completed" ||
    intent.recovery ||
    typeof id !== "string" ||
    id === receipt.page_id ||
    property(raw).id !== id ||
    property(body.parent).page_id !== receipt.page_id ||
    property(property(raw).parent).page_id !== receipt.page_id ||
    property(property(raw).parent).type !== "page_id" ||
    creationProofFromBody(body) ||
    creationMarkerProof(markdown) ||
    receipt.intents.filter(
      (item) =>
        item.method === "POST" && item.path === "v1/pages" && property(item.response).id === id,
    ).length !== 1
  )
    return false
  const title = text(property(property(body.properties).title).title)
  const path = receipt.portable.files.some((file) => file.path === title)
    ? title
    : `references/${title}`
  const titleFields = Object.values(property(property(raw).properties))
    .map(property)
    .filter((field) => field.type === "title")
  if (
    !title ||
    titleFields.length !== 1 ||
    text(titleFields[0]!.title) !== title ||
    !receipt.portable.files.some((file) => file.path === path)
  )
    return false
  const references = property(property(property(root).properties).References)
  if (references.type !== "rich_text" || !Array.isArray(references.rich_text)) return false
  const bindings = decodeReferenceLinks(
    { rich_text: references.rich_text },
    { readback: true },
  )?.bindings
  if (!bindings) return false
  const files = receipt.portable.files.filter(
    (file) => file.path !== receipt.portable.main && /\.md$/i.test(file.path),
  )
  return (
    bindings.length === files.length &&
    bindings.every(
      (entry) =>
        entry.id &&
        files.some((file) => file.path === entry.path) &&
        bindings.filter((other) => other.path === entry.path || other.id === entry.id).length === 1,
    ) &&
    bindings.some((entry) => entry.id === id && entry.path === path)
  )
}

/** Ephemeral evidence minted only after the completed proof verifies these exact
 * current fields, including the existing attachment byte verifier for uploads. */
export interface PublicationVerifiedProperties {
  readonly intent_index: number
  readonly path: string
  readonly keys: readonly string[]
  readonly owner: unknown
}

/** Later acknowledged whole-property effects may advance a completed block's
 * owner. Everything outside their verified value fields remains its preimage.
 * Both owner arguments and evidence use the existing metadataContent projection;
 * the caller must still require the exact final full metadata/body checkpoint. */
export function completedBlockOwnerPropertiesMatch(
  intent: Intent,
  receipt: Receipt,
  ownerPath: string,
  before: unknown,
  current: unknown,
  verified: readonly PublicationVerifiedProperties[],
) {
  const blockIndex = receipt.intents.indexOf(intent)
  const original = property(before),
    actual = property(current)
  const ownerId = /^v1\/pages\/([^/]+)$/.exec(ownerPath)?.[1]
  if (
    blockIndex < 0 ||
    intent.status !== "completed" ||
    intent.method !== "PATCH" ||
    !/^v1\/blocks\/[^/]+$/.test(intent.path) ||
    !ownerId ||
    original.id !== ownerId ||
    actual.id !== ownerId
  )
    return false
  const oldFields = property(original.properties),
    newFields = property(actual.properties)
  if (canonical(Object.keys(oldFields).sort()) !== canonical(Object.keys(newFields).sort()))
    return false
  const projected = { ...oldFields }
  const writable = new Set([
    "title",
    "rich_text",
    "number",
    "select",
    "multi_select",
    "status",
    "date",
    "people",
    "files",
    "checkbox",
    "url",
    "email",
    "phone_number",
    "relation",
  ])
  let changes = 0
  for (const [name, prior] of Object.entries(oldFields)) {
    const field = newFields[name]
    if (canonical(prior) === canonical(field)) continue
    const old = property(prior),
      next = property(field)
    const id = old.id,
      kind = old.type
    if (
      name === "Publication" ||
      typeof id !== "string" ||
      !id ||
      typeof kind !== "string" ||
      !writable.has(kind) ||
      next.id !== id ||
      next.type !== kind ||
      !Object.hasOwn(old, kind) ||
      !Object.hasOwn(next, kind) ||
      Object.values(oldFields).filter((value) => property(value).id === id).length !== 1 ||
      Object.values(newFields).filter((value) => property(value).id === id).length !== 1 ||
      canonical(Object.fromEntries(Object.entries(old).filter(([key]) => key !== kind))) !==
        canonical(Object.fromEntries(Object.entries(next).filter(([key]) => key !== kind)))
    )
      return false
    const proofs = verified.filter(
      (proof) => proof.path === ownerPath && proof.keys.some((key) => key === name || key === id),
    )
    if (proofs.length !== 1) return false
    const proof = proofs[0]!
    if (!Number.isInteger(proof.intent_index) || proof.intent_index <= blockIndex) return false
    const later = receipt.intents[proof.intent_index]
    if (!later) return false
    const response = property(later.response),
      body = property(later.body)
    const requested = Object.entries(property(body.properties)).filter(
      ([key]) => key === name || key === id,
    )
    if (
      later.path !== ownerPath ||
      later.method !== "PATCH" ||
      later.status !== "completed" ||
      later.recovery ||
      later.typed_links?.state === "pending" ||
      response.id !== ownerId ||
      response.recovery !== undefined ||
      response.superseded_by !== undefined ||
      response.replayed_by_intent !== undefined ||
      Object.keys(body).length !== 1 ||
      !body.properties ||
      requested.length !== 1 ||
      proof.keys.filter((key) => key === name || key === id).length !== 1 ||
      !proof.keys.includes(requested[0]![0]) ||
      canonical(proof.owner) !== canonical(actual)
    )
      return false
    const value = property(requested[0]![1])
    const requestKey = requested[0]![0]
    if (
      !Object.hasOwn(value, kind) ||
      value[kind] === undefined ||
      Object.keys(value).some((key) => key !== kind && key !== "type") ||
      (Object.hasOwn(value, "type") && value.type !== kind) ||
      [oldFields, newFields].some(
        (fields) =>
          Object.entries(fields).filter(
            ([fieldName, field]) => fieldName === requestKey || property(field).id === requestKey,
          ).length !== 1,
      ) ||
      receipt.intents.findLastIndex(
        (later) =>
          later.method === "PATCH" &&
          later.path === ownerPath &&
          Object.keys(property(property(later.body).properties)).some(
            (key) => key === name || key === id,
          ),
      ) !== proof.intent_index
    )
      return false
    // Only the authored value is replaced. Property identity, type and all
    // remaining metadata still have to match the original block preimage.
    projected[name] = { ...old, [kind]: next[kind] }
    changes++
  }
  return changes > 0 && canonical({ ...original, properties: projected }) === canonical(actual)
}
