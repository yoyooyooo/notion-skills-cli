import { publicationZeroListCandidates } from "./publication-zero-list-history.ts"
import {
  markdownReplayRequest,
  publicationMarkdownReplayCandidates,
} from "./publication-markdown-replay.ts"
import {
  hasObservedMarkdownCorrection,
  observedMarkdownCorrectionCoverage,
  originalObservedMarkdownCorrectionCandidate,
} from "./publication-markdown-history.ts"
import { proveObservedMarkdownNoEffect } from "./publication-markdown-correction.ts"
import { proveCompletedCodeLanguageCheckpoint } from "./publication-code-language-ack-checkpoint.ts"
import {
  completedTableRowCheckpointCandidate,
  proveCompletedTableRowCheckpoint,
} from "./publication-table-row-ack-checkpoint.ts"
import { retainedUploadReplacementCandidates } from "./publication-retained-upload.ts"
import { terminalPublicationCommitCandidate } from "./publication-terminal-commit.ts"
import { Clock, Effect } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { Store } from "./store.ts"
import { withLocalLocks } from "./local-locks.ts"
import { childPageTags, pageMarkdown } from "./references.ts"
import { bodyIdentity } from "./portable.ts"
import { pageId } from "./ref.ts"
import { hostname } from "node:os"
import {
  publicationMarker,
  verifyPublicationOwnership,
  PublicationReadOperation,
} from "./publication-integrity.ts"
import { openSkill, snapshotInfo } from "./snapshot.ts"
import {
  isUploadIntent,
  observeUpload,
  proveRetainedTerminalUploadOrphan,
  retainedTerminalUploadOrphan,
  unresolvedIntent,
  verifyAttachedUpload,
} from "./publication-upload.ts"
import { PublicationReceiptSchema as ReceiptSchema, type Receipt } from "./publication-model.ts"
import {
  publicationGuardComparison,
  publicationMetadataApplied,
  unobservedPublicationMetadataAck,
  verifyPublicationMetadata,
} from "./publication-source.ts"
import { discoverPublicationCreate } from "./publication-create-discovery.ts"
import {
  canonical,
  markdownReplacementInventoryPaths,
  publicationBlockReplacementCandidates,
  publicationJournalSettled,
  publicationMarkerAuthority,
  publicationPropertyReplacementCandidates,
} from "./publication-effect-proof.ts"
import { proveCompletedChildParentCheckpoint } from "./publication-child-checkpoint.ts"
import {
  terminalCanonicalCodeAliasCandidate,
  canonicalCodeLanguageCheckpoint,
  certifiedCanonicalCodeAliasCandidate,
} from "./publication-code-language-checkpoint.ts"
import { reconcileContentAdoption } from "./upstream-content-adoption.ts"
import {
  keyFor,
  copy,
  publicationReadPhase,
  capturePublicationRead,
  readPublicationMarkdownMatches,
  publicationPropertiesMatch,
  metadata,
  metadataContent,
  blockPatchRecovery,
  observation,
  completedPublicationProof,
} from "./publication-observation.ts"
type Intent = Receipt["intents"][number]
import { observeMarkdownFilesPublication } from "./markdown-files-recovery.ts"

// Query endpoints use POST but carry no publication write intent.
export function reconcilePublication(operationId: string) {
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
        if (!receipt)
          return yield* Effect.fail(fail("PUBLICATION_MISSING", "No publication receipt exists."))
        if (receipt.body_completion && receipt.body_completion.phase !== "verified")
          return yield* Effect.fail(
            fail(
              "PUBLICATION_BODY_COMPLETION_PENDING",
              "Use the retained body-completion reconciler before ordinary publication reconciliation.",
              { plan_id: receipt.body_completion.plan_id },
            ),
          )
        const fenced = receipt.conflict ? copy(receipt) : undefined
        if (!receipt.scope || (yield* authScope) !== receipt.scope)
          return yield* Effect.fail(
            fail(
              "PUBLICATION_SCOPE_MISMATCH",
              "Publication belongs to another authentication scope.",
            ),
          )
        if (!receipt.database_id || !receipt.data_source_id)
          return yield* Effect.fail(
            fail("PUBLICATION_UNRESOLVED", "Publication has no bound source authority."),
          )
        const source = yield* explicitSource(receipt.database_id)
        if (!source.data_source_ids.includes(receipt.data_source_id))
          return yield* Effect.fail(
            fail(
              "PUBLICATION_SOURCE_MISMATCH",
              "Publication data source no longer belongs to its bound database.",
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
              fail("PUBLICATION_LOCKED", "A live or unverifiable process owns this publication."),
            )
        }
        if (
          !receipt.conflict &&
          receipt.context?.source_intent &&
          receipt.state === "completed" &&
          receipt.page_id &&
          receipt.intents.length === 0 &&
          property(receipt.result).reused === true
        ) {
          yield* verifyPublicationMetadata(receipt, api)
          const snapshot = yield* openSkill(receipt.page_id, {
            database: receipt.database_id,
            refresh: true,
          }).pipe(Effect.provideService(PublicationReadOperation, operationId))
          const unchanged =
            snapshot.snapshot_id === property(receipt.result).snapshot_id &&
            snapshot.version_id === property(receipt.result).version_id
          return {
            operation_id: operationId,
            kind: "publication" as const,
            state: receipt.state,
            outcome: unchanged ? ("success" as const) : ("conflict" as const),
            verified: unchanged,
            unresolved: false,
            observations: [
              {
                path: `v1/pages/${receipt.page_id}`,
                outcome: unchanged ? ("success" as const) : ("conflict" as const),
              },
            ],
            next: { argv: ["ntn-skills", "read", receipt.page_id, "--refresh"] },
          }
        }
        if (receipt.context?.markdown_files) {
          const result = yield* observeMarkdownFilesPublication(receipt, api)
          return {
            operation_id: operationId,
            kind: "publication" as const,
            state: receipt.state,
            ...result,
            unresolved: result.outcome === "unknown",
            next: {
              argv: [
                "ntn-skills",
                "operation",
                result.outcome === "needs_safe_resume" ? "resume" : "reconcile",
                operationId,
              ],
            },
          }
        }
        if (receipt.context?.content_adoption) return yield* reconcileContentAdoption(receipt)
        if (
          !receipt.conflict &&
          hasObservedMarkdownCorrection(receipt) &&
          receipt.intents.length === 3
        ) {
          const unchanged = yield* proveObservedMarkdownNoEffect(receipt, api, "replay")
          return {
            operation_id: operationId,
            kind: "publication" as const,
            state: receipt.state,
            outcome: "needs_safe_resume" as const,
            verified: false as const,
            unresolved: false,
            observations: [
              {
                path: unchanged.candidate.bodyPath,
                outcome: "success" as const,
                intent_index: 2,
                reason:
                  "The recorded empty-preimage correction remains current; its original exact successor still must be sent.",
              },
            ],
            next: { argv: ["ntn-skills", "operation", "resume", operationId] },
          }
        }
        const creationDiscovery: unknown[] = []
        for (const [index, intent] of receipt.intents.entries()) {
          if (
            fenced ||
            intent.path !== "v1/pages" ||
            !["pending", "unknown"].includes(intent.status)
          )
            continue
          const discovery = yield* discoverPublicationCreate(receipt, index).pipe(Effect.result)
          if (discovery._tag === "Failure") {
            if (discovery.failure.code === "WRITE_CONFLICT")
              return yield* Effect.fail(discovery.failure)
            creationDiscovery.push({
              intent_index: index,
              complete: false,
              candidate_count: null,
              outcome: "unknown",
              reason: discovery.failure.code,
            })
            continue
          }
          const { candidate, evidence, inventories } = discovery.success
          creationDiscovery.push(evidence)
          if (!candidate) continue
          const parentId = property(property(intent.body).parent).page_id
          if (typeof parentId === "string") {
            const parentBodyPath = `v1/pages/${parentId}/markdown`
            const previousBody = receipt.guards[parentBodyPath]
            const parentBody = pageMarkdown(yield* api.request(parentBodyPath))
            const added = childPageTags(parentBody).filter((tag) => {
              const url = /\burl="([^"]+)"/.exec(tag)?.[1]
              return url && pageId(url) === candidate.id
            })
            if (
              typeof previousBody !== "string" ||
              added.length !== 1 ||
              bodyIdentity(parentBody.replace(added[0]!, "")) !== bodyIdentity(previousBody)
            )
              return yield* Effect.fail(
                fail("WRITE_CONFLICT", "Parent changed alongside the unknown child creation."),
              )
            const parentPath = `v1/pages/${parentId}`
            const parentRaw = yield* api.request(parentPath)
            if (
              publicationGuardComparison(
                receipt,
                parentPath,
                metadataContent(receipt.guards[parentPath]),
              ) !==
              publicationGuardComparison(receipt, parentPath, metadataContent(metadata(parentRaw)))
            )
              return yield* Effect.fail(
                fail(
                  "WRITE_CONFLICT",
                  "Parent metadata changed alongside the unknown child creation.",
                ),
              )
            receipt.guards[parentBodyPath] = parentBody
            receipt.guards[parentPath] = metadata(parentRaw)
          } else receipt.page_id = candidate.id
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
          receipt.creation_discovery = creationDiscovery
          yield* store.writeJson(keyFor(operationId), copy(receipt))
        }
        if (!fenced) receipt.creation_discovery = creationDiscovery
        if (creationDiscovery.some((item) => property(item).complete === false)) {
          receipt.state = "unknown"
          delete receipt.owner
          yield* store.writeJson(keyFor(operationId), copy(receipt))
          return {
            operation_id: operationId,
            kind: "publication" as const,
            state: receipt.state,
            outcome: "unknown" as const,
            observations: [
              {
                path: "v1/pages",
                outcome: "unknown" as const,
                reason: "Creation discovery is incomplete; adoption and replay remain forbidden.",
              },
            ],
            verified: false,
            unresolved: true,
            next: { argv: ["ntn-skills", "operation", "reconcile", operationId] },
          }
        }
        const retainedUploads = retainedUploadReplacementCandidates(receipt)
        if (!retainedUploads)
          return yield* Effect.fail(
            fail("PUBLICATION_UNRESOLVED", "The retained upload history is invalid."),
          )
        const hasRetainedUpload = retainedUploads.length > 0
        const expected = copy(receipt.guards)
        const coverage = publicationBlockReplacementCandidates(receipt)
        const propertyCoverage = publicationPropertyReplacementCandidates(receipt)
        const zeroListCoverage = publicationZeroListCandidates(receipt)
        const hasListRepairs = receipt.intents.some(
          (intent) => intent.list_start_repair || intent.zero_list_repair,
        )
        const markdownCoverage = publicationMarkdownReplayCandidates(receipt)
        const hasMarkdownCorrection = hasObservedMarkdownCorrection(receipt)
        const codeAlias =
          terminalCanonicalCodeAliasCandidate(receipt) ??
          certifiedCanonicalCodeAliasCandidate(receipt)?.candidate
        const commitIntegrity = yield* store.integrity.inspect(operationId)
        const terminalCommitCandidate = terminalPublicationCommitCandidate(
          receipt,
          commitIntegrity,
          receipt.guards[`v1/pages/${receipt.page_id}`],
          publicationMarker,
        )
        let proofReceipt =
          fenced ??
          (coverage.length > 0 ||
          propertyCoverage.length > 0 ||
          markdownCoverage.length > 0 ||
          hasMarkdownCorrection ||
          hasListRepairs ||
          codeAlias ||
          terminalCommitCandidate ||
          hasRetainedUpload
            ? copy(receipt)
            : undefined)
        const observed: Record<string, unknown> = {}
        const observations: {
          path: string
          outcome: "success" | "conflict" | "unknown"
          reason?: string
          message?: string
          intent_index?: number
          covered_by_intent_index?: number
          property_id?: string
          proof_kind?: "acknowledged_root_create" | "acknowledged_child_create"
        }[] = []
        const settled: Intent[] = []
        const rawObserved: Record<string, unknown> = {}
        const readPhase = publicationReadPhase(rawObserved)
        const readApi: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            api
              .request(path, body, options)
              .pipe(
                Effect.tap((raw) =>
                  Effect.sync(() => capturePublicationRead(readPhase, path, raw)),
                ),
              ),
        }
        const paths = new Set([
          ...Object.keys(expected),
          ...(codeAlias ? Object.keys(receipt.intents[codeAlias.intent_index]!.guards ?? {}) : []),
          ...receipt.intents
            .filter(
              (i, index) =>
                i.path !== "v1/pages" &&
                !isUploadIntent(i) &&
                !coverage.some((item) => item.intent_index === index) &&
                !zeroListCoverage.some((item) => item.intent_index === index),
            )
            .map((i) => i.path),
        ])
        // Page metadata precedes every body and root inventory in this read phase.
        const orderedPaths = [...paths].sort(
          (a, b) => Number(/^v1\/pages\/[^/]+$/.test(b)) - Number(/^v1\/pages\/[^/]+$/.test(a)),
        )
        for (const path of orderedPaths) {
          const result = yield* readApi.request(path).pipe(Effect.result)
          if (result._tag === "Failure")
            observations.push({ path, outcome: "unknown", reason: result.failure.code })
          else {
            observed[path] = observation(path, result.success)
          }
        }
        const terminalCommit =
          terminalCommitCandidate &&
          publicationGuardComparison(
            receipt,
            `v1/pages/${receipt.page_id}`,
            observed[`v1/pages/${receipt.page_id}`],
          ) ===
            publicationGuardComparison(
              receipt,
              `v1/pages/${receipt.page_id}`,
              receipt.guards[`v1/pages/${receipt.page_id}`],
            )
            ? terminalCommitCandidate
            : undefined
        for (const [index, intent] of receipt.intents.entries()) {
          if (!isUploadIntent(intent)) continue
          const upload = fenced ? copy(intent) : intent
          const exactOrphan = retainedTerminalUploadOrphan(receipt, intent, index)
          const result = exactOrphan
            ? {
                path: intent.path,
                outcome: "success" as const,
                reason:
                  "Original unknown retained as a remote orphan; replacement is a separate suboperation.",
              }
            : yield* observeUpload(upload, receipt)
          if (
            fenced &&
            !exactOrphan &&
            upload.recovery?.kind !== "retained_unusable" &&
            (upload.recovery || property(upload.response).status !== "uploaded")
          )
            observations.push({
              path: intent.path,
              outcome: "unknown",
              reason: "A completed upload has no current uploaded lifecycle proof.",
            })
          observations.push(result)
          if (result.outcome === "success" && unresolvedIntent(intent)) settled.push(intent)
        }
        for (const [index, intent] of receipt.intents.entries()) {
          if (intent.status !== "completed" || isUploadIntent(intent)) continue
          const path =
            intent.path === "v1/pages" && typeof property(intent.response).id === "string"
              ? `v1/pages/${String(property(intent.response).id)}`
              : intent.path
          if (!(path in expected) && !coverage.some((item) => item.intent_index === index))
            observations.push({
              path,
              outcome: "unknown",
              reason: "Acknowledged mutation has no retained readback guard.",
            })
        }
        for (const intent of receipt.intents.filter(
          (i) =>
            !fenced &&
            !i.list_start_repair &&
            !i.zero_list_repair &&
            i !== receipt.intents[terminalCommit?.intent_index ?? -1] &&
            !isUploadIntent(i) &&
            (unresolvedIntent(i) ||
              unobservedPublicationMetadataAck(receipt, i) ||
              (i.status === "completed" && i.typed_links?.state === "pending") ||
              (i.status === "completed" &&
                i.method === "PATCH" &&
                /^v1\/blocks\/[^/]+$/.test(i.path) &&
                i.guards?.[i.path] !== undefined &&
                canonical(expected[i.path]) === canonical(i.guards[i.path])) ||
              (receipt.context?.write_path === "@properties" &&
                i.status === "completed" &&
                !Object.keys(property(property(i.body).properties)).includes("Publication"))),
        )) {
          const before = intent.guards?.[intent.path] ?? expected[intent.path]
          const actual = observed[intent.path]
          const body = property(intent.body)
          if (intent.path === "v1/pages") {
            observations.push({
              path: intent.path,
              outcome: "unknown",
              reason: "Creation has no proven response identity; name matching is forbidden.",
            })
          } else if (actual === undefined) continue
          else if (/^v1\/blocks\/[^/]+$/.test(intent.path) && intent.method === "PATCH") {
            const recovery = blockPatchRecovery(intent, receipt, observed, true)
            if (recovery.outcome === "success") {
              Object.assign(expected, recovery.guards)
              settled.push(intent)
            } else if (recovery.outcome === "retry")
              observations.push({
                path: intent.path,
                outcome: "unknown",
                reason: "PUBLICATION_BLOCK_RETRY_REQUIRED",
              })
            else observations.push({ path: intent.path, ...recovery })
          } else if (intent.path.endsWith("/markdown")) {
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
              observations.push({
                path: intent.path,
                outcome: "unknown",
                reason: "No deterministic retained Markdown target.",
              })
            else if (
              typeof actual === "string" &&
              (yield* readPublicationMarkdownMatches(intent, actual, target, readApi, readPhase))
            ) {
              expected[intent.path] = actual
              const pagePath = intent.path.slice(0, -"/markdown".length)
              if (
                observed[pagePath] !== undefined &&
                expected[pagePath] !== undefined &&
                publicationGuardComparison(
                  receipt,
                  pagePath,
                  metadataContent(observed[pagePath]),
                ) ===
                  publicationGuardComparison(receipt, pagePath, metadataContent(expected[pagePath]))
              ) {
                expected[pagePath] = observed[pagePath]
                settled.push(intent)
              } else
                observations.push({
                  path: pagePath,
                  outcome: observed[pagePath] === undefined ? "unknown" : "conflict",
                  reason: "Metadata changed alongside Markdown.",
                })
            } else
              observations.push({
                path: intent.path,
                outcome: canonical(actual) === canonical(before) ? "unknown" : "conflict",
                reason: "Mutation target has not converged.",
              })
          } else if (publicationMetadataApplied(receipt, intent, before, actual)) {
            expected[intent.path] = actual
            settled.push(intent)
          } else if (unobservedPublicationMetadataAck(receipt, intent)) {
            observations.push({
              path: intent.path,
              outcome: "unknown",
              reason: "The acknowledged metadata assignment has no exact unchanged-resource proof.",
            })
          } else if (
            /^v1\/pages\/[^/]+$/.test(intent.path) &&
            intent.method === "PATCH" &&
            body.properties
          ) {
            const matches =
              (yield* verifyAttachedUpload(rawObserved[intent.path], intent, receipt)) ||
              publicationPropertiesMatch(actual, body.properties)
            if (matches) {
              const changedIds = Object.keys(property(body.properties))
              for (const [key, item] of Object.entries(property(property(before).properties))) {
                const field = property(item)
                if (
                  !changedIds.includes(key) &&
                  !changedIds.includes(String(field.id)) &&
                  Array.isArray(field.files) &&
                  field.files.some((file) => typeof property(file).id !== "string")
                )
                  observations.push({
                    path: intent.path,
                    outcome: "unknown",
                    reason:
                      "An unaffected attachment lacks stable identity across the pending write.",
                  })
              }
              const unchanged = (page: unknown) => {
                const content = property(metadataContent(page))
                return {
                  ...content,
                  properties: Object.fromEntries(
                    Object.entries(property(content.properties)).filter(
                      ([key, value]) =>
                        !changedIds.includes(key) &&
                        !changedIds.includes(String(property(value).id)),
                    ),
                  ),
                }
              }
              if (
                before !== undefined &&
                publicationGuardComparison(receipt, intent.path, unchanged(before)) !==
                  publicationGuardComparison(receipt, intent.path, unchanged(actual))
              )
                observations.push({
                  path: intent.path,
                  outcome: "conflict",
                  reason: "Unrequested properties changed alongside this intent.",
                })
              else {
                expected[intent.path] = actual
                settled.push(intent)
              }
            } else
              observations.push({
                path: intent.path,
                outcome:
                  intent.status === "completed" ||
                  (before !== undefined &&
                    publicationGuardComparison(receipt, intent.path, metadataContent(actual)) !==
                      publicationGuardComparison(receipt, intent.path, metadataContent(before)))
                    ? "conflict"
                    : "unknown",
                reason: "Exact saved property content has not converged.",
              })
          } else
            observations.push({
              path: intent.path,
              outcome: "unknown",
              reason: "No deterministic readback rule.",
            })
        }
        let observedMarkdownSuccessor: Intent | undefined
        const terminal = receipt.intents.at(-1)
        if (
          !fenced &&
          terminal &&
          settled.length === 1 &&
          settled[0] === terminal &&
          markdownReplayRequest(terminal) &&
          (terminal.status === "pending" || terminal.status === "unknown") &&
          terminal.response === undefined
        ) {
          // This is a proposed observed result, never an ACK. Only the complete
          // proof below may persist it together with its exact current guards.
          const projected = copy(receipt)
          const index = projected.intents.length - 1
          projected.intents[index] = {
            ...projected.intents[index]!,
            status: "completed",
            response: { prior_status: terminal.status, recovery: "observed_applied" },
          }
          if (
            publicationJournalSettled(projected) &&
            (publicationMarkdownReplayCandidates(projected).some(
              (item) => item.covered_by_intent_index === index,
            ) ||
              observedMarkdownCorrectionCoverage(projected)?.covered_by_intent_index === index)
          ) {
            observedMarkdownSuccessor = terminal
            proofReceipt = projected
          }
        }
        const matchedReplacements = (
          observedMarkdownSuccessor && proofReceipt ? proofReceipt : receipt
        ).intents.filter((intent) => {
          const body = property(intent.body)
          return (
            intent.method === "PATCH" &&
            (intent.status === "completed" || intent === observedMarkdownSuccessor) &&
            body.markdown_version === "v2" &&
            body.type === "replace_content"
          )
        })
        const coveredInventories = new Set(
          [
            ...markdownReplacementInventoryPaths(proofReceipt ?? receipt, matchedReplacements),
          ].filter((path) => observed[path] !== undefined),
        )
        for (const path of [...coveredInventories]) {
          if (path.includes("start_cursor=")) {
            coveredInventories.delete(path)
            continue
          }
          const page = /^v1\/blocks\/([^/]+)\/children\?/.exec(path)?.[1]
          if (!page) {
            coveredInventories.delete(path)
            continue
          }
          const seen = new Set<string>()
          const saved: string[] = []
          let request = path
          let complete = false
          do {
            let projected = observed[request]
            let value: { has_more?: unknown; next_cursor?: unknown }
            if (projected === undefined) {
              const raw = yield* readApi.request(request).pipe(Effect.result)
              if (raw._tag === "Failure") break
              try {
                projected = observation(request, raw.success)
              } catch {
                break
              }
              if (projected === undefined) break
              value = property(raw.success)
            } else value = property(projected)
            expected[request] = projected
            coveredInventories.add(request)
            saved.push(request)
            if (value.has_more !== true) {
              complete = true
              break
            }
            if (typeof value.next_cursor !== "string" || seen.has(value.next_cursor)) break
            seen.add(value.next_cursor)
            request = `v1/blocks/${page}/children?page_size=100&start_cursor=${encodeURIComponent(value.next_cursor)}`
          } while (request)
          if (!complete) {
            for (const item of saved) coveredInventories.delete(item)
          }
        }
        // Older child ACKs appended to a synthetic single-page projection even
        // when ordinary blocks pushed the real inventory onto another page.
        // Only pagination may change: the complete ordered child roster and
        // every other retained guard remain exact, then the normal full ACK
        // proof below must independently verify the original source and effects.
        if (proofReceipt && receipt.page_id) {
          const base = `v1/blocks/${receipt.page_id}/children?page_size=100`
          const prior = property(receipt.guards[base])
          const creates = receipt.intents.filter(
            (intent) =>
              intent.path === "v1/pages" &&
              intent.method === "POST" &&
              intent.status === "completed" &&
              !intent.recovery &&
              property(property(intent.body).parent).page_id === receipt.page_id,
          )
          if (
            prior.has_more === false &&
            prior.next_cursor === null &&
            Array.isArray(prior.results) &&
            creates.length > 0 &&
            !Object.keys(receipt.guards).some((path) => path.startsWith(`${base}&start_cursor=`)) &&
            canonical(observed[base]) !== canonical(prior)
          ) {
            const chain: Record<string, unknown> = {},
              children: unknown[] = [],
              ids = new Set<string>(),
              cursors = new Set<string>()
            let path = base,
              complete = false
            for (let count = 0; count < 1000; count++) {
              const response = property(yield* readApi.request(path))
              if (!Array.isArray(response.results) || typeof response.has_more !== "boolean") break
              let valid = true
              for (const item of response.results) {
                const block = property(item)
                if (
                  typeof block.id !== "string" ||
                  ids.has(block.id) ||
                  property(block.parent).type !== "page_id" ||
                  property(block.parent).page_id !== receipt.page_id ||
                  block.archived === true ||
                  block.in_trash === true
                ) {
                  valid = false
                  break
                }
                ids.add(block.id)
              }
              if (!valid) break
              const projected = observation(path, response)
              const result = property(projected).results
              if (!Array.isArray(result)) break
              chain[path] = projected
              children.push(...result)
              if (!response.has_more) {
                complete = response.next_cursor === null
                break
              }
              if (
                typeof response.next_cursor !== "string" ||
                !response.next_cursor ||
                cursors.has(response.next_cursor)
              )
                break
              cursors.add(response.next_cursor)
              path = `${base}&start_cursor=${encodeURIComponent(response.next_cursor)}`
            }
            const acknowledged = creates.every((intent) => {
              const id = property(intent.response).id
              return (
                children.filter((child) => property(child).id === id).length === 1 &&
                publicationPropertiesMatch(
                  rawObserved[`v1/pages/${String(id)}`],
                  property(intent.body).properties,
                ) &&
                property(property(rawObserved[`v1/pages/${String(id)}`]).parent).page_id ===
                  receipt.page_id
              )
            })
            if (complete && acknowledged && canonical(children) === canonical(prior.results)) {
              Object.assign(expected, chain)
              Object.assign(observed, chain)
              proofReceipt = copy(proofReceipt)
              Object.assign(proofReceipt.guards, chain)
              for (const path of Object.keys(chain)) coveredInventories.add(path)
              // Full retained root metadata binds the complete References value;
              // its missing property-items checkpoint is read, never invented.
              const rootPath = `v1/pages/${receipt.page_id}`
              const fields = property(property(rawObserved[rootPath]).properties)
              const field = property(fields.References)
              if (
                typeof field.id === "string" &&
                Array.isArray(field.rich_text) &&
                canonical(observed[rootPath]) === canonical(receipt.guards[rootPath])
              ) {
                const propertyBase = `${rootPath}/properties/${field.id}?page_size=100`
                if (!(propertyBase in receipt.guards)) {
                  const pages: Record<string, unknown> = {},
                    items: unknown[] = [],
                    seen = new Set<string>()
                  let request = propertyBase,
                    done = false
                  for (let count = 0; count < 1000; count++) {
                    const raw = yield* readApi.request(request),
                      response = property(raw)
                    pages[request] = observation(request, raw)
                    if (response.object === "property_item") {
                      if (
                        request === propertyBase &&
                        response.type === "rich_text" &&
                        response.id === field.id &&
                        response.has_more !== true &&
                        response.next_cursor == null
                      ) {
                        items.push(response.rich_text)
                        done = true
                      }
                      break
                    }
                    if (
                      !Array.isArray(response.results) ||
                      typeof response.has_more !== "boolean" ||
                      response.results.some(
                        (item) =>
                          property(item).id !== field.id || property(item).type !== "rich_text",
                      )
                    )
                      break
                    items.push(...response.results.map((item) => property(item).rich_text))
                    if (!response.has_more) {
                      done = response.next_cursor === null
                      break
                    }
                    if (
                      typeof response.next_cursor !== "string" ||
                      !response.next_cursor ||
                      seen.has(response.next_cursor)
                    )
                      break
                    seen.add(response.next_cursor)
                    request = `${propertyBase}&start_cursor=${encodeURIComponent(response.next_cursor)}`
                  }
                  if (
                    done &&
                    canonical(metadata(yield* readApi.request(rootPath))) ===
                      canonical(receipt.guards[rootPath]) &&
                    publicationPropertiesMatch(rawObserved[rootPath], {
                      References: { rich_text: items },
                    })
                  ) {
                    Object.assign(expected, pages)
                    Object.assign(observed, pages)
                    Object.assign(proofReceipt.guards, pages)
                    for (const path of Object.keys(pages)) coveredInventories.add(path)
                  }
                }
              }
            }
          }
        }
        for (const [path, value] of Object.entries(expected))
          if (observed[path] !== undefined)
            observations.push({
              path,
              outcome:
                coveredInventories.has(path) ||
                publicationGuardComparison(receipt, path, observed[path]) ===
                  publicationGuardComparison(receipt, path, value)
                  ? "success"
                  : "conflict",
            })
        if (!Object.keys(expected).length)
          observations.push({ path: "v1/pages", outcome: "unknown", reason: "No retained guards." })
        if (
          receipt.context?.write_path === "@properties" &&
          receipt.page_id &&
          !(`v1/pages/${receipt.page_id}/markdown` in expected)
        )
          observations.push({
            path: `v1/pages/${receipt.page_id}/markdown`,
            outcome: "unknown",
            reason: "Property-only publication has no retained content guard.",
          })
        if (observedMarkdownSuccessor && proofReceipt) proofReceipt.guards = copy(expected)
        // A pending successor's guards above derive only from its fully matched
        // whole-body effect and complete inventory. Existing fences continue
        // to require their original guards without this observation projection.
        // Reassess original guards, never projections repaired by this reconciliation.
        let reassessedHash: string | undefined
        let completedHash: string | undefined
        let terminalCommitVerified = false
        let aliasCheckpoint: ReturnType<typeof canonicalCodeLanguageCheckpoint>
        if (
          proofReceipt &&
          proofReceipt.operation_id === operationId &&
          proofReceipt.intents.length > 0 &&
          (publicationJournalSettled(proofReceipt) ||
            terminalCanonicalCodeAliasCandidate(proofReceipt) ||
            certifiedCanonicalCodeAliasCandidate(proofReceipt) ||
            terminalCommit) &&
          Object.keys(proofReceipt.guards).length > 0 &&
          Object.entries(proofReceipt.guards).every(
            ([path, value]) =>
              observed[path] !== undefined &&
              (coveredInventories.has(path) || canonical(observed[path]) === canonical(value)),
          ) &&
          observations.length > 0 &&
          observations.every((item) => item.outcome === "success")
        ) {
          const proof = yield* completedPublicationProof(
            proofReceipt,
            rawObserved,
            readApi,
            readPhase,
          ).pipe(Effect.result)
          if (proof._tag === "Failure")
            observations.push({
              path: `v1/pages/${receipt.page_id}`,
              outcome: "unknown",
              reason: proof.failure.code,
              message: proof.failure.message,
            })
          else if (proof.success.outcome === "success") {
            completedHash = proof.success.intended_hash
            terminalCommitVerified = proof.success.terminal_commit !== undefined
            aliasCheckpoint = proof.success.canonical_code_language_checkpoint
            if (fenced) reassessedHash = completedHash
            if (proof.success.code_alias_coverage)
              observations.push({
                path: proof.success.code_alias_coverage.path,
                outcome: "success",
                intent_index: proof.success.code_alias_coverage.intent_index,
                reason: aliasCheckpoint
                  ? "Original failed code-language alias has a complete exact no-effect checkpoint."
                  : "Recorded original code-language checkpoint and all current effects are verified.",
              })
            for (const item of proof.success.block_coverage)
              observations.push({
                path: item.path,
                outcome: "success",
                intent_index: item.intent_index,
                covered_by_intent_index: item.covered_by_intent_index,
                reason: `Acknowledged block intent ${item.intent_index} covered by completed whole-page replacement intent ${item.covered_by_intent_index}.`,
              })
            for (const item of [
              ...proof.success.markdown_coverage,
              ...(proof.success.observed_markdown_correction_coverage
                ? [proof.success.observed_markdown_correction_coverage]
                : []),
            ])
              observations.push({
                path: item.path,
                outcome: "success",
                intent_index: item.intent_index,
                covered_by_intent_index: item.covered_by_intent_index,
                reason:
                  "Original Markdown history is covered by an independently verified whole-body successor.",
              })
            for (const item of proof.success.property_coverage)
              observations.push({
                path: item.path,
                outcome: "success",
                intent_index: item.intent_index,
                covered_by_intent_index: item.covered_by_intent_index,
                property_id: item.property_id,
                reason:
                  item.basis === "oversized_legacy_references"
                    ? `Original over-limit References intent ${item.intent_index} covered_by_verified_whole_field_replacement:${item.covered_by_intent_index}.`
                    : `Terminal no-effect property intent ${item.intent_index} covered_by_completed_property_replacement:${item.covered_by_intent_index}.`,
              })
            for (const item of proof.success.list_repair_coverage)
              observations.push({
                path: item.path,
                outcome: "success",
                intent_index: item.intent_index,
                covered_by_intent_index: item.covered_by_intent_index,
                reason: `Original no-effect list repair ${item.intent_index} covered_by_verified_list_repair:${item.covered_by_intent_index}.`,
              })
            for (const item of proof.success.zero_list_coverage)
              observations.push({
                path: item.path,
                outcome: "success",
                intent_index: item.intent_index,
                covered_by_intent_index: item.covered_by_intent_index,
                reason:
                  "Original rejected or no-effect request retained; its whole-page successor physically preserves visible zero.",
              })
            if (proof.success.acknowledged_root_create !== undefined)
              observations.push({
                path: `v1/pages/${receipt.page_id}`,
                outcome: "success",
                intent_index: proof.success.acknowledged_root_create,
                proof_kind: "acknowledged_root_create",
                reason: `acknowledged_root_create: completed root intent ${proof.success.acknowledged_root_create} retains its exact original marker and source identity.`,
              })
            for (const index of proof.success.acknowledged_child_creates)
              observations.push({
                path: `v1/pages/${String(property(proofReceipt.intents[index]!.response).id)}`,
                outcome: "success",
                intent_index: index,
                proof_kind: "acknowledged_child_create",
                reason: `acknowledged_child_create: completed child intent ${index} retains its exact original parent and References binding.`,
              })
          } else observations.push({ path: `v1/pages/${receipt.page_id}`, ...proof.success })
        }
        if (!completedHash)
          for (const item of coverage)
            observations.push({
              path: item.path,
              outcome: "unknown",
              intent_index: item.intent_index,
              reason:
                "Acknowledged block replacement coverage lacks a completed publication proof.",
            })
        if (!completedHash)
          for (const item of propertyCoverage)
            observations.push({
              path: item.path,
              outcome: "unknown",
              intent_index: item.intent_index,
              reason:
                item.basis === "oversized_legacy_references"
                  ? "Original over-limit References history lacks a verified whole-field replacement proof."
                  : "Terminal no-effect property history lacks a completed publication proof.",
            })
        if (hasRetainedUpload && !completedHash)
          observations.push({
            path: `v1/pages/${receipt.page_id}`,
            outcome: "unknown",
            reason:
              "The retained old upload requires a fully verified replacement before completion.",
          })
        if (!completedHash && (markdownCoverage.length > 0 || hasMarkdownCorrection))
          observations.push({
            path: `v1/pages/${receipt.page_id}`,
            outcome: "unknown",
            reason: "PUBLICATION_MARKDOWN_SUCCESSOR_PROOF_REQUIRED",
          })
        if (codeAlias && !completedHash)
          observations.push({
            path: codeAlias.path,
            outcome: "unknown",
            intent_index: codeAlias.intent_index,
            reason: "PUBLICATION_CODE_LANGUAGE_CHECKPOINT_UNPROVEN",
          })
        if (hasListRepairs && !completedHash)
          observations.push({
            path: receipt.intents.findLast((intent) => intent.list_start_repair)!.path,
            outcome: "unknown",
            reason: "PUBLICATION_LIST_REPAIR_PROOF_REQUIRED",
          })
        if (terminalCommit && !terminalCommitVerified)
          observations.push({
            path: `v1/pages/${receipt.page_id}`,
            outcome: "unknown",
            reason:
              "The terminal commit requires complete original business-effect and snapshot proof.",
          })
        if (
          terminalCommit &&
          terminalCommitVerified &&
          completedHash &&
          proofReceipt &&
          observations.every((item) => item.outcome === "success")
        ) {
          // Reconciliation is read-only remotely. Preserve the unknown request;
          // ordinary resume must independently prove it again before a new send.
          const retainedAgain = yield* store.readJson(keyFor(operationId), ReceiptSchema)
          if (!retainedAgain || canonical(retainedAgain) !== canonical(proofReceipt))
            return yield* Effect.fail(
              fail(
                "PUBLICATION_UNRESOLVED",
                "The original terminal commit receipt changed during reconciliation.",
              ),
            )
          if (fenced) {
            receipt.conflict_history = [
              ...(receipt.conflict_history ?? []),
              {
                observed_at_ms: yield* Clock.currentTimeMillis,
                conflict: true,
                state: fenced.state,
                stages: [...fenced.stages],
                ...(fenced.failure ? { failure: copy(fenced.failure) } : {}),
                guard_paths: Object.keys(fenced.guards),
                intent_count: fenced.intents.length,
                intended_hash: completedHash,
              },
            ]
            delete receipt.conflict
          }
          receipt.state = "unknown"
          delete receipt.owner
          yield* store.writeJson(keyFor(operationId), copy(receipt))
          observations.push({
            path: `v1/pages/${receipt.page_id}`,
            outcome: "success",
            intent_index: terminalCommit.intent_index,
            reason:
              "The original terminal commit is proven unapplied; its complete business content matches the durable commit.",
          })
          return {
            operation_id: operationId,
            kind: "publication" as const,
            state: receipt.state,
            outcome: "needs_safe_resume" as const,
            observations,
            verified: false,
            unresolved: true,
            next: { argv: ["ntn-skills", "operation", "resume", operationId] },
          }
        }
        if (fenced && originalObservedMarkdownCorrectionCandidate(fenced)) {
          const corrected = yield* proveObservedMarkdownNoEffect(fenced, api, "initial").pipe(
            Effect.result,
          )
          if (corrected._tag === "Success") {
            const durable = yield* store.readJson(keyFor(operationId), ReceiptSchema)
            if (
              !durable ||
              canonical(durable) !== canonical(fenced) ||
              canonical(receipt) !== canonical(fenced)
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_MARKDOWN_CORRECTION_UNPROVEN",
                  "The original receipt changed before its correction could be recorded.",
                ),
              )
            const nextReceipt = copy(fenced)
            nextReceipt.conflict_history = [
              ...(fenced.conflict_history ?? []),
              {
                observed_at_ms: yield* Clock.currentTimeMillis,
                conflict: true,
                state: fenced.state,
                stages: [...fenced.stages],
                ...(fenced.failure ? { failure: copy(fenced.failure) } : {}),
                guard_paths: Object.keys(fenced.guards),
                intent_count: fenced.intents.length,
                intended_hash: corrected.success.evidence.intended_hash,
                observed_markdown_correction: corrected.success.evidence,
              },
            ]
            nextReceipt.state = "running"
            delete nextReceipt.conflict
            delete nextReceipt.owner
            yield* store.writeJson(keyFor(operationId), nextReceipt)
            return {
              operation_id: operationId,
              kind: "publication" as const,
              state: nextReceipt.state,
              outcome: "needs_safe_resume" as const,
              verified: false as const,
              unresolved: false,
              observations: [
                {
                  path: corrected.success.candidate.bodyPath,
                  outcome: "success" as const,
                  intent_index: 2,
                  reason:
                    "The original empty preimage is fully proved. The old derived observation and fence remain in history; a new exact original-body request is required.",
                },
              ],
              next: { argv: ["ntn-skills", "operation", "resume", operationId] },
            }
          }
          observations.push({
            path: `v1/pages/${receipt.page_id}`,
            outcome: "unknown",
            reason: corrected.failure.code,
            message: corrected.failure.message,
          })
        }
        const tableCheckpoint = fenced && completedTableRowCheckpointCandidate(fenced)
        if (
          fenced &&
          tableCheckpoint &&
          !completedHash &&
          !reassessedHash &&
          observations.some(
            (item) => item.path === tableCheckpoint.repair.path && item.outcome === "conflict",
          ) &&
          observations.some(
            (item) => item.path === tableCheckpoint.bodyPath && item.outcome === "conflict",
          ) &&
          observations.every(
            (item) =>
              item.outcome === "success" ||
              (item.outcome === "conflict" && tableCheckpoint.checkpointPaths.includes(item.path)),
          )
        ) {
          // Prove this original ACK from fresh reads. Its audit certificate is
          // never authority to refresh guards on a subsequent reconciliation.
          const checkpoint = yield* proveCompletedTableRowCheckpoint(fenced, api).pipe(
            Effect.result,
          )
          const durable = yield* store.readJson(keyFor(operationId), ReceiptSchema)
          if (
            !durable ||
            canonical(durable) !== canonical(fenced) ||
            canonical(receipt) !== canonical(fenced)
          )
            return yield* Effect.fail(
              fail(
                "PUBLICATION_TABLE_ROW_CHECKPOINT_UNPROVEN",
                "The original receipt changed before table checkpoint reconciliation could finish.",
              ),
            )
          if (checkpoint._tag === "Success") {
            const proof = checkpoint.success
            if (
              canonical(proof.before_guards) !== canonical(fenced.guards) ||
              proof.checkpoints.length !== 3 ||
              new Set(proof.checkpoints.map((item) => item.path)).size !== 3 ||
              proof.checkpoints.some(
                (item) =>
                  !tableCheckpoint.checkpointPaths.includes(item.path) ||
                  canonical(item.before) !== canonical(fenced.guards[item.path]),
              )
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_TABLE_ROW_CHECKPOINT_UNPROVEN",
                  "The proved table checkpoints differ from the original three guards.",
                ),
              )
            const nextReceipt = copy(fenced)
            for (const item of proof.checkpoints) nextReceipt.guards[item.path] = copy(item.after)
            nextReceipt.conflict_history = [
              ...(fenced.conflict_history ?? []),
              {
                observed_at_ms: yield* Clock.currentTimeMillis,
                conflict: true,
                state: fenced.state,
                stages: [...fenced.stages],
                ...(fenced.failure ? { failure: copy(fenced.failure) } : {}),
                guard_paths: Object.keys(fenced.guards),
                intent_count: fenced.intents.length,
                intended_hash: proof.evidence.intended_hash,
                completed_table_row_checkpoint: proof.evidence,
              },
            ]
            nextReceipt.state = "running"
            delete nextReceipt.conflict
            delete nextReceipt.owner
            yield* store.writeJson(keyFor(operationId), nextReceipt)
            return {
              operation_id: operationId,
              kind: "publication" as const,
              state: nextReceipt.state,
              outcome: "needs_safe_resume" as const,
              verified: false as const,
              unresolved: false,
              observations: observations.map((item) =>
                item.outcome === "conflict" && tableCheckpoint.checkpointPaths.includes(item.path)
                  ? {
                      ...item,
                      outcome: "success" as const,
                      intent_index: proof.evidence.intent_index,
                      reason:
                        "completed_table_row_checkpoint: the original source-bound row ACK proves these checkpoints; the original publication still requires resume.",
                    }
                  : item,
              ),
              next: { argv: ["ntn-skills", "operation", "resume", operationId] },
            }
          }
          observations.push({
            path: tableCheckpoint.repair.path,
            outcome: "unknown",
            reason: checkpoint.failure.code,
            message: checkpoint.failure.message,
          })
        }
        const codeCheckpointPath = fenced?.page_id
          ? `v1/pages/${fenced.page_id}/markdown`
          : undefined
        if (
          fenced &&
          codeCheckpointPath &&
          !fenced.owner &&
          !completedHash &&
          !reassessedHash &&
          fenced.intents.length === 4 &&
          fenced.intents.at(-1)?.method === "PATCH" &&
          /^v1\/blocks\/[^/]+$/.test(fenced.intents.at(-1)!.path) &&
          observations.filter((item) => item.outcome === "conflict").length === 1 &&
          observations.some(
            (item) => item.path === codeCheckpointPath && item.outcome === "conflict",
          ) &&
          observations.every(
            (item) =>
              item.outcome === "success" ||
              (item.path === codeCheckpointPath && item.outcome === "conflict"),
          )
        ) {
          // This separate fresh proof binds the sole missing checkpoint to its
          // real ACK and frozen source. The ordinary completed proof stays strict.
          const checkpoint = yield* proveCompletedCodeLanguageCheckpoint(fenced, api).pipe(
            Effect.result,
          )
          const durable = yield* store.readJson(keyFor(operationId), ReceiptSchema)
          if (
            !durable ||
            canonical(durable) !== canonical(fenced) ||
            canonical(receipt) !== canonical(fenced)
          )
            return yield* Effect.fail(
              fail(
                "PUBLICATION_CODE_LANGUAGE_CHECKPOINT_UNPROVEN",
                "The original receipt changed before language checkpoint reconciliation could finish.",
              ),
            )
          if (checkpoint._tag === "Success") {
            const proof = checkpoint.success
            if (
              canonical(proof.before_guards) !== canonical(fenced.guards) ||
              proof.checkpoint.path !== codeCheckpointPath ||
              proof.checkpoint.before !== fenced.guards[codeCheckpointPath]
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_CODE_LANGUAGE_CHECKPOINT_UNPROVEN",
                  "The proved language checkpoint differs from its original guards.",
                ),
              )
            const nextReceipt = copy(fenced)
            nextReceipt.guards[codeCheckpointPath] = proof.checkpoint.after
            nextReceipt.conflict_history = [
              ...(fenced.conflict_history ?? []),
              {
                observed_at_ms: yield* Clock.currentTimeMillis,
                conflict: true,
                state: fenced.state,
                stages: [...fenced.stages],
                ...(fenced.failure ? { failure: copy(fenced.failure) } : {}),
                guard_paths: Object.keys(fenced.guards),
                intent_count: fenced.intents.length,
                intended_hash: proof.evidence.intended_hash,
                completed_code_language_checkpoint: proof.evidence,
              },
            ]
            nextReceipt.state = "running"
            delete nextReceipt.conflict
            delete nextReceipt.owner
            yield* store.writeJson(keyFor(operationId), nextReceipt)
            return {
              operation_id: operationId,
              kind: "publication" as const,
              state: nextReceipt.state,
              outcome: "needs_safe_resume" as const,
              verified: false as const,
              unresolved: false,
              observations: observations.map((item) =>
                item.path === codeCheckpointPath
                  ? {
                      ...item,
                      outcome: "success" as const,
                      intent_index: proof.evidence.intent_index,
                      reason:
                        "completed_code_language_checkpoint: the original plain-text ACK proves this owner checkpoint; the original publication still requires resume.",
                    }
                  : item,
              ),
              next: { argv: ["ntn-skills", "operation", "resume", operationId] },
            }
          }
          observations.push({
            path: codeCheckpointPath,
            outcome: "unknown",
            reason: checkpoint.failure.code,
            message: checkpoint.failure.message,
          })
        }
        // This branch advances one proven ACK checkpoint and requires a later
        // ordinary resume. It never treats the projected guard as body completion.
        const childCheckpointPath = fenced?.page_id
          ? `v1/pages/${fenced.page_id}/markdown`
          : undefined
        if (
          fenced &&
          childCheckpointPath &&
          fenced.operation === "create" &&
          !fenced.owner &&
          !completedHash &&
          !reassessedHash &&
          coverage.length === 0 &&
          propertyCoverage.length === 0 &&
          !hasListRepairs &&
          !codeAlias &&
          observations.filter((item) => item.outcome === "conflict").length === 1 &&
          observations.some(
            (item) => item.path === childCheckpointPath && item.outcome === "conflict",
          ) &&
          observations.every(
            (item) =>
              item.outcome === "success" ||
              (item.path === childCheckpointPath && item.outcome === "conflict"),
          )
        ) {
          // Use the original service, not the preceding observation cache. The
          // helper brackets fresh GETs and rechecks durable receipt/source/ledger.
          const checkpoint = yield* proveCompletedChildParentCheckpoint(fenced, api).pipe(
            Effect.result,
          )
          const retainedAgain = yield* store.readJson(keyFor(operationId), ReceiptSchema)
          if (!retainedAgain || canonical(retainedAgain) !== canonical(fenced))
            return yield* Effect.fail(
              fail(
                "PUBLICATION_CHILD_CHECKPOINT_UNPROVEN",
                "The durable receipt changed before checkpoint reconciliation could finish.",
              ),
            )
          if (checkpoint._tag === "Success") {
            const proof = checkpoint.success
            if (
              canonical(receipt) !== canonical(fenced) ||
              canonical(receipt.guards) !== canonical(proof.before_guards) ||
              proof.checkpoint.path !== childCheckpointPath ||
              proof.checkpoint.before !== fenced.guards[childCheckpointPath]
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_CHILD_CHECKPOINT_UNPROVEN",
                  "The retained checkpoint changed before its proof was consumed.",
                ),
              )
            const nextReceipt = copy(fenced)
            nextReceipt.guards[childCheckpointPath] = proof.checkpoint.after
            nextReceipt.conflict_history = [
              ...(fenced.conflict_history ?? []),
              {
                observed_at_ms: yield* Clock.currentTimeMillis,
                conflict: true,
                state: fenced.state,
                stages: [...fenced.stages],
                ...(fenced.failure ? { failure: copy(fenced.failure) } : {}),
                guard_paths: Object.keys(fenced.guards),
                intent_count: fenced.intents.length,
                intended_hash: proof.evidence.intended_hash,
                completed_child_checkpoint: proof.evidence,
              },
            ]
            nextReceipt.state = "running"
            delete nextReceipt.conflict
            delete nextReceipt.owner
            yield* store.writeJson(keyFor(operationId), nextReceipt)
            return {
              operation_id: operationId,
              kind: "publication" as const,
              state: nextReceipt.state,
              outcome: "needs_safe_resume" as const,
              observations: observations.map((item) =>
                item.path === childCheckpointPath
                  ? {
                      ...item,
                      outcome: "success" as const,
                      intent_index: proof.evidence.intent_index,
                      reason:
                        "completed_child_parent_checkpoint: original final child ACK proves this checkpoint; original publication still requires resume.",
                    }
                  : item,
              ),
              verified: false as const,
              unresolved: false,
              next: { argv: ["ntn-skills", "operation", "resume", operationId] },
            }
          }
        }
        let outcome:
          | "success"
          | "conflict"
          | "unknown"
          | "needs_safe_commit"
          | "needs_safe_resume" = observations.some((o) => o.outcome === "conflict")
          ? ("conflict" as const)
          : observations.some((o) => o.outcome === "unknown")
            ? ("unknown" as const)
            : ("success" as const)
        // A fence stays until a completed reassessment proves it. Matching pages are not proof.
        if (fenced && !reassessedHash && outcome === "success") outcome = "conflict"
        if (outcome === "conflict") {
          receipt.conflict = true
          receipt.state = "failed"
        } else if (outcome === "unknown") receipt.state = "unknown"
        else {
          for (const intent of settled) {
            if (unresolvedIntent(intent))
              intent.response = {
                ...property(intent.response),
                prior_status: intent.status,
                recovery: "observed_applied",
              }
            intent.status = "completed"
          }
          receipt.guards = expected
          if (receipt.state !== "completed") receipt.state = "running"
          if (receipt.page_id) {
            const raw = yield* api.request(`v1/pages/${receipt.page_id}`)
            const marker = publicationMarker(raw)
            const intent = yield* store.integrity.inspect(operationId)
            if (
              !intent ||
              !marker ||
              marker.operation_id !== operationId ||
              marker.intended_hash !== intent.intended_hash ||
              (completedHash !== undefined &&
                (canonical(metadata(raw)) !==
                  canonical(proofReceipt?.guards[`v1/pages/${receipt.page_id}`]) ||
                  !publicationMarkerAuthority(proofReceipt!, raw, intent, publicationMarker)))
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_UNRESOLVED",
                  "The observed completion marker does not match this operation's retained intended revision.",
                ),
              )
            if (
              marker?.state === "committed" &&
              marker.operation_id === operationId &&
              !receipt.intents.some((intent) => intent.typed_links?.state === "pending")
            ) {
              if (receipt.context?.ownership)
                yield* verifyPublicationOwnership(raw, receipt.context.ownership)
              yield* verifyPublicationMetadata(receipt, api)
              const snapshot = yield* openSkill(receipt.page_id, {
                database: receipt.database_id,
                refresh: true,
              }).pipe(Effect.provideService(PublicationReadOperation, operationId))
              receipt.state = "completed"
              receipt.result = {
                ...receipt.result,
                ...snapshotInfo(snapshot),
                operation_id: operationId,
                operation:
                  receipt.context?.write_path === "@properties" ? "update" : receipt.operation,
                verified: true,
              }
              if (!reassessedHash) delete receipt.failure
            } else if (
              marker?.state === "writing" &&
              marker.operation_id === operationId &&
              !receipt.intents.some(unresolvedIntent) &&
              (receipt.context?.write_path === "@properties" || receipt.stages.includes("verify"))
            ) {
              outcome = "needs_safe_commit"
            }
          }
          if (receipt.intents.some((intent) => intent.typed_links?.state === "pending")) {
            receipt.state = "running"
            outcome = "needs_safe_resume"
          }
        }
        const terminalOrphan = receipt.intents.at(-1)
        const provedOrphan =
          fenced &&
          reassessedHash &&
          completedHash &&
          terminalOrphan &&
          retainedTerminalUploadOrphan(receipt, terminalOrphan) &&
          observations.every((item) => item.outcome === "success")
            ? yield* proveRetainedTerminalUploadOrphan(receipt).pipe(Effect.result)
            : undefined
        if (provedOrphan?._tag === "Failure") return yield* Effect.fail(provedOrphan.failure)
        if (fenced && reassessedHash && provedOrphan?._tag === "Success") {
          receipt.conflict_history = [
            ...(receipt.conflict_history ?? []),
            {
              observed_at_ms: yield* Clock.currentTimeMillis,
              conflict: true,
              state: fenced.state,
              stages: [...fenced.stages],
              ...(fenced.failure ? { failure: copy(fenced.failure) } : {}),
              guard_paths: Object.keys(fenced.guards),
              intent_count: fenced.intents.length,
              intended_hash: reassessedHash,
              ...(aliasCheckpoint ? { canonical_code_language_checkpoint: aliasCheckpoint } : {}),
            },
          ]
          delete receipt.conflict
          receipt.state = "unknown"
          outcome = "needs_safe_resume"
        } else if (fenced && reassessedHash) {
          receipt.conflict_history = [
            ...(receipt.conflict_history ?? []),
            {
              observed_at_ms: yield* Clock.currentTimeMillis,
              conflict: true,
              state: fenced.state,
              stages: [...fenced.stages],
              ...(fenced.failure ? { failure: copy(fenced.failure) } : {}),
              guard_paths: Object.keys(fenced.guards),
              intent_count: fenced.intents.length,
              intended_hash: reassessedHash,
              ...(aliasCheckpoint ? { canonical_code_language_checkpoint: aliasCheckpoint } : {}),
            },
          ]
          delete receipt.conflict
        }
        if (outcome !== "conflict") {
          for (const path of coveredInventories) {
            if (expected[path] !== undefined) receipt.guards[path] = expected[path]
          }
          if (fenced && reassessedHash && provedOrphan?._tag === "Success") delete receipt.conflict
        }
        delete receipt.owner
        yield* store.writeJson(keyFor(operationId), copy(receipt))
        const next =
          outcome === "conflict" ||
          (receipt.context?.write_path === "@properties" && receipt.state === "completed")
            ? { argv: ["ntn-skills", "read", receipt.page_id ?? operationId, "--refresh"] }
            : observations.some((item) => item.reason === "PUBLICATION_UPLOAD_RECOVERY_REQUIRED") ||
                observations.some(
                  (item) =>
                    item.reason ===
                    "Original unknown retained as a remote orphan; replacement is a separate suboperation.",
                )
              ? { argv: ["ntn-skills", "operation", "resume", operationId, "--new-artifact"] }
              : {
                  argv: [
                    "ntn-skills",
                    "operation",
                    outcome === "unknown" &&
                    !observations.some((item) => item.reason === "PUBLICATION_BLOCK_RETRY_REQUIRED")
                      ? "reconcile"
                      : "resume",
                    operationId,
                  ],
                }
        return {
          operation_id: operationId,
          kind: "publication" as const,
          state: receipt.state,
          outcome,
          observations,
          verified: outcome === "success" && receipt.state === "completed",
          unresolved: outcome === "unknown",
          next,
        }
      }),
    )
  })
}
