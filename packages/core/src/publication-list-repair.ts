import { Effect } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { fail, property } from "./model.ts"
import type { Notion } from "./notion.ts"
import type { ListStartRepair, Receipt } from "./publication-model.ts"
import { Store, sha256 } from "./store.ts"
import { pageMarkdown } from "./references.ts"
import { planOrderedListStart } from "./ordered-list-start.ts"
import { unsupportedOrderedListStart } from "./ordered-list-capability.ts"
import {
  blockObservation,
  canonical,
  copy,
  metadataContent,
  observation,
  publicationGuardRoles,
  publicationReadPhase,
  capturePublicationRead,
  readPublicationMarkdownMatches,
  publicationPropertiesMatch,
} from "./publication-observation.ts"
import { publicationMarker } from "./publication-integrity.ts"
import {
  publicationMarkerAuthority,
  acknowledgedChildCreate,
  publicationPropertyReplacementCandidates,
  publicationListStartRepairHistory,
} from "./publication-effect-proof.ts"
import {
  creationMarkerProof,
  creationProofFromBody,
  creationProofMatchesIntent,
} from "./publication-create-identity.ts"

type Intent = Receipt["intents"][number]
export interface PublicationListRepairProof {
  readonly repair: ListStartRepair
  readonly outcome: "before" | "applied"
  readonly intent_index?: number
  readonly observed: Readonly<Record<string, unknown>>
}

export const listStartRepairBody = () => ({ numbered_list_item: { list_start_index: 0 } })
export function isListStartRepairBody(body: unknown) {
  return canonical(body) === canonical(listStartRepairBody())
}
export function retainedListSource(intent: Intent | undefined) {
  const body = property(intent?.body)
  const replacement = property(body.replace_content)
  const target = replacement.new_str
  return intent?.method === "PATCH" &&
    /^v1\/pages\/[^/]+\/markdown$/.test(intent.path) &&
    intent.status === "completed" &&
    body.type === "replace_content" &&
    body.markdown_version === "v2" &&
    typeof target === "string" &&
    Object.keys(body).every((key) =>
      ["type", "markdown_version", "replace_content"].includes(key),
    ) &&
    Object.keys(replacement).length === 1
    ? target
    : undefined
}
const refuse = (message: string) => Effect.fail(fail("PUBLICATION_LIST_REPAIR_UNPROVEN", message))
const content = (raw: unknown) => {
  const { last_edited_time: _revision, ...value } = property(raw)
  return value
}

// Owner metadata deliberately omits expiring attachment URLs. A retained file
// therefore needs its own stable identity before that metadata can prove an
// unchanged owner across a block effect.
export function stableListOwner(raw: unknown, pageId: string) {
  const owner = property(raw)
  if (
    owner.id !== pageId ||
    owner.properties === null ||
    typeof owner.properties !== "object" ||
    Array.isArray(owner.properties)
  )
    return false
  return Object.values(property(owner.properties)).every((value) => {
    const field = property(value)
    if (field.type !== "files" && !("files" in field)) return true
    return (
      Array.isArray(field.files) &&
      field.files.every((file) => {
        const id = property(file).id
        return typeof id === "string" && id.length > 0
      })
    )
  })
}

export function readListRepairRoots(pageId: string, api: Notion["Service"]) {
  return Effect.gen(function* () {
    const roots: unknown[] = []
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const response = property(
        yield* api.request(
          `v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
      if (!Array.isArray(response.results) || typeof response.has_more !== "boolean")
        return yield* refuse("List repair requires a complete root inventory.")
      for (const raw of response.results) {
        const block = property(raw)
        const parent = property(block.parent)
        if (
          typeof block.id !== "string" ||
          !block.id ||
          ids.has(block.id) ||
          typeof block.type !== "string" ||
          typeof block.has_children !== "boolean" ||
          typeof block.last_edited_time !== "string" ||
          parent.type !== "page_id" ||
          parent.page_id !== pageId ||
          block.archived === true ||
          block.in_trash === true
        )
          return yield* refuse("List repair root identity or parent is unproved.")
        ids.add(block.id)
        roots.push(blockObservation(raw))
      }
      if (!response.has_more) {
        if (response.next_cursor !== null && response.next_cursor !== undefined)
          return yield* refuse("List repair inventory has an unexpected final cursor.")
        break
      }
      if (
        typeof response.next_cursor !== "string" ||
        !response.next_cursor ||
        cursors.has(response.next_cursor)
      )
        return yield* refuse("List repair inventory pagination is incomplete.")
      cursor = response.next_cursor
      cursors.add(cursor)
    } while (cursor)
    return roots
  })
}

function sourceForRepair(receipt: Receipt, repair: ListStartRepair) {
  if (
    !Number.isSafeInteger(repair.source_intent_index) ||
    repair.source_intent_index < 0 ||
    !Number.isSafeInteger(repair.list_ordinal) ||
    repair.list_ordinal < 0
  )
    return
  const source = receipt.intents[repair.source_intent_index]
  const target = retainedListSource(source)
  if (
    !source ||
    target === undefined ||
    source.path !== `v1/pages/${repair.page_id}/markdown` ||
    receipt.intents
      .slice(repair.source_intent_index + 1)
      .some((intent) => intent.path === source.path)
  )
    return
  return { source, target }
}

/** Existing original requests remain authority. The new record binds a derived
 * single-field correction and its full preimage; it is never a free-form PATCH. */
export function validateListStartRepairRecord(receipt: Receipt, repair: ListStartRepair) {
  return Effect.gen(function* () {
    const original = sourceForRepair(receipt, repair)
    if (!original || (yield* sha256(canonical(original.source.body))) !== repair.source_sha256)
      return yield* refuse(
        "List repair no longer names its acknowledged original Markdown request.",
      )
    const bodyPath = `v1/pages/${repair.page_id}/markdown`
    const firstRepair = receipt.intents.find(
      (intent) =>
        intent.list_start_repair &&
        intent.list_start_repair.source_intent_index === repair.source_intent_index,
    )
    const before = firstRepair?.guards?.[bodyPath] ?? receipt.guards[bodyPath]
    if (typeof before !== "string")
      return yield* refuse("List repair has no original body preimage.")
    if (
      firstRepair &&
      repair.before_roots.some(
        (root) =>
          canonical(firstRepair.guards?.[`v1/blocks/${String(property(root).id)}`]) !==
          canonical(root),
      )
    )
      return yield* refuse("List repair ordered roots differ from its original per-block guards.")
    const planned = planOrderedListStart(
      repair.page_id,
      before,
      original.target,
      repair.before_roots,
    )
    if (
      !planned ||
      planned.block_id !== repair.block_id ||
      planned.list_ordinal !== repair.list_ordinal ||
      planned.list_start_index !== repair.list_start_index
    )
      return yield* refuse("List repair fields cannot be derived from its original ordered roots.")
    return original
  })
}

function listRootEffectsMatch(repair: ListStartRepair, roots: readonly unknown[]) {
  const actual = roots.map(property)
  return (
    roots.length === repair.before_roots.length &&
    repair.before_roots.map(property).every((before, index) => {
      const after = actual[index]!
      if (before.id !== repair.block_id) return canonical(before) === canonical(after)
      const expected = {
        ...before,
        numbered_list_item: { ...property(before.numbered_list_item), list_start_index: 0 },
      }
      return canonical(content(after)) === canonical(content(expected))
    })
  )
}

export function completedListOwnerMatches(receipt: Receipt, intent: Intent, current: unknown) {
  const repair = intent.list_start_repair ?? intent.zero_list_repair?.original
  return Boolean(
    repair &&
      stableListOwner(intent.guards?.[`v1/pages/${repair.page_id}`], repair.page_id) &&
      stableListOwner(current, repair.page_id) &&
      completedListOwnerContentMatches(receipt, intent, current),
  )
}

/** Property coverage only. Callers must independently prove attachment identity. */
export function completedListOwnerContentMatches(
  receipt: Receipt,
  intent: Intent,
  current: unknown,
) {
  const repair = intent.list_start_repair ?? intent.zero_list_repair?.original
  if (!repair) return false
  const owner = `v1/pages/${repair.page_id}`
  const before = property(metadataContent(intent.guards?.[owner]))
  const after = property(metadataContent(current))
  if (
    before.id !== repair.page_id ||
    after.id !== repair.page_id ||
    !publicationGuardRoles(receipt).ownedMutationTargets.has(owner)
  )
    return false
  const oldFields = property(before.properties)
  const newFields = property(after.properties)
  if (canonical(Object.keys(oldFields).sort()) !== canonical(Object.keys(newFields).sort()))
    return false
  const later = receipt.intents.slice(receipt.intents.indexOf(intent) + 1)
  for (const [name, raw] of Object.entries(oldFields)) {
    const original = property(raw)
    const actual = property(newFields[name])
    if (canonical(original) === canonical(actual)) continue
    const type = String(original.type)
    if (
      !["rich_text", "select", "relation", "title"].includes(type) ||
      actual.type !== type ||
      typeof original.id !== "string" ||
      original.id !== actual.id
    )
      return false
    const definition = (field: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(field).filter(([key]) => key !== type))
    if (canonical(definition(original)) !== canonical(definition(actual))) return false
    const covering = later.findLast(
      (candidate) =>
        candidate.status === "completed" &&
        candidate.method === "PATCH" &&
        candidate.path === owner &&
        !candidate.recovery &&
        Object.keys(property(candidate.body)).length === 1 &&
        Object.entries(property(property(candidate.body).properties)).some(
          ([key]) => key === name || key === original.id,
        ),
    )
    if (!covering) return false
    const [key, requested] = Object.entries(property(property(covering.body).properties)).find(
      ([key]) => key === name || key === original.id,
    )!
    if (
      Object.keys(property(requested)).length !== 1 ||
      !(type in property(requested)) ||
      !publicationPropertiesMatch(current, { [key]: requested })
    )
      return false
  }
  const header = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== "properties"))
  return canonical(header(before)) === canonical(header(after))
}

/** The final fence proof independently re-derives the correction and checks the
 * complete original root inventory. A completed PATCH alone is insufficient. */
export function verifyCompletedListStartRepair(
  receipt: Receipt,
  intent: Intent,
  intendedHash: string,
  api: Notion["Service"],
  verifiedBodies: ReadonlySet<string>,
) {
  return Effect.gen(function* () {
    const repair = intent.list_start_repair
    if (
      !repair ||
      intent.status !== "completed" ||
      repair.intended_hash !== intendedHash ||
      !publicationListStartRepairHistory(receipt) ||
      !verifiedBodies.has(`v1/pages/${repair.page_id}/markdown`)
    )
      return yield* refuse(
        "Completed list correction lacks its original source and settled history.",
      )
    const { source, target } = yield* validateListStartRepairRecord(receipt, repair)
    const roots = yield* readListRepairRoots(repair.page_id, api)
    if (!listRootEffectsMatch(repair, roots))
      return yield* refuse(
        "Completed list correction changed another root, its order, or its content.",
      )
    for (const root of roots) {
      const path = `v1/blocks/${String(property(root).id)}`
      if (canonical(receipt.guards[path]) !== canonical(root))
        return yield* refuse(
          "A completed list root differs from the retained publication checkpoint.",
        )
    }
    const owner = `v1/pages/${repair.page_id}`
    const bodyPath = `${owner}/markdown`
    if (!completedListOwnerMatches(receipt, intent, receipt.guards[owner]))
      return yield* refuse(
        "List owner metadata changed without a later verified original property request.",
      )
    const raw = yield* api.request(bodyPath)
    if (
      receipt.guards[bodyPath] !== pageMarkdown(raw) ||
      !(yield* readPublicationMarkdownMatches(
        source,
        pageMarkdown(raw),
        target,
        api,
        publicationReadPhase(),
        undefined,
        true,
      )) ||
      canonical(observation(owner, yield* api.request(owner))) !== canonical(receipt.guards[owner])
    )
      return yield* refuse("Completed list correction lacks a stable exact final body and owner.")
    return true
  })
}

export function originalListAuthority(receipt: Receipt, raw: Record<string, unknown>) {
  return Effect.gen(function* () {
    if (
      !receipt.page_id ||
      !receipt.scope ||
      !receipt.database_id ||
      !receipt.data_source_id ||
      receipt.state === "completed" ||
      receipt.context?.write_path === "@properties"
    )
      return yield* refuse("This publication has no unfinished bound content authority.")
    if ((yield* authScope) !== receipt.scope)
      return yield* Effect.fail(
        fail("PUBLICATION_SCOPE_MISMATCH", "List repair belongs to another authentication scope."),
      )
    if (
      !(yield* explicitSource(receipt.database_id)).data_source_ids.includes(receipt.data_source_id)
    )
      return yield* refuse("The original publication source no longer belongs to its database.")
    const store = yield* Store
    const integrity = yield* store.integrity.inspect(receipt.operation_id)
    const rootPath = `v1/pages/${receipt.page_id}`
    if (
      !integrity ||
      integrity.marker.state !== "writing" ||
      !publicationMarkerAuthority(receipt, raw[rootPath], integrity, publicationMarker)
    )
      return yield* refuse("List repair lacks its original writing marker and creation identity.")
    const files: Array<readonly [string, number, string]> = []
    const paths = new Set<string>()
    for (const file of [...receipt.portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      if (paths.has(file.path)) return yield* refuse("Frozen source paths are not unique.")
      paths.add(file.path)
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      if ((yield* sha256(bytes)) !== file.sha256)
        return yield* refuse("An original source object failed its hash.")
      files.push([file.path, bytes.length, file.sha256])
    }
    if (
      !paths.has(receipt.portable.main) ||
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
      return yield* refuse("Original source bytes do not match the intended publication.")
    for (const [index, intent] of receipt.intents.entries()) {
      if (intent.path !== "v1/pages") continue
      if (intent.status !== "completed")
        return yield* refuse("An original page allocation remains unresolved.")
      const id = property(intent.response).id
      if (typeof id !== "string") return yield* refuse("An original created page has no identity.")
      const current = raw[`v1/pages/${id}`]
      const markdown = raw[`v1/pages/${id}/markdown`]
      const beforeParent = property(property(intent.body).parent)
      if (
        !current ||
        typeof markdown !== "object" ||
        Object.entries(beforeParent).some(
          ([key, value]) => canonical(property(property(current).parent)[key]) !== canonical(value),
        )
      )
        return yield* refuse("A created page no longer has its original parent or body.")
      if (id === receipt.page_id) continue
      const proof = creationProofFromBody(intent.body)
      if (
        proof
          ? !creationProofMatchesIntent(proof, receipt, index) ||
            proof.intended_hash !== integrity.intended_hash ||
            canonical(creationMarkerProof(pageMarkdown(markdown))) !== canonical(proof)
          : !acknowledgedChildCreate(receipt, index, current, pageMarkdown(markdown), raw[rootPath])
      )
        return yield* refuse("A created child lacks its original creation identity.")
    }
    return integrity.intended_hash
  })
}

/** Read-only historical classification. No guard, status or fence is changed.
 * An exact before-image describes an absent effect; it is not write authority. */
export function observePublicationListRepair<E = never, R = never>(
  receipt: Receipt,
  transport: Notion["Service"],
  normalWrite = false,
  retainedSourceOwner?: (
    pageId: string,
    guards: Readonly<Record<string, unknown>>,
    current: unknown,
  ) => Effect.Effect<boolean, E, R>,
) {
  return Effect.gen(function* () {
    if (!normalWrite && !receipt.conflict)
      return yield* refuse("Restricted list recovery requires its original fence.")
    const phase = publicationReadPhase()
    const api: Notion["Service"] = {
      ...transport,
      request: (path, body, options) =>
        transport
          .request(path, body, options)
          .pipe(Effect.tap((raw) => Effect.sync(() => capturePublicationRead(phase, path, raw)))),
    }
    const repairs = receipt.intents.flatMap((intent, index) =>
      intent.list_start_repair ? [{ intent, index }] : [],
    )
    const latest = repairs.at(-1)
    if (!publicationListStartRepairHistory(receipt))
      return yield* refuse(
        "List correction history is not a consecutive original-request retry chain.",
      )
    const paths = new Set([
      ...Object.keys(receipt.guards),
      ...Object.keys(latest?.intent.guards ?? {}),
    ])
    const raw: Record<string, unknown> = {}
    const observed: Record<string, unknown> = {}
    for (const path of paths) {
      raw[path] = yield* api.request(path)
      observed[path] = observation(path, raw[path])
    }
    const intendedHash = yield* originalListAuthority(receipt, raw)
    const ordinaryCoverage = publicationPropertyReplacementCandidates(receipt)
    for (const [index, intent] of receipt.intents.entries()) {
      if (intent.list_start_repair) continue
      if (
        intent.status !== "completed" &&
        !ordinaryCoverage.some((item) => item.intent_index === index)
      )
        return yield* refuse("Another original mutation remains unresolved.")
      if (intent.typed_links?.state === "pending" && !normalWrite)
        return yield* refuse("Typed-link restoration must finish before list recovery.")
    }
    const roles = publicationGuardRoles(receipt)
    if (latest) {
      const repair = latest.intent.list_start_repair!
      if (
        repair.intended_hash !== intendedHash ||
        latest.index !== receipt.intents.length - 1 ||
        latest.intent.path !== `v1/blocks/${repair.block_id}` ||
        latest.intent.method !== "PATCH" ||
        !isListStartRepairBody(latest.intent.body) ||
        !roles.ownedMutationTargets.has(`v1/pages/${repair.page_id}`) ||
        repairs.some(({ intent }) => canonical(intent.list_start_repair) !== canonical(repair))
      )
        return yield* refuse(
          "List recovery history differs from its original single-field correction.",
        )
      const { source, target } = yield* validateListStartRepairRecord(receipt, repair)
      const saved = latest.intent.guards
      const owner = `v1/pages/${repair.page_id}`
      const bodyPath = `${owner}/markdown`
      const blockPath = `v1/blocks/${repair.block_id}`
      if (!saved || !saved[blockPath] || typeof saved[bodyPath] !== "string" || !saved[owner])
        return yield* refuse("List recovery has incomplete original guards.")
      if (
        ![saved[owner], receipt.guards[owner], observed[owner]].every((value) =>
          stableListOwner(value, repair.page_id),
        ) &&
        (!retainedSourceOwner ||
          !(yield* retainedSourceOwner(repair.page_id, saved, raw[owner])) ||
          !(yield* retainedSourceOwner(repair.page_id, receipt.guards, raw[owner])))
      )
        return yield* refuse(
          "List recovery owner metadata or files lack stable retained and current identity.",
        )
      const roots = yield* readListRepairRoots(repair.page_id, api)
      const before =
        Object.entries({ ...receipt.guards, ...saved }).every(
          ([path, value]) => canonical(observed[path]) === canonical(value),
        ) && canonical(roots) === canonical(repair.before_roots)
      if (before) {
        if (latest.intent.status === "completed")
          return yield* refuse("The acknowledged list correction did not take effect.")
        return { repair, outcome: "before", intent_index: latest.index, observed } as const
      }
      // A definitive failure, including a durable known-not-applied conclusion
      // whose successor was not yet appended, cannot acquire an after-effect
      // later. Only an unresolved send may be settled by current effect proof.
      if (latest.intent.status === "failed")
        return yield* refuse(
          "A failed list correction cannot be promoted by a later matching effect.",
        )
      if (
        !listRootEffectsMatch(repair, roots) ||
        Object.entries(receipt.guards).some(
          ([path, value]) =>
            ![owner, blockPath, bodyPath].includes(path) &&
            canonical(observed[path]) !== canonical(value),
        ) ||
        Object.entries(saved).some(([path, value]) => {
          if (path === blockPath || path === bodyPath) return false
          return (
            canonical(path === owner ? metadataContent(value) : value) !==
            canonical(path === owner ? metadataContent(observed[path]) : observed[path])
          )
        }) ||
        !(yield* readPublicationMarkdownMatches(
          source,
          pageMarkdown(raw[bodyPath]),
          target,
          api,
          phase,
          undefined,
          true,
        ))
      )
        return yield* Effect.fail(
          fail(
            "WRITE_CONFLICT",
            "List correction differs from its exact original before/after proof.",
          ),
        )
      const targetRoot = roots.find((root) => property(root).id === repair.block_id)
      if (canonical(targetRoot) !== canonical(observed[blockPath]))
        return yield* refuse(
          "List correction block and ordered inventory do not identify the same current effect.",
        )
      for (const path of [owner, bodyPath, blockPath]) {
        const fresh = observation(path, yield* api.request(path))
        if (canonical(fresh) !== canonical(observed[path]))
          return yield* refuse("List correction changed during effect proof.")
      }
      return { repair, outcome: "applied", intent_index: latest.index, observed } as const
    }
    if (
      !Object.keys(receipt.guards).length ||
      Object.entries(receipt.guards).some(
        ([path, value]) => canonical(observed[path]) !== canonical(value),
      )
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "List repair requires every original publication guard unchanged."),
      )
    const seen = new Set<string>()
    const candidates: ListStartRepair[] = []
    for (let index = receipt.intents.length - 1; index >= 0; index--) {
      const intent = receipt.intents[index]!
      if (!intent.path.endsWith("/markdown") || seen.has(intent.path)) continue
      seen.add(intent.path)
      const target = retainedListSource(intent)
      const pageId = intent.path.split("/")[2]!
      if (
        target === undefined ||
        !roles.ownedMutationTargets.has(`v1/pages/${pageId}`) ||
        typeof observed[intent.path] !== "string"
      )
        return yield* refuse("A body lacks an acknowledged complete owned target.")
      if (
        yield* readPublicationMarkdownMatches(
          intent,
          String(observed[intent.path]),
          target,
          api,
          phase,
        )
      )
        continue
      const owner = `v1/pages/${pageId}`
      if (
        ![receipt.guards[owner], observed[owner]].every((value) =>
          stableListOwner(value, pageId),
        ) &&
        (!retainedSourceOwner || !(yield* retainedSourceOwner(pageId, receipt.guards, raw[owner])))
      )
        return yield* refuse(
          "List repair owner metadata or files lack stable retained and current identity.",
        )
      const roots = yield* readListRepairRoots(pageId, api)
      const plan = planOrderedListStart(pageId, String(observed[intent.path]), target, roots)
      if (!plan) return yield* refuse("The body mismatch is not one proven default-one list start.")
      candidates.push({
        version: 1,
        source_intent_index: index,
        source_sha256: yield* sha256(canonical(intent.body)),
        intended_hash: intendedHash,
        page_id: pageId,
        block_id: plan.block_id,
        list_ordinal: plan.list_ordinal,
        list_start_index: 0,
        before_roots: copy(roots),
        ...(receipt.conflict
          ? {
              original_fence: {
                state: receipt.state,
                stages: [...receipt.stages],
                ...(receipt.failure ? { failure: copy(receipt.failure) } : {}),
                intent_count: receipt.intents.length,
              },
            }
          : {}),
      })
    }
    if (candidates.length !== 1)
      return yield* refuse("Exactly one original list correction must be proved.")
    const repair = candidates[0]!
    for (const path of [`v1/pages/${repair.page_id}`, `v1/pages/${repair.page_id}/markdown`]) {
      if (canonical(observation(path, yield* api.request(path))) !== canonical(observed[path]))
        return yield* refuse("The original owner changed during list planning.")
    }
    return { repair, outcome: "before", observed } as const
  })
}

/** The public API cannot write this field. Refuse before the caller acquires
 * a receipt owner, rewrites a no-effect disposition, or appends a new intent.
 * A retained unresolved send may still be settled by its exact applied proof. */
export function provePublicationListRepair(
  receipt: Receipt,
  transport: Notion["Service"],
  normalWrite = false,
) {
  return observePublicationListRepair(receipt, transport, normalWrite).pipe(
    Effect.flatMap((proof) =>
      proof.outcome === "before"
        ? Effect.fail(unsupportedOrderedListStart())
        : Effect.succeed<PublicationListRepairProof>(proof),
    ),
  )
}
