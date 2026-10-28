import { Clock, Effect, Schema } from "effect"
import { locallySelectedScope, recordScope } from "./cache.ts"
import { authScope } from "./catalog.ts"
import {
  DatabaseSchema,
  PageSchema,
  decode,
  fail,
  listSchema,
  property,
  SkillsError,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { publicationMarker, publicationOwnership } from "./publication-integrity.ts"
import { fileRef, pageId } from "./ref.ts"
import {
  SubscriptionSchema,
  type Subscription,
  type UpstreamBinding,
  type UpstreamOperation,
  type UpstreamPlan,
} from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import { getSubscription } from "./upstream-subscription.ts"
import { SUBSCRIPTION_ROUTER_MIN_MEMBERS } from "./upstream-router.ts"

const MemberMetadataSchema = Schema.Struct({
  page_id: Schema.String,
  member_key: Schema.String,
  publication: Schema.Literals(["writing", "committed", "unknown"]),
  mode: Schema.Literals(["tracked", "fork", "unknown"]),
  ownership_matches: Schema.NullOr(Schema.Boolean),
  content_hash: Schema.String,
  version: Schema.NullOr(Schema.String),
})
const FailureSchema = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  message: Schema.String,
})
export const UpstreamObservationSchema = Schema.Struct({
  subscription: SubscriptionSchema,
  observed_at: Schema.Number,
  members: Schema.Array(MemberMetadataSchema),
  failed_sources: Schema.Array(FailureSchema),
  directory_observed: Schema.Boolean,
})
type Observation = typeof UpstreamObservationSchema.Type
const keyOf = (scope: string, id: string) => `upstream-observation:${scope}:${id}`
const ownerKey = (subscription: Subscription, key: string) => {
  const prefix = subscription.source.strip_prefix?.replace(/\/$/, "")
  const relative = prefix && key.startsWith(prefix + "/") ? key.slice(prefix.length + 1) : key
  return subscription.source.target_prefix
    ? `${subscription.source.target_prefix}/${relative}`
    : relative
}

/** Metadata evidence only: a committed pointer is not a fresh verification of member file bytes. */
export function upstreamStateView(input: {
  readonly subscription_id: string
  readonly observation?: Observation
  readonly now: number
  readonly online: boolean
  readonly bindings: readonly UpstreamBinding[]
  readonly operations: readonly UpstreamOperation[]
  readonly plans: readonly UpstreamPlan[]
}) {
  const observed = input.observation,
    subscription = observed?.subscription
  const published = subscription?.published
  const activeMap = new Map(published?.members.map((member) => [member.member_key, member]) ?? [])
  const keys = new Set([
    ...activeMap.keys(),
    ...input.bindings.map((member) => member.member_key),
    ...input.plans.flatMap((plan) => plan.items.map((member) => member.member_key)),
    ...input.operations.flatMap((operation) => operation.items.map((member) => member.member_key)),
    ...(observed?.members.map((member) => member.member_key) ?? []),
  ])
  const members = [...keys].sort().map((member_key) => {
    const active = activeMap.get(member_key)
    const binding = input.bindings.find((member) => member.member_key === member_key)
    const planned = input.plans
      .flatMap((plan) => plan.items)
      .filter((member) => member.member_key === member_key)
    const operations = input.operations.flatMap((operation) =>
      operation.items
        .filter((member) => member.member_key === member_key)
        .map((item) => ({ operation_id: operation.operation_id, ...item })),
    )
    const operationPages = [
      ...new Set(operations.flatMap((item) => (item.page_id ? [item.page_id] : []))),
    ]
    const page_id =
      active?.page_id ??
      binding?.page_id ??
      (operationPages.length === 1 ? operationPages[0] : undefined)
    const metadata = observed?.members.find(
      (member) => member.member_key === member_key && (!page_id || member.page_id === page_id),
    )
    const conflict =
      metadata?.ownership_matches === undefined || metadata.ownership_matches === null
        ? null
        : !metadata.ownership_matches
    const publication = metadata?.publication ?? "unknown"
    const mode = metadata?.mode ?? binding?.mode ?? "unknown"
    const isActive =
      !subscription || (active && (!metadata || metadata.ownership_matches === null))
        ? null
        : Boolean(
            active &&
              metadata?.ownership_matches &&
              publication === "committed" &&
              metadata.content_hash === active.content_hash,
          )
    return {
      member_key,
      ...((page_id ?? metadata?.page_id) ? { page_id: page_id ?? metadata?.page_id } : {}),
      candidate: planned.length ? planned.some((item) => item.candidate !== undefined) : null,
      publication,
      mode,
      conflict,
      active: isActive,
      evidence: {
        metadata_observed: Boolean(metadata),
        ...(metadata ? { version: metadata.version, content_hash: metadata.content_hash } : {}),
        local_binding: Boolean(binding),
        plan_ids: input.plans
          .filter((plan) => plan.items.some((item) => item.member_key === member_key))
          .map((plan) => plan.plan_id),
        operations,
      },
    }
  })
  const activeMembers = members.filter((member) => member.active === true)
  let availability: "ready" | "partial" | "unavailable" | "unknown" = "unknown"
  if (subscription) {
    if (observed?.failed_sources.length) availability = "unknown"
    else if (
      subscription.removed ||
      !published ||
      published.members.length < SUBSCRIPTION_ROUTER_MIN_MEMBERS ||
      !["verified", "partial", "disabled"].includes(subscription.status)
    )
      availability = "unavailable"
    else {
      const mapped = published.members.map(
        (entry) => members.find((member) => member.member_key === entry.member_key)!,
      )
      if (mapped.some((member) => member.publication === "writing" || member.conflict))
        availability = "unavailable"
      else if (mapped.every((member) => member.active === true))
        availability =
          subscription.status === "partial" || members.some((member) => member.active !== true)
            ? "partial"
            : "ready"
    }
  }
  const failed_sources = observed?.failed_sources ?? []
  return {
    subscription_id: input.subscription_id,
    aggregate_status: subscription?.status ?? "unknown",
    members,
    router: {
      availability,
      exact_ref: fileRef(`upstream:${input.subscription_id}`, "ROUTER.md"),
      active_member_count: subscription ? activeMembers.length : null,
      active_member_ids: subscription ? activeMembers.map((member) => member.page_id!) : null,
      published_member_ids: subscription
        ? (published?.members.map((member) => member.page_id) ?? [])
        : null,
      membership_observed: Boolean(subscription),
      body_verified: false,
    },
    observation: {
      source: input.online ? "notion_metadata" : observed ? "local_observation" : "none",
      freshness: observed
        ? {
            validated_at: new Date(observed.observed_at).toISOString(),
            age_ms: input.now - observed.observed_at,
            current: input.online,
          }
        : { current: false },
      directory: observed?.directory_observed ? "observed" : "unknown",
      member_bodies_read: false,
    },
    failed_sources,
    coverage: {
      complete: Boolean(observed?.directory_observed) && failed_sources.length === 0,
      directory_observed: observed?.directory_observed ?? false,
      observed_member_ids: observed?.members.map((member) => member.page_id) ?? [],
    },
  }
}

function localEvidence(id: string, scope: string | undefined) {
  return Effect.gen(function* () {
    const state = yield* UpstreamState
    const operations = scope
      ? (yield* state.operations(id)).filter((operation) => operation.scope === scope)
      : []
    const plans: UpstreamPlan[] = []
    for (const operation of operations) {
      const plan = yield* state.plan(operation.plan_id)
      if (plan && plan.scope === scope) plans.push(plan)
    }
    // Bindings have no scope field; only expose bindings backed by this scope's frozen plan/operation.
    const known = new Set(plans.flatMap((plan) => plan.items.map((item) => item.member_key)))
    const bindings = scope
      ? (yield* state.bindings(id)).filter((binding) => known.has(binding.member_key))
      : []
    const projections = []
    for (const operation of operations) {
      const projection = yield* state.command(`${operation.operation_id}:projections`)
      if (projection) projections.push(projection)
    }
    return { bindings, operations, plans, projections }
  })
}
export function statusUpstreamObservation(subscriptionId: string) {
  return Effect.gen(function* () {
    const id = pageId(subscriptionId)
    if (!id) return yield* Effect.fail(fail("EXACT_TARGET_REQUIRED", "Use a subscription UUID."))
    const scope = yield* locallySelectedScope()
    const saved = scope ? yield* (yield* UpstreamState).command(keyOf(scope, id)) : undefined
    const observation =
      saved === undefined
        ? undefined
        : yield* Effect.try({
            try: () => Schema.decodeUnknownSync(UpstreamObservationSchema)(saved),
            catch: () => fail("STATE_CORRUPT", "Invalid saved upstream observation."),
          })
    const evidence = yield* localEvidence(id, scope)
    const state = upstreamStateView({
      subscription_id: id,
      observation,
      now: yield* Clock.currentTimeMillis,
      online: false,
      ...evidence,
    })
    return {
      subscription: observation?.subscription ?? null,
      bindings: evidence.bindings,
      operations: evidence.operations,
      projections: evidence.projections,
      state,
    }
  })
}
export function checkUpstreamObservation(subscriptionId: string) {
  return Effect.gen(function* () {
    const scope = yield* authScope.pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          failed_sources: [{ id: "selected_auth", code: error.code }],
          coverage: { complete: false, directory_observed: false },
        }),
      ),
    )
    const subscription = yield* getSubscription(subscriptionId).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          failed_sources: [{ id: subscriptionId, code: error.code }],
          coverage: { complete: false, directory_observed: false },
        }),
      ),
    )
    const api = yield* Notion
    const members: Array<typeof MemberMetadataSchema.Type> = [],
      failed_sources: Array<typeof FailureSchema.Type> = []
    const publisherId =
      subscription.published?.publisher_subscription_id ??
      subscription.source.publisher_subscription_id ??
      subscription.subscription_id
    let directory_observed = false
    const targetSources: string[] = []
    const inspect = (raw: unknown) =>
      Effect.try({
        try: () => {
          const page = decode(PageSchema, raw),
            owner = publicationOwnership(raw),
            marker = publicationMarker(raw)
          const active = subscription.published?.members.find(
            (member) => member.page_id === page.id,
          )
          const prefix = subscription.source.target_prefix
          const relative =
            prefix && owner.key.startsWith(prefix + "/")
              ? owner.key.slice(prefix.length + 1)
              : owner.key
          const key =
            active?.member_key ??
            (subscription.source.strip_prefix
              ? `${subscription.source.strip_prefix.replace(/\/$/, "")}/${relative}`
              : relative)
          if (!key) return undefined
          const parent = property(property(raw).parent)
          const relationKnown =
            page.properties.Upstream !== undefined &&
            (typeof parent.data_source_id === "string" || typeof parent.database_id === "string")
          const targetMatches =
            parent.database_id === subscription.target_database_id ||
            (typeof parent.data_source_id === "string" &&
              targetSources.includes(parent.data_source_id))
          return {
            page_id: page.id,
            member_key: key,
            publication: marker?.state ?? "unknown",
            mode: owner.mode === "fork" ? "fork" : owner.mode === "tracked" ? "tracked" : "unknown",
            ownership_matches: relationKnown
              ? !page.in_trash &&
                targetMatches &&
                owner.upstream.length === 1 &&
                pageId(owner.upstream[0]!) === publisherId &&
                owner.key === ownerKey(subscription, key) &&
                (!active || owner.hash === active.content_hash) &&
                (property(page.properties.Kind).type === undefined ||
                  property(page.properties.Kind).select === null ||
                  property(property(page.properties.Kind).select).name === "skill")
              : null,
            content_hash: owner.hash,
            version:
              typeof property(raw).last_edited_time === "string"
                ? String(property(raw).last_edited_time)
                : null,
          } as typeof MemberMetadataSchema.Type
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_RESPONSE", "Invalid upstream member metadata."),
      })
    const targetDatabase = yield* api
      .request(`v1/databases/${subscription.target_database_id}`)
      .pipe(Effect.result)
    if (targetDatabase._tag === "Failure")
      return yield* Effect.fail(
        fail(targetDatabase.failure.code, targetDatabase.failure.message, {
          failed_sources: [
            { id: subscription.target_database_id, code: targetDatabase.failure.code },
          ],
          coverage: { complete: false, directory_observed: false },
        }),
      )
    const rows = yield* Effect.gen(function* () {
      const db = yield* Effect.try({
        try: () => decode(DatabaseSchema, targetDatabase.success),
        catch: () => fail("INVALID_RESPONSE", "Invalid upstream target database metadata."),
      })
      if (db.in_trash || db.data_sources.length === 0)
        return yield* Effect.fail(
          fail(
            "UPSTREAM_ROUTER_UNAVAILABLE",
            "The selected target database has no active observable directory.",
          ),
        )
      targetSources.push(...db.data_sources.map((source) => source.id))
      for (const source of db.data_sources) {
        const cursors = new Set<string>()
        let cursor: string | undefined
        while (true) {
          const raw = yield* api.request(`v1/data_sources/${source.id}/query`, {
            page_size: 100,
            filter: { property: "Upstream", relation: { contains: publisherId } },
            ...(cursor ? { start_cursor: cursor } : {}),
          })
          const page = yield* Effect.try({
            try: () => decode(listSchema(Schema.Unknown), raw),
            catch: () => fail("INVALID_RESPONSE", "Invalid upstream member directory metadata."),
          })
          for (const row of page.results) {
            const member = yield* inspect(row)
            if (member) members.push(member)
          }
          if (!page.has_more) break
          if (!page.next_cursor || cursors.has(page.next_cursor))
            return yield* Effect.fail(
              fail("INVALID_RESPONSE", "Member metadata cursor repeated or disappeared."),
            )
          cursor = page.next_cursor
          cursors.add(cursor)
        }
      }
      directory_observed = true
    }).pipe(Effect.result)
    if (rows._tag === "Failure")
      failed_sources.push({
        id: subscription.target_database_id,
        code: rows.failure.code,
        message: rows.failure.message,
      })
    for (const active of subscription.published?.members ?? []) {
      if (members.some((member) => member.page_id === active.page_id)) continue
      const result = yield* Effect.gen(function* () {
        return yield* inspect(yield* api.request(`v1/pages/${active.page_id}`))
      }).pipe(Effect.result)
      if (result._tag === "Failure")
        failed_sources.push({
          id: active.page_id,
          code: result.failure.code,
          message: result.failure.message,
        })
      else if (result.success) members.push(result.success)
    }
    const now = yield* Clock.currentTimeMillis
    const observation: Observation = {
      subscription,
      observed_at: now,
      members,
      failed_sources,
      directory_observed,
    }
    yield* recordScope(scope)
    yield* (yield* UpstreamState).saveCommand(
      keyOf(scope, subscription.subscription_id),
      observation,
    )
    const evidence = yield* localEvidence(subscription.subscription_id, scope)
    const state = upstreamStateView({
      subscription_id: subscription.subscription_id,
      observation,
      now,
      online: true,
      ...evidence,
    })
    return {
      subscription_id: subscription.subscription_id,
      revision: subscription.published?.revision ?? subscription.source.accepted_ref ?? null,
      members: state.members,
      bindings: evidence.bindings,
      state,
      failed_sources: state.failed_sources,
      coverage: state.coverage,
    }
  })
}
