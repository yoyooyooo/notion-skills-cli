import { Effect } from "effect"
import { fail, property } from "./model.ts"
import type { SkillsError } from "./model.ts"
import type { Notion } from "./notion.ts"
import type { Receipt } from "./publication-model.ts"
import { readMarkdownFileBlocks } from "./markdown-files.ts"
import {
  canonical,
  metadata,
  metadataContent,
  observation,
  publicationPropertiesMatch,
} from "./publication-observation.ts"
import { publicationMarker, PublicationReadOperation } from "./publication-integrity.ts"
import { openSkill, snapshotInfo } from "./snapshot.ts"
import { portableIdentity, snapshotAuthoredPortable } from "./export.ts"
import { sha256, Store } from "./store.ts"
import { authScope, explicitSource } from "./catalog.ts"
import { hostname } from "node:os"
import { unresolvedIntent } from "./publication-upload.ts"
import {
  bindPublicationSource,
  isPublicationMetadataIntent,
  publicationGuardComparison,
  unobservedPublicationMetadataAck,
  verifyPublicationMetadata,
} from "./publication-source.ts"

interface Node {
  type: string
  body: unknown
  children: Node[]
}
function node(value: unknown): Node {
  const block = property(value),
    type = String(block.type),
    body = property(block[type])
  if (!["paragraph", "toggle", "code"].includes(type) || !Array.isArray(body.rich_text))
    throw fail("PUBLICATION_UNRESOLVED", "Append contains unsupported file content.")
  const rich = (values: unknown[]) =>
    values
      .map((value) => {
        const span = property(value),
          text = property(span.text)
        if (span.type !== "text" || typeof text.content !== "string" || text.link != null)
          throw fail("PUBLICATION_UNRESOLVED", "Append contains nonliteral file content.")
        const styles = property(span.annotations)
        if (
          Object.entries(styles).some(
            ([key, value]) => value !== (key === "color" ? "default" : false),
          )
        )
          throw fail("WRITE_CONFLICT", "Editable file code or paths acquired formatting.")
        return text.content
      })
      .join("")
  return {
    type,
    body: {
      text: rich(body.rich_text),
      ...(type === "code"
        ? {
            language: body.language,
            caption: rich(Array.isArray(body.caption) ? body.caption : []),
          }
        : {}),
    },
    children: Array.isArray(body.children) ? body.children.map(node) : [],
  }
}
/** Complete original create plus ordered append journal supplies the expected tree.
 * Actual block IDs bind nested append owners; titles alone never grant ownership. */
function journalTree(
  receipt: Receipt,
  blocks: readonly Record<string, unknown>[],
  includePending: boolean,
) {
  const roots: Node[] = [],
    actualRoots = blocks.filter((block) => property(block.parent).page_id === receipt.page_id)
  const byActualId = new Map<string, Node>()
  for (const intent of receipt.intents) {
    const owner = /^v1\/blocks\/([^/]+)\/children$/.exec(intent.path)?.[1]
    if (
      !owner ||
      intent.method !== "PATCH" ||
      (intent.status !== "completed" &&
        !(includePending && ["pending", "unknown"].includes(intent.status)))
    )
      continue
    const children = property(intent.body).children
    if (!Array.isArray(children))
      throw fail("PUBLICATION_UNRESOLVED", "Append journal has no complete children.")
    if (owner === receipt.page_id) {
      for (const value of children) {
        const expected = node(value),
          actual = actualRoots[roots.length]
        roots.push(expected)
        if (actual && typeof actual.id === "string") byActualId.set(actual.id, expected)
      }
    } else {
      const parent = byActualId.get(owner)
      if (!parent || parent.type !== "toggle")
        throw fail("PUBLICATION_UNRESOLVED", "Nested append lacks a unique original owned toggle.")
      parent.children.push(...children.map(node))
    }
  }
  return roots
}
function actualTree(page: string, blocks: readonly Record<string, unknown>[]) {
  const roots: Node[] = [],
    byId = new Map<string, Node>()
  for (const raw of blocks) {
    const value = node(raw),
      owner = property(raw.parent)
    if (typeof raw.id !== "string" || byId.has(raw.id))
      throw fail("INVALID_RESPONSE", "Repeated file block identity.")
    byId.set(raw.id, value)
    if (owner.page_id === page) roots.push(value)
    else {
      const parent = byId.get(String(owner.block_id))
      if (!parent) throw fail("INVALID_RESPONSE", "Unclosed file tree ownership.")
      parent.children.push(value)
    }
  }
  return roots
}
export function reconcileMarkdownFileAppend(receipt: Receipt, api: Notion["Service"]) {
  return Effect.gen(function* () {
    const unresolved = receipt.intents.filter(unresolvedIntent)
    if (
      unresolved.length !== 1 ||
      unresolved[0] !== receipt.intents.at(-1) ||
      !receipt.page_id ||
      receipt.operation !== "create" ||
      !receipt.context?.markdown_files ||
      unresolved[0]!.method !== "PATCH" ||
      !/^v1\/blocks\/[^/]+\/children$/.test(unresolved[0]!.path)
    )
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UNRESOLVED",
          "Only the one terminal file append can reconcile; no mutation was replayed.",
        ),
      )
    const root = `v1/pages/${receipt.page_id}`,
      before = yield* api.request(root)
    if (
      publicationGuardComparison(receipt, root, metadataContent(metadata(before))) !==
      publicationGuardComparison(receipt, root, metadataContent(receipt.guards[root]))
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "File metadata or publication authority changed during the unknown append.",
        ),
      )
    const blocks = yield* readMarkdownFileBlocks(receipt.page_id, api)
    const after = yield* api.request(root)
    if (canonical(metadata(before)) !== canonical(metadata(after)))
      return yield* Effect.fail(
        fail("PUBLICATION_CHANGED", "File page changed during append reconciliation."),
      )
    const applied = yield* Effect.try({
      try: () =>
        canonical(journalTree(receipt, blocks, true)) ===
        canonical(actualTree(receipt.page_id!, blocks)),
      catch: (error) => error as SkillsError,
    })
    if (!applied)
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UNRESOLVED",
          "Unknown append is not the exact complete intended tree; no request was replayed.",
        ),
      )
    const markdown = observation(root + "/markdown", yield* api.request(root + "/markdown"))
    if (canonical(metadata(yield* api.request(root))) !== canonical(metadata(after)))
      return yield* Effect.fail(
        fail("PUBLICATION_CHANGED", "File page changed before recording append reconciliation."),
      )
    const intent = unresolved[0]!
    intent.status = "completed"
    intent.response = { recovery: "observed_applied", prior_status: "unknown" }
    receipt.guards[root] = observation(root, after)
    receipt.guards[root + "/markdown"] = markdown
    for (const path of Object.keys(receipt.guards)) {
      const id = /^v1\/blocks\/([^/]+)(?:\/children\?.*)?$/.exec(path)?.[1]
      if (!id) continue
      const block = blocks.find((block) => block.id === id)
      if (block && path === `v1/blocks/${id}`) receipt.guards[path] = observation(path, block)
      else if (id === receipt.page_id || block) delete receipt.guards[path]
    }
    return receipt
  })
}

/** Settle only a terminal property write already present in full readback. */
export function reconcileMarkdownFileProperties(receipt: Receipt, api: Notion["Service"]) {
  return Effect.gen(function* () {
    const pending = receipt.intents.filter(
      (intent) => unresolvedIntent(intent) || unobservedPublicationMetadataAck(receipt, intent),
    )
    const intent = pending[0],
      root = `v1/pages/${receipt.page_id}`
    const requested = property(property(intent?.body).properties)
    if (
      pending.length !== 1 ||
      intent !== receipt.intents.at(-1) ||
      intent?.path !== root ||
      intent.method !== "PATCH" ||
      !receipt.page_id ||
      !receipt.context?.markdown_files ||
      !Object.keys(requested).length ||
      Object.keys(property(intent.body)).join() !== "properties"
    )
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UNRESOLVED",
          "Only one terminal file metadata write can reconcile without replay.",
        ),
      )
    const originalContext = property(
      property(property(receipt.guards[root]).properties)["Default Context"],
    )
    const frozenContextWrite =
      typeof receipt.context.default_context === "boolean" &&
      originalContext.type === "checkbox" &&
      typeof originalContext.id === "string" &&
      canonical(requested) ===
        canonical({ [originalContext.id]: { checkbox: receipt.context.default_context } })
    if (
      receipt.context.source_intent &&
      !isPublicationMetadataIntent(receipt, intent) &&
      !frozenContextWrite &&
      Object.keys(requested).join() !== "Publication"
    )
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UNRESOLVED",
          "The terminal request is not exact frozen publication metadata.",
        ),
      )
    if (receipt.data_source_id) yield* bindPublicationSource(receipt, receipt.data_source_id, api)
    const before = yield* api.request(root)
    if (!publicationPropertiesMatch(before, requested))
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UNRESOLVED",
          "The unknown metadata write is not present; no request was replayed.",
        ),
      )
    const unchanged = (raw: unknown) => {
      const content = property(metadataContent(raw)),
        fields = property(content.properties)
      return {
        ...content,
        properties: Object.fromEntries(
          Object.entries(fields).filter(
            ([key, value]) =>
              !Object.hasOwn(requested, key) &&
              !Object.hasOwn(requested, String(property(value).id)),
          ),
        ),
      }
    }
    if (
      publicationGuardComparison(receipt, root, unchanged(metadata(before))) !==
      publicationGuardComparison(receipt, root, unchanged(receipt.guards[root]))
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "Unrequested metadata changed alongside the unknown file write."),
      )
    const snapshot = yield* openSkill(receipt.page_id, {
      database: receipt.database_id,
      refresh: true,
    }).pipe(Effect.provideService(PublicationReadOperation, receipt.operation_id))
    const store = yield* Store
    const files = yield* Effect.forEach(receipt.portable.files, (file) =>
      Effect.gen(function* () {
        const bytes = yield* store.readBytes(`objects/${file.sha256}`)
        if ((yield* sha256(bytes)) !== file.sha256)
          return yield* Effect.fail(fail("STATE_CORRUPT", "Frozen editable file changed."))
        return { path: file.path, bytes }
      }),
    )
    if (
      (yield* portableIdentity({ ...receipt.portable, files })) !==
      (yield* portableIdentity(yield* snapshotAuthoredPortable(snapshot)))
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "Live files differ from the source during metadata reconciliation."),
      )
    const after = yield* api.request(root)
    if (canonical(metadata(before)) !== canonical(metadata(after)))
      return yield* Effect.fail(
        fail("PUBLICATION_CHANGED", "The file page changed during metadata reconciliation."),
      )
    if (unresolvedIntent(intent)) {
      intent.response = {
        ...property(intent.response),
        recovery: "observed_applied",
        prior_status: intent.status,
      }
      intent.status = "completed"
    }
    receipt.guards[root] = observation(root, after)
    return receipt
  })
}

/** Read-only public reconciliation; never pass literal append paths through the
 * rendered-Markdown effect grammar, and never demote a committed receipt. */
export function observeMarkdownFilesPublication(receipt: Receipt, api: Notion["Service"]) {
  return Effect.gen(function* () {
    if (!receipt.scope || (yield* authScope) !== receipt.scope)
      return yield* Effect.fail(
        fail("PUBLICATION_SCOPE_MISMATCH", "Publication belongs to another authentication scope."),
      )
    if (
      !receipt.database_id ||
      !receipt.data_source_id ||
      !(yield* explicitSource(receipt.database_id)).data_source_ids.includes(receipt.data_source_id)
    )
      return yield* Effect.fail(
        fail("PUBLICATION_SOURCE_MISMATCH", "The original file publication source changed."),
      )
    if (receipt.owner) {
      const owner = receipt.owner
      const alive = yield* Effect.sync(() => {
        if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
          return true
        try {
          process.kill(owner.pid, 0)
          return true
        } catch (error) {
          return property(error).code !== "ESRCH"
        }
      })
      if (alive)
        return yield* Effect.fail(
          fail("PUBLICATION_LOCKED", "A live or unverifiable process owns this publication."),
        )
    }
    const observations: {
      path: string
      outcome: "success" | "unknown" | "conflict"
      reason?: string
    }[] = []
    if (!receipt.page_id) return { outcome: "unknown" as const, verified: false, observations }
    const path = `v1/pages/${receipt.page_id}`
    const checked = yield* Effect.gen(function* () {
      const root = yield* api.request(path),
        marker = publicationMarker(root)
      if (receipt.conflict) return "conflict" as const
      if (marker?.state !== "committed" || marker.operation_id !== receipt.operation_id) {
        if (
          receipt.intents.some(
            (intent) =>
              unresolvedIntent(intent) || unobservedPublicationMetadataAck(receipt, intent),
          )
        ) {
          const candidate = structuredClone(receipt)
          if (candidate.intents.at(-1)?.path === path)
            yield* reconcileMarkdownFileProperties(candidate, api)
          else yield* reconcileMarkdownFileAppend(candidate, api)
          return "needs_safe_resume" as const
        }
        return "unknown" as const
      }
      const snapshot = yield* openSkill(receipt.page_id!, {
        database: receipt.database_id,
        refresh: true,
      }).pipe(Effect.provideService(PublicationReadOperation, receipt.operation_id))
      const store = yield* Store
      const files = yield* Effect.forEach(receipt.portable.files, (file) =>
        Effect.gen(function* () {
          const bytes = yield* store.readBytes(`objects/${file.sha256}`)
          if ((yield* sha256(bytes)) !== file.sha256)
            return yield* Effect.fail(fail("STATE_CORRUPT", "Frozen editable file changed."))
          return { path: file.path, bytes }
        }),
      )
      if (
        (yield* portableIdentity({ ...receipt.portable, files })) !==
        (yield* portableIdentity(yield* snapshotAuthoredPortable(snapshot)))
      )
        return "conflict" as const
      yield* verifyPublicationMetadata(receipt, api)
      if (
        receipt.context?.default_context !== undefined &&
        snapshot.record.default_context !== receipt.context.default_context
      )
        return "conflict" as const
      if (
        receipt.intents.some(
          (intent) => unresolvedIntent(intent) || unobservedPublicationMetadataAck(receipt, intent),
        )
      )
        yield* reconcileMarkdownFileProperties(receipt, api)
      if (!receipt.intents.some(unresolvedIntent) && receipt.state !== "completed") {
        receipt.state = "completed"
        receipt.result = {
          ...receipt.result,
          ...snapshotInfo(snapshot),
          operation: receipt.operation,
          verified: true,
          operation_id: receipt.operation_id,
        }
        yield* store.writeJson(`publications/${receipt.operation_id}.json`, receipt)
      }
      return "success" as const
    }).pipe(Effect.result)
    const outcome =
      checked._tag === "Success"
        ? checked.success
        : ["WRITE_CONFLICT", "PUBLICATION_DIVERGED"].includes(checked.failure.code)
          ? ("conflict" as const)
          : ("unknown" as const)
    observations.push({
      path,
      outcome: outcome === "success" ? "success" : outcome === "conflict" ? "conflict" : "unknown",
      ...(checked._tag === "Failure" ? { reason: checked.failure.code } : {}),
    })
    return { outcome, verified: outcome === "success", observations }
  })
}
