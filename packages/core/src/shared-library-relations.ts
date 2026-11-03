import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import {
  SharedLibrarySchema,
  SharedSkillRelationFieldSchema,
  type SharedLibrary,
} from "./shared-library-model.ts"
import {
  inspectTable,
  loadSharedLibrary,
  registeredSkillProperties,
  sharedRelationProperty,
  validateSharedRelationField,
} from "./shared-library.ts"
import { LIBRARY_MARKER } from "./shared-library-model.ts"
import {
  appendSharedArchiveRecord,
  canonicalSharedJson,
  querySharedArchiveRecords,
} from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

export const SharedRelationSchemaPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("relation_schema"),
  operation_id: Schema.String.check(Schema.isPattern(/^relations-schema-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  additions: Schema.Array(SharedSkillRelationFieldSchema),
  schema_property_ids: Schema.Array(Schema.String),
})
export type SharedRelationSchemaPlan = typeof SharedRelationSchemaPlanSchema.Type
const entity = "relation-schema-v1"
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("RELATION_SCHEMA_INVALID", "The relation schema operation is invalid."),
  })
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const spans = (content: string) => {
  const chars = Array.from(content)
  const result: Array<{ type: "text"; text: { content: string } }> = []
  for (let offset = 0; offset < chars.length; offset += 2000)
    result.push({ type: "text", text: { content: chars.slice(offset, offset + 2000).join("") } })
  return result
}
const marker = (plan: SharedRelationSchemaPlan, field: string) =>
  `ntn-skills-relation:v1 ${plan.operation_id}:${field}`

function schema(library: SharedLibrary) {
  return Effect.gen(function* () {
    const raw = property(
      yield* (yield* Notion).request(`v1/data_sources/${library.skills.data_source_id}`),
    )
    if (
      raw.id !== library.skills.data_source_id ||
      raw.in_trash === true ||
      property(raw.parent).database_id !== library.skills.database_id
    )
      return yield* Effect.fail(
        fail(
          "RELATION_SCHEMA_CONFLICT",
          "The registered Skills data source has a different owner.",
        ),
      )
    return property(raw.properties)
  })
}

export function prepareSharedRelationSchema(entry: string) {
  return Effect.gen(function* () {
    const library = yield* loadSharedLibrary(entry)
    yield* inspectTable(
      library.skills.database_id,
      registeredSkillProperties(library.skills),
      library.parent_page_id,
      library.skills,
    )
    const fields = yield* schema(library)
    const additions = (["Members", "Requires"] as const).filter(
      (field) => library.skills.property_ids[field] === undefined,
    )
    yield* checked(() => {
      for (const field of additions)
        if (fields[field] !== undefined)
          throw fail(
            "RELATION_SCHEMA_CONFLICT",
            "An unregistered property already occupies the requested name; explicitly bind its verified identity instead of overwriting or guessing.",
            { field },
          )
    })
    const schema_property_ids = yield* checked(() =>
      Object.values(fields)
        .map((raw) => {
          const id = property(raw).id
          if (typeof id !== "string" || !id)
            throw fail(
              "RELATION_SCHEMA_INVALID",
              "The complete Skills schema contains a missing property identity.",
            )
          return id
        })
        .sort(),
    )
    if (new Set(schema_property_ids).size !== schema_property_ids.length)
      return yield* Effect.fail(
        fail("RELATION_SCHEMA_INVALID", "The Skills schema repeats a property identity."),
      )
    const description = {
      version: 1 as const,
      kind: "relation_schema" as const,
      library,
      additions,
      schema_property_ids,
    }
    return {
      ...description,
      operation_id: `relations-schema-${yield* sha256(canonicalSharedJson(description))}`,
    } satisfies SharedRelationSchemaPlan
  })
}

/** Read-only health check. Missing optional legacy bindings require an explicit upgrade. */
export function inspectSharedRelationSchema(library: SharedLibrary) {
  return Effect.gen(function* () {
    yield* inspectTable(
      library.skills.database_id,
      registeredSkillProperties(library.skills),
      library.parent_page_id,
      library.skills,
    )
    const missing = (["Members", "Requires"] as const).filter(
      (field) => library.skills.property_ids[field] === undefined,
    )
    return {
      library_id: library.library_id,
      data_source_id: library.skills.data_source_id,
      ready: missing.length === 0,
      missing,
      bindings: Object.fromEntries(
        (["Members", "Requires"] as const).flatMap((field) => {
          const id = library.skills.property_ids[field]
          return id === undefined ? [] : [[field, id]]
        }),
      ),
      parent_kinds: ["skill", "router"] as const,
      target_kind: "skill" as const,
      targets_enabled: true as const,
      upgrade_argv:
        missing.length === 0
          ? []
          : [
              "ntn-skills",
              "ctl",
              "library",
              "relations",
              "plan",
              "--entry",
              library.skills.database_id,
            ],
    }
  })
}

export function validateSharedRelationSchemaPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* checked(() =>
      Schema.decodeUnknownSync(SharedRelationSchemaPlanSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const { operation_id, ...description } = plan
    if (
      operation_id !== `relations-schema-${yield* sha256(canonicalSharedJson(description))}` ||
      new Set(plan.additions).size !== plan.additions.length ||
      !same([...plan.additions].sort(), plan.additions) ||
      !same([...new Set(plan.schema_property_ids)].sort(), plan.schema_property_ids) ||
      !same(
        plan.additions,
        (["Members", "Requires"] as const).filter(
          (field) => plan.library.skills.property_ids[field] === undefined,
        ),
      ) ||
      Object.values(plan.library.skills.property_ids).some(
        (id) => !plan.schema_property_ids.includes(id),
      )
    )
      return yield* Effect.fail(
        fail(
          "RELATION_SCHEMA_INVALID",
          "The plan differs from its exact original schema identities.",
        ),
      )
    return plan
  })
}

function observedCandidate(plan: SharedRelationSchemaPlan) {
  return Effect.gen(function* () {
    const fields = yield* schema(plan.library)
    const values = Object.values(fields)
    const ids = values.map((raw) => property(raw).id)
    if (plan.schema_property_ids.some((id) => !ids.includes(id)))
      return yield* Effect.fail(
        fail(
          "RELATION_SCHEMA_CONFLICT",
          "An original property was deleted or recreated; its replacement name is not its identity.",
        ),
      )
    const property_ids = { ...plan.library.skills.property_ids }
    let incomplete = false
    for (const field of plan.additions) {
      const matches = values.filter((raw) => property(raw).description === marker(plan, field))
      if (matches.length === 0) {
        if (fields[field] !== undefined)
          return yield* Effect.fail(
            fail(
              "RELATION_SCHEMA_CONFLICT",
              "A relation name is occupied without the original operation marker.",
              { field },
            ),
          )
        incomplete = true
        continue
      }
      if (matches.length !== 1)
        return yield* Effect.fail(
          fail(
            "RELATION_SCHEMA_CONFLICT",
            "Several native properties claim one original relation operation.",
            { field },
          ),
        )
      property_ids[field] = yield* checked(() =>
        validateSharedRelationField(matches[0], plan.library.skills.data_source_id),
      )
    }
    if (incomplete) return undefined
    const candidate = { ...plan.library, skills: { ...plan.library.skills, property_ids } }
    yield* inspectTable(
      candidate.skills.database_id,
      registeredSkillProperties(candidate.skills),
      candidate.parent_page_id,
      candidate.skills,
    )
    return candidate
  })
}

/** Uses existing immutable Records plus the same local pre-dispatch barrier as native writes.
 * A prior step can only be observed. A missing effect never permits another PATCH. */
function dispatchSchemaStep<R>(
  plan: SharedRelationSchemaPlan,
  step: "schema" | "descriptor",
  request: { readonly path: string; readonly body: unknown },
  observe: Effect.Effect<SharedLibrary | undefined, SkillsError, R>,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const scope = yield* authScope
    const recordId = `${plan.operation_id}-${step}`
    const frozen = { version: 1, kind: "relation_schema_dispatch", plan, step, request }
    const key = `operations/shared-relation-schema/${scope}/${recordId}.json`
    const pending = yield* store.readJson(key, Schema.Unknown)
    if (pending !== undefined && !same(pending, frozen))
      return yield* Effect.fail(
        fail(
          "RELATION_SCHEMA_CONFLICT",
          "The local original schema request differs from the supplied plan.",
        ),
      )
    const records = yield* querySharedArchiveRecords(plan.library, { entityId: entity, recordId })
    if (records.length > 0 || pending !== undefined) {
      if (
        records.length > 0 &&
        records.some(
          (record) => !same(record.payload, frozen) || record.operation_id !== plan.operation_id,
        )
      )
        return yield* Effect.fail(
          fail(
            "RELATION_SCHEMA_CONFLICT",
            "The retained original schema request differs from this plan.",
          ),
        )
      const current = yield* observe
      if (current !== undefined) return current
      return yield* Effect.fail(
        fail(
          "RELATION_SCHEMA_UNKNOWN",
          "The original schema step has no completely verified effect; it will not be replayed.",
          { operation_id: plan.operation_id, step, recovery: { mode: "reconcile", plan } },
        ),
      )
    }
    yield* store.writeJson(key, frozen)
    yield* appendSharedArchiveRecord(plan.library, {
      mode: "create",
      recordId,
      operationId: plan.operation_id,
      entityId: entity,
      payload: frozen,
    })
    yield* (yield* Notion).request(request.path, request.body, { method: "PATCH" })
    const current = yield* observe
    if (current === undefined)
      return yield* Effect.fail(
        fail(
          "RELATION_SCHEMA_UNKNOWN",
          "The acknowledged schema step failed complete readback; retain the original plan.",
          { operation_id: plan.operation_id, step },
        ),
      )
    return current
  }).pipe(
    Effect.mapError((error) =>
      fail(error.code, error.message, {
        ...property(error.details),
        operation_id: plan.operation_id,
        step,
        recovery: { mode: "reconcile", plan },
      }),
    ),
  )
}

export function executeSharedRelationSchema(input: unknown, mode: "apply" | "reconcile" = "apply") {
  return Effect.gen(function* () {
    const plan = yield* validateSharedRelationSchemaPlan(input)
    const current = yield* loadSharedLibrary(plan.library.skills.database_id)
    let candidate = yield* observedCandidate(plan)
    if (candidate !== undefined && same(current, candidate))
      return {
        status: "unchanged" as const,
        verified: true as const,
        operation_id: plan.operation_id,
        library: current,
      }
    if (!same(current, plan.library))
      return yield* Effect.fail(
        fail(
          "RELATION_SCHEMA_CONFLICT",
          "The library descriptor changed since the frozen schema plan; no field was overwritten.",
        ),
      )
    if (mode === "reconcile")
      return {
        status:
          candidate === undefined
            ? ("schema_unresolved" as const)
            : ("registration_pending" as const),
        verified: false as const,
        operation_id: plan.operation_id,
        library: current,
        ...(candidate === undefined ? {} : { candidate }),
        plan,
      }
    if (candidate === undefined) {
      // Validate registered native bindings again before the first schema dispatch.
      yield* inspectTable(
        current.skills.database_id,
        registeredSkillProperties(current.skills),
        current.parent_page_id,
        current.skills,
      )
      candidate = yield* dispatchSchemaStep(
        plan,
        "schema",
        {
          path: `v1/data_sources/${current.skills.data_source_id}`,
          body: {
            properties: Object.fromEntries(
              plan.additions.map((field) => [
                field,
                {
                  ...sharedRelationProperty(current.skills.data_source_id),
                  description: marker(plan, field),
                },
              ]),
            ),
          },
        },
        observedCandidate(plan),
      )
    }
    const selected = candidate
    const verified = yield* dispatchSchemaStep(
      plan,
      "descriptor",
      {
        path: `v1/databases/${current.skills.database_id}`,
        body: { description: spans(LIBRARY_MARKER + JSON.stringify(selected)) },
      },
      Effect.gen(function* () {
        const observed = yield* loadSharedLibrary(selected.skills.database_id)
        if (!same(observed, selected)) return undefined
        yield* inspectTable(
          observed.skills.database_id,
          registeredSkillProperties(observed.skills),
          observed.parent_page_id,
          observed.skills,
        )
        return observed
      }),
    )
    return {
      status: "applied" as const,
      verified: true as const,
      operation_id: plan.operation_id,
      library: verified,
    }
  })
}
