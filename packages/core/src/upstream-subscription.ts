import { Crypto, Effect, Schema } from "effect"
import {
  validateDisplayName,
  DatabaseSchema,
  DataSourceSchema,
  PageSchema,
  decode,
  fail,
  listSchema,
  property,
  SkillsError,
  text,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { configuration, sha256 } from "./store.ts"
import { pageId } from "./ref.ts"
import {
  PublishedMembersSchema,
  strictDecode,
  strictJson,
  UpstreamCommandOperationSchema,
  SubscriptionAdoptionEvidenceSchema,
  type SubscriptionAdoptionEvidence,
  UpstreamSourceSchema,
  SubscriptionSyncSchema,
  type SubscriptionSync,
  type PublishedMembers,
  type Subscription,
  type SubscriptionInput,
} from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import { canonical } from "./publication-effect-proof.ts"
import { resolveDatabasePropertyIds } from "./database-init.ts"
import { authScope } from "./catalog.ts"
import type { UpstreamCommandOperation } from "./upstream-model.ts"
import { invalidateSnapshotCache, invalidateSubscriptionCatalog } from "./cache.ts"
import { sourceDisplayUrl } from "./upstream-source-model.ts"

const Strings = Schema.Array(Schema.String)
const Mapping = Schema.Record(Schema.String, Schema.String)
const SourceUrl = Schema.Struct({ type: Schema.Literal("url"), url: Schema.NullOr(Schema.String) })
const valueText = (
  props: Record<string, unknown>,
  name: string,
  type: "rich_text" | "title" = "rich_text",
) => {
  const p = property(props[name])
  if (p.type !== type || !Array.isArray(p[type]))
    throw fail("INVALID_UPSTREAM", `Subscription ${name} must be ${type}.`)
  return text(p[type])
}
const nativeTitle = (props: Readonly<Record<string, unknown>>) => {
  const titles = Object.values(props)
    .map(property)
    .filter((field) => field.type === "title")
  if (titles.length !== 1 || titles[0]!.id !== "title")
    throw fail(
      "DATABASE_SCHEMA_CONFLICT",
      "Subscription requires exactly one native title property.",
    )
  return titles[0]!
}
export function decodePublishedMembers(input: string): PublishedMembers | null {
  if (!input.trim()) return null
  const doc = strictJson(PublishedMembersSchema, input)
  if (
    !doc.revision ||
    !/^[a-f0-9]{64}$/.test(doc.plan_hash) ||
    pageId(doc.publisher_subscription_id) !== doc.publisher_subscription_id
  )
    throw fail(
      "INVALID_UPSTREAM",
      "Published Members requires an exact revision, publisher UUID and plan hash.",
    )
  const keys = new Set<string>(),
    pages = new Set<string>()
  for (const member of doc.members) {
    const id = pageId(member.page_id)
    if (
      !id ||
      id !== member.page_id ||
      !member.member_key ||
      keys.has(member.member_key) ||
      pages.has(id) ||
      !/^[a-f0-9]{64}$/.test(member.content_hash)
    )
      throw fail(
        "INVALID_UPSTREAM",
        "Published Members contains an invalid or duplicate active identity.",
      )
    keys.add(member.member_key)
    pages.add(id)
  }
  return doc
}
export function decodeSubscription(
  raw: unknown,
  databaseId: string,
  dataSourceId: string,
): Effect.Effect<Subscription, SkillsError, Crypto.Crypto> {
  return Effect.gen(function* () {
    const row = yield* Effect.try({
      try: () => decode(PageSchema, raw),
      catch: () => fail("INVALID_UPSTREAM", "Invalid subscription page."),
    })
    const decoded = yield* Effect.try({
      try: () => {
        const p = row.properties
        const checkbox = (name: string) => {
          const prop = property(p[name])
          if (prop.type !== "checkbox" || typeof prop.checkbox !== "boolean")
            throw fail("INVALID_UPSTREAM", `${name} must be checkbox.`)
          return prop.checkbox
        }
        if (
          property(p.Status).type !== "select" ||
          !["pending", "verified", "partial", "failed", "disabled"].includes(
            String(property(property(p.Status).select).name),
          )
        )
          throw fail("INVALID_UPSTREAM", "Subscription Status has an invalid select value.")
        const syncDate = (name: string) => {
          const start = property(property(p[name]).date).start
          return typeof start === "string" ? new Date(start).toISOString() : null
        }
        const sync =
          p["Sync Status"] === undefined
            ? undefined
            : strictDecode(SubscriptionSyncSchema, {
                status: property(property(p["Sync Status"]).select).name ?? null,
                attempted_at: syncDate("Last Sync Attempt"),
                succeeded_at: syncDate("Last Synced"),
                summary: valueText(p, "Sync Summary"),
              })
        const source = strictJson(UpstreamSourceSchema, valueText(p, "Source"))
        const ref = valueText(p, "Ref")
        if (source.provider.type === "git" && source.provider.ref !== ref)
          throw fail("INVALID_UPSTREAM", "Source Git ref and native Ref property disagree.")
        if (
          source.provider.type === "github-market" &&
          source.provider.ref !== undefined &&
          source.provider.ref !== ref
        )
          throw fail("INVALID_UPSTREAM", "Marketplace source ref and native Ref property disagree.")
        if (
          source.provider.type === "registry" &&
          source.provider.version !== undefined &&
          source.provider.version !== ref
        )
          throw fail("INVALID_UPSTREAM", "Registry version and native Ref property disagree.")
        const provider = source.provider
        const parent = property(property(raw).parent)
        if (parent.data_source_id !== dataSourceId)
          throw fail(
            "INVALID_UPSTREAM",
            "Subscription does not belong to the configured data source.",
          )
        return {
          subscription_id: pageId(row.id) ?? "",
          database_id: databaseId,
          data_source_id: dataSourceId,
          target_database_id: valueText(p, "Target Database ID"),
          name: validateDisplayName(text(nativeTitle(p).title)),
          description: valueText(p, "Description"),
          default_context: checkbox("Default Context"),
          enabled: checkbox("Enabled"),
          removed: row.in_trash === true,
          status: String(property(property(p.Status).select).name ?? ""),
          ...(sync ? { sync } : {}),
          source: { ...source, provider },
          ...(p["Source URL"] === undefined
            ? {}
            : { source_url: decode(SourceUrl, p["Source URL"]).url }),
          roots: strictJson(Strings, valueText(p, "Roots")),
          include: strictJson(Strings, valueText(p, "Include")),
          exclude: strictJson(Strings, valueText(p, "Exclude")),
          mapping: strictJson(Mapping, valueText(p, "Mapping")),
          published: decodePublishedMembers(valueText(p, "Published Members")),
        }
      },
      catch: (e) =>
        e instanceof SkillsError ? e : fail("INVALID_UPSTREAM", "Invalid subscription properties."),
    })
    if (!decoded.subscription_id || !pageId(decoded.target_database_id))
      return yield* Effect.fail(
        fail("INVALID_UPSTREAM", "Subscription and target require precise UUIDs."),
      )
    const version = yield* sha256(JSON.stringify([property(raw).last_edited_time, decoded]))
    return { ...decoded, version }
  })
}
export function resolveSubscriptionDatabase(databaseId?: string) {
  return Effect.gen(function* () {
    const config = yield* configuration
    const id = pageId(databaseId ?? config.upstream_database ?? "")
    if (!id)
      return yield* Effect.fail(
        fail("UPSTREAM_NOT_CONFIGURED", "Initialize the native subscription database first."),
      )
    const api = yield* Notion
    const raw = yield* api.request(`v1/databases/${id}`)
    const db = yield* Effect.try({
      try: () => decode(DatabaseSchema, raw),
      catch: () => fail("INVALID_UPSTREAM", "Invalid subscription database."),
    })
    if (db.in_trash || db.data_sources.length !== 1)
      return yield* Effect.fail(
        fail("INVALID_UPSTREAM", "Subscription database must have exactly one active data source."),
      )
    return { database_id: id, data_source_id: db.data_sources[0]!.id }
  })
}
export const subscriptionDatabase = resolveSubscriptionDatabase()
export function getSubscription(id: string, databaseId?: string) {
  return Effect.gen(function* () {
    const normalized = pageId(id)
    if (!normalized)
      return yield* Effect.fail(fail("EXACT_TARGET_REQUIRED", "Use a subscription UUID."))
    const db = yield* resolveSubscriptionDatabase(databaseId)
    const raw = yield* (yield* Notion).request(`v1/pages/${normalized}`)
    return yield* decodeSubscription(raw, db.database_id, db.data_source_id)
  })
}
export function listSubscriptionsInDatabase(databaseId?: string) {
  return Effect.gen(function* () {
    const db = yield* resolveSubscriptionDatabase(databaseId)
    const api = yield* Notion
    const rows: Subscription[] = [],
      cursors = new Set<string>()
    let cursor: string | undefined
    while (true) {
      const raw = yield* api.request(`v1/data_sources/${db.data_source_id}/query`, {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      const page = yield* Effect.try({
        try: () => decode(listSchema(Schema.Unknown), raw),
        catch: () => fail("INVALID_UPSTREAM", "Invalid subscription query response."),
      })
      for (const row of page.results)
        rows.push(yield* decodeSubscription(row, db.database_id, db.data_source_id))
      if (!page.has_more) return rows
      if (!page.next_cursor || cursors.has(page.next_cursor))
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "Subscription cursor repeated or disappeared."),
        )
      cursor = page.next_cursor
      cursors.add(cursor)
    }
  })
}
export const listSubscriptions = listSubscriptionsInDatabase()
const rich = (value: string) => ({
  rich_text: Array.from({ length: Math.ceil(value.length / 2000) }, (_, index) => ({
    type: "text",
    text: { content: value.slice(index * 2000, (index + 1) * 2000) },
  })),
})
function properties(input: SubscriptionInput | Subscription) {
  const provider = input.source.provider
  return {
    Name: { title: [{ type: "text", text: { content: input.name } }] },
    Description: rich(input.description),
    Source: rich(JSON.stringify(input.source)),
    "Source URL": {
      url: "subscription_id" in input ? (input.source_url ?? null) : sourceDisplayUrl(provider),
    },
    Ref: rich(
      provider.type === "git"
        ? provider.ref
        : provider.type === "github-market"
          ? (provider.ref ?? "HEAD")
          : (provider.version ?? "latest"),
    ),
    Roots: rich(JSON.stringify(input.roots)),
    Include: rich(JSON.stringify(input.include)),
    Exclude: rich(JSON.stringify(input.exclude)),
    Mapping: rich(JSON.stringify(input.mapping)),
    "Target Database ID": rich(input.target_database_id),
    Enabled: { checkbox: input.enabled },
    "Default Context": { checkbox: input.default_context },
  }
}
function propertyIds(dataSourceId: string, values: Readonly<Record<string, unknown>>) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/data_sources/${dataSourceId}`)
    yield* Effect.try({
      try: () => {
        const source = decode(DataSourceSchema, raw)
        for (const [name, value] of Object.entries(values)) {
          const expected = Object.keys(property(value))[0]
          const field =
            name === "Name"
              ? nativeTitle(source.properties ?? {})
              : property(source.properties?.[name])
          if (field.type !== expected)
            throw fail("DATABASE_SCHEMA_CONFLICT", "Native subscription property type changed.", {
              property: name,
              expected,
            })
        }
      },
      catch: (e) => e as SkillsError,
    })
    const ids = yield* resolveDatabasePropertyIds(dataSourceId)
    return yield* Effect.try({
      try: () =>
        Object.fromEntries(
          Object.entries(values).map(([name, value]) => {
            if (!ids[name])
              throw fail(
                "DATABASE_SCHEMA_CONFLICT",
                "A required native subscription property is missing.",
                { property: name },
              )
            return [ids[name]!, value]
          }),
        ),
      catch: (e) => e as SkillsError,
    })
  })
}
export const upstreamOperationScope = Effect.gen(function* () {
  const config = yield* configuration
  const database_id = config.upstream_database && pageId(config.upstream_database)
  if (!database_id) return undefined
  return { scope: yield* authScope, database_id }
})
function validateSubscriptionInput(input: SubscriptionInput) {
  return Effect.try({
    try: () => {
      strictDecode(UpstreamSourceSchema, input.source)
      validateDisplayName(input.name)
      if (!pageId(input.target_database_id))
        throw fail("INVALID_UPSTREAM", "Target database UUID is required.")
    },
    catch: (error) => error as SkillsError,
  })
}
const frozenInput = (input: SubscriptionInput): SubscriptionInput => ({
  target_database_id: input.target_database_id,
  name: input.name,
  description: input.description,
  default_context: input.default_context,
  enabled: input.enabled,
  source: input.source,
  roots: input.roots,
  include: input.include,
  exclude: input.exclude,
  mapping: input.mapping,
})
export function addSubscription(input: SubscriptionInput, operationId?: string) {
  return Effect.gen(function* () {
    yield* validateSubscriptionInput(input)
    const db = yield* subscriptionDatabase,
      state = yield* UpstreamState
    const id = operationId ?? `ua_${yield* (yield* Crypto.Crypto).randomUUIDv4()}`
    const scope = yield* authScope
    const evidence = {
      operation_id: id,
      domain: "subscription_add" as const,
      scope,
      database_id: db.database_id,
      input: frozenInput(input),
    }
    const marker = `ntn-skills-upstream-operation:${id}`
    let inputHash = yield* sha256(JSON.stringify(frozenInput(input)))
    const prior = property(yield* state.command(id))
    if (
      Object.keys(prior).length &&
      (prior.scope !== scope || prior.database_id !== db.database_id)
    )
      return yield* Effect.fail(
        fail(
          "UPSTREAM_OPERATION_MISMATCH",
          "The operation belongs to another authentication scope or lacks scoped evidence.",
        ),
      )
    if (
      prior.input_hash &&
      prior.input_hash !== inputHash &&
      JSON.stringify(properties(prior.input as SubscriptionInput)) !==
        JSON.stringify(properties(input))
    )
      return yield* Effect.fail(
        fail(
          "UPSTREAM_OPERATION_MISMATCH",
          "The operation belongs to another frozen subscription input.",
        ),
      )
    if (typeof prior.input_hash === "string") inputHash = prior.input_hash
    if (typeof prior.page_id === "string") {
      const created = yield* getSubscription(prior.page_id)
      yield* invalidateSubscriptionCatalog(scope, created.target_database_id)
      return created
    }
    if (
      prior.intent ||
      ((prior.state === "unknown" || prior.state === "running") && prior.phase !== "preparing")
    ) {
      const command = yield* loadSubscriptionCommand(id)
      if (yield* reconcileSubscriptionCommand(command))
        return yield* getSubscription(
          String(property(yield* state.command(id)).page_id),
          db.database_id,
        )
      return yield* Effect.fail(
        fail(
          "WRITE_OUTCOME_UNKNOWN",
          "Creation is unresolved; reconcile or explicitly adopt an evidenced exact page. No POST was replayed.",
          { operation_id: id },
        ),
      )
    }
    const preparation = {
      ...evidence,
      ...(prior.preparation_recovery ? { preparation_recovery: prior.preparation_recovery } : {}),
      input_hash: inputHash,
      state: "running" as const,
      phase: "preparing" as const,
    }
    yield* state.saveCommand(id, preparation)
    const mapped = yield* propertyIds(db.data_source_id, {
      ...properties(input),
      Status: { select: { name: "pending" } },
      "Published Members": rich(""),
    })
    const payload = {
      parent: { type: "data_source_id", data_source_id: db.data_source_id },
      properties: mapped,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: marker } }] },
        },
      ],
    }
    const intent = {
      method: "POST" as const,
      path: "v1/pages",
      payload,
      data_source_id: db.data_source_id,
      target_database_id: input.target_database_id,
      source_config_hash: inputHash,
      correlation: marker,
      origin: { database_id: db.database_id, scope },
    }
    const intended = { ...preparation, phase: "mutation_intended" as const, intent }
    yield* state.claimCommand(id, preparation, intended)
    const result = yield* (yield* Notion)
      .request(intent.path, intent.payload, { method: intent.method })
      .pipe(Effect.result)
    if (result._tag === "Failure") {
      yield* state.saveCommand(id, {
        ...intended,
        state: result.failure.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed",
        error_code: result.failure.code,
      })
      return yield* Effect.fail(
        fail(result.failure.code, result.failure.message, { operation_id: id }),
      )
    }
    const created = yield* decodeSubscription(result.success, db.database_id, db.data_source_id)
    yield* state.saveCommand(id, {
      ...intended,
      phase: "response_received",
      state: "verified",
      page_id: created.subscription_id,
      version: created.version,
    })
    yield* invalidateSubscriptionCatalog(scope, created.target_database_id)
    return created
  })
}
export function updateSubscription(id: string, expectedVersion: string, input: SubscriptionInput) {
  return Effect.gen(function* () {
    yield* validateSubscriptionInput(input)
    const current = yield* getSubscription(id),
      state = yield* UpstreamState
    const scope = yield* authScope
    const operationId = `uu_${yield* sha256(JSON.stringify([scope, current.database_id, current.subscription_id, expectedVersion, input]))}`
    const evidence = {
      operation_id: operationId,
      domain: "subscription_update" as const,
      scope,
      database_id: current.database_id,
      page_id: current.subscription_id,
      expected_version: expectedVersion,
      input: frozenInput(input),
    }
    const prior = property(yield* state.command(operationId))
    const same = JSON.stringify(properties(current)) === JSON.stringify(properties(input))
    if (
      prior.state === "verified" ||
      ((prior.state === "running" || prior.state === "unknown") && same)
    ) {
      yield* state.saveCommand(operationId, { ...prior, ...evidence, state: "verified" })
      return current
    }
    if (
      prior.intent ||
      ((prior.state === "running" || prior.state === "unknown") && prior.phase !== "preparing")
    )
      return yield* Effect.fail(
        fail("WRITE_OUTCOME_UNKNOWN", "Reconcile the subscription update before another write.", {
          operation_id: operationId,
        }),
      )
    if (current.version !== expectedVersion)
      return yield* Effect.fail(fail("UPSTREAM_PLAN_STALE", "Subscription changed before update."))
    yield* state.saveCommand(operationId, { ...evidence, state: "running", phase: "preparing" })
    const payload = { properties: yield* propertyIds(current.data_source_id, properties(input)) }
    const intent = {
      method: "PATCH" as const,
      path: `v1/pages/${current.subscription_id}`,
      payload,
      data_source_id: current.data_source_id,
      target_database_id: input.target_database_id,
      source_config_hash: yield* sha256(JSON.stringify(input)),
      correlation: operationId,
      origin: { database_id: current.database_id, scope },
      before_version: current.version,
    }
    const intended = {
      ...evidence,
      state: "running" as const,
      phase: "mutation_intended" as const,
      intent,
    }
    yield* state.claimCommand(
      operationId,
      { ...evidence, state: "running", phase: "preparing" },
      intended,
    )
    const result = yield* (yield* Notion)
      .request(intent.path, intent.payload, { method: intent.method })
      .pipe(Effect.result)
    if (result._tag === "Failure") {
      yield* state.saveCommand(operationId, {
        ...intended,
        state: result.failure.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed",
        error_code: result.failure.code,
      })
      return yield* Effect.fail(
        fail(result.failure.code, result.failure.message, { operation_id: operationId }),
      )
    }
    yield* state.saveCommand(operationId, { ...intended, phase: "response_received" })
    const verified = yield* getSubscription(id)
    if (JSON.stringify(properties(verified)) !== JSON.stringify(properties(input)))
      return yield* Effect.fail(
        fail("UPSTREAM_UNVERIFIED", "Subscription update did not read back exactly.", {
          operation_id: operationId,
        }),
      )
    yield* state.saveCommand(operationId, {
      ...intended,
      phase: "response_received",
      state: "verified",
    })
    yield* invalidateSnapshotCache(`notion_subscription:${current.subscription_id}`, scope)
    yield* invalidateSubscriptionCatalog(scope, current.target_database_id)
    if (verified.target_database_id !== current.target_database_id)
      yield* invalidateSubscriptionCatalog(scope, verified.target_database_id)
    return verified
  })
}
export function removeSubscription(id: string, expectedVersion: string) {
  return Effect.gen(function* () {
    const current = yield* getSubscription(id),
      state = yield* UpstreamState
    const scope = yield* authScope
    const operationId = `ur_${yield* sha256(JSON.stringify([scope, current.database_id, current.subscription_id, expectedVersion]))}`
    const evidence = {
      operation_id: operationId,
      domain: "subscription_remove" as const,
      scope,
      database_id: current.database_id,
      page_id: current.subscription_id,
      expected_version: expectedVersion,
    }
    const prior = property(yield* state.command(operationId))
    if (
      current.removed &&
      (prior.state === "running" || prior.state === "unknown" || prior.state === "verified")
    ) {
      yield* state.saveCommand(operationId, { ...prior, ...evidence, state: "verified" })
      return {
        subscription_id: id,
        operation_id: operationId,
        removed: true,
        content_retained: true,
      } as const
    }
    if (
      prior.intent ||
      ((prior.state === "running" || prior.state === "unknown") && prior.phase !== "preparing")
    )
      return yield* Effect.fail(
        fail("WRITE_OUTCOME_UNKNOWN", "Subscription removal needs reconciliation.", {
          operation_id: operationId,
        }),
      )
    if (current.version !== expectedVersion)
      return yield* Effect.fail(fail("UPSTREAM_PLAN_STALE", "Subscription changed before removal."))
    yield* state.saveCommand(operationId, { ...evidence, state: "running", phase: "preparing" })
    const intent = {
      method: "PATCH" as const,
      path: `v1/pages/${current.subscription_id}`,
      payload: { in_trash: true },
      data_source_id: current.data_source_id,
      target_database_id: current.target_database_id,
      source_config_hash: yield* sha256(JSON.stringify(frozenInput(current))),
      correlation: operationId,
      origin: { database_id: current.database_id, scope },
      before_version: current.version,
    }
    const intended = {
      ...evidence,
      state: "running" as const,
      phase: "mutation_intended" as const,
      intent,
    }
    yield* state.claimCommand(
      operationId,
      { ...evidence, state: "running", phase: "preparing" },
      intended,
    )
    const result = yield* (yield* Notion)
      .request(intent.path, intent.payload, { method: intent.method })
      .pipe(Effect.result)
    if (result._tag === "Failure") {
      yield* state.saveCommand(operationId, {
        ...intended,
        state: result.failure.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed",
        error_code: result.failure.code,
      })
      return yield* Effect.fail(
        fail(result.failure.code, result.failure.message, { operation_id: operationId }),
      )
    }
    yield* state.saveCommand(operationId, { ...intended, phase: "response_received" })
    if (!(yield* getSubscription(id)).removed)
      return yield* Effect.fail(
        fail("UPSTREAM_UNVERIFIED", "Removed subscription was not verified.", {
          operation_id: operationId,
        }),
      )
    yield* state.saveCommand(operationId, {
      ...intended,
      phase: "response_received",
      state: "verified",
    })
    return {
      subscription_id: current.subscription_id,
      operation_id: operationId,
      removed: true,
      content_retained: true,
    } as const
  })
}
export function publishSubscriptionMembers(
  id: string,
  expectedVersion: string,
  published: PublishedMembers,
  status: "verified" | "partial",
) {
  return Effect.gen(function* () {
    const current = yield* getSubscription(id)
    if (current.version !== expectedVersion)
      return yield* Effect.fail(
        fail("UPSTREAM_PLAN_STALE", "Subscription configuration changed during publication."),
      )
    const encoded = JSON.stringify(published)
    yield* Effect.try({
      try: () => decodePublishedMembers(encoded),
      catch: (e) => e as SkillsError,
    })
    yield* (yield* Notion).request(
      `v1/pages/${current.subscription_id}`,
      {
        properties: yield* propertyIds(current.data_source_id, {
          "Published Members": rich(encoded),
          Status: { select: { name: status } },
        }),
      },
      { method: "PATCH" },
    )
    const verified = yield* getSubscription(id)
    if (canonical(verified.published) !== canonical(published) || verified.status !== status)
      return yield* Effect.fail(
        fail("UPSTREAM_UNVERIFIED", "Published member map did not read back exactly."),
      )
    const scope = yield* authScope
    yield* invalidateSnapshotCache(`notion_subscription:${current.subscription_id}`, scope)
    yield* invalidateSubscriptionCatalog(scope, verified.target_database_id)
    return verified
  })
}
export function updateSubscriptionSync(id: string, sync: SubscriptionSync) {
  return Effect.gen(function* () {
    const current = yield* getSubscription(id)
    const values = {
      "Sync Status": { select: sync.status === null ? null : { name: sync.status } },
      "Last Sync Attempt": { date: sync.attempted_at ? { start: sync.attempted_at } : null },
      "Last Synced": { date: sync.succeeded_at ? { start: sync.succeeded_at } : null },
      "Sync Summary": rich(sync.summary),
    }
    yield* (yield* Notion).request(
      `v1/pages/${current.subscription_id}`,
      {
        properties: yield* propertyIds(current.data_source_id, values),
      },
      { method: "PATCH" },
    )
    const confirmed = yield* getSubscription(id)
    if (confirmed.sync?.status !== sync.status)
      return yield* Effect.fail(
        fail("UPSTREAM_UNVERIFIED", "Synchronization status did not read back."),
      )
    yield* invalidateSubscriptionCatalog(yield* authScope, current.target_database_id)
    return confirmed
  })
}

function loadSubscriptionCommand(id: string) {
  return Effect.gen(function* () {
    const raw = yield* (yield* UpstreamState).command(id)
    const command = yield* Effect.try({
      try: () => strictDecode(UpstreamCommandOperationSchema, raw),
      catch: () => fail("UPSTREAM_OPERATION_NOT_FOUND", "An exact retained command is required."),
    })
    if (command.scope !== (yield* authScope))
      return yield* Effect.fail(
        fail(
          "UPSTREAM_OPERATION_MISMATCH",
          "Authentication scope differs from the retained command.",
        ),
      )
    return command
  })
}
export function resumeSubscriptionCommand(command: UpstreamCommandOperation) {
  return Effect.gen(function* () {
    const saved = yield* loadSubscriptionCommand(command.operation_id)
    if (saved.domain === "upstream_fork" || saved.domain === "upstream_track") return false
    if (yield* reconcileSubscriptionCommand(saved)) return true
    if (saved.domain === "subscription_add") {
      if (saved.phase !== "preparing" || saved.intent)
        return yield* Effect.fail(
          fail(
            "WRITE_OUTCOME_UNKNOWN",
            "An uncertain create cannot be replayed. Adopt an exactly evidenced page or retain the blocked audit.",
          ),
        )
      yield* addSubscription(saved.input, saved.operation_id)
      return true
    }
    const current = yield* getSubscription(saved.page_id, saved.database_id)
    if (
      current.version !== saved.expected_version ||
      (saved.intent && current.version !== saved.intent.before_version)
    )
      return yield* Effect.fail(
        fail(
          "UPSTREAM_PLAN_STALE",
          "External subscription changes prevent resuming the original mutation.",
        ),
      )
    if (!saved.intent) {
      if (saved.phase !== "preparing")
        return yield* Effect.fail(
          fail("WRITE_OUTCOME_UNKNOWN", "The legacy command has no exact mutation intent."),
        )
      if (saved.domain === "subscription_update")
        yield* updateSubscription(saved.page_id, saved.expected_version, saved.input)
      else yield* removeSubscription(saved.page_id, saved.expected_version)
      return true
    }
    const db = yield* resolveSubscriptionDatabase(saved.database_id)
    if (
      db.data_source_id !== saved.intent.data_source_id ||
      saved.intent.origin.scope !== saved.scope ||
      saved.intent.origin.database_id !== saved.database_id
    )
      return yield* Effect.fail(
        fail("UPSTREAM_OPERATION_MISMATCH", "The retained mutation target or origin changed."),
      )
    const next = {
      ...saved,
      state: "running" as const,
      recovery_generation: (saved.recovery_generation ?? 0) + 1,
    }
    yield* (yield* UpstreamState).claimCommand(saved.operation_id, saved, next)
    yield* (yield* Notion).request(saved.intent.path, saved.intent.payload, {
      method: saved.intent.method,
    })
    return yield* reconcileSubscriptionCommand(next)
  })
}
export function planSubscriptionAdoption(input: SubscriptionAdoptionEvidence) {
  return Effect.gen(function* () {
    const evidence = yield* Effect.try({
      try: () => strictDecode(SubscriptionAdoptionEvidenceSchema, input),
      catch: () => fail("INVALID_ARGUMENT", "Provide exact adoption evidence."),
    })
    const command = yield* loadSubscriptionCommand(evidence.operation_id)
    if (
      command.domain !== "subscription_add" ||
      command.state === "verified" ||
      !evidence.creation_evidence.trim() ||
      pageId(evidence.page_id) !== evidence.page_id
    )
      return yield* Effect.fail(
        fail(
          "UPSTREAM_OPERATION_MISMATCH",
          "Adoption requires an unresolved add and exact creation evidence.",
        ),
      )
    const db = yield* resolveSubscriptionDatabase(command.database_id)
    if (
      evidence.scope !== command.scope ||
      evidence.database_id !== command.database_id ||
      evidence.data_source_id !== db.data_source_id ||
      evidence.target_database_id !== command.input.target_database_id ||
      evidence.source_config_hash !== command.input_hash
    )
      return yield* Effect.fail(
        fail(
          "UPSTREAM_OPERATION_MISMATCH",
          "Adoption source, target, configuration or authentication evidence differs.",
        ),
      )
    const raw = yield* (yield* Notion).request(`v1/pages/${evidence.page_id}`)
    const current = yield* decodeSubscription(raw, db.database_id, db.data_source_id)
    if (
      property(raw).created_time !== evidence.created_time ||
      current.removed ||
      JSON.stringify(properties(current)) !== JSON.stringify(properties(command.input))
    )
      return yield* Effect.fail(
        fail(
          "UPSTREAM_OPERATION_MISMATCH",
          "The exact page creation time and full original configuration must match.",
        ),
      )
    const plan_hash = yield* sha256(JSON.stringify([evidence, current.version]))
    const adoption = { evidence, plan_hash, observed_version: current.version, applied: false }
    yield* (yield* UpstreamState).saveCommand(command.operation_id, { ...command, adoption })
    return {
      operation_id: command.operation_id,
      plan_hash,
      evidence,
      observed_version: current.version,
      remote_writes: 0,
      next: [
        "ntn-skills-operator",
        "upstream",
        "adopt-apply",
        command.operation_id,
        "--plan-hash",
        plan_hash,
      ],
    }
  })
}
export function applySubscriptionAdoption(operationId: string, planHash: string) {
  return Effect.gen(function* () {
    const command = yield* loadSubscriptionCommand(operationId)
    if (
      command.domain !== "subscription_add" ||
      !command.adoption ||
      command.adoption.plan_hash !== planHash
    )
      return yield* Effect.fail(
        fail("UPSTREAM_OPERATION_MISMATCH", "Use the exact reviewed adoption plan hash."),
      )
    const plan = yield* planSubscriptionAdoption(command.adoption.evidence)
    if (plan.plan_hash !== planHash)
      return yield* Effect.fail(
        fail("UPSTREAM_PLAN_STALE", "The adoption page changed after planning."),
      )
    const adopted = {
      ...command,
      state: "verified" as const,
      page_id: command.adoption.evidence.page_id,
      version: command.adoption.observed_version,
      adoption: { ...command.adoption, applied: true },
    }
    yield* (yield* UpstreamState).saveCommand(operationId, adopted)
    yield* invalidateSubscriptionCatalog(command.scope, command.input.target_database_id)
    return { operation_id: operationId, page_id: adopted.page_id, verified: true, remote_writes: 0 }
  })
}
/** Read remote evidence only; absence never authorizes a create or mutation replay. */
export function reconcileSubscriptionCommand(command: UpstreamCommandOperation) {
  return Effect.gen(function* () {
    if (command.domain === "upstream_fork" || command.domain === "upstream_track") return false
    if (command.scope !== (yield* authScope))
      return yield* Effect.fail(
        fail("UPSTREAM_OPERATION_MISMATCH", "Authentication scope differs from the command."),
      )
    if (command.domain === "subscription_add") {
      const matches: Subscription[] = []
      const observed = yield* Effect.gen(function* () {
        for (const candidate of yield* listSubscriptionsInDatabase(command.database_id)) {
          const api = yield* Notion
          let cursor: string | undefined
          const cursors = new Set<string>()
          let found = false
          while (true) {
            const raw = yield* api.request(
              `v1/blocks/${candidate.subscription_id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
            )
            const page = yield* Effect.try({
              try: () => decode(listSchema(Schema.Unknown), raw),
              catch: () => fail("INVALID_RESPONSE", "Invalid subscription marker response."),
            })
            found ||= page.results.some(
              (child) =>
                text(property(property(child).paragraph).rich_text) ===
                `ntn-skills-upstream-operation:${command.operation_id}`,
            )
            if (!page.has_more) break
            if (!page.next_cursor || cursors.has(page.next_cursor))
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "Subscription marker cursor repeated or disappeared."),
              )
            cursor = page.next_cursor
            cursors.add(cursor)
          }
          if (found) matches.push(candidate)
        }
      }).pipe(Effect.result)
      const state = yield* UpstreamState
      const observation = {
        coverage: observed._tag === "Success" ? ("complete" as const) : ("blocked" as const),
        matches: matches.map((m) => m.subscription_id),
        reason:
          observed._tag === "Failure"
            ? observed.failure.code
            : matches.length === 1
              ? "exact_marker_observed"
              : matches.length
                ? "duplicate_markers"
                : "marker_not_visible_no_replay",
      }
      yield* state.saveCommand(command.operation_id, { ...command, observation })
      if (observed._tag === "Failure") return yield* Effect.fail(observed.failure)
      if (
        matches.length !== 1 ||
        JSON.stringify(properties(matches[0]!)) !== JSON.stringify(properties(command.input))
      )
        return false
      yield* (yield* UpstreamState).saveCommand(command.operation_id, {
        ...command,
        observation,
        state: "verified",
        page_id: matches[0]!.subscription_id,
        version: matches[0]!.version,
      })
      return true
    }
    const current = yield* getSubscription(command.page_id, command.database_id)
    const verified =
      command.domain === "subscription_remove"
        ? current.removed
        : JSON.stringify(properties(current)) === JSON.stringify(properties(command.input))
    if (verified)
      yield* (yield* UpstreamState).saveCommand(command.operation_id, {
        ...command,
        state: "verified",
      })
    return verified
  })
}
