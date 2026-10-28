import { publicationZeroListCandidates } from "./publication-zero-list-history.ts"
import { retainedUploadCertificates } from "./publication-retained-upload.ts"
import { Clock, Crypto, Effect } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { Store, sha256 } from "./store.ts"
import { childPageTags, pageMarkdown, rewritePageLinks } from "./references.ts"
import type { PortableSkill } from "./portable.ts"
import { BUNDLE, bodyIdentity } from "./portable.ts"
import { fileRef, pageId } from "./ref.ts"
import { hostname } from "node:os"
import { restoreMarkdownBlocks, restoreOrderedListStart } from "./markdown-blocks.ts"
import { hasTypedLinks, readLinkBlocks, restoreTypedLinks } from "./typed-links.ts"
import { markdownIdentity } from "./markdown.ts"
import {
  commitPublicationIntegrity,
  preparePublicationIntegrity,
  preparedPublicationMarker,
  publicationProperties,
  publicationMarker,
  PublicationReadOperation,
  startPublicationIntegrity,
  publicationOwnership,
} from "./publication-integrity.ts"
import { openSkill, snapshotInfo } from "./snapshot.ts"
import type { ManagedContent } from "./upstream-model.ts"
import { unresolvedIntent, publicationUpload, verifyAttachedUpload } from "./publication-upload.ts"
import { publicationMutationGuards } from "./publication-guard-check.ts"
import { Path, type FileSystem } from "effect"
import type { HttpClient } from "effect/http"
import { PublicationReceiptSchema as ReceiptSchema, type Receipt } from "./publication-model.ts"
import {
  canonical,
  copy,
  keyFor,
  metadata,
  metadataContent,
  capturePublicationRead,
  publicationReadPhase,
  readPublicationMarkdownMatches,
  publicationPropertiesMatch,
  observation,
  publicationGuardRoles,
} from "./publication-observation.ts"
import { creationMarkerBlock, prepareCreationProof } from "./publication-create-identity.ts"
import { isListStartRepairBody, provePublicationListRepair } from "./publication-list-repair.ts"
import {
  authorizeContentAdoptionMutation,
  verifyContentAdoptionReadback,
} from "./upstream-content-adoption.ts"
import {
  bindPublicationSource,
  initialPublicationSource,
  isPublicationMetadataIntent,
  isPublicationMetadataRequest,
  publicationGuardComparison,
  publicationMetadataMatches,
  publicationMetadataProperties,
  verifyPublicationMetadata,
} from "./publication-source.ts"
import type {
  PublicationSource,
  PublicationSourceIntent,
  PublicationSourceBinding,
} from "./publication-model.ts"

export interface PublicationProgress {
  readonly operation_id: string
  readonly stage: string
  readonly status: "started" | "completed" | "failed"
  readonly elapsed_ms: number
  readonly stage_ms: number
}
export interface PublicationOptions {
  readonly onProgress?: (event: PublicationProgress) => Effect.Effect<void, SkillsError>
  readonly operationId?: string
  readonly ownership?: NonNullable<ManagedContent["ownership"]>
  readonly source?: PublicationSource
  /** Internal supersede handoff: omission inside this value preserves historical absence. */
  readonly retainedSource?: {
    readonly intent?: PublicationSourceIntent
    readonly binding?: PublicationSourceBinding
  }
  readonly newArtifact?: boolean
  readonly modeOnly?: boolean
  readonly supersedePlanId?: string
  readonly retryMetadata?: boolean
}
export interface PublicationContext {
  readonly content_adoption?: { readonly plan_id: string; readonly plan_hash: string }
  readonly markdown_files?: boolean
  readonly write_path?: string
  readonly previous_version_id?: string
  readonly input_type?: "directory" | "zip" | "markdown"
  readonly main_path?: string
  readonly members?: readonly string[]
  /** Frozen rebuild opt-in. Ordinary create and apply omit it and keep name uniqueness. */
  readonly allow_same_name?: boolean
  /** Exact member page checkbox. Ordinary create and apply omit it. */
  readonly default_context?: boolean
  readonly source_intent?: PublicationSourceIntent
}
type Intent = Receipt["intents"][number]

function retainedChildInventory(guards: Receipt["guards"], parent: string) {
  const base = `v1/blocks/${parent}/children?page_size=100`
  const saved: Record<string, unknown>[] = []
  const paths = new Set(
    Object.keys(guards).filter((path) => path === base || path.startsWith(`${base}&start_cursor=`)),
  )
  let path = base
  while (paths.delete(path)) {
    const page = property(guards[path])
    if (!Array.isArray(page.results) || typeof page.has_more !== "boolean")
      throw fail("WRITE_CONFLICT", "The retained child inventory is invalid.", { path })
    saved.push(...page.results.map(property))
    if (!page.has_more) {
      if (page.next_cursor != null || paths.size > 0)
        throw fail("WRITE_CONFLICT", "The retained child inventory has orphaned pagination.", {
          path,
        })
      break
    }
    if (typeof page.next_cursor !== "string" || !page.next_cursor)
      throw fail("WRITE_CONFLICT", "The retained child inventory has no next cursor.", { path })
    path = `${base}&start_cursor=${encodeURIComponent(page.next_cursor)}`
  }
  if (paths.size > 0 || property(guards[path]).has_more !== false)
    throw fail("WRITE_CONFLICT", "The retained child inventory is incomplete.", { path: base })
  return saved
}
export interface Publication {
  readonly operationId: string
  readonly receiptPath: string
  readonly notion: Notion["Service"]
  readonly upload: (
    input: { bytes: Uint8Array },
    filename: string,
  ) => Effect.Effect<
    { name: string; type: "file_upload"; file_upload: { id: string } },
    SkillsError,
    Path.Path
  >
  readonly run: <A, E, R>(
    stage: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SkillsError, R>
  readonly validate: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SkillsError, R>
  readonly authorize: (
    path: string,
    body: unknown,
    scope: string,
    observations: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void, SkillsError>
  readonly bind: (
    source: { database_id: string; data_source_id: string; page_id?: string },
    scope: string,
  ) => Effect.Effect<void, SkillsError>
  readonly metadataUnchanged: () => Effect.Effect<boolean, SkillsError>
  readonly finish: <A extends object, E extends SkillsError, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A & { operation_id: string; receipt_path?: string }, E | SkillsError, R>
}

export function beginPublication(
  portable: PortableSkill,
  operation: Receipt["operation"],
  options: PublicationOptions = {},
  context?: PublicationContext,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const crypto = yield* Crypto.Crypto
    const id =
      options.operationId ??
      `p_${yield* crypto
        .randomUUIDv4()
        .pipe(
          Effect.mapError(() => fail("CRYPTO_ERROR", "Could not allocate a publication identity.")),
        )}`
    if (!/^p_[a-zA-Z0-9-]{1,100}$/.test(id))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Invalid publication operation ID."))
    const existing = yield* store.readJson(keyFor(id), ReceiptSchema)
    if (existing)
      return yield* Effect.fail(
        fail(
          "PUBLICATION_EXISTS",
          "This publication identity already has an intent; reconcile or resume it instead of replaying.",
          { operation_id: id },
        ),
      )
    if (options.retainedSource !== undefined) {
      const claim = property(
        options.supersedePlanId
          ? yield* store.upstream.command(`publication-supersede:plan:${options.supersedePlanId}`)
          : undefined,
      )
      const plan = property(claim.plan)
      const original =
        typeof plan.old_operation_id === "string"
          ? yield* store.readJson(keyFor(plan.old_operation_id), ReceiptSchema)
          : undefined
      if (
        claim.state !== "applying" ||
        plan.new_operation_id !== id ||
        !original ||
        canonical(options.retainedSource) !==
          canonical({ intent: original.context?.source_intent, binding: original.source_binding })
      )
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UNRESOLVED",
            "Frozen source handoff requires the exact claimed supersede receipt.",
          ),
        )
    }
    const sourceIntent =
      options.retainedSource !== undefined
        ? options.retainedSource.intent
        : yield* Effect.try({
            try: () => initialPublicationSource(operation, options.source, options.ownership),
            catch: () => fail("INVALID_ARGUMENT", "Invalid or contradictory publication source."),
          })
    yield* preparePublicationIntegrity(id, portable)
    const files: Receipt["portable"]["files"] = []
    for (const file of portable.files) {
      const hash = yield* sha256(file.bytes)
      yield* store.writeBytes(`objects/${hash}`, file.bytes)
      files.push({ path: file.path, sha256: hash })
    }
    return yield* publicationSession(
      {
        format: 1,
        operation_id: id,
        operation,
        context: {
          ...context,
          ...(options.ownership ? { ownership: options.ownership } : {}),
          ...(sourceIntent ? { source_intent: sourceIntent } : {}),
        },
        ...(options.retainedSource?.binding
          ? { source_binding: options.retainedSource.binding }
          : {}),
        state: "prepared",
        portable: {
          kind: portable.kind,
          name: portable.name,
          description: portable.description,
          main: portable.main,
          files,
        },
        guards: {},
        intents: [],
        stages: [],
      },
      options,
    )
  })
}
export function progressPublication(
  options: PublicationOptions = {},
  operation: Receipt["operation"] = "replace",
  context?: PublicationContext,
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const sourceIntent =
      options.retainedSource !== undefined
        ? options.retainedSource.intent
        : yield* Effect.try({
            try: () => initialPublicationSource(operation, options.source, options.ownership),
            catch: () => fail("INVALID_ARGUMENT", "Invalid or contradictory publication source."),
          })
    const id = `p_${yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(() => fail("CRYPTO_ERROR", "Could not allocate a publication identity.")),
      )}`
    return yield* publicationSession(
      {
        format: 1,
        operation_id: id,
        operation,
        context: {
          ...context,
          ...(options.ownership ? { ownership: options.ownership } : {}),
          ...(sourceIntent ? { source_intent: sourceIntent } : {}),
        },
        ...(options.retainedSource?.binding
          ? { source_binding: options.retainedSource.binding }
          : {}),
        state: "prepared",
        portable: { kind: "skill", name: "", description: "", main: "", files: [] },
        guards: {},
        intents: [],
        stages: [],
      },
      options,
      true,
    )
  })
}
export function publicationSession(receipt: Receipt, options: PublicationOptions, dry = false) {
  return Effect.gen(function* () {
    const transport = yield* Notion
    let readPhase = publicationReadPhase()
    const api: Notion["Service"] = {
      ...transport,
      request: (path, body, requestOptions) =>
        Effect.gen(function* () {
          const method = requestOptions?.method ?? (body === undefined ? "GET" : "POST")
          if (method !== "GET" && path !== "v1/search" && !path.endsWith("/query"))
            readPhase = publicationReadPhase()
          const raw = yield* transport.request(path, body, requestOptions)
          if (method === "GET") capturePublicationRead(readPhase, path, raw)
          return raw
        }),
    }
    const store = yield* Store
    const authorizationContext = yield* Effect.context<Store | Notion | Crypto.Crypto>()
    const uploadContext = yield* Effect.context<
      Store | Notion | Crypto.Crypto | HttpClient.HttpClient
    >()
    const integrityContext = yield* Effect.context<
      Store | Notion | Crypto.Crypto | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
    >()
    const started = yield* Clock.monotonicTimeNanos
    const receiptPath = keyFor(receipt.operation_id)
    let bound = Boolean(receipt.scope)
    let validationGuards: Receipt["guards"] | undefined
    let integrityMutation = false
    let integrityStarted = receipt.intents.some((intent) =>
      Object.keys(property(property(intent.body).properties)).includes("Publication"),
    )
    let uploadArtifact: Intent["artifact"]
    let graphCheckNeeded = false
    // Coverage belongs to one read proof and one expected baseline, never write authority.
    const phaseReads = new Set<string>()
    let authorization:
      | { path: string; body: unknown; scope: string; guards: Receipt["guards"] }
      | undefined
    const persist = () =>
      bound && !dry ? store.writeJson(receiptPath, copy(receipt)) : Effect.void
    const remember = (path: string, raw: unknown) =>
      Effect.gen(function* () {
        const observed = yield* Effect.try({
          try: () => observation(path, raw),
          catch: (error) =>
            error instanceof SkillsError
              ? error
              : fail("INVALID_RESPONSE", "Invalid publication observation."),
        })
        if (observed !== undefined) {
          if (validationGuards) validationGuards[path] = copy(observed)
          else {
            receipt.guards[path] = copy(observed)
            yield* persist()
          }
        }
      })
    const rememberRevision = (path: string, raw: unknown) =>
      Effect.gen(function* () {
        const known = property(receipt.guards[path])
        const latest = property(metadata(raw))
        if (
          publicationGuardComparison(receipt, path, metadataContent(known)) !==
          publicationGuardComparison(receipt, path, metadataContent(latest))
        )
          return yield* Effect.fail(
            fail("WRITE_CONFLICT", "Metadata changed alongside this publication write.", { path }),
          )
        yield* remember(path, raw)
      })
    const verifyGuards = (paths: Iterable<string>, completePhase = false) =>
      Effect.gen(function* () {
        for (const guardPath of paths) {
          if (completePhase && phaseReads.has(guardPath)) continue
          if (!(guardPath in receipt.guards))
            return yield* Effect.fail(
              fail(
                "PUBLICATION_UNRESOLVED",
                "Mutation target has no retained original observation.",
                {
                  path: guardPath,
                },
              ),
            )
          const actual = observation(guardPath, yield* api.request(guardPath))
          if (
            publicationGuardComparison(receipt, guardPath, actual) !==
            publicationGuardComparison(receipt, guardPath, receipt.guards[guardPath])
          )
            return yield* Effect.fail(
              fail("WRITE_CONFLICT", "Remote state changed before the next publication mutation.", {
                path: guardPath,
              }),
            )
          if (completePhase) phaseReads.add(guardPath)
        }
      })
    const verifyGraph = () =>
      Effect.gen(function* () {
        yield* verifyGuards(Object.keys(receipt.guards), true)
        graphCheckNeeded = false
      })
    const notion: Notion["Service"] = {
      ...api,
      request: (path, body, requestOptions) =>
        Effect.gen(function* () {
          const method = requestOptions?.method ?? (body === undefined ? "GET" : "POST")
          if (method === "GET" || path === "v1/search" || path.endsWith("/query")) {
            const response = yield* api.request(path, body, requestOptions)
            const observed = observation(path, response)
            if (
              bound &&
              !validationGuards &&
              path in receipt.guards &&
              observed !== undefined &&
              publicationGuardComparison(receipt, path, observed) !==
                publicationGuardComparison(receipt, path, receipt.guards[path])
            )
              return yield* Effect.fail(
                fail("WRITE_CONFLICT", "Remote publication state changed outside this operation.", {
                  path,
                }),
              )
            if (bound && !validationGuards && path in receipt.guards && observed !== undefined)
              phaseReads.add(path)
            yield* remember(path, response)
            return response
          }
          if (validationGuards)
            return yield* Effect.fail(
              fail("INTERNAL_ERROR", "Publication validation must be read-only."),
            )
          if (!bound || dry)
            return yield* Effect.fail(
              fail(
                "PUBLICATION_UNBOUND",
                "Publication must be bound before its first remote mutation.",
              ),
            )
          const listRepair =
            /^v1\/blocks\/[^/]+$/.test(path) && method === "PATCH" && isListStartRepairBody(body)
              ? yield* provePublicationListRepair(receipt, api, !receipt.conflict)
              : undefined
          if (receipt.conflict && !listRepair)
            return yield* Effect.fail(
              fail(
                "WRITE_CONFLICT",
                "A fenced publication permits only its independently proven list correction.",
              ),
            )
          const adoptionHandoff = receipt.context?.content_adoption
            ? yield* authorizeContentAdoptionMutation(receipt, path, body, method, api, {
                file: requestOptions?.file,
                artifact: uploadArtifact,
              }).pipe(Effect.provide(integrityContext))
            : false
          if (listRepair) {
            if (
              listRepair.outcome !== "before" ||
              path !== `v1/blocks/${listRepair.repair.block_id}`
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_LIST_REPAIR_UNPROVEN",
                  "The block request is not the original derived list correction.",
                ),
              )
            // Preserve every root as an immutable pre-write guard. The ordinary
            // child-page inventory intentionally does not contain text blocks.
            for (const raw of listRepair.repair.before_roots) {
              const blockPath = `v1/blocks/${String(property(raw).id)}`
              const current = observation(blockPath, raw)
              if (
                blockPath in receipt.guards &&
                canonical(receipt.guards[blockPath]) !== canonical(current)
              )
                return yield* Effect.fail(
                  fail("WRITE_CONFLICT", "List root differs from its retained block guard."),
                )
              yield* remember(blockPath, raw)
            }
          }
          if (receipt.context?.write_path === "@properties" && !integrityMutation) {
            if (
              !authorization ||
              authorization.path !== path ||
              canonical(authorization.body) !== canonical(body) ||
              authorization.scope !== receipt.scope
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_UNRESOLVED",
                  "Property mutation has no matching original authorization.",
                ),
              )
            if ((yield* authScope) !== authorization.scope)
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_SCOPE_MISMATCH",
                  "Property authorization belongs to another authentication scope.",
                ),
              )
            const source = yield* explicitSource(receipt.database_id!)
            if (!source.data_source_ids.includes(receipt.data_source_id!))
              return yield* Effect.fail(
                fail("PUBLICATION_SOURCE_MISMATCH", "Property authorization source changed."),
              )
            for (const [guardPath, expected] of Object.entries(authorization.guards)) {
              const actual = observation(guardPath, yield* api.request(guardPath))
              if (
                publicationGuardComparison(receipt, guardPath, actual) !==
                publicationGuardComparison(receipt, guardPath, expected)
              )
                return yield* Effect.fail(
                  fail(
                    "WRITE_CONFLICT",
                    "Remote state differs from the original property authorization.",
                    { path: guardPath },
                  ),
                )
            }
          }
          const roles = publicationGuardRoles(receipt)
          const pageTarget = /^v1\/pages\/[^/]+/.exec(path)?.[0]
          const parentTarget = property(property(body).parent).page_id
          if (
            (pageTarget && !roles.ownedMutationTargets.has(pageTarget)) ||
            (path === "v1/pages" &&
              typeof parentTarget === "string" &&
              !roles.ownedMutationTargets.has(`v1/pages/${parentTarget}`))
          )
            return yield* Effect.fail(
              fail(
                "PUBLICATION_UNRESOLVED",
                "A read-only dependency is not a publication mutation target.",
                { path },
              ),
            )
          const appendOwner = /^v1\/blocks\/([^/]+)\/children$/.exec(path)?.[1]
          if (appendOwner && (!receipt.context?.markdown_files || method !== "PATCH"))
            return yield* Effect.fail(
              fail("PUBLICATION_UNRESOLVED", "File append requires the exact owned editable page."),
            )
          let blockOwner: string | undefined
          const blockAncestors: string[] = []
          if (/^v1\/blocks\/[^/]+$/.test(path) || appendOwner) {
            let blockId = appendOwner ?? path.split("/")[2]!
            const seen = new Set<string>()
            while (!roles.ownedMutationTargets.has(`v1/pages/${blockId}`)) {
              if (seen.has(blockId))
                return yield* Effect.fail(
                  fail("PUBLICATION_UNRESOLVED", "Block ownership is cyclic.", { path }),
                )
              seen.add(blockId)
              const blockPath = `v1/blocks/${blockId}`
              blockAncestors.push(blockPath)
              const block = yield* api.request(blockPath)
              const observedBlock = observation(blockPath, block)
              if (
                blockPath in receipt.guards &&
                canonical(observedBlock) !== canonical(receipt.guards[blockPath])
              )
                return yield* Effect.fail(
                  fail("WRITE_CONFLICT", "Block content changed before publication repair.", {
                    path: blockPath,
                  }),
                )
              yield* remember(blockPath, block)
              const parent = property(property(block).parent)
              const next = parent.type === "page_id" ? parent.page_id : parent.block_id
              if (typeof next !== "string")
                return yield* Effect.fail(
                  fail("PUBLICATION_UNRESOLVED", "Block has no owned publication parent.", {
                    path,
                  }),
                )
              blockId = next
            }
            blockOwner = `v1/pages/${blockId}`
            for (const ownerPath of [blockOwner, `${blockOwner}/markdown`]) {
              const raw = yield* api.request(ownerPath)
              const observedOwner = observation(ownerPath, raw)
              if (
                ownerPath in receipt.guards &&
                publicationGuardComparison(receipt, ownerPath, observedOwner) !==
                  publicationGuardComparison(receipt, ownerPath, receipt.guards[ownerPath])
              )
                return yield* Effect.fail(
                  fail("WRITE_CONFLICT", "Owned page changed before publication repair.", {
                    path: ownerPath,
                  }),
                )
              yield* remember(ownerPath, raw)
            }
          }
          // Existing traversal provides these inventories. Only unregistered children lack
          // the metadata/body reads already performed by openSkill; fill those holes once.
          for (const [inventoryPath, inventory] of Object.entries(receipt.guards)) {
            if (!inventoryPath.startsWith("v1/blocks/")) continue
            const inventoryOwner = /^v1\/blocks\/([^/]+)\//.exec(inventoryPath)?.[1]
            if (!inventoryOwner || !roles.ownedMutationTargets.has(`v1/pages/${inventoryOwner}`))
              continue
            const children = property(inventory).results
            if (!Array.isArray(children)) continue
            for (const item of children) {
              const child = property(item)
              if (
                typeof child.id !== "string" ||
                !roles.ownedMutationTargets.has(`v1/pages/${child.id}`)
              )
                continue
              for (const childPath of [`v1/pages/${child.id}`, `v1/pages/${child.id}/markdown`]) {
                if (!(childPath in receipt.guards))
                  yield* remember(childPath, yield* api.request(childPath))
              }
            }
          }
          if (/^v1\/pages\/[^/]+$/.test(path) && !(path in receipt.guards))
            yield* remember(path, yield* api.request(path))
          if (
            receipt.context?.write_path === "@properties" &&
            !(path + "/markdown" in receipt.guards)
          )
            yield* remember(path + "/markdown", yield* api.request(path + "/markdown"))
          const guardPaths = integrityMutation
            ? new Set(Object.keys(receipt.guards))
            : publicationMutationGuards(
                receipt,
                path,
                body,
                roles.ownedMutationTargets,
                blockOwner,
                blockAncestors,
              )
          yield* verifyGuards(guardPaths)
          if (guardPaths.size < Object.keys(receipt.guards).length) graphCheckNeeded = true
          // Content ownership is independent of read freshness and publication integrity.
          // Use the same validated root guard for native pages, editable files and resumes.
          if (
            receipt.page_id &&
            !receipt.context?.ownership &&
            !integrityMutation &&
            !adoptionHandoff &&
            !listRepair
          ) {
            const rootPath = `v1/pages/${receipt.page_id}`
            const root = receipt.guards[rootPath]
            const owner = yield* Effect.try({
              try: () => publicationOwnership(root),
              catch: (error) => error as SkillsError,
            })
            if (owner.mode === "tracked") {
              const rootFields = property(property(root).properties)
              const requested = property(property(body).properties)
              const organizationOnly =
                method === "PATCH" &&
                path === rootPath &&
                Object.keys(property(body)).length === 1 &&
                Object.keys(requested).length > 0 &&
                Object.keys(requested).every((key) =>
                  ["Default Context", "Tags", "Members"].some(
                    (name) =>
                      rootFields[name] !== undefined &&
                      (key === name || key === property(rootFields[name]).id),
                  ),
                )
              if (!organizationOnly)
                return yield* Effect.fail(
                  fail(
                    "UPSTREAM_CONTENT_READ_ONLY",
                    "Tracked content belongs to its upstream source; fork this member before editing its body, resources, name or description.",
                    {
                      page_id: receipt.page_id,
                      subscription_id: owner.upstream[0],
                      member_key: owner.key,
                    },
                  ),
                )
            }
          }
          const requestedProperties = property(property(body).properties)
          const fields = property(property(receipt.guards[path]).properties)
          const businessProperties =
            Object.keys(property(body)).length === 1 &&
            Object.keys(requestedProperties).length > 0 &&
            Object.entries(requestedProperties).every(([key, value]) => {
              const field = property(
                fields[key] ?? Object.values(fields).find((item) => property(item).id === key),
              )
              return (
                key !== "Publication" &&
                key !== property(fields.Publication).id &&
                field.type !== "files" &&
                !("files" in property(value))
              )
            })
          const attachmentProperties =
            Object.keys(property(body)).length === 1 &&
            Object.entries(requestedProperties).length === 1 &&
            Object.entries(requestedProperties).every(([key, value]) => {
              const field = property(
                fields[key] ?? Object.values(fields).find((item) => property(item).id === key),
              )
              const files = property(value).files
              return (
                field.type === "files" &&
                Array.isArray(files) &&
                files.length === 1 &&
                property(files[0]).type === "file_upload" &&
                typeof property(property(files[0]).file_upload).id === "string"
              )
            })
          const replacement = property(property(body).replace_content).new_str
          if (
            !integrityMutation &&
            method === "PATCH" &&
            ((/^v1\/pages\/[^/]+$/.test(path) && (businessProperties || attachmentProperties)) ||
              (/^v1\/pages\/[^/]+\/markdown$/.test(path) &&
                property(body).type === "replace_content" &&
                typeof replacement === "string"))
          ) {
            const acknowledged = receipt.intents.findLast(
              (intent) =>
                intent.path === path &&
                intent.method === method &&
                canonical(intent.body) === canonical(body) &&
                intent.status === "completed" &&
                !intent.recovery &&
                (property(intent.response).recovery === undefined ||
                  ((attachmentProperties ||
                    isPublicationMetadataRequest(receipt, path, body, method)) &&
                    property(intent.response).recovery === "observed_applied")) &&
                !property(intent.response).superseded_by &&
                !property(intent.response).replayed_by_intent &&
                intent.typed_links?.state !== "pending",
            )
            if (acknowledged) {
              const later = receipt.intents.slice(receipt.intents.indexOf(acknowledged) + 1)
              const last = later[0]
              const sourceAttachment =
                attachmentProperties &&
                Object.values(requestedProperties).some((value) => {
                  const files = property(value).files
                  return Array.isArray(files) && property(files[0]).name === BUNDLE
                })
              // The original create may have stopped after its source attachment
              // and a proven no-effect ownership PATCH. This permits only reuse
              // of that ACK; current guards and the full attachment bytes are
              // still proved below. Normal finish must append ownership again.
              const terminalNoEffectOwnership =
                sourceAttachment &&
                receipt.operation === "create" &&
                !receipt.conflict &&
                path === `v1/pages/${receipt.page_id}` &&
                property(acknowledged.response).id === receipt.page_id &&
                receipt.context?.write_path === undefined &&
                later.length === 1 &&
                last?.method === "PATCH" &&
                last.path === path &&
                last.status === "failed" &&
                !last.recovery &&
                !last.typed_links &&
                !last.artifact &&
                !last.list_start_repair &&
                canonical(last.response) ===
                  canonical({ prior_status: "unknown", recovery: "known_not_applied" }) &&
                isPublicationMetadataIntent(receipt, last)
              if (
                later.some((intent) => {
                  const response = property(intent.response)
                  // Recovery proved this PATCH had no effect. Keep that failed history,
                  // while allowing reuse of earlier fields that still pass the guards below.
                  const noEffectProperty =
                    businessProperties &&
                    !attachmentProperties &&
                    intent.path === path &&
                    intent.method === "PATCH" &&
                    intent.status === "failed" &&
                    !intent.recovery &&
                    !intent.typed_links &&
                    response.prior_status === "unknown" &&
                    response.recovery === "known_not_applied" &&
                    response.superseded_by === undefined &&
                    response.replayed_by_intent === undefined
                  const retainedNoEffectFiles =
                    businessProperties &&
                    !attachmentProperties &&
                    !receipt.conflict &&
                    intent.recovery?.kind === "retained_unusable" &&
                    retainedUploadCertificates(receipt)?.some(({ sequence }) => {
                      const currentField = property(fields[sequence.files_property_name])
                      return (
                        sequence.files_intent_index === receipt.intents.indexOf(intent) &&
                        path === sequence.root_path &&
                        currentField.type === "files" &&
                        currentField.id === sequence.files_property_id &&
                        canonical(currentField.files) === "[]"
                      )
                    }) === true
                  const coveredZeroHistory =
                    !receipt.conflict &&
                    receipt.stages.includes("zero_list_repair_verified") &&
                    publicationZeroListCandidates(receipt).some(
                      (item) => item.intent_index === receipt.intents.indexOf(intent),
                    )
                  return (
                    !noEffectProperty &&
                    !retainedNoEffectFiles &&
                    !coveredZeroHistory &&
                    !(terminalNoEffectOwnership && intent === last) &&
                    (attachmentProperties || intent.path === path) &&
                    (intent.status !== "completed" ||
                      intent.recovery ||
                      (response.recovery !== undefined &&
                        response.recovery !== "observed_applied") ||
                      response.superseded_by ||
                      response.replayed_by_intent ||
                      intent.typed_links?.state === "pending")
                  )
                })
              )
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_UNRESOLVED",
                    "A later mutation requires recovery before reuse.",
                    {
                      path,
                    },
                  ),
                )
              const current = yield* api.request(path)
              const matches =
                publicationGuardComparison(receipt, path, observation(path, current)) ===
                  publicationGuardComparison(receipt, path, receipt.guards[path]) &&
                (path.endsWith("/markdown")
                  ? yield* readPublicationMarkdownMatches(
                      acknowledged,
                      pageMarkdown(current),
                      rewritePageLinks(String(replacement), "", [], "local"),
                      api,
                      readPhase,
                      {
                        local: (markdown) => rewritePageLinks(markdown, "", [], "local"),
                        preserveExternal: (markdown) =>
                          rewritePageLinks(markdown, "", [], "local", [], {
                            preserveExternalUrls: true,
                          }),
                        ...(path === `v1/pages/${receipt.page_id}/markdown`
                          ? {
                              source: {
                                path: receipt.portable.main,
                                files: receipt.portable.files,
                              },
                            }
                          : {}),
                      },
                    )
                  : attachmentProperties
                    ? yield* verifyAttachedUpload(current, acknowledged, receipt).pipe(
                        Effect.provide(integrityContext),
                      )
                    : publicationPropertiesMatch(metadata(current), requestedProperties))
              if (!matches)
                return yield* Effect.fail(
                  fail("WRITE_CONFLICT", "Acknowledged publication content no longer matches.", {
                    path,
                  }),
                )
              return current
            }
          }
          if (!integrityMutation && !integrityStarted) {
            if (adoptionHandoff) {
              // The typed plan and complete read proof authorize only this exact old-marker handoff.
              integrityStarted = true
            } else if (path === "v1/pages" && property(property(body).parent).data_source_id) {
              const marker = yield* preparedPublicationMarker(receipt.operation_id)
              const creation = yield* prepareCreationProof(receipt, body, marker.intended_hash)
              body = {
                ...property(body),
                properties: {
                  ...property(property(body).properties),
                  ...publicationProperties({ ...marker, creation }),
                },
              }
              integrityStarted = true
            } else if (options.supersedePlanId && receipt.page_id) {
              const authorization = property(
                yield* store.upstream.command(
                  `publication-supersede:plan:${options.supersedePlanId}`,
                ),
              )
              const plan = property(authorization.plan)
              const originalIntegrity = property(plan.original_integrity)
              const previous = publicationMarker(receipt.guards[`v1/pages/${receipt.page_id}`])
              const marker = yield* preparedPublicationMarker(receipt.operation_id)
              if (
                authorization.state !== "applying" ||
                plan.target_kind !== "child" ||
                plan.new_operation_id !== receipt.operation_id ||
                plan.parent_id !== receipt.page_id ||
                plan.scope !== receipt.scope ||
                previous?.state !== "writing" ||
                previous.operation_id !== plan.old_operation_id ||
                previous.intended_hash !== originalIntegrity.intended_hash ||
                method !== "PATCH" ||
                path !== `v1/pages/${receipt.page_id}` ||
                canonical(body) !== canonical({ properties: publicationProperties(marker) })
              )
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_UNRESOLVED",
                    "Child marker handoff requires its exact durably claimed supersede plan and original guarded writing marker.",
                  ),
                )
              integrityStarted = true
            } else if (receipt.page_id) {
              integrityMutation = true
              yield* startPublicationIntegrity(receipt.operation_id, receipt.page_id).pipe(
                Effect.provideService(Notion, notion),
                Effect.ensuring(
                  Effect.sync(() => {
                    integrityMutation = false
                  }),
                ),
              )
              integrityStarted = true
              // This operation's marker advances the retained page revision and authorization.
              if (authorization) authorization.guards = copy(receipt.guards)
            }
          }
          if (path === "v1/pages" && typeof property(property(body).parent).page_id === "string") {
            const marker = yield* preparedPublicationMarker(receipt.operation_id)
            const proof = yield* prepareCreationProof(receipt, body, marker.intended_hash)
            body = {
              ...property(body),
              children: [
                creationMarkerBlock(proof),
                ...(Array.isArray(property(body).children)
                  ? (property(body).children as unknown[])
                  : []),
              ],
            }
          }
          const replacementMarkdown = property(property(body).replace_content).new_str
          const markdownUpdates = property(property(body).update_content).content_updates
          const submittedMarkdown =
            typeof replacementMarkdown === "string"
              ? replacementMarkdown
              : Array.isArray(markdownUpdates) && markdownUpdates.length === 1
                ? property(markdownUpdates[0]).new_str
                : undefined
          const inventoryPage =
            path.endsWith("/markdown") && property(body).markdown_version === "v2"
              ? path.split("/")[2]!
              : undefined
          const originalChildren =
            inventoryPage &&
            "References" in
              property(property(receipt.guards[`v1/pages/${inventoryPage}`]).properties)
              ? yield* Effect.try({
                  try: () => retainedChildInventory(receipt.guards, inventoryPage),
                  catch: (error) => error as SkillsError,
                })
              : undefined
          const intent: Intent = {
            path,
            ...(body === undefined ? {} : { body: copy(body) }),
            method,
            status: "pending",
            ...(listRepair ? { list_start_repair: copy(listRepair.repair) } : {}),
            ...(/^v1\/blocks\/[^/]+$/.test(path) ||
            receipt.context?.content_adoption ||
            isPublicationMetadataRequest(receipt, path, body, method)
              ? { guards: copy(receipt.guards) }
              : authorization
                ? { guards: copy(authorization.guards) }
                : {}),
            ...(path === "v1/file_uploads" && uploadArtifact ? { artifact: uploadArtifact } : {}),
            ...(path.endsWith("/markdown") &&
            typeof submittedMarkdown === "string" &&
            hasTypedLinks(submittedMarkdown)
              ? {
                  typed_links: {
                    page_id: path.split("/")[2]!,
                    markdown: submittedMarkdown,
                    state: "pending" as const,
                  },
                }
              : {}),
          }
          receipt.intents.push(intent)
          receipt.state = "running"
          yield* persist()
          phaseReads.clear()
          const outcome = yield* api.request(path, body, requestOptions).pipe(Effect.result)
          if (outcome._tag === "Failure") {
            intent.status = outcome.failure.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed"
            yield* persist()
            return yield* Effect.fail(outcome.failure)
          }
          intent.status = "completed"
          const response = property(outcome.success)
          if (path === "v1/file_uploads" && typeof response.id !== "string") {
            intent.status = "unknown"
            yield* persist()
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Upload allocation returned no identity.", {
                next: {
                  argv: [
                    "ntn-skills",
                    "operation",
                    "resume",
                    receipt.operation_id,
                    "--new-artifact",
                  ],
                },
              }),
            )
          }
          intent.response = { id: response.id, status: response.status }
          // The known response identity must survive a failure in any subsequent read.
          yield* persist()
          if (path.endsWith("/markdown") && property(body).markdown_version === "v2") {
            yield* remember(path, yield* api.request(path))
            const pagePath = path.slice(0, -"/markdown".length)
            yield* rememberRevision(pagePath, yield* api.request(pagePath))
            const replacedPage = path.split("/")[2]!
            const oldGuards = copy(receipt.guards)
            for (const guardPath of Object.keys(oldGuards)) {
              const owner = /^v1\/blocks\/([^/]+)(?:\/children\?.*)?$/.exec(guardPath)?.[1]
              if (!owner) continue
              let blockId: string | undefined = owner
              const seen = new Set<string>()
              while (blockId && !seen.has(blockId)) {
                if (blockId === replacedPage) {
                  delete receipt.guards[guardPath]
                  break
                }
                seen.add(blockId)
                const parent = property(property(oldGuards[`v1/blocks/${blockId}`]).parent)
                blockId =
                  typeof parent.page_id === "string"
                    ? parent.page_id
                    : typeof parent.block_id === "string"
                      ? parent.block_id
                      : undefined
              }
            }
            yield* persist()
            const replacement = property(property(body).replace_content).new_str
            const updates = property(property(body).update_content).content_updates
            const submitted =
              typeof replacement === "string"
                ? replacement
                : Array.isArray(updates) && updates.length === 1
                  ? property(updates[0]).new_str
                  : undefined
            if (typeof submitted === "string")
              yield* restoreMarkdownBlocks(path.split("/")[2]!, submitted, notion)
          }
          if (intent.typed_links) {
            // Advance our own Markdown/page revision before the separately journaled
            // block repairs compare all retained publication guards.
            yield* remember(path, yield* api.request(path))
            const pagePath = path.slice(0, -"/markdown".length)
            yield* rememberRevision(pagePath, yield* api.request(pagePath))
            yield* restoreTypedLinks(
              intent.typed_links.page_id,
              intent.typed_links.markdown,
              notion,
            )
            intent.typed_links.state = "completed"
            yield* persist()
          }
          if (
            path.endsWith("/markdown") &&
            property(body).markdown_version === "v2" &&
            typeof submittedMarkdown === "string"
          )
            yield* restoreOrderedListStart(path.split("/")[2]!, submittedMarkdown, notion)
          if (inventoryPage && originalChildren !== undefined) {
            const base = `v1/blocks/${inventoryPage}/children?page_size=100`
            let currentGuards = receipt.guards
            if (!(base in currentGuards)) {
              currentGuards = {}
              const captured = currentGuards
              yield* readLinkBlocks(
                inventoryPage,
                {
                  ...api,
                  request: (readPath, readBody, readOptions) =>
                    api.request(readPath, readBody, readOptions).pipe(
                      Effect.tap((raw) =>
                        Effect.try({
                          try: () => {
                            captured[readPath] = copy(observation(readPath, raw))
                          },
                          catch: (error) => error as SkillsError,
                        }),
                      ),
                    ),
                },
                { structureEvidence: true },
              )
            }
            const currentChildren = yield* Effect.try({
              try: () => retainedChildInventory(currentGuards, inventoryPage),
              catch: (error) => error as SkillsError,
            })
            if (canonical(currentChildren) !== canonical(originalChildren))
              return yield* Effect.fail(
                fail("WRITE_CONFLICT", "Child pages changed alongside the Markdown replacement.", {
                  path: base,
                }),
              )
            if (currentGuards !== receipt.guards) {
              // Commit the complete new pagination only while the acknowledged body and metadata still match.
              yield* verifyGuards([`v1/pages/${inventoryPage}`, path])
              Object.assign(receipt.guards, currentGuards)
              yield* persist()
            }
          }
          // v2 accepts CommonMark input; guards and snapshots use v1 readback consistently.
          const saved =
            path.endsWith("/markdown") && property(body).markdown_version === "v2"
              ? yield* api.request(path)
              : isPublicationMetadataIntent(receipt, intent)
                ? yield* api.request(path)
                : outcome.success
          if (path === "v1/pages") {
            const created = property(outcome.success)
            if (typeof created.id !== "string") {
              intent.status = "unknown"
              yield* persist()
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Created page returned no identity."),
              )
            }
            const parent = property(property(body).parent)
            if (parent.data_source_id) receipt.page_id = created.id
            receipt.guards[`v1/pages/${created.id}/markdown`] =
              typeof parent.page_id === "string"
                ? pageMarkdown(yield* api.request(`v1/pages/${created.id}/markdown`))
                : ""
            yield* remember(`v1/pages/${created.id}`, outcome.success)
            // A newly allocated page starts empty; known child creates extend that inventory.
            receipt.guards[`v1/blocks/${created.id}/children?page_size=100`] = receipt.context
              ?.markdown_files
              ? observation(
                  `v1/blocks/${created.id}/children?page_size=100`,
                  yield* api.request(`v1/blocks/${created.id}/children?page_size=100`),
                )
              : { results: [], has_more: false, next_cursor: null }
            if (typeof parent.page_id === "string") {
              const base = `v1/blocks/${parent.page_id}/children?page_size=100`
              const title = property(property(property(body).properties).title).title
              const label = Array.isArray(title)
                ? property(property(title[0]).text).content
                : undefined
              const parentId = parent.page_id
              const saved = yield* Effect.try({
                try: () => retainedChildInventory(receipt.guards, parentId),
                catch: (error) => error as SkillsError,
              })
              const chain: Receipt["guards"] = {}
              const seen = new Set<string>()
              let cursor: string | undefined
              let request = base
              do {
                if (seen.size > 1000)
                  return yield* Effect.fail(
                    fail("INVALID_RESPONSE", "Child inventory pagination exceeds its bound.", {
                      path: request,
                    }),
                  )
                const raw = yield* api.request(request)
                const rawChildren = property(raw).results
                if (
                  Array.isArray(rawChildren) &&
                  rawChildren.some((item) => {
                    const child = property(item)
                    return (
                      child.type === "child_page" &&
                      (property(child.parent).type !== "page_id" ||
                        property(child.parent).page_id !== parent.page_id ||
                        child.archived === true ||
                        child.in_trash === true)
                    )
                  })
                )
                  return yield* Effect.fail(
                    fail(
                      "WRITE_CONFLICT",
                      "A child page no longer has its intended active parent.",
                      { path: request },
                    ),
                  )
                const page = property(observation(request, raw))
                if (!Array.isArray(page.results))
                  return yield* Effect.fail(
                    fail("INVALID_RESPONSE", "Invalid child inventory.", { path: request }),
                  )
                chain[request] = page
                if (page.has_more !== true) {
                  if (page.next_cursor !== null && page.next_cursor !== undefined)
                    return yield* Effect.fail(
                      fail("INVALID_RESPONSE", "Completed child inventory retains a cursor.", {
                        path: request,
                      }),
                    )
                  break
                }
                if (
                  typeof page.next_cursor !== "string" ||
                  !page.next_cursor ||
                  seen.has(page.next_cursor)
                )
                  return yield* Effect.fail(
                    fail("INVALID_RESPONSE", "Invalid child inventory pagination.", {
                      path: request,
                    }),
                  )
                seen.add(page.next_cursor)
                cursor = page.next_cursor
                request = `${base}&start_cursor=${encodeURIComponent(cursor)}`
              } while (cursor)
              const current = Object.values(chain).flatMap((page) =>
                (property(page).results as unknown[]).map(property),
              )
              const createdChild = {
                id: created.id,
                type: "child_page",
                child_page: { title: label },
              }
              const withoutCreated = current.filter((child) => child.id !== created.id)
              if (
                current.filter((child) => child.id === created.id).length !== 1 ||
                canonical(current.find((child) => child.id === created.id)) !==
                  canonical(createdChild) ||
                canonical(withoutCreated) !==
                  canonical(saved.filter((child) => child.id !== created.id)) ||
                saved.filter((child) => child.id === created.id).length > 1
              )
                return yield* Effect.fail(
                  fail(
                    "WRITE_CONFLICT",
                    "Parent child inventory changed alongside child creation.",
                    { path: base },
                  ),
                )
              for (const guardPath of Object.keys(receipt.guards))
                if (
                  (guardPath === base || guardPath.startsWith(`${base}&start_cursor=`)) &&
                  !(guardPath in chain)
                )
                  delete receipt.guards[guardPath]
              Object.assign(receipt.guards, chain)
              const parentBodyPath = `v1/pages/${parent.page_id}/markdown`
              const before = receipt.guards[parentBodyPath]
              const raw = yield* api.request(parentBodyPath)
              const after = pageMarkdown(raw)
              const added = childPageTags(after).filter((tag) => {
                const url = /\burl="([^"]+)"/.exec(tag)?.[1]
                return url && pageId(url) === created.id
              })
              if (
                typeof before !== "string" ||
                added.length !== 1 ||
                bodyIdentity(after.replace(added[0]!, "")) !== bodyIdentity(before)
              )
                return yield* Effect.fail(
                  fail("WRITE_CONFLICT", "Parent content changed alongside child creation.", {
                    path: parentBodyPath,
                  }),
                )
              yield* rememberRevision(
                `v1/pages/${parent.page_id}`,
                yield* api.request(`v1/pages/${parent.page_id}`),
              )
              yield* remember(parentBodyPath, raw)
            }
          } else if (/^v1\/pages\/[^/]+(?:\/markdown)?$/.test(path)) {
            const managedMetadata = isPublicationMetadataIntent(receipt, intent)
            if (
              !integrityMutation &&
              ((authorization && path === authorization.path) || managedMetadata)
            ) {
              const changed = Object.keys(property(property(body).properties))
              const unchanged = (raw: unknown) => {
                const content = property(metadataContent(raw))
                return {
                  ...content,
                  properties: Object.fromEntries(
                    Object.entries(property(content.properties)).filter(
                      ([key, value]) =>
                        !changed.includes(key) && !changed.includes(String(property(value).id)),
                    ),
                  ),
                }
              }
              if (
                canonical(unchanged(authorization?.guards[path] ?? intent.guards?.[path])) !==
                canonical(unchanged(metadata(saved)))
              )
                return yield* Effect.fail(
                  fail(
                    "WRITE_CONFLICT",
                    "Unrequested properties changed alongside the authorized update.",
                    { path },
                  ),
                )
            }
            yield* remember(path, saved)
            if (path.endsWith("/markdown")) {
              const metadataPath = path.slice(0, -"/markdown".length)
              yield* rememberRevision(metadataPath, yield* api.request(metadataPath))
            }
            if (!path.endsWith("/markdown")) {
              const request = property(body)
              const fields = Object.entries(property(property(saved).properties))
              const changed = Object.keys(property(request.properties)).map((key) => {
                const matches = fields.filter(
                  ([name, value]) => name === key || property(value).id === key,
                )
                const id = matches.length === 1 ? property(matches[0]![1]).id : undefined
                return typeof id === "string" && id.length > 0
                  ? `${path}/properties/${id}`
                  : undefined
              })
              const exact =
                method === "PATCH" &&
                Object.keys(request).length === 1 &&
                Object.hasOwn(request, "properties") &&
                request.properties !== null &&
                typeof request.properties === "object" &&
                !Array.isArray(request.properties) &&
                changed.every((base) => base !== undefined)
              // A metadata ACK changes only the requested property chains. Keep
              // unrelated complete observations, including References, so the
              // next normal guard comparison can still detect external edits.
              for (const key of Object.keys(receipt.guards)) {
                if (!key.startsWith(`${path}/properties/`)) continue
                if (!exact || changed.some((base) => key === base || key.startsWith(`${base}?`)))
                  delete receipt.guards[key]
              }
            }
          } else if (/^v1\/blocks\/[^/]+$/.test(path)) {
            for (const blockPath of blockAncestors)
              yield* remember(blockPath, yield* api.request(blockPath))
            if (blockOwner) {
              yield* rememberRevision(blockOwner, yield* api.request(blockOwner))
              yield* remember(
                `${blockOwner}/markdown`,
                yield* api.request(`${blockOwner}/markdown`),
              )
            }
          } else if (appendOwner) {
            const pagePath = blockOwner ?? `v1/pages/${appendOwner}`
            for (const blockPath of blockAncestors)
              yield* remember(blockPath, yield* api.request(blockPath))
            yield* rememberRevision(pagePath, yield* api.request(pagePath))
            yield* remember(`${pagePath}/markdown`, yield* api.request(`${pagePath}/markdown`))
            for (const guard of Object.keys(receipt.guards))
              if (
                guard.startsWith(`v1/blocks/${appendOwner}/children?`) ||
                (blockOwner &&
                  guard.startsWith(`v1/blocks/${blockOwner.slice("v1/pages/".length)}/children?`))
              )
                delete receipt.guards[guard]
            yield* persist()
          }
          yield* persist()
          if (listRepair) {
            const applied = yield* provePublicationListRepair(receipt, api, !receipt.conflict)
            if (applied.outcome !== "applied")
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_LIST_REPAIR_UNPROVEN",
                  "The acknowledged list field and complete body have not converged.",
                ),
              )
            if (!receipt.stages.includes("list_start_repair_verified"))
              receipt.stages.push("list_start_repair_verified")
            yield* persist()
          }
          if (receipt.context?.content_adoption)
            yield* verifyContentAdoptionReadback(receipt, api).pipe(
              Effect.provide(integrityContext),
            )
          if (Array.isArray(response.warnings) && response.warnings.length)
            return yield* Effect.fail(
              fail("WRITE_VERIFICATION_FAILED", "Notion reported unsupported Markdown syntax.", {
                path,
                warnings: response.warnings,
              }),
            )
          return saved
        }).pipe(Effect.provide(authorizationContext)),
    }
    const run: Publication["run"] = (stage, effect) =>
      Effect.gen(function* () {
        phaseReads.clear()
        readPhase = publicationReadPhase()
        const start = yield* Clock.monotonicTimeNanos
        const knownGuards = copy(receipt.guards)
        const knownIntents = receipt.intents.length
        const emit = (status: PublicationProgress["status"]) =>
          Effect.gen(function* () {
            const now = yield* Clock.monotonicTimeNanos
            if (options.onProgress)
              yield* options.onProgress({
                operation_id: receipt.operation_id,
                stage,
                status,
                elapsed_ms: Number(now - started) / 1_000_000,
                stage_ms: Number(now - start) / 1_000_000,
              })
          })
        yield* emit("started")
        const result = yield* Effect.gen(function* () {
          const value = yield* effect
          if (
            !validationGuards &&
            graphCheckNeeded &&
            (stage === "checkpoint" || stage === "prepare")
          )
            yield* verifyGraph()
          return value
        }).pipe(Effect.result)
        if (result._tag === "Failure") {
          if (receipt.intents.length === knownIntents) {
            phaseReads.clear()
            receipt.guards = knownGuards
            yield* persist()
          }
          yield* emit("failed")
          return yield* Effect.fail(result.failure)
        }
        receipt.stages.push(stage)
        yield* persist()
        yield* emit("completed")
        return result.success
      })
    const validate: Publication["validate"] = (effect) =>
      run(
        "validate",
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            if (validationGuards)
              return yield* Effect.fail(
                fail("INTERNAL_ERROR", "Publication validation cannot be nested."),
              )
            validationGuards = copy(receipt.guards)
            phaseReads.clear()
            readPhase = publicationReadPhase()
            return validationGuards
          }),
          (candidate) =>
            Effect.gen(function* () {
              const value = yield* effect
              for (const [path, value] of Object.entries(receipt.guards))
                if (
                  publicationGuardComparison(receipt, path, candidate[path]) !==
                  publicationGuardComparison(receipt, path, value)
                )
                  return yield* Effect.fail(
                    fail("WRITE_CONFLICT", "Remote publication state changed during validation.", {
                      path,
                    }),
                  )
              // Until comparison succeeds, hard exits retain the committed baseline.
              if (bound && !dry)
                yield* store.writeJson(receiptPath, copy({ ...receipt, guards: candidate }))
              receipt.guards = candidate
              phaseReads.clear()
              readPhase = publicationReadPhase()
              return value
            }),
          () =>
            Effect.sync(() => {
              validationGuards = undefined
              readPhase = publicationReadPhase()
            }),
        ),
      )
    const metadataUnchanged = () =>
      Effect.gen(function* () {
        if (receipt.data_source_id)
          yield* bindPublicationSource(receipt, receipt.data_source_id, api)
        yield* persist()
        return (
          !Object.keys(publicationMetadataProperties(receipt)).length ||
          Boolean(
            receipt.page_id &&
              publicationMetadataMatches(
                receipt,
                yield* notion.request(`v1/pages/${receipt.page_id}`),
              ),
          )
        )
      })
    const finish: Publication["finish"] = (effect) =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const saved = yield* effect
          if (receipt.state === "completed") {
            yield* verifyPublicationMetadata(receipt, notion)
            return saved
          }
          phaseReads.clear()
          readPhase = publicationReadPhase()
          const metadataChanged = !(yield* metadataUnchanged())
          if (!dry && receipt.page_id && metadataChanged && !integrityStarted) {
            const markdownPath = `v1/pages/${receipt.page_id}/markdown`
            if (!(markdownPath in receipt.guards)) yield* notion.request(markdownPath)
            integrityMutation = true
            yield* startPublicationIntegrity(receipt.operation_id, receipt.page_id).pipe(
              Effect.provideService(Notion, notion),
              Effect.provideService(PublicationReadOperation, receipt.operation_id),
              Effect.provide(integrityContext),
              Effect.ensuring(
                Effect.sync(() => {
                  integrityMutation = false
                }),
              ),
            )
            integrityStarted = true
          }
          if (!dry && receipt.page_id && integrityStarted) {
            const current = yield* openSkill(receipt.page_id, {
              database: receipt.database_id,
              refresh: true,
            }).pipe(
              Effect.provideService(Notion, notion),
              Effect.provideService(PublicationReadOperation, receipt.operation_id),
              Effect.provide(integrityContext),
            )
            yield* verifyGraph()
            if (Object.keys(publicationMetadataProperties(receipt)).length) {
              if (!(yield* metadataUnchanged()))
                yield* notion.request(
                  `v1/pages/${receipt.page_id}`,
                  { properties: publicationMetadataProperties(receipt) },
                  { method: "PATCH" },
                )
              yield* verifyPublicationMetadata(receipt, notion)
            }
            phaseReads.clear()
            // Ownership/source assignments change metadata only. The final
            // committed read below re-reads all content; commit also checks
            // the live manifest against this already verified snapshot.
            const verified = current
            yield* verifyGraph()
            integrityMutation = true
            yield* commitPublicationIntegrity(receipt.operation_id, verified).pipe(
              Effect.provideService(Notion, notion),
              Effect.provideService(PublicationReadOperation, receipt.operation_id),
              Effect.provide(integrityContext),
              Effect.ensuring(
                Effect.sync(() => {
                  integrityMutation = false
                }),
              ),
            )
            phaseReads.clear()
            const committed = yield* openSkill(receipt.page_id, {
              database: receipt.database_id,
              refresh: true,
            }).pipe(
              Effect.provideService(Notion, notion),
              Effect.provideService(PublicationReadOperation, receipt.operation_id),
              Effect.provide(integrityContext),
            )
            yield* verifyGraph()
            return {
              ...saved,
              ...snapshotInfo(committed),
              ...((metadataChanged ||
                receipt.intents.some(
                  (intent) =>
                    intent.status === "completed" && isPublicationMetadataIntent(receipt, intent),
                )) &&
              property(saved).reused === true
                ? { action: "update" as const, reused: false }
                : {}),
            }
          }
          if (!dry) yield* verifyGraph()
          return saved
        }).pipe(
          Effect.provideService(PublicationReadOperation, receipt.operation_id),
          Effect.result,
        )
        delete receipt.owner
        if (result._tag === "Failure") {
          const error = result.failure
          const cause = property(error.details)
          if (
            error.code === "WRITE_CONFLICT" ||
            cause.cause_code === "WRITE_CONFLICT" ||
            property(cause.cause_details).cause_code === "WRITE_CONFLICT"
          )
            receipt.conflict = true
          if (receipt.state !== "completed")
            receipt.state = receipt.intents.some(unresolvedIntent) ? "unknown" : "failed"
          receipt.failure = { code: error.code, message: error.message, details: error.details }
          yield* persist()
          return yield* Effect.fail(
            fail(error.code, error.message, {
              ...property(error.details),
              operation_id: receipt.operation_id,
              ...(bound && !dry
                ? { receipt_path: `sqlite:publications/${receipt.operation_id}` }
                : {}),
            }),
          )
        }
        const value = {
          ...result.success,
          ...(receipt.context?.input_type ? { input_type: receipt.context.input_type } : {}),
          ...(receipt.context?.main_path ? { main_path: receipt.context.main_path } : {}),
          ...(receipt.context?.write_path
            ? {
                path: receipt.context.write_path,
                ref: fileRef(
                  receipt.page_id!,
                  receipt.context.write_path,
                  String(property(result.success).snapshot_id),
                ),
                previous_version_id: receipt.context.previous_version_id,
                unchanged: false,
              }
            : {}),
          operation_id: receipt.operation_id,
          ...(bound && !dry ? { receipt_path: `sqlite:publications/${receipt.operation_id}` } : {}),
        }
        receipt.result = value
        receipt.state = "completed"
        yield* persist()
        return value
      })
    return {
      operationId: receipt.operation_id,
      receiptPath: `sqlite:publications/${receipt.operation_id}`,
      notion,
      upload: (input, filename) =>
        publicationUpload(
          receipt,
          notion,
          persist,
          (artifact) => {
            uploadArtifact = artifact
          },
          input,
          filename,
        ).pipe(Effect.provide(uploadContext)),
      run,
      validate,
      metadataUnchanged,
      authorize: (path, body, scope, observations) =>
        Effect.gen(function* () {
          if (receipt.intents.length || authorization)
            return yield* Effect.fail(
              fail("INTERNAL_ERROR", "Mutation authorization cannot be replaced."),
            )
          const guards: Receipt["guards"] = {}
          for (const [key, raw] of Object.entries(observations)) {
            const value = observation(key, raw)
            if (value !== undefined) guards[key] = copy(value)
          }
          if (!(path in guards) || !(path + "/markdown" in guards))
            return yield* Effect.fail(
              fail(
                "PUBLICATION_UNRESOLVED",
                "Property authorization requires original metadata and body observations.",
              ),
            )
          authorization = { path, body: copy(body), scope, guards }
          receipt.guards = copy(guards)
          yield* persist()
        }),
      finish,
      bind: (source, scope) =>
        Effect.gen(function* () {
          Object.assign(receipt, source, { scope })
          yield* bindPublicationSource(receipt, source.data_source_id, api)
          if (
            source.page_id &&
            receipt.context?.source_intent?.mode === "set" &&
            receipt.context.source_intent.value.type === "builtin"
          ) {
            const raw = yield* notion.request(`v1/pages/${source.page_id}`)
            const owner = yield* Effect.try({
              try: () => publicationOwnership(raw),
              catch: () =>
                fail("INVALID_UPSTREAM", "Builtin replacement requires valid unmanaged ownership."),
            })
            if (
              owner.upstream.length ||
              owner.mode ||
              owner.key ||
              owner.revision ||
              owner.hash ||
              owner.baseline
            )
              return yield* Effect.fail(
                fail(
                  "WRITE_CONFLICT",
                  "Builtin publication cannot overwrite an upstream-owned target.",
                ),
              )
          }
          receipt.owner = { pid: process.pid, host: hostname() }
          bound = true
          yield* persist()
        }),
    } satisfies Publication
  })
}
