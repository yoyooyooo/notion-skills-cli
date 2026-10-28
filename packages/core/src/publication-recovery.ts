import {
  pendingMarkdownReplayCandidate,
  terminalRecordedMarkdownReplay,
} from "./publication-markdown-replay.ts"
import {
  hasObservedMarkdownCorrection,
  recordedObservedMarkdownCorrection,
} from "./publication-markdown-history.ts"
import { proveObservedMarkdownNoEffect } from "./publication-markdown-correction.ts"
import {
  retainedUnusableUploadCandidate,
  retainedUploadCertificates,
} from "./publication-retained-upload.ts"
import { terminalPublicationCommitCandidate } from "./publication-terminal-commit.ts"
import { proveOriginalCreateRootInventory } from "./publication-root-inventory.ts"
import { Effect } from "effect"
import { hostname } from "node:os"
import { authScope, explicitSource } from "./catalog.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import type { PortableSkill } from "./portable.ts"
import { publicationSession } from "./publication.ts"
import type { Publication, PublicationContext, PublicationOptions } from "./publication.ts"
import { PublicationReceiptSchema as ReceiptSchema, type Receipt } from "./publication-model.ts"
import { publicationMarker, PublicationReadOperation } from "./publication-integrity.ts"
import {
  blockPatchRecovery,
  proveUnappliedPublicationCommit,
  proveRetainedUploadReplacement,
  canonical,
  copy,
  keyFor,
  metadata,
  metadataContent,
  observation,
  publicationGuardRoles,
  capturePublicationRead,
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "./publication-observation.ts"
import {
  isUploadIntent,
  proveRetainedTerminalUploadOrphan,
  retainedTerminalUploadOrphan,
  unresolvedIntent,
  verifyAttachedUpload,
  recoverUploadIntents,
} from "./publication-upload.ts"
import { restoreMarkdownBlocks, restoreOrderedListStart } from "./markdown-blocks.ts"
import { restoreTypedLinks } from "./typed-links.ts"
import { childPageTags, pageMarkdown } from "./references.ts"
import { bodyIdentity } from "./portable.ts"
import { pageId } from "./ref.ts"
import { openSkill, snapshotInfo } from "./snapshot.ts"
import { sha256, Store } from "./store.ts"
import { listStartRepairBody, provePublicationListRepair } from "./publication-list-repair.ts"
import { restoreAcknowledgedCodeLanguages } from "./publication-code-languages.ts"
import {
  bindPublicationSource,
  isPublicationMetadataIntent,
  publicationGuardComparison,
  publicationMetadataApplied,
  publicationMetadataProperties,
  rejectPublicationSourceOverride,
  unobservedPublicationMetadataAck,
} from "./publication-source.ts"

import { discoverPublicationCreate } from "./publication-create-discovery.ts"
import { MARKDOWN_FILES_MARKER } from "./markdown-files.ts"
import { referenceLinks } from "./reference-links.ts"
import {
  creationMarkerBlock,
  creationProofFromBody,
  creationProofMatchesIntent,
} from "./publication-create-identity.ts"
import { text } from "./model.ts"

type Intent = Receipt["intents"][number]
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const exactKeys = (value: unknown, keys: readonly string[]) => {
  const raw = record(value)
  return (
    raw !== undefined &&
    Object.keys(raw).length === keys.length &&
    keys.every((key) => Object.hasOwn(raw, key))
  )
}

/** Only the original native replace's whole References registration, keyed by
 * the frozen field ID and bound to every preceding acknowledged child create.
 * No other property, prefix, or later registration is eligible. */
function originalNativeReferencesRegistration(receipt: Receipt, intent: Intent) {
  if (
    receipt.operation !== "replace" ||
    receipt.conflict ||
    receipt.context?.ownership ||
    receipt.context?.source_intent?.mode !== "preserve" ||
    receipt.source_binding ||
    !receipt.page_id ||
    intent !== receipt.intents.at(-1) ||
    unresolvedIntent(intent) === false ||
    intent.method !== "PATCH" ||
    intent.path !== `v1/pages/${receipt.page_id}` ||
    intent.recovery ||
    intent.typed_links ||
    intent.artifact ||
    intent.list_start_repair ||
    intent.zero_list_repair ||
    intent.response !== undefined ||
    intent.guards !== undefined
  )
    return false
  const rootPath = `v1/pages/${receipt.page_id}`
  const root = record(receipt.guards[rootPath])
  const field = record(record(root?.properties)?.References)
  const fieldId = field?.id
  if (
    !root ||
    root.id !== receipt.page_id ||
    root.archived !== false ||
    root.in_trash !== false ||
    record(root.parent)?.type !== "data_source_id" ||
    record(root.parent)?.data_source_id !== receipt.data_source_id ||
    field?.type !== "rich_text" ||
    typeof fieldId !== "string" ||
    !fieldId ||
    /[/?#\\\s]/.test(fieldId) ||
    fieldId === "." ||
    fieldId === ".." ||
    !Array.isArray(field.rich_text)
  )
    return false
  const marker = publicationMarker(root)
  const initial = receipt.intents[0]
  if (
    marker?.state !== "writing" ||
    marker.operation_id !== receipt.operation_id ||
    initial?.status !== "completed" ||
    initial.method !== "PATCH" ||
    initial.path !== rootPath ||
    !exactKeys(initial.body, ["properties"]) ||
    !exactKeys(record(initial.body)?.properties, ["Publication"]) ||
    canonical(
      publicationMarker({
        properties: {
          Publication: {
            type: "rich_text",
            ...(property(record(initial.body)?.properties).Publication as object),
          },
        },
      }),
    ) !== canonical(marker)
  )
    return false
  const body = record(intent.body)
  const requested = record(body?.properties)
  const key = requested ? Object.keys(requested)[0] : undefined
  if (
    !exactKeys(body, ["properties"]) ||
    !requested ||
    !key ||
    Object.keys(requested).length !== 1 ||
    (key !== fieldId && key !== "References") ||
    !exactKeys(requested[key], ["rich_text"])
  )
    return false
  const files = receipt.portable.files.filter(
    (file) => file.path !== receipt.portable.main && /\.md$/i.test(file.path),
  )
  if (!files.length || files.length !== new Set(files.map((file) => file.path)).size) return false
  const children: { id: string; path: string }[] = []
  for (let index = 1; index < receipt.intents.length; index += 2) {
    const created = receipt.intents[index]!
    const registration = receipt.intents[index + 1]
    const child = record(created.body)
    const id = record(created.response)?.id
    const title = text(record(record(child?.properties)?.title)?.title)
    const path = receipt.portable.files.some((file) => file.path === title)
      ? title
      : `references/${title}`
    const proof = creationProofFromBody(child)
    const source = files[children.length]
    const page = record(receipt.guards[`v1/pages/${String(id)}`])
    if (
      created.method !== "POST" ||
      created.path !== "v1/pages" ||
      created.status !== "completed" ||
      created.recovery ||
      created.typed_links ||
      created.artifact ||
      created === intent ||
      typeof id !== "string" ||
      id === receipt.page_id ||
      !title ||
      !source ||
      source.path !== path ||
      !proof ||
      proof.role !== "reference" ||
      !creationProofMatchesIntent(proof, receipt, index) ||
      proof.path !== source.path ||
      proof.source_sha256 !== source.sha256 ||
      proof.intended_hash !== marker.intended_hash ||
      canonical(child?.children) !== canonical([creationMarkerBlock(proof)]) ||
      record(child?.parent)?.type !== "page_id" ||
      record(child?.parent)?.page_id !== receipt.page_id ||
      page?.id !== id ||
      record(page?.parent)?.type !== "page_id" ||
      record(page?.parent)?.page_id !== receipt.page_id ||
      page?.archived !== false ||
      page?.in_trash !== false ||
      !(`v1/pages/${id}/markdown` in receipt.guards) ||
      children.some((other) => other.id === id || other.path === path)
    )
      return false
    children.push({ id, path })
    if (!registration) return false
    const terminal = registration === intent
    const prior = record(registration.body)
    const priorFields = record(prior?.properties)
    const priorKey = priorFields ? Object.keys(priorFields)[0] : undefined
    if (
      registration.method !== "PATCH" ||
      registration.path !== rootPath ||
      (terminal
        ? !unresolvedIntent(registration)
        : registration.status !== "completed" ||
          record(registration.response)?.id !== receipt.page_id) ||
      (!terminal &&
        (!exactKeys(prior, ["properties"]) ||
          !priorKey ||
          Object.keys(priorFields!).length !== 1 ||
          (priorKey !== fieldId && priorKey !== "References"))) ||
      canonical(terminal ? requested[key] : priorFields?.[priorKey ?? ""]) !==
        canonical(referenceLinks(children))
    )
      return false
    if (terminal)
      return (
        children.length > 0 &&
        children.length < files.length &&
        index + 1 === receipt.intents.length - 1
      )
  }
  return false
}
/** Recover under an exclusive local fence. The continuation always receives frozen bytes and a fixed page ID. */
export function recoverPublication<A extends object, E extends SkillsError, R>(
  operationId: string,
  options: PublicationOptions,
  continuation: (
    portable: PortableSkill,
    pageId: string,
    database: string,
    publication: Publication,
    operation: Receipt["operation"],
    context?: PublicationContext,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    yield* rejectPublicationSourceOverride(options)
    if (!/^p_[a-zA-Z0-9-]{1,100}$/.test(operationId))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Invalid publication operation ID."))
    const store = yield* Store
    return yield* withLocalLocks(
      store.root,
      [`publication:${operationId}`],
      Effect.gen(function* () {
        const raw = yield* store.readJson(keyFor(operationId), ReceiptSchema)
        const receipt = yield* Effect.try({
          try: () => {
            const value = raw
            if (
              !value ||
              value.format !== 1 ||
              value.operation_id !== operationId ||
              !Array.isArray(value.intents) ||
              !Array.isArray(value.portable?.files) ||
              !value.guards ||
              !value.scope ||
              !value.database_id ||
              !value.data_source_id
            )
              throw fail("PUBLICATION_MISSING", "No valid bound publication receipt exists.")
            return value
          },
          catch: (error) =>
            error instanceof SkillsError
              ? error
              : fail("STATE_CORRUPT", "Invalid publication receipt."),
        })
        if (receipt.body_completion && receipt.body_completion.phase !== "verified")
          return yield* Effect.fail(
            fail(
              "PUBLICATION_BODY_COMPLETION_PENDING",
              "Reconcile the retained body-completion journal before ordinary publication resume.",
              { plan_id: receipt.body_completion.plan_id },
            ),
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
              fail("PUBLICATION_LOCKED", "A live or unverifiable process owns this publication.", {
                operation_id: operationId,
                receipt_path: `sqlite:publications/${operationId}`,
              }),
            )
        }
        receipt.owner = { pid: process.pid, host: hostname() }
        yield* store.writeJson(keyFor(operationId), copy(receipt))
        const session = yield* publicationSession(receipt, options)
        return yield* session.finish(
          session.run(
            "resume_preflight",
            Effect.gen(function* () {
              if ((yield* authScope) !== receipt.scope)
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_SCOPE_MISMATCH",
                    "Publication belongs to another authentication scope.",
                  ),
                )
              const terminalOrphan = receipt.intents.at(-1)
              const provedTerminalOrphan =
                options.newArtifact &&
                !receipt.conflict &&
                terminalOrphan &&
                retainedTerminalUploadOrphan(receipt, terminalOrphan)
                  ? yield* proveRetainedTerminalUploadOrphan(receipt).pipe(Effect.result)
                  : undefined
              if (provedTerminalOrphan?._tag === "Failure")
                return yield* Effect.fail(provedTerminalOrphan.failure)
              if (receipt.conflict)
                return yield* Effect.fail(
                  fail(
                    "WRITE_CONFLICT",
                    "This publication was fenced after an external edit; it cannot be resumed.",
                  ),
                )
              if (
                terminalOrphan?.recovery?.kind === "remote_orphan" &&
                provedTerminalOrphan?._tag !== "Success"
              )
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
                    "The terminal unknown upload remains fenced until its completed body proof authorizes a separate artifact.",
                  ),
                )
              const source = yield* explicitSource(receipt.database_id!)
              yield* bindPublicationSource(receipt, receipt.data_source_id!, session.notion)
              if (!source.data_source_ids.includes(receipt.data_source_id!))
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_SOURCE_MISMATCH",
                    "Publication data source no longer belongs to the bound database.",
                  ),
                )
              if (
                receipt.state === "completed" &&
                receipt.result &&
                !receipt.intents.some((intent) => intent.typed_links?.state === "pending")
              )
                return receipt.result as A
              const creationDiscovery: unknown[] = []
              for (const [index, intent] of receipt.intents.entries()) {
                if (intent.path !== "v1/pages" || !["pending", "unknown"].includes(intent.status))
                  continue
                const rawApi = yield* Notion
                const discovery = yield* discoverPublicationCreate(receipt, index).pipe(
                  Effect.provideService(Notion, rawApi),
                )
                const { candidate, evidence, inventories } = discovery
                creationDiscovery.push(evidence)
                if (!candidate) continue
                const parentId = property(property(intent.body).parent).page_id
                if (typeof parentId === "string") {
                  const parentBodyPath = `v1/pages/${parentId}/markdown`
                  const previousBody = receipt.guards[parentBodyPath]
                  const parentBody = pageMarkdown(yield* rawApi.request(parentBodyPath))
                  const added = childPageTags(parentBody).filter(
                    (tag) => pageId(/\burl="([^"]+)"/.exec(tag)?.[1] ?? "") === candidate.id,
                  )
                  if (
                    typeof previousBody !== "string" ||
                    added.length !== 1 ||
                    (!previousBody.includes(MARKDOWN_FILES_MARKER) &&
                      bodyIdentity(parentBody.replace(added[0]!, "")) !==
                        bodyIdentity(previousBody))
                  )
                    return yield* Effect.fail(
                      fail(
                        "WRITE_CONFLICT",
                        "Parent changed alongside the unknown child creation.",
                      ),
                    )
                  const parentPath = `v1/pages/${parentId}`
                  const parentRaw = yield* rawApi.request(parentPath)
                  if (
                    publicationGuardComparison(
                      receipt,
                      parentPath,
                      metadataContent(receipt.guards[parentPath]),
                    ) !==
                    publicationGuardComparison(
                      receipt,
                      parentPath,
                      metadataContent(metadata(parentRaw)),
                    )
                  )
                    return yield* Effect.fail(
                      fail(
                        "WRITE_CONFLICT",
                        "Parent metadata changed alongside the unknown child creation.",
                      ),
                    )
                  receipt.guards[parentBodyPath] = parentBody
                  receipt.guards[parentPath] = metadata(parentRaw)
                }
                for (const [path, raw] of Object.entries(inventories))
                  receipt.guards[path] = observation(path, raw)
                receipt.guards[`v1/pages/${candidate.id}`] = metadata(candidate.raw)
                receipt.guards[`v1/pages/${candidate.id}/markdown`] = candidate.markdown
                intent.response = {
                  ...property(intent.response),
                  id: candidate.id,
                  prior_status: intent.status,
                  recovery: "observed_applied",
                }
                intent.status = "completed"
              }
              receipt.creation_discovery = creationDiscovery
              if (creationDiscovery.some((item) => property(item).complete === false))
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_UNRESOLVED",
                    "A page creation has no uniquely proven response; automatic replay is forbidden.",
                  ),
                )
              if (
                !receipt.page_id ||
                receipt.intents.some(
                  (intent) =>
                    intent.path === "v1/pages" && ["pending", "unknown"].includes(intent.status),
                )
              )
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_UNRESOLVED",
                    "A page creation has no uniquely proven response; automatic replay is forbidden.",
                  ),
                )
              const transport = yield* Notion
              const readPhase = publicationReadPhase()
              const api: Notion["Service"] = {
                ...transport,
                request: (path, body, options) =>
                  transport
                    .request(path, body, options)
                    .pipe(
                      Effect.tap((raw) =>
                        Effect.sync(() => capturePublicationRead(readPhase, path, raw)),
                      ),
                    ),
              }
              const retainedCertificates = retainedUploadCertificates(receipt)
              if (!retainedCertificates)
                return yield* Effect.fail(
                  fail("PUBLICATION_UNRESOLVED", "The retained upload certificate is invalid."),
                )
              const expected = copy(receipt.guards)
              const roles = publicationGuardRoles(receipt)
              const rootPath = `v1/pages/${receipt.page_id}`
              const propertyRetries: Receipt["intents"][number][] = []
              const appliedMetadata = new Set<Intent>()
              const markdownRetries: { intent: Intent; corrected: boolean }[] = []
              const correction = recordedObservedMarkdownCorrection(receipt)
              if (hasObservedMarkdownCorrection(receipt) && !correction)
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_MARKDOWN_CORRECTION_UNPROVEN",
                    "The recorded correction no longer matches its original journal and source.",
                  ),
                )
              const correctedReplay =
                correction && receipt.intents.length === 3 ? correction.candidate.intent : undefined
              const recordedReplay = terminalRecordedMarkdownReplay(receipt)
              let terminalCommitIndex: number | undefined
              const blockRetries: { intent: Intent; skip: boolean }[] = []
              if (!(rootPath in expected) || !(rootPath + "/markdown" in expected))
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_UNRESOLVED",
                    "The bound root has incomplete retained observations.",
                  ),
                )
              for (const intent of receipt.intents) {
                if (intent.path !== "v1/pages" || intent.status !== "completed") continue
                const id = property(intent.response).id
                if (
                  typeof id !== "string" ||
                  !(`v1/pages/${id}` in expected) ||
                  !(`v1/pages/${id}/markdown` in expected)
                )
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "A created page has incomplete retained observations.",
                    ),
                  )
              }
              for (const [inventoryPath, inventory] of Object.entries(expected)) {
                if (!/^v1\/blocks\/[^/]+\/children\?/.test(inventoryPath)) continue
                const inventoryOwner = /^v1\/blocks\/([^/]+)\//.exec(inventoryPath)?.[1]
                if (
                  !inventoryOwner ||
                  !roles.ownedMutationTargets.has(`v1/pages/${inventoryOwner}`)
                )
                  continue
                const children = property(inventory).results
                if (!Array.isArray(children))
                  return yield* Effect.fail(
                    fail("PUBLICATION_UNRESOLVED", "A child inventory is invalid."),
                  )
                const inventoryPage = property(inventory)
                if (inventoryPage.has_more === true) {
                  const cursor = inventoryPage.next_cursor
                  const base = inventoryPath.split("&start_cursor=")[0]
                  if (
                    typeof cursor !== "string" ||
                    !(`${base}&start_cursor=${encodeURIComponent(cursor)}` in expected)
                  )
                    return yield* Effect.fail(
                      fail(
                        "PUBLICATION_UNRESOLVED",
                        "The retained child inventory is incomplete.",
                        { path: inventoryPath },
                      ),
                    )
                }
                for (const item of children) {
                  const id = property(item).id
                  if (
                    typeof id !== "string" ||
                    !(`v1/pages/${id}` in expected) ||
                    !(`v1/pages/${id}/markdown` in expected)
                  )
                    return yield* Effect.fail(
                      fail(
                        "PUBLICATION_UNRESOLVED",
                        "An unregistered child has incomplete retained observations.",
                      ),
                    )
                }
              }
              for (const intent of receipt.intents.filter(
                (item) =>
                  !isUploadIntent(item) &&
                  (unresolvedIntent(item) ||
                    unobservedPublicationMetadataAck(receipt, item) ||
                    item === correctedReplay ||
                    item === recordedReplay ||
                    (item.status === "completed" && item.typed_links?.state === "pending") ||
                    (item.status === "completed" &&
                      item.method === "PATCH" &&
                      /^v1\/blocks\/[^/]+$/.test(item.path) &&
                      item.guards?.[item.path] !== undefined &&
                      canonical(expected[item.path]) === canonical(item.guards[item.path]))),
              )) {
                if (intent.list_start_repair || intent.zero_list_repair)
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_LIST_REPAIR_UNPROVEN",
                      "List correction requires its restricted original-operation recovery.",
                    ),
                  )
                const raw = yield* api.request(intent.path)
                if (/^v1\/blocks\/[^/]+$/.test(intent.path) && intent.method === "PATCH") {
                  const observed: Record<string, unknown> = {
                    [intent.path]: observation(intent.path, raw),
                  }
                  for (const path of Object.keys(intent.guards ?? {}))
                    if (path !== intent.path)
                      observed[path] = observation(path, yield* api.request(path))
                  const recovery = blockPatchRecovery(intent, receipt, observed, true)
                  if (recovery.outcome === "retry") {
                    blockRetries.push({ intent, skip: recovery.skip })
                    continue
                  }
                  if (recovery.outcome !== "success")
                    return yield* Effect.fail(
                      fail(
                        recovery.outcome === "conflict"
                          ? "WRITE_CONFLICT"
                          : "PUBLICATION_UNRESOLVED",
                        recovery.reason,
                        { path: intent.path },
                      ),
                    )
                  Object.assign(expected, recovery.guards)
                  continue
                }
                const retained =
                  options.newArtifact && !options.modeOnly && retainedCertificates.length === 0
                    ? retainedUnusableUploadCandidate(receipt, metadata(raw))
                    : undefined
                if (
                  retained?.files_intent_index !== undefined &&
                  receipt.intents[retained.files_intent_index] === intent
                )
                  continue
                if (yield* verifyAttachedUpload(raw, intent, receipt)) {
                  const latest = observation(intent.path, raw)
                  const changed = Object.keys(property(property(intent.body).properties))
                  for (const [key, item] of Object.entries(
                    property(property(expected[intent.path]).properties),
                  )) {
                    const field = property(item)
                    if (
                      !changed.includes(key) &&
                      !changed.includes(String(field.id)) &&
                      Array.isArray(field.files) &&
                      field.files.some((file) => typeof property(file).id !== "string")
                    )
                      return yield* Effect.fail(
                        fail(
                          "PUBLICATION_UNRESOLVED",
                          "An unaffected attachment lacks stable identity across the pending attachment write.",
                          { path: intent.path },
                        ),
                      )
                  }
                  const unchanged = (raw: unknown) => {
                    const value = property(metadataContent(raw))
                    return {
                      ...value,
                      properties: Object.fromEntries(
                        Object.entries(property(value.properties)).filter(
                          ([key, item]) =>
                            !changed.includes(key) && !changed.includes(String(property(item).id)),
                        ),
                      ),
                    }
                  }
                  if (canonical(unchanged(expected[intent.path])) !== canonical(unchanged(latest)))
                    return yield* Effect.fail(
                      fail(
                        "WRITE_CONFLICT",
                        "Remote content changed alongside the upload attachment.",
                        { path: intent.path },
                      ),
                    )
                  expected[intent.path] = latest
                  continue
                }
                if (
                  publicationMetadataApplied(
                    receipt,
                    intent,
                    expected[intent.path],
                    observation(intent.path, raw),
                  )
                ) {
                  expected[intent.path] = observation(intent.path, raw)
                  appliedMetadata.add(intent)
                  continue
                }
                if (unobservedPublicationMetadataAck(receipt, intent))
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "The acknowledged metadata assignment has no exact unchanged-resource proof.",
                    ),
                  )
                if (
                  options.modeOnly &&
                  receipt.operation === "write" &&
                  receipt.context?.ownership &&
                  intent.path === rootPath &&
                  intent.method === "PATCH" &&
                  isPublicationMetadataIntent(receipt, intent)
                ) {
                  if (
                    publicationGuardComparison(
                      receipt,
                      intent.path,
                      observation(intent.path, raw),
                    ) !== publicationGuardComparison(receipt, intent.path, expected[intent.path])
                  )
                    return yield* Effect.fail(
                      fail(
                        "WRITE_CONFLICT",
                        "The unresolved mode intent differs from its retained original state.",
                      ),
                    )
                  continue
                }
                const properties = property(property(intent.body).properties)
                const keys = Object.keys(properties),
                  fields = property(property(expected[rootPath]).properties)
                const sourceBinding = receipt.source_binding
                const ownedBusinessProperties =
                  receipt.context?.ownership &&
                  intent.path === rootPath &&
                  intent.method === "PATCH" &&
                  Object.keys(property(intent.body)).length === 1 &&
                  keys.length > 0 &&
                  keys.every((key) => {
                    const id = property(
                      fields[key] ??
                        Object.values(fields).find((field) => property(field).id === key),
                    ).id
                    return (
                      key !== "Publication" &&
                      id !== property(fields.Publication).id &&
                      key !== "Source Type" &&
                      key !== "Builtin ID" &&
                      (sourceBinding?.status !== "bound" ||
                        (key !== sourceBinding.source_type_id &&
                          key !== sourceBinding.builtin_id_id &&
                          id !== sourceBinding.source_type_id &&
                          id !== sourceBinding.builtin_id_id))
                    )
                  })
                if (
                  !options.modeOnly &&
                  (isPublicationMetadataIntent(receipt, intent) || ownedBusinessProperties) &&
                  publicationGuardComparison(
                    receipt,
                    intent.path,
                    observation(intent.path, raw),
                  ) === publicationGuardComparison(receipt, intent.path, expected[intent.path])
                ) {
                  propertyRetries.push(intent)
                  continue
                }
                if (
                  (Object.keys(publicationMetadataProperties(receipt)).length > 0 ||
                    (receipt.context?.source_intent?.mode === "preserve" &&
                      !receipt.context.ownership &&
                      !receipt.source_binding &&
                      receipt.operation === "replace" &&
                      intent === receipt.intents[0] &&
                      receipt.intents.length === 1)) &&
                  intent.path === rootPath &&
                  intent.method === "PATCH" &&
                  canonical(Object.keys(property(property(intent.body).properties))) ===
                    canonical(["Publication"]) &&
                  publicationGuardComparison(
                    receipt,
                    intent.path,
                    observation(intent.path, raw),
                  ) === publicationGuardComparison(receipt, intent.path, expected[intent.path])
                ) {
                  const marker = yield* Effect.try({
                    try: () =>
                      publicationMarker({
                        properties: {
                          Publication: {
                            type: "rich_text",
                            ...property(property(property(intent.body).properties).Publication),
                          },
                        },
                      }),
                    catch: () => fail("STATE_CORRUPT", "The saved publication marker is invalid."),
                  })
                  const integrity = yield* store.integrity.inspect(operationId)
                  const terminalCommit =
                    !options.modeOnly && !options.newArtifact
                      ? terminalPublicationCommitCandidate(
                          receipt,
                          integrity,
                          metadata(raw),
                          publicationMarker,
                        )
                      : undefined
                  if (terminalCommit && receipt.intents[terminalCommit.intent_index] === intent) {
                    terminalCommitIndex = terminalCommit.intent_index
                    continue
                  }
                  if (
                    !marker ||
                    marker.state !== "writing" ||
                    marker.operation_id !== operationId ||
                    marker.intended_hash !== integrity?.intended_hash ||
                    integrity.page_id !== receipt.page_id
                  )
                    return yield* Effect.fail(
                      fail(
                        "WRITE_CONFLICT",
                        "The retained writing-marker intent differs from this publication's original integrity authority.",
                      ),
                    )
                  propertyRetries.push(intent)
                  continue
                }
                if (
                  originalNativeReferencesRegistration(receipt, intent) &&
                  publicationGuardComparison(
                    receipt,
                    intent.path,
                    observation(intent.path, raw),
                  ) === publicationGuardComparison(receipt, intent.path, expected[intent.path])
                ) {
                  propertyRetries.push(intent)
                  continue
                }
                if (!intent.path.endsWith("/markdown"))
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "The pending mutation has no safe deterministic reconciliation.",
                      { path: intent.path },
                    ),
                  )
                if (intent === correctedReplay || intent === recordedReplay) {
                  if (pageMarkdown(raw) !== expected[intent.path])
                    return yield* Effect.fail(
                      fail(
                        "WRITE_CONFLICT",
                        "The retained no-effect Markdown preimage changed before its successor.",
                      ),
                    )
                  markdownRetries.push({ intent, corrected: intent === correctedReplay })
                  continue
                }
                const body = property(intent.body)
                const before = expected[intent.path]
                const updates = property(body.update_content).content_updates
                const replacement =
                  body.type === "replace_content"
                    ? property(body.replace_content).new_str
                    : typeof before === "string" &&
                        Array.isArray(updates) &&
                        updates.length === 1 &&
                        property(updates[0]).old_str === before
                      ? property(updates[0]).new_str
                      : undefined
                if (typeof replacement !== "string")
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "The pending Markdown target cannot be proven from the saved state.",
                    ),
                  )
                const actual = pageMarkdown(raw)
                const converged = yield* readPublicationMarkdownMatches(
                  intent,
                  actual,
                  replacement,
                  api,
                  readPhase,
                )
                if (converged) expected[intent.path] = actual
                if (converged) {
                  const metadataPath = intent.path.slice(0, -"/markdown".length)
                  const known = property(expected[metadataPath])
                  const latest = property(metadata(yield* api.request(metadataPath)))
                  if (
                    publicationGuardComparison(receipt, metadataPath, metadataContent(known)) !==
                    publicationGuardComparison(receipt, metadataPath, metadataContent(latest))
                  )
                    return yield* Effect.fail(
                      fail(
                        "WRITE_CONFLICT",
                        "Metadata changed alongside the pending Markdown write.",
                        { path: metadataPath },
                      ),
                    )
                  for (const item of Object.values(property(known.properties)).map(property)) {
                    if (
                      item.type === "files" &&
                      Array.isArray(item.files) &&
                      item.files.some((file) => typeof property(file).id !== "string")
                    )
                      return yield* Effect.fail(
                        fail(
                          "PUBLICATION_UNRESOLVED",
                          "A pending body write changed the revision of attachments without stable IDs.",
                        ),
                      )
                  }
                  expected[metadataPath] = latest
                  if (
                    body.type === "replace_content" &&
                    typeof before === "string" &&
                    before.trimStart().startsWith(MARKDOWN_FILES_MARKER) &&
                    !replacement.includes(MARKDOWN_FILES_MARKER) &&
                    Object.values(expected).some((value) => {
                      const block = property(value)
                      const parent = property(block.parent)
                      const spans = property(block.paragraph).rich_text
                      return (
                        block.type === "paragraph" &&
                        parent.type === "page_id" &&
                        parent.page_id === intent.path.split("/")[2] &&
                        Array.isArray(spans) &&
                        spans
                          .map((span) => String(property(property(span).text).content ?? ""))
                          .join("")
                          .startsWith(MARKDOWN_FILES_MARKER)
                      )
                    })
                  ) {
                    // Only the proven whole-root conversion retires its old
                    // concrete literal blocks. Child pages remain live authority.
                    const replacedPage = intent.path.split("/")[2]!
                    const prior = copy(expected)
                    for (const guardPath of Object.keys(prior)) {
                      const owner = /^v1\/blocks\/([^/]+)(?:\/children\?.*)?$/.exec(guardPath)?.[1]
                      if (!owner || owner === replacedPage) continue
                      let blockId: string | undefined = owner
                      const seen = new Set<string>()
                      while (blockId && !seen.has(blockId)) {
                        if (blockId === replacedPage) {
                          delete expected[guardPath]
                          break
                        }
                        seen.add(blockId)
                        const block = property(prior[`v1/blocks/${blockId}`])
                        if (block.type === "child_page") break
                        const parent = property(block.parent)
                        blockId =
                          typeof parent.page_id === "string"
                            ? parent.page_id
                            : typeof parent.block_id === "string"
                              ? parent.block_id
                              : undefined
                      }
                    }
                  }
                } else if (actual !== expected[intent.path])
                  return yield* Effect.fail(
                    fail(
                      "WRITE_CONFLICT",
                      "Pending Markdown differs from both the known state and its deterministic target.",
                      { path: intent.path },
                    ),
                  )
                else if (intent.typed_links?.state === "pending")
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "The typed-link Markdown mutation has not converged; automatic replay is forbidden.",
                      { path: intent.path },
                    ),
                  )
                else {
                  if (!pendingMarkdownReplayCandidate(receipt, intent, actual))
                    return yield* Effect.fail(
                      fail(
                        "PUBLICATION_UNRESOLVED",
                        "Unapplied Markdown lacks a bounded exact original replacement retry.",
                      ),
                    )
                  markdownRetries.push({ intent, corrected: false })
                }
              }
              // Re-read every retained page, complete References property and child inventory before any write.
              for (const [path, value] of Object.entries(expected)) {
                if (!roles.ownedMutationTargets.has(path)) continue
                if (!/^v1\/pages\/[^/]+$/.test(path)) continue
                if (!(path + "/markdown" in expected))
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "A known page has no retained body observation.",
                      { path },
                    ),
                  )
                const page = property(value)
                for (const item of Object.values(property(page.properties)).map(property)) {
                  if (
                    item.type !== "files" ||
                    !Array.isArray(item.files) ||
                    item.files.length === 0
                  )
                    continue
                  if (
                    typeof page.last_edited_time !== "string" &&
                    item.files.some((file) => typeof property(file).id !== "string")
                  )
                    return yield* Effect.fail(
                      fail(
                        "PUBLICATION_UNRESOLVED",
                        "Attachment identity has neither a stable file ID nor a server edit revision.",
                        { path },
                      ),
                    )
                }
                const references =
                  Object.values(property(page.properties))
                    .map(property)
                    .some((item) => item.type === "rich_text" && item.id === "references") ||
                  "References" in property(page.properties)
                if (path === rootPath) {
                  for (const item of [property(property(page.properties).References)]) {
                    if (!Array.isArray(item.rich_text)) continue
                    for (const entry of item.rich_text) {
                      const mention = property(property(entry).mention)
                      const linked = property(property(property(entry).text).link).url
                      const id =
                        mention.type === "page"
                          ? pageId(String(property(mention.page).id))
                          : typeof linked === "string"
                            ? pageId(linked)
                            : undefined
                      if (
                        id &&
                        (!(`v1/pages/${id}` in expected) ||
                          !(`v1/pages/${id}/markdown` in expected))
                      )
                        return yield* Effect.fail(
                          fail(
                            "PUBLICATION_UNRESOLVED",
                            "A registered reference has incomplete retained observations.",
                          ),
                        )
                    }
                  }
                }
                if (
                  !options.modeOnly &&
                  references &&
                  !(`v1/blocks/${path.split("/")[2]}/children?page_size=100` in expected) &&
                  !(path === rootPath && (yield* proveOriginalCreateRootInventory(receipt, api)))
                )
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "Reference child inventory was not fully observed.",
                      { path },
                    ),
                  )
              }
              for (const [path, value] of Object.entries(expected)) {
                const actual = observation(path, yield* api.request(path))
                if (
                  publicationGuardComparison(receipt, path, actual) !==
                  publicationGuardComparison(receipt, path, value)
                )
                  return yield* Effect.fail(
                    fail(
                      "WRITE_CONFLICT",
                      "Remote publication state changed outside this operation.",
                      { path },
                    ),
                  )
              }
              if (options.modeOnly) {
                if (receipt.operation !== "write" || !receipt.context?.ownership)
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "Mode recovery requires its frozen write ownership.",
                    ),
                  )
                for (const intent of receipt.intents.filter(
                  (item) =>
                    !isUploadIntent(item) &&
                    unresolvedIntent(item) &&
                    !propertyRetries.includes(item) &&
                    !appliedMetadata.has(item),
                )) {
                  if (
                    intent.path !== rootPath ||
                    intent.method !== "PATCH" ||
                    !isPublicationMetadataIntent(receipt, intent)
                  )
                    return yield* Effect.fail(
                      fail(
                        "PUBLICATION_UNRESOLVED",
                        "Mode recovery cannot replay a content, child, upload, or unrelated property intent.",
                      ),
                    )
                  intent.response = {
                    ...property(intent.response),
                    prior_status: intent.status,
                    recovery: "known_not_applied",
                    replayed_by_intent: receipt.intents.length,
                  }
                  intent.status = "failed"
                }
              }
              const retainedCandidate =
                options.newArtifact && !options.modeOnly && retainedCertificates.length === 0
                  ? retainedUnusableUploadCandidate(receipt, metadata(readPhase.raw[rootPath]))
                  : undefined
              if (retainedCandidate) {
                const lifecycle = property(
                  yield* api.request(`v1/file_uploads/${retainedCandidate.upload_id}`),
                )
                if (
                  lifecycle.id === retainedCandidate.upload_id &&
                  ["expired", "failed"].includes(String(lifecycle.status))
                ) {
                  const retained = yield* proveRetainedUploadReplacement(receipt, api, readPhase)
                  for (const index of [
                    retained.allocation_index,
                    retained.send_index,
                    ...(retained.files_intent_index === undefined
                      ? []
                      : [retained.files_intent_index]),
                  ])
                    receipt.intents[index]!.recovery = retained
                  // Persist the decision before any independent allocation. The
                  // old requests, outcomes and response bytes stay unchanged.
                  yield* store.writeJson(keyFor(operationId), copy(receipt))
                }
              }
              yield* recoverUploadIntents(receipt, options)
              if (terminalCommitIndex !== undefined) {
                const proof = yield* proveUnappliedPublicationCommit(receipt, api, readPhase)
                if (proof.intent_index !== terminalCommitIndex)
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "The terminal commit identity changed before retry.",
                    ),
                  )
                const original = receipt.intents[terminalCommitIndex]!
                original.response = {
                  prior_status: "unknown",
                  recovery: "known_not_applied",
                  replayed_by_intent: receipt.intents.length,
                }
                original.status = "failed"
                yield* store.writeJson(keyFor(operationId), copy(receipt))
                yield* session.notion.request(original.path, original.body, { method: "PATCH" })
                const committed = yield* openSkill(receipt.page_id, {
                  database: receipt.database_id,
                  refresh: true,
                }).pipe(Effect.provideService(Notion, session.notion))
                const current = yield* session.notion.request(rootPath)
                if (canonical(publicationMarker(current)) !== canonical(proof.marker))
                  return yield* Effect.fail(
                    fail(
                      "WRITE_CONFLICT",
                      "The retried terminal commit differs from its original durable marker.",
                    ),
                  )
                for (const path of Object.keys(receipt.guards)) yield* session.notion.request(path)
                // The normal reader verified the exact committed manifest. No
                // business/attachment continuation belongs after this final ACK.
                receipt.state = "completed"
                return {
                  ...snapshotInfo(committed),
                  operation: receipt.operation,
                  resumed: true,
                  verified: true,
                } as A
              }
              for (const intent of receipt.intents) {
                if (
                  !isUploadIntent(intent) &&
                  unresolvedIntent(intent) &&
                  !propertyRetries.includes(intent) &&
                  !markdownRetries.some((retry) => retry.intent === intent) &&
                  !blockRetries.some((retry) => retry.intent === intent)
                ) {
                  intent.response = {
                    ...property(intent.response),
                    prior_status: intent.status,
                    recovery: "observed_applied",
                  }
                  intent.status = "completed"
                }
              }
              receipt.guards = expected
              if (receipt.intents.some((intent) => intent.recovery?.kind === "retained_unusable"))
                yield* proveRetainedUploadReplacement(receipt, api, readPhase)
              receipt.state = "running"
              yield* store.writeJson(keyFor(operationId), copy(receipt))
              for (const { intent, corrected } of markdownRetries) {
                if (corrected) {
                  // The stored correction is history. Fresh source, ledger and
                  // every exact empty-page guard must still prove this send.
                  const proof = yield* proveObservedMarkdownNoEffect(receipt, api, "replay")
                  if (
                    proof.candidate.bodyPath !== intent.path ||
                    canonical(proof.candidate.intent.body) !== canonical(intent.body)
                  )
                    return yield* Effect.fail(
                      fail(
                        "PUBLICATION_MARKDOWN_CORRECTION_UNPROVEN",
                        "The original corrected request changed before its successor.",
                      ),
                    )
                } else if (intent.status === "pending" || intent.status === "unknown") {
                  intent.response = {
                    prior_status: intent.status,
                    recovery: "known_not_applied",
                    replayed_by_intent: receipt.intents.length,
                  }
                  intent.status = "failed"
                  yield* store.writeJson(keyFor(operationId), copy(receipt))
                } else if (terminalRecordedMarkdownReplay(receipt) !== intent)
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "The recorded no-effect successor index changed.",
                    ),
                  )
                // The old history stays intact. The ordinary session records a
                // new pending intent before transport and keeps its real result.
                yield* session.notion.request(intent.path, intent.body, { method: "PATCH" })
              }
              for (const { intent, skip } of blockRetries) {
                intent.response = {
                  ...property(intent.response),
                  prior_status: intent.status,
                  recovery: "known_not_applied",
                  ...(skip
                    ? { superseded_by: "canonical_code_language" }
                    : { replayed_by_intent: receipt.intents.length }),
                }
                intent.status = "failed"
                yield* store.writeJson(keyFor(operationId), copy(receipt))
                if (!skip)
                  yield* session.notion.request(intent.path, intent.body, { method: intent.method })
              }
              const files: { path: string; bytes: Uint8Array }[] = []
              for (const file of receipt.portable.files) {
                const bytes = yield* store.readBytes(`objects/${file.sha256}`)
                if ((yield* sha256(bytes)) !== file.sha256)
                  return yield* Effect.fail(
                    fail("STATE_CORRUPT", "Frozen publication object failed its content hash.", {
                      path: file.path,
                    }),
                  )
                files.push({ path: file.path, bytes })
              }
              if (!options.modeOnly)
                yield* session.run(
                  "resume_code_languages",
                  restoreAcknowledgedCodeLanguages(
                    receipt,
                    { ...receipt.portable, files },
                    session.notion,
                  ),
                )
              for (const intent of propertyRetries) {
                if (intent.recovery?.kind === "retained_unusable") continue
                const immediateReplay = Object.keys(
                  property(property(intent.body).properties),
                ).includes("Publication")
                intent.response = {
                  ...property(intent.response),
                  prior_status: "unknown",
                  recovery: "known_not_applied",
                  ...(immediateReplay ? { replayed_by_intent: receipt.intents.length } : {}),
                }
                intent.status = "failed"
                yield* store.writeJson(keyFor(operationId), copy(receipt))
                if (immediateReplay)
                  yield* session.notion.request(intent.path, intent.body, { method: intent.method })
              }
              for (const intent of receipt.intents) {
                if (intent.typed_links?.state !== "pending") continue
                if (
                  intent.status !== "completed" ||
                  intent.path !== `v1/pages/${intent.typed_links.page_id}/markdown`
                )
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_UNRESOLVED",
                      "Typed-link repair requires its acknowledged original Markdown target.",
                      { path: intent.path },
                    ),
                  )
                yield* restoreMarkdownBlocks(
                  intent.typed_links.page_id,
                  intent.typed_links.markdown,
                  session.notion,
                )
                yield* restoreTypedLinks(
                  intent.typed_links.page_id,
                  intent.typed_links.markdown,
                  session.notion,
                )
                intent.typed_links.state = "completed"
                yield* store.writeJson(keyFor(operationId), copy(receipt))
                yield* restoreOrderedListStart(
                  intent.typed_links.page_id,
                  intent.typed_links.markdown,
                  session.notion,
                )
              }
              if (receipt.context?.write_path === "@properties") {
                yield* store.writeJson(keyFor(operationId), copy(receipt))
                const current = yield* openSkill(receipt.page_id, {
                  database: receipt.database_id,
                  refresh: true,
                }).pipe(
                  Effect.provideService(Notion, session.notion),
                  Effect.provideService(PublicationReadOperation, operationId),
                )
                return {
                  ...snapshotInfo(current),
                  operation: "update",
                  resumed: true,
                  verified: true,
                } as A
              }

              yield* store.writeJson(keyFor(operationId), copy(receipt))
              const resumed = yield* continuation(
                { ...receipt.portable, files },
                receipt.page_id,
                receipt.database_id!,
                session,
                receipt.operation,
                receipt.context,
              ).pipe(Effect.provideService(Notion, session.notion))
              return { ...resumed, operation: receipt.operation, resumed: true }
            }),
          ),
        )
      }),
    )
  })
}

/** This continuation repairs only a derived field. It deliberately never calls
 * Publication.finish and never clears a fence or enters ordinary publication. */
export function resumePublicationListRepair(operationId: string, options: PublicationOptions = {}) {
  return Effect.gen(function* () {
    if (!/^p_[a-zA-Z0-9-]{1,100}$/.test(operationId))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Invalid publication operation ID."))
    const store = yield* Store
    const api = yield* Notion
    return yield* withLocalLocks(
      store.root,
      [`publication:${operationId}`],
      Effect.gen(function* () {
        const receipt = yield* store.readJson(keyFor(operationId), ReceiptSchema)
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
        const normalRepair =
          !receipt.conflict && receipt.intents.some((intent) => intent.list_start_repair)
        const proof = yield* provePublicationListRepair(receipt, api, normalRepair)
        const persist = () => store.writeJson(keyFor(operationId), copy(receipt))
        return yield* Effect.acquireUseRelease(
          Effect.gen(function* () {
            receipt.owner = { pid: process.pid, host: hostname() }
            yield* persist()
          }),
          () =>
            Effect.gen(function* () {
              const result = yield* Effect.gen(function* () {
                if (proof.outcome === "before") {
                  if (proof.intent_index !== undefined) {
                    const original = receipt.intents[proof.intent_index]!
                    // The immutable request and preimages remain in the journal. A
                    // successor, not a status reset, records the newly authorized send.
                    if (property(original.response).recovery !== "known_not_applied") {
                      original.response = {
                        ...property(original.response),
                        prior_status: original.status,
                        recovery: "known_not_applied",
                        replayed_by_intent: receipt.intents.length,
                      }
                      original.status = "failed"
                      yield* persist()
                    }
                  }
                  const session = yield* publicationSession(receipt, options)
                  yield* session.run(
                    "list_start_repair",
                    session.notion.request(
                      `v1/blocks/${proof.repair.block_id}`,
                      listStartRepairBody(),
                      { method: "PATCH" },
                    ),
                  )
                }
                const after = yield* provePublicationListRepair(receipt, api, normalRepair)
                if (after.outcome !== "applied" || after.intent_index === undefined)
                  return yield* Effect.fail(
                    fail(
                      "PUBLICATION_LIST_REPAIR_UNPROVEN",
                      "The original list correction has not been proven applied.",
                    ),
                  )
                const repaired = receipt.intents[after.intent_index]!
                if (repaired.status !== "completed") {
                  if (repaired.status !== "pending" && repaired.status !== "unknown")
                    return yield* Effect.fail(
                      fail(
                        "PUBLICATION_LIST_REPAIR_UNPROVEN",
                        "Only an unresolved list send may acquire an observed-applied result.",
                      ),
                    )
                  repaired.response = {
                    ...property(repaired.response),
                    id: after.repair.block_id,
                    prior_status: repaired.status,
                    recovery: "observed_applied",
                    proof_kind: "list_start_repair_v1",
                  }
                  repaired.status = "completed"
                }
                // Advance only the proven effect and its owner revision/body. Every
                // other root and original guard remains the retained checkpoint.
                const owner = `v1/pages/${after.repair.page_id}`
                for (const path of [
                  `v1/blocks/${after.repair.block_id}`,
                  owner,
                  `${owner}/markdown`,
                ])
                  receipt.guards[path] = copy(after.observed[path])
                receipt.state = receipt.conflict ? "failed" : "running"
                if (!receipt.stages.includes("list_start_repair_verified"))
                  receipt.stages.push("list_start_repair_verified")
                yield* persist()
                return {
                  operation_id: operationId,
                  verified: false,
                  repair_applied: true,
                  next: {
                    argv: ["ntn-skills", "operation", "reconcile", operationId],
                    reason:
                      "The original list field is repaired; a strict read-only reassessment must validate the retained publication.",
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
              yield* persist()
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
