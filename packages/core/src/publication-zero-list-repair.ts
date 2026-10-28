import { Effect } from "effect"
import { hostname } from "node:os"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { Store, sha256 } from "./store.ts"
import { withLocalLocks } from "./local-locks.ts"
import { PublicationReceiptSchema, type Receipt, type ZeroListRepair } from "./publication-model.ts"
import {
  zeroStartPresentation,
  notionMarkdownForComparison,
  projectNotionBlocks,
} from "./markdown.ts"
import { hasTypedLinks } from "./typed-links.ts"
import { pageMarkdown } from "./references.ts"
import {
  canonical,
  copy,
  keyFor,
  metadataContent,
  observation,
  publicationGuardRoles,
  publicationReadPhase,
  capturePublicationRead,
  readPublicationMarkdownMatches,
} from "./publication-observation.ts"
import {
  observePublicationListRepair,
  validateListStartRepairRecord,
  retainedListSource,
  readListRepairRoots,
  originalListAuthority,
  completedListOwnerContentMatches,
} from "./publication-list-repair.ts"
import { publicationZeroListHistory } from "./publication-zero-list-history.ts"
import { unresolvedIntent } from "./publication-upload.ts"
import {
  originalZeroSourceBundle,
  proveRetainedZeroListOwner,
} from "./publication-zero-list-source.ts"

type Intent = Receipt["intents"][number]
const refuse = (message: string) => Effect.fail(fail("PUBLICATION_ZERO_LIST_UNPROVEN", message))
const bodyFor = (markdown: string) => ({
  type: "replace_content",
  markdown_version: "v2",
  replace_content: { new_str: markdown },
})
const rootPath = (raw: unknown) => "v1/blocks/" + String(property(raw).id)
const originalRoots = (repair: ZeroListRepair) =>
  new Set(repair.original.before_roots.map(rootPath))

function sourceFilesSupported(raw: unknown) {
  const fields = property(property(raw).properties)
  const source =
    Object.values(fields)
      .map(property)
      .find((field) => field.id === "notion%3A%2F%2Fskills%2Ffiles_property") ??
    property(fields.Files)
  return (
    typeof source.id === "string" &&
    source.id.length > 0 &&
    source.type === "files" &&
    Array.isArray(source.files) &&
    source.has_more !== true &&
    source.next_cursor == null
  )
}

function fullGuards(receipt: Receipt, repair: ZeroListRepair["original"]) {
  const guards = copy(receipt.guards)
  for (const root of repair.before_roots) guards[rootPath(root)] = copy(root)
  return guards
}
function supportedRoots(roots: readonly unknown[]) {
  const supported = new Set([
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "quote",
    "divider",
    "bulleted_list_item",
    "numbered_list_item",
  ])
  return (
    roots.length > 0 &&
    roots.length <= 100 &&
    roots.every((raw) => {
      const root = property(raw)
      return (
        typeof root.type === "string" && supported.has(root.type) && root.has_children === false
      )
    })
  )
}

// blockObservation removed response-only rendering and default annotation
// flags. Reintroducing those known defaults does not invent a physical value.
function boundariesFor(roots: readonly unknown[]) {
  return projectNotionBlocks(
    roots.map((raw) => {
      const root = property(raw),
        type = String(root.type),
        body = property(root[type])
      return {
        ...root,
        [type]: {
          ...body,
          ...(Array.isArray(body.rich_text)
            ? {
                rich_text: body.rich_text.map((value) => {
                  const rich = property(value)
                  return {
                    ...rich,
                    annotations: { bold: false, code: false, ...property(rich.annotations) },
                  }
                }),
              }
            : {}),
        },
      }
    }),
  )
}

function mergedRichText(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const result: Array<Record<string, unknown>> = []
  for (const raw of value) {
    const rich = property(raw),
      text = property(rich.text)
    if (rich.type !== "text" || typeof text.content !== "string") return value
    const content = text.content
    const shape = { ...rich, text: { ...text, content: "" } }
    const prior = result.at(-1)
    const priorText = property(prior?.text)
    const priorShape = prior && { ...prior, text: { ...priorText, content: "" } }
    if (prior && canonical(priorShape) === canonical(shape))
      prior.text = { ...priorText, content: String(priorText.content) + content }
    else if (content) result.push(copy(rich))
  }
  return result
}
function rootContent(raw: unknown) {
  const root = property(raw),
    type = String(root.type),
    body = property(root[type])
  const { id: _id, last_edited_time: _revision, ...header } = root
  return {
    ...header,
    [type]: {
      ...body,
      ...(Array.isArray(body.rich_text) ? { rich_text: mergedRichText(body.rich_text) } : {}),
    },
  }
}

/** Every physical root, including roots outside the list, participates. */
export function zeroListRootEffectsMatch(
  repair: ZeroListRepair["original"],
  itemCount: number,
  roots: readonly unknown[],
) {
  if (!supportedRoots(roots) || roots.length !== repair.before_roots.length) return false
  const start = repair.before_roots.findIndex((root) => property(root).id === repair.block_id)
  if (start < 0 || start + itemCount > roots.length) return false
  return repair.before_roots.every((raw, index) => {
    const before = property(raw)
    let expected = before
    if (index >= start && index < start + itemCount) {
      if (before.type !== "numbered_list_item") return false
      const {
        list_format: _format,
        list_start_index: _start,
        ...body
      } = property(before.numbered_list_item)
      if (!Array.isArray(body.rich_text)) return false
      const { numbered_list_item: _list, ...header } = before
      expected = {
        ...header,
        type: "paragraph",
        paragraph: {
          ...body,
          // Notion adds this explicit no-icon default when a numbered item is
          // replaced by a paragraph. A visible icon or any other field still fails.
          ...(property(property(roots[index]).paragraph).icon === null && !("icon" in body)
            ? { icon: null }
            : {}),
          rich_text: [{ type: "text", text: { content: index - start + ". " } }, ...body.rich_text],
        },
      }
    }
    return canonical(rootContent(expected)) === canonical(rootContent(roots[index]))
  })
}

function validateRecord(receipt: Receipt) {
  return Effect.gen(function* () {
    const history = publicationZeroListHistory(receipt)
    if (!history)
      return yield* refuse("Literal-zero history is not one original-operation retry chain.")
    const { repair, first } = history
    if (
      (yield* sha256(canonical(receipt.intents.slice(0, repair.original_intent_count)))) !==
      repair.original_journal_sha256
    )
      return yield* refuse(
        "An original request, acknowledgement, or rejected field receipt changed.",
      )
    const saved = first.intent.guards!
    if (!sourceFilesSupported(saved["v1/pages/" + receipt.page_id]))
      return yield* refuse("Literal-zero source recovery requires the original Files property.")
    const guards = Object.fromEntries(
      repair.original_guard_paths.map((path) => [path, saved[path]]),
    )
    if ((yield* sha256(canonical(guards))) !== repair.original_guards_sha256)
      return yield* refuse("The original guard set changed.")
    const prefix: Receipt = {
      ...copy(receipt),
      guards: copy(guards),
      intents: copy(receipt.intents.slice(0, repair.original_intent_count)),
    }
    const original = yield* validateListStartRepairRecord(prefix, repair.original)
    const plan = zeroStartPresentation(original.target)
    if (
      !plan ||
      plan.codec !== repair.codec ||
      hasTypedLinks(plan.wire) ||
      !supportedRoots(repair.original.before_roots) ||
      (yield* sha256(plan.wire)) !== repair.wire_sha256 ||
      canonical(first.intent.body) !== canonical(bodyFor(plan.wire)) ||
      canonical(saved) !== canonical(fullGuards(prefix, repair.original))
    )
      return yield* refuse(
        "The wire body or physical preimage is not derived from the original source.",
      )
    return { ...history, prefix, plan, target: original.target, source: original.source }
  })
}

function initialProof(receipt: Receipt, api: Notion["Service"]) {
  return Effect.gen(function* () {
    const prior = yield* observePublicationListRepair(
      receipt,
      api,
      false,
      (pageId, guards, current) =>
        proveRetainedZeroListOwner(receipt, receipt.intents.length, pageId, guards, current),
    )
    if (prior.outcome !== "before")
      return yield* refuse(
        "Literal-zero replacement requires a complete unchanged original before-image.",
      )
    const last = receipt.intents.at(-1)
    if (
      prior.intent_index !== undefined &&
      (prior.intent_index !== receipt.intents.length - 1 ||
        last?.status !== "failed" ||
        property(last.response).id !== undefined ||
        property(last.response).recovery !== undefined)
    )
      return yield* refuse(
        "An unresolved or acknowledged old field request cannot authorize a replacement.",
      )
    const source = receipt.intents[prior.repair.source_intent_index]!
    const target = retainedListSource(source)
    const plan = target === undefined ? undefined : zeroStartPresentation(target)
    if (
      !plan ||
      !prior.repair.original_fence ||
      hasTypedLinks(plan.wire) ||
      !supportedRoots(prior.repair.before_roots)
    )
      return yield* refuse("The original list is outside the bounded literal-zero encoding.")
    if (!sourceFilesSupported(prior.observed["v1/pages/" + receipt.page_id]))
      return yield* refuse(
        "The original page needs a Files property for a reversible source bundle.",
      )
    if (
      prior.repair.before_roots.some(
        (root) =>
          rootPath(root) in receipt.guards &&
          canonical(receipt.guards[rootPath(root)]) !== canonical(root),
      )
    )
      return yield* refuse(
        "A retained physical root guard differs from the complete original preimage.",
      )
    yield* originalZeroSourceBundle(
      receipt,
      receipt.intents.length,
      prior.repair.page_id,
      receipt.guards,
    )
    const repair: ZeroListRepair = {
      version: 1,
      codec: plan.codec,
      original: copy(prior.repair),
      original_fence: {
        state: receipt.state,
        stages: [...receipt.stages],
        ...(receipt.failure ? { failure: copy(receipt.failure) } : {}),
        intent_count: receipt.intents.length,
      },
      original_intent_count: receipt.intents.length,
      original_journal_sha256: yield* sha256(canonical(receipt.intents)),
      original_guard_paths: Object.keys(receipt.guards).sort(),
      original_guards_sha256: yield* sha256(canonical(receipt.guards)),
      wire_sha256: yield* sha256(plan.wire),
      ...(prior.intent_index === undefined
        ? {}
        : { rejected_field_intent_index: prior.intent_index }),
    }
    return {
      repair,
      body: bodyFor(plan.wire),
      guards: fullGuards(receipt, prior.repair),
      outcome: "before" as const,
      observed: prior.observed,
      roots: prior.repair.before_roots,
      intent_index: undefined as number | undefined,
    }
  })
}

/** Read-only classification. Original history and all unrelated guards remain authority. */
export function observePublicationZeroListRepair(receipt: Receipt, transport: Notion["Service"]) {
  return Effect.gen(function* () {
    if (!receipt.conflict)
      return yield* refuse("Literal-zero recovery requires the retained publication fence.")
    if (!receipt.intents.some((intent) => intent.zero_list_repair))
      return yield* initialProof(receipt, transport)
    const record = yield* validateRecord(receipt)
    const { repair, terminal, first, plan, target } = record
    if (terminal.index !== receipt.intents.length - 1)
      return yield* refuse("Restricted recovery cannot bypass later original-operation mutations.")
    const phase = publicationReadPhase()
    const api: Notion["Service"] = {
      ...transport,
      request: (path, body, options) =>
        transport
          .request(path, body, options)
          .pipe(Effect.tap((raw) => Effect.sync(() => capturePublicationRead(phase, path, raw)))),
    }
    const owner = "v1/pages/" + repair.original.page_id,
      bodyPath = owner + "/markdown"
    const priorRoots = originalRoots(repair)
    const paths = new Set([...Object.keys(receipt.guards), ...Object.keys(first.intent.guards!)])
    const raw: Record<string, unknown> = {},
      observed: Record<string, unknown> = {}
    for (const path of [...paths].sort(
      (a, b) => Number(/^v1\/pages\/[^/]+$/.test(b)) - Number(/^v1\/pages\/[^/]+$/.test(a)),
    )) {
      if (priorRoots.has(path)) continue
      raw[path] = yield* api.request(path)
      observed[path] = observation(path, raw[path])
    }
    const intendedHash = yield* originalListAuthority(receipt, raw)
    if (
      intendedHash !== repair.original.intended_hash ||
      !publicationGuardRoles(receipt).ownedMutationTargets.has(owner) ||
      !(yield* proveRetainedZeroListOwner(
        receipt,
        repair.original_intent_count,
        repair.original.page_id,
        first.intent.guards!,
        raw[owner],
      ))
    )
      return yield* refuse(
        "The original source, marker, or owner no longer identifies this replacement.",
      )
    const roots = yield* readListRepairRoots(repair.original.page_id, api)
    for (const root of roots) observed[rootPath(root)] = root
    const saved = first.intent.guards!
    const before =
      canonical(roots) === canonical(repair.original.before_roots) &&
      Object.entries(saved).every(
        ([path, value]) => canonical(observed[path]) === canonical(value),
      ) &&
      Object.entries(receipt.guards).every(
        ([path, value]) => canonical(observed[path]) === canonical(value),
      )
    if (before) {
      if (terminal.intent.status === "completed")
        return yield* refuse("An acknowledged literal-zero replacement has no current effect.")
      return {
        repair,
        body: bodyFor(plan.wire),
        guards: saved,
        outcome: "before" as const,
        observed,
        roots,
        intent_index: terminal.index,
      }
    }
    if (terminal.intent.status === "failed")
      return yield* refuse("A failed literal-zero request cannot acquire a later matching effect.")
    const boundaries = boundariesFor(roots)
    if (
      !boundaries ||
      !zeroListRootEffectsMatch(repair.original, plan.items.length, roots) ||
      notionMarkdownForComparison(pageMarkdown(raw[bodyPath]), target, boundaries) !== target ||
      canonical(metadataContent(saved[owner])) !== canonical(metadataContent(observed[owner])) ||
      Object.entries(saved).some(
        ([path, value]) =>
          path !== owner &&
          path !== bodyPath &&
          !priorRoots.has(path) &&
          canonical(observed[path]) !== canonical(value),
      ) ||
      Object.entries(receipt.guards).some(
        ([path, value]) =>
          path !== owner &&
          path !== bodyPath &&
          !priorRoots.has(path) &&
          !roots.some((root) => rootPath(root) === path) &&
          canonical(observed[path]) !== canonical(value),
      ) ||
      !(yield* readPublicationMarkdownMatches(
        terminal.intent,
        pageMarkdown(raw[bodyPath]),
        plan.wire,
        api,
        phase,
        undefined,
        true,
      ))
    )
      return yield* refuse(
        "The current page is neither the exact old page nor its literal-zero representation.",
      )
    for (const path of [owner, bodyPath]) {
      if (canonical(observation(path, yield* api.request(path))) !== canonical(observed[path]))
        return yield* refuse("The replacement changed during the complete after-proof.")
    }
    if (canonical(yield* readListRepairRoots(repair.original.page_id, api)) !== canonical(roots))
      return yield* refuse("The physical root order changed during the after-proof.")
    return {
      repair,
      body: bodyFor(plan.wire),
      guards: saved,
      outcome: "applied" as const,
      observed,
      roots,
      intent_index: terminal.index,
    }
  })
}

/** Called by ordinary completedPublicationProof; a recorded ACK alone never suffices. */
export function verifyCompletedZeroListRepair(
  receipt: Receipt,
  intent: Intent,
  intendedHash: string,
  api: Notion["Service"],
) {
  return Effect.gen(function* () {
    const record = yield* validateRecord(receipt)
    const { repair, terminal, plan, target } = record
    if (
      terminal.intent !== intent ||
      intent.status !== "completed" ||
      repair.original.intended_hash !== intendedHash
    )
      return yield* refuse(
        "Literal-zero coverage does not identify its completed original successor.",
      )
    const owner = "v1/pages/" + repair.original.page_id,
      bodyPath = owner + "/markdown"
    const rawOwner = yield* api.request(owner)
    const currentOwner = observation(owner, rawOwner)
    if (
      !(yield* proveRetainedZeroListOwner(
        receipt,
        repair.original_intent_count,
        repair.original.page_id,
        record.first.intent.guards!,
        rawOwner,
      )) ||
      !completedListOwnerContentMatches(receipt, intent, currentOwner) ||
      canonical(currentOwner) !== canonical(receipt.guards[owner])
    )
      return yield* refuse("The literal-zero owner lacks its retained complete property proof.")
    const roots = yield* readListRepairRoots(repair.original.page_id, api)
    const boundaries = boundariesFor(roots)
    const actual = pageMarkdown(yield* api.request(bodyPath))
    if (
      !boundaries ||
      !zeroListRootEffectsMatch(repair.original, plan.items.length, roots) ||
      roots.some((root) => canonical(receipt.guards[rootPath(root)]) !== canonical(root)) ||
      actual !== receipt.guards[bodyPath] ||
      notionMarkdownForComparison(actual, target, boundaries) !== target ||
      !(yield* readPublicationMarkdownMatches(
        intent,
        actual,
        plan.wire,
        api,
        publicationReadPhase(),
        undefined,
        true,
      )) ||
      canonical(observation(owner, yield* api.request(owner))) !== canonical(currentOwner) ||
      pageMarkdown(yield* api.request(bodyPath)) !== actual ||
      canonical(yield* readListRepairRoots(repair.original.page_id, api)) !== canonical(roots)
    )
      return yield* refuse(
        "The full current body and ordered physical roots no longer prove visible zero.",
      )
    return terminal.index
  })
}

export function hasZeroListRepairCandidate(receipt: Receipt) {
  const last = receipt.intents.at(-1)
  if (receipt.intents.some((intent) => intent.zero_list_repair))
    return Boolean(
      receipt.conflict ||
        last?.status !== "completed" ||
        !receipt.stages.includes("zero_list_repair_verified"),
    )
  if (
    !receipt.conflict ||
    (last?.list_start_repair &&
      (last.status !== "failed" || property(last.response).recovery !== undefined))
  )
    return false
  return receipt.intents.some((intent) => {
    const source = retainedListSource(intent)
    return source !== undefined && zeroStartPresentation(source) !== undefined
  })
}

/**
 * One finite real mutation in the original journal. The original source ACK,
 * old rejected field request, and fence are immutable. Reconciliation alone
 * can release that fence after independently checking all publication effects.
 */
export function resumePublicationZeroListRepair(operationId: string) {
  return Effect.gen(function* () {
    if (!/^p_[a-zA-Z0-9-]{1,100}$/.test(operationId))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Invalid publication operation ID."))
    const store = yield* Store,
      api = yield* Notion
    return yield* withLocalLocks(
      store.root,
      ["publication:" + operationId],
      Effect.gen(function* () {
        const receipt = yield* store.readJson(keyFor(operationId), PublicationReceiptSchema)
        if (!receipt || receipt.operation_id !== operationId)
          return yield* Effect.fail(
            fail("PUBLICATION_MISSING", "No original publication receipt exists."),
          )
        if (receipt.owner) {
          const owner = receipt.owner
          const dead = yield* Effect.sync(() => {
            if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
              return false
            try {
              process.kill(owner.pid, 0)
              return false
            } catch (error) {
              return property(error).code === "ESRCH"
            }
          })
          if (!dead)
            return yield* Effect.fail(
              fail("PUBLICATION_LOCKED", "A live or unverifiable process owns this publication."),
            )
        }
        // No receipt mutation, including owner acquisition, precedes this proof.
        yield* observePublicationZeroListRepair(receipt, api)
        const persist = () => store.writeJson(keyFor(operationId), copy(receipt))
        return yield* Effect.acquireUseRelease(
          Effect.gen(function* () {
            receipt.owner = { pid: process.pid, host: hostname() }
            yield* persist()
          }),
          () =>
            Effect.gen(function* () {
              const result = yield* Effect.gen(function* () {
                const proof = yield* observePublicationZeroListRepair(receipt, api)
                if (proof.outcome === "before") {
                  if (proof.intent_index !== undefined) {
                    const previous = receipt.intents[proof.intent_index]!
                    if (property(previous.response).recovery !== "known_not_applied") {
                      previous.response = {
                        ...property(previous.response),
                        prior_status: previous.status,
                        recovery: "known_not_applied",
                        replayed_by_intent: receipt.intents.length,
                      }
                      previous.status = "failed"
                      yield* persist()
                    }
                  }
                  const intent: Intent = {
                    method: "PATCH",
                    path: "v1/pages/" + proof.repair.original.page_id + "/markdown",
                    body: copy(proof.body),
                    guards: copy(proof.guards),
                    status: "pending",
                    zero_list_repair: copy(proof.repair),
                  }
                  receipt.intents.push(intent)
                  receipt.state = "running"
                  yield* persist()
                  // Persisting the pending request is another scheduling boundary.
                  // Re-prove the complete preimage immediately before the send.
                  const ready = yield* observePublicationZeroListRepair(receipt, api).pipe(
                    Effect.result,
                  )
                  if (ready._tag === "Failure" || ready.success.outcome !== "before") {
                    intent.status = "failed"
                    intent.response = { recovery: "pre_send_guard_failed" }
                    yield* persist()
                    return yield* ready._tag === "Failure"
                      ? Effect.fail(ready.failure)
                      : refuse(
                          "The exact before-image changed before the journaled request was sent.",
                        )
                  }
                  const sent = yield* api
                    .request(intent.path, intent.body, { method: "PATCH" })
                    .pipe(Effect.result)
                  if (sent._tag === "Failure") {
                    intent.status =
                      sent.failure.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed"
                    yield* persist()
                    return yield* Effect.fail(sent.failure)
                  }
                  intent.status = "completed"
                  const response = property(sent.success)
                  intent.response = {
                    acknowledgement: "received",
                    ...(typeof response.id === "string" ? { id: response.id } : {}),
                    ...(typeof response.object === "string" ? { object: response.object } : {}),
                    ...(typeof response.status === "string" ? { status: response.status } : {}),
                  }
                  yield* persist()
                }
                const after = yield* observePublicationZeroListRepair(receipt, api)
                if (after.outcome !== "applied" || after.intent_index === undefined)
                  return yield* refuse(
                    "The original operation has no complete literal-zero after-proof.",
                  )
                const applied = receipt.intents[after.intent_index]!
                if (applied.status !== "completed") {
                  if (applied.status !== "pending" && applied.status !== "unknown")
                    return yield* refuse(
                      "Only an unresolved send can receive an observed-applied conclusion.",
                    )
                  applied.response = {
                    ...property(applied.response),
                    prior_status: applied.status,
                    recovery: "observed_applied",
                    proof_kind: "zero_start_paragraphs_v1",
                  }
                  applied.status = "completed"
                }
                for (const path of originalRoots(after.repair)) delete receipt.guards[path]
                const owner = "v1/pages/" + after.repair.original.page_id
                for (const path of [owner, owner + "/markdown", ...after.roots.map(rootPath)])
                  receipt.guards[path] = copy(after.observed[path])
                receipt.state = "failed"
                if (!receipt.stages.includes("zero_list_repair_verified"))
                  receipt.stages.push("zero_list_repair_verified")
                yield* persist()
                return {
                  operation_id: operationId,
                  verified: false as const,
                  repair_applied: true,
                  next: {
                    argv: ["ntn-skills", "operation", "reconcile", operationId],
                    reason:
                      "Visible zero is physically verified; reassess the complete original publication before releasing its fence.",
                  },
                }
              }).pipe(Effect.result)
              if (result._tag === "Failure") {
                receipt.state = receipt.intents.some(unresolvedIntent) ? "unknown" : "failed"
                receipt.failure = {
                  code: result.failure.code,
                  message: result.failure.message,
                  details: result.failure.details,
                }
                yield* persist()
                return yield* Effect.fail(result.failure)
              }
              return result.success
            }),
          () =>
            Effect.gen(function* () {
              delete receipt.owner
              if (receipt.intents.some(unresolvedIntent)) receipt.state = "unknown"
              yield* persist()
            }).pipe(Effect.orDie),
        )
      }),
    )
  })
}
