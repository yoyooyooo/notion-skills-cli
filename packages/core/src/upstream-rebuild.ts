import { Effect } from "effect"
import { authScope } from "./catalog.ts"
import { portableIdentity } from "./export.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import {
  publicationGuard,
  publicationMarker,
  publicationOwnership,
} from "./publication-integrity.ts"
import { canonical } from "./publication-observation.ts"
import { sha256, Store } from "./store.ts"
import {
  discover,
  freezePortable,
  publicationMemberKey,
  subscriptionConfigHash,
  targetKey,
  thawPortable,
} from "./upstream-content.ts"
import type { PortableSkill } from "./portable.ts"
import {
  UpstreamPublisher,
  type FrozenPortable,
  type PublishedMembers,
  type UpstreamBinding,
} from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import { getSubscription, publishSubscriptionMembers } from "./upstream-subscription.ts"
import { withLocalLocks } from "./local-locks.ts"
import { buildSourceMemberManifest, type SourceMemberManifest } from "./upstream-member-links.ts"
import { invalidateSubscriptionCatalog } from "./cache.ts"

const commandKey = (operationId: string) => `upstream-rebuild:${operationId}`

type SelectedRoot = {
  readonly page_id: string
  readonly publisher_subscription_id: string
  readonly binding?: UpstreamBinding
  readonly target?: { readonly page_id: string; readonly publisher_subscription_id: string }
}

type RebuildCommand = {
  readonly version: 1
  readonly operation_id: string
  readonly subscription_id: string
  readonly member_key: string
  readonly scope: string
  readonly config_hash: string
  readonly default_context: boolean
  readonly member_default_context?: boolean
  readonly member_tags?: readonly string[] | null
  readonly tags_write_requested?: true
  readonly tags_applied?: true
  readonly revision: string
  readonly provenance: Readonly<Record<string, string>>
  readonly publisher_subscription_id: string
  readonly target_database_id: string
  readonly target_key: string
  readonly publication_member_key: string
  readonly content_hash: string
  readonly candidate: FrozenPortable
  readonly accepted: FrozenPortable
  readonly projection?: PortableSkill["projection"]
  readonly source_manifest?: SourceMemberManifest
  readonly previous?: SelectedRoot
  readonly previous_map?: PublishedMembers | null
  readonly publication_operation_id: string
  readonly map?: PublishedMembers
  readonly map_status?: "verified" | "partial"
  readonly archive?: { readonly requested: true; readonly verified?: true }
  readonly restore_deleted?: true
  readonly state:
    | "frozen"
    | "archived"
    | "published"
    | "committed"
    | "mapped"
    | "verified"
    | "unknown"
    | "failed"
  readonly page_id?: string
}

const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)

/** Organization tags belong to the user, not to the upstream portable content. */
function pageTags(raw: unknown): readonly string[] | null {
  const tags = property(property(raw).properties).Tags
  if (tags === undefined) return null
  const value = property(tags)
  if (value.type !== "multi_select" || !Array.isArray(value.multi_select))
    throw fail("PROPERTY_UNAVAILABLE", "Tags must be an existing multi-select property.")
  const names = value.multi_select.map((item) => property(item).name)
  if (!names.every((name): name is string => typeof name === "string" && name.length > 0))
    throw fail("INVALID_RESPONSE", "Tags contains an invalid option name.")
  return [...new Set(names)].sort()
}

const readTags = (raw: unknown) =>
  Effect.try({ try: () => pageTags(raw), catch: (error) => error as SkillsError })

function selectedRoot(
  member: string,
  publisher: string,
  key: string,
  binding: UpstreamBinding | undefined,
  target: { readonly page_id: string; readonly publisher_subscription_id: string } | undefined,
  mapped: string | undefined,
): SelectedRoot | undefined {
  const ids = [binding?.page_id, target?.page_id, mapped].filter(
    (id): id is string => id !== undefined,
  )
  if (new Set(ids).size > 1)
    throw fail("UPSTREAM_TARGET_CONFLICT", "The selected member has inconsistent active roots.", {
      member,
    })
  if (binding && (binding.member_key !== member || binding.target_key !== key))
    throw fail("STATE_CORRUPT", "The selected binding does not match the current member.")
  if (target && target.publisher_subscription_id !== publisher)
    throw fail("UPSTREAM_TARGET_CONFLICT", "Another publisher owns the selected shared target.")
  if (!binding && !target && !mapped) return undefined
  return {
    page_id: ids[0]!,
    publisher_subscription_id: publisher,
    ...(binding ? { binding } : {}),
    ...(target ? { target } : {}),
  }
}

function owned(raw: unknown, publisher: string, member: string, pageId: string) {
  const page = property(raw)
  const parent = property(page.parent)
  if (
    page.id !== pageId ||
    typeof parent.data_source_id !== "string" ||
    typeof parent.database_id !== "string"
  )
    throw fail("UPSTREAM_UNVERIFIED", "The selected page has no exact parent.")
  const owner = publicationOwnership(raw)
  if (owner.upstream.length !== 1 || owner.upstream[0] !== publisher || owner.key !== member)
    throw fail(
      "UPSTREAM_TARGET_CONFLICT",
      "The selected page is not owned by this publisher and member.",
    )
  return {
    database_id: parent.database_id,
    data_source_id: parent.data_source_id,
    in_trash: page.in_trash === true,
  }
}

export function rebuildUpstream(
  subscriptionId: string,
  memberKey: string,
  operationId: string,
  options: { readonly restoreDeleted?: boolean } = {},
) {
  return Effect.gen(function* () {
    if (!/^p_[a-zA-Z0-9-]{1,100}$/.test(operationId))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Use one stable rebuild operation ID."))
    const state = yield* UpstreamState
    const store = yield* Store
    const api = yield* Notion
    const publisher = yield* UpstreamPublisher
    const scope = yield* authScope
    const subscription = yield* getSubscription(subscriptionId)
    if (!subscription.enabled || subscription.removed)
      return yield* Effect.fail(
        fail("UPSTREAM_PLAN_STALE", "The selected subscription is not active."),
      )
    const publisherId =
      subscription.source.publisher_subscription_id ?? subscription.subscription_id
    if (publisherId !== subscription.subscription_id)
      return yield* Effect.fail(
        fail(
          "UPSTREAM_TARGET_CONFLICT",
          "Rebuild must run on the shared target's publisher subscription.",
        ),
      )
    const key = targetKey(subscription, memberKey)
    const publishedKey = publicationMemberKey(subscription, memberKey)
    const locks = [
      `upstream-subscription:${subscription.subscription_id}`,
      `upstream-target:${key}`,
      `upstream-rebuild:${operationId}`,
    ]
    return yield* withLocalLocks(
      store.root,
      locks,
      Effect.gen(function* () {
        const current = yield* getSubscription(subscription.subscription_id)
        if (
          (yield* subscriptionConfigHash(current)) !== (yield* subscriptionConfigHash(subscription))
        )
          return yield* Effect.fail(
            fail("UPSTREAM_PLAN_STALE", "Subscription configuration changed before rebuild."),
          )
        const saved = property(
          yield* state.command(commandKey(operationId)),
        ) as Partial<RebuildCommand>
        const frozen = saved.version === 1 ? (saved as RebuildCommand) : undefined
        if (
          frozen &&
          (frozen.subscription_id !== current.subscription_id ||
            frozen.member_key !== memberKey ||
            frozen.scope !== scope)
        )
          return yield* Effect.fail(
            fail("UPSTREAM_OPERATION_MISMATCH", "This operation belongs to another rebuild."),
          )
        if (frozen && Boolean(frozen.restore_deleted) !== Boolean(options.restoreDeleted))
          return yield* Effect.fail(
            fail(
              "UPSTREAM_OPERATION_MISMATCH",
              "This operation belongs to a different rebuild mode.",
            ),
          )
        if (
          frozen &&
          (frozen.config_hash !== (yield* subscriptionConfigHash(current)) ||
            frozen.default_context !== current.default_context ||
            frozen.target_key !== key)
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_PLAN_STALE",
              "The source configuration changed after this rebuild began.",
            ),
          )
        const binding = (yield* state.bindings(current.subscription_id)).find(
          (item) => item.member_key === memberKey,
        )
        const target = yield* state.target(key)
        const mapped = current.published?.members.find(
          (item) => item.member_key === memberKey,
        )?.page_id
        const intended =
          frozen?.page_id === undefined
            ? undefined
            : {
                subscription_id: current.subscription_id,
                member_key: memberKey,
                target_key: key,
                page_id: frozen.page_id,
                generation: (frozen.previous?.binding?.generation ?? 0) + 1,
                mode: "tracked" as const,
                active: true,
                revision: frozen.revision,
                published_hash: frozen.content_hash,
                accepted: frozen.accepted,
                materialized: frozen.candidate,
              }
        const committed =
          intended !== undefined &&
          canonical(binding) === canonical(intended) &&
          canonical(target) ===
            canonical({ page_id: frozen!.page_id, publisher_subscription_id: publisherId })
        if (frozen?.state === "verified") {
          const active = current.published?.members.find((item) => item.member_key === memberKey)
          const completed = frozen.map?.members.find((item) => item.member_key === memberKey)
          if (!committed || !same(active, completed))
            return yield* Effect.fail(
              fail("UPSTREAM_PLAN_STALE", "The rebuilt member mapping has changed."),
            )
          return {
            operation_id: operationId,
            subscription_id: subscriptionId,
            member_key: memberKey,
            previous_page_id: frozen.previous?.page_id,
            page_id: frozen.page_id!,
            publication_operation_id: frozen.publication_operation_id,
            revision: frozen.revision,
            verified: true as const,
          }
        }
        const previous = committed
          ? frozen!.previous
          : yield* Effect.try({
              try: () => selectedRoot(memberKey, publisherId, key, binding, target, mapped),
              catch: (error) => error as SkillsError,
            })
        let command = frozen
        if (!command) {
          const snapshot = yield* discover(current)
          const source = snapshot.members.find((item) => item.member_key === memberKey)
          if (!source)
            return yield* Effect.fail(
              fail("INVALID_ARGUMENT", "The selected member is absent from the current source."),
            )
          const candidate = yield* freezePortable(source.portable)
          if ((yield* portableIdentity(yield* thawPortable(candidate))) !== source.content_hash)
            return yield* Effect.fail(
              fail("STATE_CORRUPT", "Frozen source bytes differ from the discovered member."),
            )
          const previousPage = previous
            ? yield* api.request(`v1/pages/${previous.page_id}`)
            : undefined
          const memberDefaultContext = previousPage
            ? publicationGuard(previousPage).default_context
            : false
          const memberTags = previousPage ? yield* readTags(previousPage) : null
          command = {
            version: 1,
            operation_id: operationId,
            subscription_id: current.subscription_id,
            member_key: memberKey,
            scope,
            config_hash: yield* subscriptionConfigHash(current),
            default_context: current.default_context,
            revision: snapshot.revision,
            provenance: snapshot.provenance,
            publisher_subscription_id: publisherId,
            target_database_id: current.target_database_id,
            target_key: key,
            publication_member_key: publishedKey,
            content_hash: source.content_hash,
            candidate,
            accepted: candidate,
            member_default_context: memberDefaultContext,
            member_tags: memberTags,
            source_manifest: yield* buildSourceMemberManifest(current.subscription_id, snapshot),
            ...(source.portable.projection ? { projection: source.portable.projection } : {}),
            ...(previous ? { previous } : {}),
            ...(options.restoreDeleted ? { restore_deleted: true as const } : {}),
            publication_operation_id: operationId,
            state: "frozen",
            previous_map: current.published,
          }
          yield* state.createCommand(commandKey(operationId), command)
        }
        if (!same(command.previous, previous) && !committed)
          return yield* Effect.fail(
            fail(
              "UPSTREAM_PLAN_STALE",
              "The selected member root changed after the rebuild was frozen.",
            ),
          )
        const portable = {
          ...(yield* thawPortable(command.candidate)),
          ...(command.projection ? { projection: command.projection } : {}),
        }
        const retain = (next: RebuildCommand) =>
          Effect.gen(function* () {
            command = next
            yield* state.saveCommand(commandKey(operationId), next)
          })
        if (command.member_default_context === undefined) {
          const memberDefaultContext = command.previous
            ? publicationGuard(yield* api.request(`v1/pages/${command.previous.page_id}`))
                .default_context
            : false
          yield* retain({ ...command, member_default_context: memberDefaultContext })
        }
        if (command.member_tags === undefined) {
          const memberTags = command.previous
            ? yield* readTags(yield* api.request(`v1/pages/${command.previous.page_id}`))
            : null
          yield* retain({ ...command, member_tags: memberTags })
        }
        if (!command.source_manifest) {
          const snapshot = yield* discover(current, command.revision)
          if (snapshot.revision !== command.revision)
            return yield* Effect.fail(
              fail("UPSTREAM_PLAN_STALE", "The frozen source revision is unavailable."),
            )
          yield* retain({
            ...command,
            source_manifest: yield* buildSourceMemberManifest(current.subscription_id, snapshot),
          })
        }
        if (command.restore_deleted) {
          if (!command.previous)
            return yield* Effect.fail(
              fail("INVALID_ARGUMENT", "Deleted-page restore requires the original member page."),
            )
          const raw = yield* api.request(`v1/pages/${command.previous.page_id}`)
          const identity = yield* Effect.try({
            try: () =>
              owned(
                raw,
                command!.publisher_subscription_id,
                command!.publication_member_key,
                command!.previous!.page_id,
              ),
            catch: (error) => error as SkillsError,
          })
          if (!identity.in_trash || identity.database_id !== command.target_database_id)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_TARGET_CONFLICT",
                "The selected member page is still available; restore does not replace it.",
              ),
            )
          if (publicationGuard(raw).default_context !== command.member_default_context)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_PLAN_STALE",
                "The selected member Default Context changed after freezing.",
              ),
            )
          if (!same(yield* readTags(raw), command.member_tags))
            return yield* Effect.fail(
              fail("UPSTREAM_PLAN_STALE", "The selected member Tags changed after freezing."),
            )
          if (command.archive?.verified !== true)
            yield* retain({
              ...command,
              archive: { requested: true, verified: true },
              state: "archived",
            })
        } else if (command.previous && command.archive?.verified !== true) {
          yield* retain({ ...command, archive: { requested: true }, state: "unknown" })
          const raw = yield* api.request(`v1/pages/${command.previous.page_id}`).pipe(Effect.result)
          if (raw._tag === "Failure")
            return yield* Effect.fail(
              raw.failure.code === "NOT_FOUND" || raw.failure.code === "ACCESS_DENIED"
                ? fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "Missing permission is not proof that the old page is in Trash.",
                    { operation_id: operationId },
                  )
                : raw.failure,
            )
          const identity = yield* Effect.try({
            try: () =>
              owned(
                raw.success,
                command!.publisher_subscription_id,
                command!.publication_member_key,
                command!.previous!.page_id,
              ),
            catch: (error) => error as SkillsError,
          })
          if (identity.database_id !== command.target_database_id)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_TARGET_CONFLICT",
                "The selected page is outside the subscription database.",
              ),
            )
          if (publicationGuard(raw.success).default_context !== command.member_default_context)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_PLAN_STALE",
                "The selected member Default Context changed after freezing.",
              ),
            )
          if (!same(yield* readTags(raw.success), command.member_tags))
            return yield* Effect.fail(
              fail("UPSTREAM_PLAN_STALE", "The selected member Tags changed after freezing."),
            )
          if (!identity.in_trash) {
            const trashed = yield* api
              .request(
                `v1/pages/${command.previous.page_id}`,
                { in_trash: true },
                { method: "PATCH" },
              )
              .pipe(Effect.result)
            if (trashed._tag === "Failure") {
              yield* retain({
                ...command,
                state: trashed.failure.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed",
              })
              return yield* Effect.fail(trashed.failure)
            }
          }
          const readback = yield* api.request(`v1/pages/${command.previous.page_id}`)
          const after = yield* Effect.try({
            try: () =>
              owned(
                readback,
                command!.publisher_subscription_id,
                command!.publication_member_key,
                command!.previous!.page_id,
              ),
            catch: (error) => error as SkillsError,
          })
          if (!after.in_trash)
            return yield* Effect.fail(
              fail("UPSTREAM_UNVERIFIED", "The selected old page was not verified in Trash."),
            )
          yield* retain({
            ...command,
            archive: { requested: true, verified: true },
            state: "archived",
          })
        }
        const ownership = {
          subscription_id: command.publisher_subscription_id,
          member_key: command.publication_member_key,
          mode: "tracked" as const,
          published_hash: command.content_hash,
          revision: command.revision,
        }
        const published = yield* publisher
          .publish({
            operation_id: command.publication_operation_id,
            portable,
            target_database_id: command.target_database_id,
            ownership,
            allow_same_name: true,
            default_context: command.member_default_context,
          })
          .pipe(
            Effect.tap((value) =>
              command!.page_id === value.page_id
                ? Effect.void
                : retain({ ...command!, page_id: value.page_id, state: "published" }),
            ),
            Effect.tapError((error) =>
              retain({
                ...command!,
                state: error.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed",
              }),
            ),
          )
        if (command.previous && published.page_id === command.previous.page_id)
          return yield* Effect.fail(fail("WRITE_CONFLICT", "Rebuild created no distinct page."))
        const rawPage = yield* api.request(`v1/pages/${published.page_id}`)
        const marker = publicationMarker(rawPage)
        if (
          marker?.state !== "committed" ||
          marker.operation_id !== command.publication_operation_id
        )
          return yield* Effect.fail(
            fail("UPSTREAM_UNVERIFIED", "The new native page is not committed."),
          )
        if (publicationGuard(rawPage).default_context !== command.member_default_context)
          return yield* Effect.fail(
            fail("UPSTREAM_UNVERIFIED", "The rebuilt member Default Context did not read back."),
          )
        if (command.member_tags !== null) {
          const expectedTags = command.member_tags!
          const actualTags = yield* readTags(rawPage)
          if (!same(actualTags, expectedTags)) {
            if (actualTags === null)
              return yield* Effect.fail(
                fail("PROPERTY_UNAVAILABLE", "The rebuilt member has no Tags property."),
              )
            if (command.tags_applied || actualTags.length > 0)
              return yield* Effect.fail(
                fail(
                  "WRITE_CONFLICT",
                  "The rebuilt member Tags were edited; do not replace the user's selection.",
                ),
              )
            if (command.tags_write_requested)
              return yield* Effect.fail(
                fail(
                  "WRITE_OUTCOME_UNKNOWN",
                  "The prior Tags write is not confirmed. Review the new page before another metadata write; an empty value may be a user edit.",
                ),
              )
            yield* retain({ ...command, tags_write_requested: true, state: "unknown" })
            yield* api
              .request(
                `v1/pages/${published.page_id}`,
                {
                  properties: { Tags: { multi_select: expectedTags.map((name) => ({ name })) } },
                },
                { method: "PATCH" },
              )
              .pipe(
                Effect.tapError((error) =>
                  retain({
                    ...command!,
                    state: error.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed",
                  }),
                ),
              )
            const after = yield* readTags(yield* api.request(`v1/pages/${published.page_id}`))
            if (!same(after, expectedTags))
              return yield* Effect.fail(
                fail("UPSTREAM_UNVERIFIED", "The rebuilt member Tags did not read back."),
              )
          }
          if (!command.tags_applied) {
            yield* invalidateSubscriptionCatalog(scope, command.target_database_id)
            yield* retain({ ...command, tags_applied: true })
          }
        }
        const nextBinding: UpstreamBinding = {
          subscription_id: command.subscription_id,
          member_key: command.member_key,
          target_key: command.target_key,
          page_id: published.page_id,
          generation: (command.previous?.binding?.generation ?? 0) + 1,
          mode: "tracked",
          active: true,
          revision: command.revision,
          published_hash: command.content_hash,
          accepted: command.accepted,
          materialized: command.candidate,
        }
        if (!committed) {
          yield* state.commitRebuild(
            nextBinding,
            command.previous?.binding,
            command.previous?.target,
            command.publisher_subscription_id,
            command.publication_operation_id,
            command.publication_member_key,
          )
          yield* retain({ ...command, page_id: published.page_id, state: "committed" })
        }
        const latest = yield* getSubscription(command.subscription_id)
        if (
          (yield* subscriptionConfigHash(latest)) !== command.config_hash ||
          latest.default_context !== command.default_context
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_PLAN_STALE",
              "Subscription configuration changed before member mapping.",
            ),
          )
        const others = (latest.published?.members ?? []).filter(
          (item) => item.member_key !== command!.member_key,
        )
        const baseline =
          (committed ? latest.published?.members : command.previous_map?.members) ?? []
        const originalOthers = baseline.filter((item) => item.member_key !== command!.member_key)
        if (!same(others, originalOthers) && !committed)
          return yield* Effect.fail(
            fail(
              "UPSTREAM_PLAN_STALE",
              "An unselected member changed while this rebuild was in progress.",
            ),
          )
        const status =
          command.map_status ??
          (latest.status === "verified" && latest.published ? "verified" : "partial")
        const selected = {
          member_key: command.member_key,
          page_id: published.page_id,
          content_hash: command.content_hash,
          revision: command.revision,
        }
        const pendingMap = command.state === "unknown" && command.map !== undefined
        const remoteSelected = latest.published?.members.find(
          (item) => item.member_key === command!.member_key,
        )
        const expectedSelected = pendingMap
          ? command.map!.members.find((item) => item.member_key === command!.member_key)
          : selected
        if (pendingMap && (!same(remoteSelected, expectedSelected) || latest.status !== status))
          return yield* Effect.fail(
            fail("WRITE_OUTCOME_UNKNOWN", "The pending member map was not confirmed.", {
              operation_id: operationId,
            }),
          )
        const map: PublishedMembers = command.map
          ? {
              ...(latest.published ?? command.map),
              members: [...others, selected].sort((a, b) =>
                a.member_key.localeCompare(b.member_key),
              ),
            }
          : {
              version: 1,
              revision: command.revision,
              plan_hash: command.content_hash,
              publisher_subscription_id: command.publisher_subscription_id,
              ...(command.source_manifest ? { source_manifest: command.source_manifest } : {}),
              members: [...others, selected].sort((a, b) =>
                a.member_key.localeCompare(b.member_key),
              ),
            }
        if (!command.map)
          yield* retain({
            ...command,
            page_id: published.page_id,
            map,
            map_status: status,
            state: "unknown",
          })
        if (!pendingMap && (!same(latest.published, map) || latest.status !== status)) {
          const mappedSubscription = yield* publishSubscriptionMembers(
            command.subscription_id,
            latest.version,
            map,
            status,
          ).pipe(Effect.result)
          if (mappedSubscription._tag === "Failure") {
            if (mappedSubscription.failure.code !== "WRITE_OUTCOME_UNKNOWN")
              return yield* Effect.fail(mappedSubscription.failure)
            const observed = yield* getSubscription(command.subscription_id)
            if (!same(observed.published, map) || observed.status !== status)
              return yield* Effect.fail(mappedSubscription.failure)
          }
        }
        const verified = yield* getSubscription(command.subscription_id)
        if (
          !same(verified.published, map) ||
          verified.status !== status ||
          verified.default_context !== command.default_context
        )
          return yield* Effect.fail(
            fail("UPSTREAM_UNVERIFIED", "The selected member map did not read back."),
          )
        yield* retain({
          ...command,
          page_id: published.page_id,
          map,
          map_status: status,
          state: "verified",
        })
        return {
          operation_id: operationId,
          subscription_id: command.subscription_id,
          member_key: command.member_key,
          previous_page_id: command.previous?.page_id,
          page_id: published.page_id,
          publication_operation_id: command.publication_operation_id,
          revision: command.revision,
          verified: true as const,
        }
      }),
    )
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("UPSTREAM_UNVERIFIED", "Selected upstream rebuild failed."),
    ),
  )
}

export function restoreDeletedUpstream(
  subscriptionId: string,
  memberKey: string,
  operationId: string,
) {
  return rebuildUpstream(subscriptionId, memberKey, operationId, { restoreDeleted: true })
}

export interface RestoredUpstreamMember {
  readonly operation_id: string
  readonly subscription_id: string
  readonly member_key: string
  readonly previous_page_id?: string
  readonly page_id: string
  readonly publication_operation_id: string
  readonly revision: string
  readonly verified: true
}

/** Daily run uses the existing rebuild receipt; a missing permission is never deletion evidence. */
export function restoreDeletedUpstreamMembers(subscriptionId: string) {
  return Effect.gen(function* () {
    const subscription = yield* getSubscription(subscriptionId)
    const publisherId =
      subscription.source.publisher_subscription_id ?? subscription.subscription_id
    if (publisherId !== subscription.subscription_id) return [] as RestoredUpstreamMember[]
    const state = yield* UpstreamState
    const api = yield* Notion
    const scope = yield* authScope
    const bindings = (yield* state.bindings(subscription.subscription_id)).filter(
      (binding) => binding.active,
    )
    const selected = new Map(
      bindings
        .filter((binding) => binding.mode === "tracked")
        .map((binding) => [binding.member_key, binding.page_id]),
    )
    for (const member of subscription.published?.members ?? [])
      if (!bindings.some((binding) => binding.member_key === member.member_key))
        selected.set(member.member_key, member.page_id)
    const restored: RestoredUpstreamMember[] = []
    let currentMembers: ReadonlySet<string> | undefined
    for (const [memberKey, pageId] of selected) {
      const mapped = subscription.published?.members.find(
        (member) => member.member_key === memberKey,
      )?.page_id
      let resumed = false
      const resumeRetained = (operationId: string) =>
        Effect.gen(function* () {
          const retained = property(yield* state.command(commandKey(operationId)))
          if (
            retained.version !== 1 ||
            retained.restore_deleted !== true ||
            retained.scope !== scope ||
            retained.subscription_id !== subscription.subscription_id ||
            retained.member_key !== memberKey ||
            retained.state === "verified"
          )
            return false
          restored.push(
            yield* restoreDeletedUpstream(subscription.subscription_id, memberKey, operationId),
          )
          return true
        })
      // The old active map survives a binding commit until its exact map write settles.
      for (const candidate of new Set([pageId, ...(mapped ? [mapped] : [])])) {
        const operationId = `p_restore-${yield* sha256(JSON.stringify([scope, subscription.subscription_id, memberKey, candidate]))}`
        if (yield* resumeRetained(operationId)) {
          resumed = true
          break
        }
      }
      if (resumed) continue
      const raw = yield* api.request(`v1/pages/${pageId}`)
      if (property(raw).id !== pageId)
        return yield* Effect.fail(
          fail("UPSTREAM_UNVERIFIED", "The current member metadata has another page identity."),
        )
      const marker = yield* Effect.try({
        try: () => publicationMarker(raw),
        catch: (error) => error as SkillsError,
      })
      // A lost final receipt write is recoverable from the new page's original publication ID.
      if (marker && (yield* resumeRetained(marker.operation_id))) continue
      if (property(raw).in_trash !== true) continue
      const owner = yield* Effect.try({
        try: () => publicationOwnership(raw),
        catch: (error) => error as SkillsError,
      })
      if (owner.mode === "fork") continue
      if (!currentMembers)
        currentMembers = new Set(
          (yield* discover(subscription)).members.map((member) => member.member_key),
        )
      // Source removal/exclusion keeps the old page; it does not recreate a deleted copy.
      if (!currentMembers.has(memberKey)) continue
      const operationId = `p_restore-${yield* sha256(JSON.stringify([scope, subscription.subscription_id, memberKey, pageId]))}`
      restored.push(
        yield* restoreDeletedUpstream(subscription.subscription_id, memberKey, operationId),
      )
    }
    return restored
  })
}
