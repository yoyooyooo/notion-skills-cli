import { Effect } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Store, sha256 } from "./store.ts"
import { UpstreamState } from "./upstream-state.ts"
import { getSubscription } from "./upstream-subscription.ts"
import {
  publicationMemberKey,
  subscriptionConfigHash,
  targetKey,
  thawPortable,
} from "./upstream-content.ts"
import {
  publishMarkdownFiles,
  resumeMarkdownFilesPublication,
} from "./markdown-files-publication.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { openSkill, snapshotInfo } from "./snapshot.ts"
import { portableIdentity, snapshotAuthoredPortable } from "./export.ts"
import { PublicationReadOperation, publicationMarker } from "./publication-integrity.ts"
import { Notion } from "./notion.ts"
import { withLocalLocks } from "./local-locks.ts"
import { hostname } from "node:os"
import { canonical, metadata, metadataContent } from "./publication-observation.ts"
import { verifyPublicationMetadata } from "./publication-source.ts"

/** Explicit replacement attempt on a distinct page. Original unknown requests
 * remain untouched; only a completed new publication can move the parent pointer. */
export function publishUpstreamMarkdownFiles(
  planId: string,
  member: string,
  operationId: string,
  supersede?: string,
) {
  return Effect.gen(function* () {
    const state = yield* UpstreamState,
      store = yield* Store
    const plan = yield* state.plan(planId)
    if (!plan || (yield* authScope) !== plan.scope || !/^p_[a-zA-Z0-9-]{1,100}$/.test(operationId))
      return yield* Effect.fail(
        fail(
          "UPSTREAM_PLAN_NOT_FOUND",
          "Select the exact frozen source and a stable publication operation ID.",
        ),
      )
    const { plan_id: _id, plan_hash: _hash, ...body } = plan
    if ((yield* sha256(JSON.stringify(body))) !== plan.plan_hash)
      return yield* Effect.fail(fail("STATE_CORRUPT", "Original plan digest differs."))
    const index = plan.items.findIndex((item) => item.member_key === member),
      item = plan.items[index]
    if (!item?.candidate || !item.accepted || !item.content_hash)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select one complete original source member."),
      )
    return yield* withLocalLocks(
      store.root,
      [
        `upstream-plan:${planId}`,
        `upstream-subscription:${plan.subscription_id}`,
        ...plan.items.map((item) => `upstream-target:${item.target_key}`),
        ...(supersede ? [`publication:${supersede}`] : []),
      ],
      Effect.gen(function* () {
        const subscription = yield* getSubscription(plan.subscription_id)
        if (
          (yield* subscriptionConfigHash(subscription)) !== plan.config_hash ||
          !subscription.enabled ||
          subscription.removed ||
          targetKey(subscription, member) !== item.target_key
        )
          return yield* Effect.fail(
            fail("UPSTREAM_PLAN_STALE", "The original source configuration changed."),
          )
        const operation = yield* state.operation(planId),
          prior = operation?.items[index]
        if (
          !operation ||
          !prior ||
          !["unknown", "failed", "running", "pending"].includes(prior.status)
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_PLAN_STALE",
              "The selected original member is no longer pending publication.",
            ),
          )
        const binding = (yield* state.bindings(plan.subscription_id)).find(
          (binding) => binding.member_key === member,
        )
        if (binding || (yield* state.target(item.target_key)))
          return yield* Effect.fail(
            fail(
              "UPSTREAM_TARGET_CONFLICT",
              "An accepted target already owns this member; use its guarded update path.",
            ),
          )
        const portable = yield* thawPortable(item.candidate!)
        if ((yield* portableIdentity(portable)) !== item.content_hash)
          return yield* Effect.fail(fail("STATE_CORRUPT", "Original source identity differs."))
        const ownership = {
          subscription_id: plan.publisher_subscription_id,
          member_key: publicationMemberKey(subscription, member),
          mode: "tracked" as const,
          published_hash: item.content_hash,
          revision: plan.revision,
        }
        const intentKey = `markdown-files:member:${planId}:${index}`
        const previous = yield* state.command(intentKey)
        const sameAttempt =
          property(previous).operation_id === operationId &&
          prior.publication_operation_id === operationId
        const intent = {
          version: 1,
          plan_id: planId,
          member_key: member,
          operation_id: operationId,
          original_operation_id: operation.operation_id,
          original_publication_id: sameAttempt
            ? property(previous).original_publication_id
            : (prior.publication_operation_id ?? null),
          content_hash: item.content_hash,
          new_page: true,
        }
        if (previous && canonical(previous) !== canonical(intent)) {
          const previousId = property(previous).operation_id
          const old =
            typeof previousId === "string"
              ? yield* store.readJson(`publications/${previousId}.json`, PublicationReceiptSchema)
              : undefined
          const failure = property(old?.failure?.details)
          const rejected =
            old &&
            !old.page_id &&
            old.intents.length === 1 &&
            old.intents[0]!.status === "failed" &&
            failure.phase === "definitive_rejection" &&
            failure.http_status === 400
          if (!rejected) {
            if (
              !old?.page_id ||
              previousId !== supersede ||
              operationId === supersede ||
              old.state !== "unknown" ||
              !old.context?.markdown_files ||
              canonical(old.context.ownership) !== canonical(ownership)
            )
              return yield* Effect.fail(
                fail(
                  "UPSTREAM_OPERATION_BUSY",
                  "Resume the original operation or explicitly supersede its unknown file append on a distinct page.",
                ),
              )
            if (old.owner) {
              const owner = old.owner
              if (owner.host !== hostname())
                return yield* Effect.fail(
                  fail("PUBLICATION_BUSY", "The original publication belongs to another host."),
                )
              const alive = yield* Effect.sync(() => {
                try {
                  process.kill(owner.pid, 0)
                  return true
                } catch (error) {
                  return property(error).code !== "ESRCH"
                }
              })
              if (alive)
                return yield* Effect.fail(
                  fail("PUBLICATION_BUSY", "The original publication process is alive."),
                )
            }
            const unresolved = old.intents.filter((entry) =>
              ["unknown", "pending"].includes(entry.status),
            )
            if (
              unresolved.length !== 1 ||
              unresolved[0] !== old.intents.at(-1) ||
              unresolved[0]!.method !== "PATCH" ||
              !/^v1\/blocks\/[^/]+\/children$/.test(unresolved[0]!.path) ||
              old.operation !== "create"
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_UNRESOLVED",
                  "Only a known own page with one unknown terminal file append can be abandoned.",
                ),
              )
            const frozen = {
              kind: portable.kind,
              name: portable.name,
              description: portable.description,
              main: portable.main,
              files: item.candidate!.files.map((file) => ({ path: file.path, sha256: file.hash })),
            }
            if (canonical(old.portable) !== canonical(frozen))
              return yield* Effect.fail(
                fail(
                  "STATE_CORRUPT",
                  "The original page does not contain this exact frozen source.",
                ),
              )
            const root = `v1/pages/${old.page_id}`,
              current = yield* (yield* Notion).request(root)
            const marker = publicationMarker(current)
            if (
              marker?.state !== "writing" ||
              marker.operation_id !== supersede ||
              canonical(metadataContent(metadata(current))) !==
                canonical(metadataContent(old.guards[root]))
            )
              return yield* Effect.fail(
                fail("WRITE_CONFLICT", "The abandoned page publication authority changed."),
              )
          }
          yield* state.createCommand(
            `${intentKey}:${rejected ? "rejected" : "abandoned"}:${previousId}`,
            previous,
          )
          yield* state.claimCommand(intentKey, previous, intent)
        } else if (!previous) yield* state.createCommand(intentKey, intent)
        const receipt = yield* store.readJson(
          `publications/${operationId}.json`,
          PublicationReceiptSchema,
        )
        let result: Record<string, unknown>
        if (receipt) {
          if (
            receipt.context?.markdown_files !== true ||
            JSON.stringify(receipt.context.ownership) !== JSON.stringify(ownership)
          )
            return yield* Effect.fail(
              fail("UPSTREAM_OPERATION_BUSY", "Publication identity belongs to another request."),
            )
          if (receipt.state !== "completed") yield* resumeMarkdownFilesPublication(operationId)
          const latest = yield* store.readJson(
            `publications/${operationId}.json`,
            PublicationReceiptSchema,
          )
          if (!latest?.page_id)
            return yield* Effect.fail(
              fail("PUBLICATION_UNRESOLVED", "The original file publication has no proven page."),
            )
          yield* verifyPublicationMetadata(latest, yield* Notion)
          const snapshot = yield* openSkill(latest.page_id, {
            database: plan.target_database_id,
            refresh: true,
          }).pipe(Effect.provideService(PublicationReadOperation, operationId))
          if (
            (yield* portableIdentity(yield* snapshotAuthoredPortable(snapshot))) !==
            item.content_hash
          )
            return yield* Effect.fail(
              fail("WRITE_CONFLICT", "The completed editable source changed."),
            )
          result = snapshotInfo(snapshot)
        } else
          result = yield* publishMarkdownFiles(portable, {
            database: plan.target_database_id,
            ownership,
            source: { type: "upstream" },
            operationId,
          })
        const pageId = property(property(result.record).locator).page_id
        if (typeof pageId !== "string")
          return yield* Effect.fail(
            fail("UPSTREAM_UNVERIFIED", "File publication has no exact content page."),
          )
        const marker = publicationMarker(yield* (yield* Notion).request(`v1/pages/${pageId}`))
        if (marker?.state !== "committed" || marker.operation_id !== operationId)
          return yield* Effect.fail(
            fail("UPSTREAM_UNVERIFIED", "File publication is not committed."),
          )
        yield* state.replacePublicationPointer(operation, index, undefined, operationId, pageId)
        return {
          ...result,
          verified: true,
          operation_id: operationId,
          original_plan_id: planId,
          member_key: member,
          next: ["ntn-skills", "sync", "upstream", "apply", planId, "--member", member],
        }
      }),
    )
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("MARKDOWN_FILES_FAILED", "Editable file publication failed."),
    ),
  )
}
