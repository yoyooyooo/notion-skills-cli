import { Crypto, Effect, Schema } from "effect"
import { decode, fail, property, text, type SkillsError } from "./model.ts"
import { Notion, withNotionRequestAttribution } from "./notion.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { guardedSourceMutation, sourceField } from "./shared-source-definitions.ts"
import {
  canonicalSharedJson,
  canonicalSharedRecordEnvelope,
  querySharedRecords,
  SharedRecordKindSchema,
  verifySharedRecordPage,
} from "./shared-records.ts"
import { isCoalescibleNotionRead } from "./shared-read-coalescing.ts"
import { blankRepairBinding } from "./shared-native-repair-model.ts"
import { sha256, Store } from "./store.ts"

type RepairBinding =
  | {
      readonly kind: "historical_missing_main"
      readonly skill_page_id: string
      readonly file_id: string
    }
  | {
      readonly kind: "managed_file"
      readonly file_page_id: string
      readonly skill_page_id: string
      readonly file_id: string
      readonly path: string
    }
type CreateIdentity = {
  readonly operation_id: string
  readonly skill_id: string
  readonly recovery_file_projections?: readonly {
    readonly page_id: string
    readonly file_id: string
    readonly path: string
    readonly skill_page_id: string
    readonly projection: string
  }[]
  /** Set only by the maintenance repair journal. Creation plans omit it. */
  readonly repair_binding?: RepairBinding
}
type Options = NonNullable<Parameters<Notion["Service"]["request"]>[2]>

function projectionSpans(value: string) {
  const points = Array.from(value),
    result = []
  for (let at = 0; at < points.length; at += 2000)
    result.push({ type: "text", text: { content: points.slice(at, at + 2000).join("") } })
  return result
}

function fieldValue(field: Record<string, unknown>, requested: Record<string, unknown>): unknown {
  if ("rich_text" in requested) return text(field.rich_text)
  if ("checkbox" in requested) return field.checkbox
  return undefined
}

function completeRich(row: unknown, id: string) {
  const field = sourceField(row, id)
  if (field.type !== "rich_text" || !Array.isArray(field.rich_text) || field.has_more === true)
    return Effect.fail(
      fail("SHARED_CREATE_SCOPE", "Repair identity text is incomplete.", { property_id: id }),
    )
  return Effect.succeed(text(field.rich_text))
}

/** Repair binds one blank identity. It never creates a page and never resends a lost POST. */
function observeRepairBinding(
  library: SharedLibrary,
  plan: CreateIdentity,
  path: string,
  body: unknown,
  method: "POST" | "PATCH",
) {
  return Effect.gen(function* () {
    const binding = plan.repair_binding
    if (binding === undefined) return undefined
    if (plan.recovery_file_projections !== undefined)
      return yield* Effect.fail(
        fail("SHARED_CREATE_SCOPE", "Repair cannot share a creation projection dispatch."),
      )
    if (method === "POST")
      return yield* Effect.fail(
        fail("SHARED_CREATE_SCOPE", "Repair does not create a page or repeat a missing POST.", {
          operation_id: plan.operation_id,
        }),
      )
    const request = property(body)
    const props = property(request.properties)
    if (Object.keys(request).length !== 1 || !Object.hasOwn(request, "properties"))
      return yield* Effect.fail(
        fail("SHARED_CREATE_SCOPE", "Repair may send only the exact identity property."),
      )
    const api = yield* Notion
    if (binding.kind === "historical_missing_main") {
      const mainId = library.skills.property_ids["Main File ID"]!
      if (
        path !== `v1/pages/${binding.skill_page_id}` ||
        Object.keys(props).length !== 1 ||
        !Object.hasOwn(props, mainId) ||
        text(property(props[mainId]).rich_text) !== binding.file_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_SCOPE",
            "Repair may fill only the blank Main File ID on the exact original Skill page.",
            { page_id: binding.skill_page_id, operation_id: plan.operation_id },
          ),
        )
      const row = property(yield* api.request(path))
      if (
        row.id !== binding.skill_page_id ||
        row.archived === true ||
        row.is_archived === true ||
        row.in_trash === true ||
        property(row.parent).data_source_id !== library.skills.data_source_id ||
        (yield* completeRich(row, library.skills.property_ids["Skill ID"]!)) !== plan.skill_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_SCOPE",
            "The original Skill page no longer matches the frozen repair binding.",
            { page_id: binding.skill_page_id, operation_id: plan.operation_id },
          ),
        )
      const current = yield* completeRich(row, mainId)
      if (current === binding.file_id) return row
      if (!blankRepairBinding(current))
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_SCOPE",
            "Repair will not replace a Main File ID that is already bound.",
            { page_id: binding.skill_page_id, operation_id: plan.operation_id },
          ),
        )
      return undefined
    }
    const fileId = library.files.property_ids["File ID"]!
    if (
      path !== `v1/pages/${binding.file_page_id}` ||
      Object.keys(props).length !== 1 ||
      !Object.hasOwn(props, fileId) ||
      text(property(props[fileId]).rich_text) !== binding.file_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "Managed-file repair may fill only the blank File ID on the exact Files row.",
          { page_id: binding.file_page_id, operation_id: plan.operation_id },
        ),
      )
    const row = property(yield* api.request(path))
    const ids = library.files.property_ids
    const relation = sourceField(row, ids.Skill!)
    if (
      row.id !== binding.file_page_id ||
      row.archived === true ||
      row.is_archived === true ||
      row.in_trash === true ||
      property(row.parent).data_source_id !== library.files.data_source_id ||
      relation.type !== "relation" ||
      relation.has_more === true ||
      !Array.isArray(relation.relation) ||
      relation.relation.length !== 1 ||
      property(relation.relation[0]).id !== binding.skill_page_id ||
      (yield* completeRich(row, ids.Path!)) !== binding.path
    )
      return yield* Effect.fail(
        fail("SHARED_CREATE_SCOPE", "The Files row no longer has the frozen owner and path.", {
          page_id: binding.file_page_id,
          operation_id: plan.operation_id,
        }),
      )
    const owner = property(yield* api.request(`v1/pages/${binding.skill_page_id}`))
    if (
      owner.id !== binding.skill_page_id ||
      owner.archived === true ||
      owner.in_trash === true ||
      owner.is_archived === true ||
      property(owner.parent).data_source_id !== library.skills.data_source_id ||
      (yield* completeRich(owner, library.skills.property_ids["Skill ID"]!)) !== plan.skill_id
    )
      return yield* Effect.fail(
        fail("SHARED_CREATE_SCOPE", "The Files row owner is no longer the frozen Skill.", {
          page_id: binding.skill_page_id,
          file_page_id: binding.file_page_id,
        }),
      )
    const current = yield* completeRich(row, fileId)
    if (current === binding.file_id) return row
    if (!blankRepairBinding(current))
      return yield* Effect.fail(
        fail("SHARED_CREATE_SCOPE", "Repair will not replace a File ID that is already bound.", {
          page_id: binding.file_page_id,
          operation_id: plan.operation_id,
        }),
      )
    return undefined
  })
}

/** Original page acknowledgements and exact immutable Record facts have different authority. */
function observeMutation(
  library: SharedLibrary,
  plan: CreateIdentity,
  path: string,
  body: unknown,
  method: "POST" | "PATCH",
  acknowledgedPageId?: string,
) {
  return Effect.gen(function* () {
    if (plan.repair_binding !== undefined)
      return yield* observeRepairBinding(library, plan, path, body, method)
    const api = yield* Notion,
      request = property(body),
      props = property(request.properties)
    const parent = property(request.parent).data_source_id
    if (method === "PATCH") {
      if (!/^v1\/pages\/[a-f0-9-]{36}$/u.test(path))
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_SCOPE",
            "Creation may patch only its exact allocated Skill metadata.",
          ),
        )
      const row = property(yield* api.request(path)),
        ids = library.skills.property_ids
      if (property(row.parent).data_source_id === library.files.data_source_id) {
        const allowed = plan.recovery_file_projections?.filter(
          (item) => path === "v1/pages/" + item.page_id,
        )
        const target = allowed?.[0],
          fileIds = library.files.property_ids
        if (
          !target ||
          allowed?.length !== 1 ||
          row.id !== target.page_id ||
          row.archived === true ||
          row.is_archived === true ||
          row.in_trash === true ||
          Object.keys(request).length !== 1 ||
          Object.keys(props).length !== 1 ||
          !Object.hasOwn(props, fileIds.Projection!) ||
          canonicalSharedJson(props[fileIds.Projection!]) !==
            canonicalSharedJson({ rich_text: projectionSpans(target.projection) }) ||
          text(sourceField(row, fileIds["File ID"]!).rich_text) !== target.file_id ||
          text(sourceField(row, fileIds.Path!).rich_text) !== target.path ||
          sourceField(row, fileIds.Skill!).has_more === true ||
          canonicalSharedJson(sourceField(row, fileIds.Skill!).relation) !==
            canonicalSharedJson([{ id: target.skill_page_id }])
        )
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_SCOPE",
              "Recovery may only update the exact acknowledged reference Projection metadata.",
            ),
          )
        const owner = property(yield* api.request("v1/pages/" + target.skill_page_id))
        if (
          owner.id !== target.skill_page_id ||
          owner.archived === true ||
          owner.is_archived === true ||
          owner.in_trash === true ||
          property(owner.parent).data_source_id !== library.skills.data_source_id ||
          text(sourceField(owner, ids["Skill ID"]!).rich_text) !== plan.skill_id
        )
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_SCOPE",
              "The acknowledged reference no longer belongs to the exact original Skill.",
            ),
          )
        return text(sourceField(row, fileIds.Projection!).rich_text) === target.projection
          ? row
          : undefined
      }
      if (
        property(row.parent).data_source_id !== library.skills.data_source_id ||
        text(sourceField(row, ids["Skill ID"]!).rich_text) !== plan.skill_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_SCOPE",
            "The original metadata mutation belongs to another allocated Skill.",
          ),
        )
      for (const [key, value] of Object.entries(props)) {
        if (![ids.Enabled, ids.Source, ids.Projection].includes(key))
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_SCOPE",
              "Original creation may only select its source or enable its verified new tree.",
            ),
          )
        const wanted = property(value),
          actual = sourceField(row, key)
        if (fieldValue(actual, wanted) !== fieldValue(wanted, wanted)) return undefined
      }
      return row
    }
    if (path !== "v1/pages")
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "Original creation does not authorize another mutation endpoint.",
        ),
      )
    if (parent === library.records.data_source_id) {
      const ids = library.records.property_ids
      const recordId = text(property(props[ids["Record ID"]!]).rich_text)
      const relation = property(props[ids.Skill!]).relation
      const skillPageId =
        Array.isArray(relation) && relation.length === 1 ? property(relation[0]).id : undefined
      if (typeof skillPageId !== "string")
        return yield* Effect.fail(
          fail("SHARED_CREATE_SCOPE", "A creation fact requires one exact allocated Skill."),
        )
      const kind = decode(SharedRecordKindSchema, property(property(props[ids.Kind!]).select).name)
      const selection = {
        skillPageId,
        recordId,
        kind,
        entityId: text(property(props[ids["Entity ID"]!]).rich_text),
      }
      const acknowledgedPage =
        acknowledgedPageId === undefined
          ? undefined
          : property(
              yield* api.request(`v1/pages/${acknowledgedPageId}`, undefined, { content: "body" }),
            )
      if (acknowledgedPage !== undefined && acknowledgedPage.id !== acknowledgedPageId)
        return yield* Effect.fail(
          fail("SHARED_CREATE_SCOPE", "Readback differs from the exact acknowledged Record page."),
        )
      const records =
        acknowledgedPage === undefined
          ? yield* querySharedRecords(library, { ...selection, payloadContainsBody: true })
          : [yield* verifySharedRecordPage(library, acknowledgedPage, selection)]
      if (records.length === 0) return undefined
      const row = records[0]!
      const envelope = canonicalSharedJson({
        version: 1,
        operation_id: row.operation_id,
        payload: row.payload,
      })
      if (
        records.length !== 1 ||
        row.entity_id !== text(property(props[ids["Entity ID"]!]).rich_text) ||
        row.kind !== property(property(props[ids.Kind!]).select).name ||
        row.hash !== text(property(props[ids.Hash!]).rich_text) ||
        envelope !==
          canonicalSharedRecordEnvelope(kind, text(property(props[ids.Payload!]).rich_text))
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_SCOPE",
            "The original immutable creation fact has a conflicting identity or payload.",
          ),
        )
      return acknowledgedPage ?? (yield* api.request(`v1/pages/${row.page_id}`))
    }
    const table =
      parent === library.skills.data_source_id
        ? library.skills
        : parent === library.files.data_source_id
          ? library.files
          : undefined
    if (table === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "Creation may allocate only registered Skills and Files pages.",
        ),
      )
    const field = table === library.skills ? "Skill ID" : "File ID",
      id = table.property_ids[field]!
    const identity = text(property(props[id]).rich_text)
    const raw = property(
      yield* api.request(`v1/data_sources/${table.data_source_id}/query`, {
        page_size: 100,
        filter: { property: id, rich_text: { equals: identity } },
      }),
    )
    if (raw.object !== "list" || !Array.isArray(raw.results) || typeof raw.has_more !== "boolean")
      return yield* Effect.fail(
        fail("SHARED_CREATE_INCOMPLETE", "The original allocation cannot be observed completely."),
      )
    if (raw.has_more || raw.next_cursor !== null || raw.results.length > 1)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "The original stable creation identity has ambiguous allocations.",
        ),
      )
    if (raw.results.length === 0 && acknowledgedPageId === undefined) return undefined
    const candidate = property(raw.results[0]),
      page = acknowledgedPageId ?? candidate.id
    if (typeof page !== "string") return undefined
    if (
      acknowledgedPageId !== undefined &&
      raw.results.length === 1 &&
      candidate.id !== acknowledgedPageId
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "The stable identity query points to a different page than the original acknowledgement.",
        ),
      )
    const row = property(yield* api.request(`v1/pages/${page}`))
    if (
      row.id !== page ||
      row.archived === true ||
      row.is_archived === true ||
      row.in_trash === true ||
      property(row.parent).data_source_id !== table.data_source_id ||
      text(sourceField(row, id).rich_text) !== identity
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "An allocated page no longer has its exact original parent and stable identity.",
        ),
      )
    if (table === library.skills) {
      const mainId = table.property_ids["Main File ID"]!
      if (
        identity !== plan.skill_id ||
        text(sourceField(row, mainId).rich_text) !== text(property(props[mainId]).rich_text)
      )
        return yield* Effect.fail(
          fail("SHARED_CREATE_SCOPE", "The main allocation no longer binds its original File ID."),
        )
    } else {
      const ids = table.property_ids,
        skill = sourceField(row, ids.Skill!)
      if (
        skill.has_more ||
        canonicalSharedJson(skill.relation) !==
          canonicalSharedJson(property(props[ids.Skill!]).relation) ||
        text(sourceField(row, ids.Path!).rich_text) !== text(property(props[ids.Path!]).rich_text)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_SCOPE",
            "A supporting allocation no longer binds its exact Skill and path.",
          ),
        )
    }
    return row
  })
}

/** Reuse the shared durable ACK protocol, inside the existing original creation journal. */
export function sharedCreateDispatch(
  library: SharedLibrary,
  plan: CreateIdentity,
  beforeDispatch?: Effect.Effect<void, SkillsError, Notion | Store | Crypto.Crypto>,
) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      services = yield* Effect.context<Notion | Store | Crypto.Crypto>()
    const run = (path: string, body: unknown, options: Options, dryRun = false) =>
      Effect.gen(function* () {
        const method = options.method
        if (method !== "POST" && method !== "PATCH")
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_SCOPE",
              "Original creation supports only its frozen page mutations.",
            ),
          )
        if (plan.repair_binding !== undefined && method === "POST")
          return yield* Effect.fail(
            fail("SHARED_CREATE_SCOPE", "Repair does not create a page or repeat a missing POST.", {
              operation_id: plan.operation_id,
            }),
          )
        // Mutable metadata authority is checked before the first transport write as well
        // as after its ACK. The durable guard's current observation is a postcondition.
        if (method === "PATCH") yield* observeMutation(library, plan, path, body, method)
        const identity = `${plan.operation_id}:${yield* sha256(canonicalSharedJson([path, method, body]))}`
        const immutableRecord =
          method === "POST" &&
          path === "v1/pages" &&
          property(property(body).parent).data_source_id === library.records.data_source_id
        const table = immutableRecord
          ? library.records
          : property(property(body).parent).data_source_id === library.files.data_source_id
            ? library.files
            : undefined
        const relation =
          table === undefined
            ? undefined
            : property(property(property(body).properties)[table.property_ids.Skill!]).relation
        const owner =
          method === "PATCH"
            ? (plan.recovery_file_projections?.find((item) => path === `v1/pages/${item.page_id}`)
                ?.skill_page_id ??
              path.match(/^v1\/pages\/([a-f0-9-]{36})$/u)?.[1] ??
              null)
            : Array.isArray(relation) &&
                relation.length === 1 &&
                typeof property(relation[0]).id === "string"
              ? String(property(relation[0]).id)
              : null
        const transport: Notion["Service"] = {
          ...api,
          request: (requestPath, requestBody, requestOptions) => {
            const originalWrite = requestOptions?.method === method && requestPath === path
            const requested = api.request(
              requestPath,
              requestBody,
              originalWrite ? { ...options, ...requestOptions } : requestOptions,
            )
            return originalWrite
              ? withNotionRequestAttribution(requested, {
                  phase: "author_apply",
                  skill_page_id: owner,
                  operation_id: plan.operation_id,
                })
              : requested
          },
        }
        const result = yield* guardedSourceMutation(
          library,
          {
            identity,
            path,
            method,
            body,
            dryRun,
            repeat: "never",
            ...(beforeDispatch === undefined ? {} : { beforeDispatch }),
            ...(method === "POST" && path === "v1/pages"
              ? {
                  observeAcknowledged: (response: unknown) => {
                    const pageId = property(response).id
                    if (typeof pageId !== "string" || !/^[a-f0-9-]{36}$/u.test(pageId))
                      return Effect.fail(
                        fail(
                          "SHARED_CREATE_DISPATCH_UNKNOWN",
                          "The original creation acknowledgement has no exact page ID.",
                        ),
                      )
                    return withNotionRequestAttribution(
                      observeMutation(library, plan, path, body, method, pageId),
                      {
                        phase: "author_verify",
                        skill_page_id:
                          owner ??
                          (property(property(body).parent).data_source_id ===
                          library.skills.data_source_id
                            ? pageId
                            : null),
                        operation_id: plan.operation_id,
                      },
                    )
                  },
                }
              : {}),
          },
          observeMutation(library, plan, path, body, method),
        ).pipe(Effect.provideService(Notion, transport))
        if (result.status === "planned")
          return { acknowledged: false as const, response: undefined }
        const row = property(result.result)
        const acknowledged =
          result.status === "applied" ||
          ("original_outcome" in result && result.original_outcome === "applied")
        if (
          (!acknowledged && !immutableRecord) ||
          (acknowledged && result.response_page_id !== row.id)
        )
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_DISPATCH_UNKNOWN",
              "The original page mutation has no matching durable acknowledgement. Current equality cannot authorize replay or completion.",
              { operation_id: plan.operation_id, mutation_operation_id: result.operation_id },
            ),
          )
        return { acknowledged, response: result.result }
      }).pipe(
        Effect.mapError((error) =>
          error.code === "SOURCE_WRITE_UNKNOWN"
            ? fail("WRITE_OUTCOME_UNKNOWN", error.message, error.details)
            : error,
        ),
        Effect.provide(services),
        (effect) => withNotionRequestAttribution(effect, { operation_id: plan.operation_id }),
      )
    return {
      canResume: Effect.gen(function* () {
        const store = yield* Store
        const scope = yield* sha256(
          canonicalSharedJson([
            yield* api.credentialIdentity,
            library.library_id,
            library.sources?.data_source_id ?? null,
          ]),
        )
        for (const key of yield* store.listKeys(`operations/shared-sources/${scope}/`)) {
          if (!/\/source-op-[a-f0-9]{64}\.json$/u.test(key)) continue
          const pending = property(yield* store.readJson(key, Schema.Unknown))
          if (
            typeof pending.identity !== "string" ||
            !pending.identity.startsWith(`${plan.operation_id}:`)
          )
            continue
          const acknowledged = yield* store.readJson(
            key.replace("/source-op-", "/source-ack-"),
            Schema.Unknown,
          )
          if (acknowledged !== undefined) continue
          // An exact immutable original Record is the existing reconcile contract;
          // mutable native pages require their actual original POST/PATCH ACK.
          if (
            pending.method !== "POST" ||
            pending.path !== "v1/pages" ||
            property(property(pending.body).parent).data_source_id !==
              library.records.data_source_id
          )
            return false
          const observed = yield* observeMutation(library, plan, "v1/pages", pending.body, "POST")
          if (observed === undefined) return false
        }
        return true
      }).pipe(Effect.provide(services)),
      acknowledged: (path: string, body: unknown, method: "POST" | "PATCH") =>
        run(path, body, { method }, true).pipe(Effect.map((result) => result.acknowledged)),
      api: {
        ...api,
        request: (path: string, body?: unknown, options?: Options) => {
          const method = options?.method ?? (body === undefined ? "GET" : "POST")
          if (
            isCoalescibleNotionRead({ key: "original-create", path, method, file: options?.file })
          )
            return api.request(path, body, options)
          return run(path, body, { ...options, method }).pipe(
            Effect.map((result) => result.response),
          )
        },
      } satisfies Notion["Service"],
    }
  })
}
