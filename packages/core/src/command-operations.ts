import {
  hasZeroListRepairCandidate,
  observePublicationZeroListRepair,
  resumePublicationZeroListRepair,
} from "./publication-zero-list-repair.ts"
import { Effect, Schema } from "effect"
import { aliasFor, fail, notionPage, property, SkillsError, validateDescription } from "./model.ts"
import { pageId, parseTarget } from "./ref.ts"
import { resumePublication } from "./mutation.ts"
import type { PublicationOptions } from "./publication.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { reconcilePublication } from "./publication-reconcile.ts"
import { ReceiptSchema, syncStatus } from "./sync.ts"
import { authScope } from "./catalog.ts"
import { configuration } from "./store.ts"
import {
  listUpstreamOperations,
  showUpstreamOperation,
  reconcileUpstreamOperation,
  resumeUpstreamOperation,
} from "./upstream-operations.ts"
import { UpstreamPublicOperationSchema } from "./upstream-model.ts"
import { publicationIdentityForUpstream } from "./upstream-content.ts"
import {
  listDatabaseInitOperations,
  showDatabaseInitOperation,
  reconcileDatabaseInitOperation,
  resumeDatabaseInitOperation,
  DatabaseInitOperationSchema,
} from "./database-init.ts"
import { Store } from "./store.ts"
import { Notion } from "./notion.ts"
import { openSkill, snapshotInfo, targetSnapshot } from "./snapshot.ts"
import { snapshotAuthoredPortable } from "./export.ts"
import { beginPublication } from "./publication.ts"
import { invalidateSnapshotCache } from "./cache.ts"
import { memberIds, membersProperty, resolveRouterMembers } from "./router-members.ts"
import { referencePagesMatch } from "./reference-mutation.ts"
import { sha256 } from "./store.ts"
import { creationProofFromBody } from "./publication-create-identity.ts"
import { provePublicationListRepair, retainedListSource } from "./publication-list-repair.ts"
import { resumePublicationListRepair } from "./publication-recovery.ts"
export {
  PublicationSupersedePlanSchema,
  supersedePlanOperation,
  supersedeApplyOperation,
} from "./publication-supersede.ts"
export type { PublicationSupersedePlan } from "./publication-supersede.ts"
export {
  planPublicationBodyCompletion,
  applyPublicationBodyCompletion,
  reconcilePublicationBodyCompletion,
} from "./publication-body-completion.ts"

export const OperationReviewSchema = Schema.Struct({
  format: Schema.Literal(1),
  operation_id: Schema.String,
  kind: Schema.Literal("review"),
  state: Schema.Literal("unknown"),
  reason: Schema.Literal("UNRESOLVED_NO_REPLAY"),
  provenance: Schema.Struct({
    type: Schema.String,
    source_sha256: Schema.String,
    audit_ref: Schema.String,
  }),
  refs: Schema.Struct({
    plan_ids: Schema.Array(Schema.String),
    publication_ids: Schema.Array(Schema.String),
    binding_ids: Schema.Array(Schema.String),
  }),
  next: Schema.Struct({ action: Schema.Literal("inspect"), audit_ref: Schema.String }),
})

const NextSchema = Schema.Struct({ argv: Schema.Array(Schema.String), reason: Schema.String })
const hasListRepairCandidate = (receipt: typeof PublicationReceiptSchema.Type) =>
  Boolean(
    receipt.intents.at(-1)?.list_start_repair &&
      (receipt.conflict ||
        receipt.intents.at(-1)?.status !== "completed" ||
        !receipt.stages.includes("list_start_repair_verified")),
  ) ||
  Boolean(
    receipt.conflict &&
      receipt.intents.some((intent) => {
        const target = retainedListSource(intent)
        return target !== undefined && /(?:^|\n) {0,3}0[.)][ \t]/.test(target)
      }),
  )
const PublicFields = {
  operation_id: Schema.String,
  state: Schema.String,
  verified: Schema.Boolean,
  next: NextSchema,
  resume_supported: Schema.Boolean,
}
const PublicationOperationSchema = Schema.Struct({
  ...PublicFields,
  domain: Schema.Literal("publication"),
  result: Schema.Struct({
    operation: Schema.Literals(["create", "replace", "write"]),
    page_id: Schema.optional(Schema.String),
    effects: Schema.Array(
      Schema.Struct({
        method: Schema.Literals(["GET", "POST", "PATCH"]),
        path: Schema.String,
        status: Schema.Literals(["pending", "completed", "failed", "unknown"]),
      }),
    ),
    failure_code: Schema.optional(Schema.String),
    body_completion: Schema.optional(
      Schema.Struct({
        plan_id: Schema.String,
        phase: Schema.String,
        attempts: Schema.Number,
        completed_effects: Schema.Number,
      }),
    ),
    creation_recovery: Schema.Array(Schema.Unknown),
    creation_discovery: Schema.Array(Schema.Unknown),
    upload_recovery: Schema.Array(
      Schema.Struct({
        suboperation_id: Schema.String,
        filename: Schema.String,
        sha256: Schema.String,
        byte_length: Schema.Number,
        upload_id: Schema.optional(Schema.String),
        state: Schema.Literals(["pending", "uploaded", "remote_orphan"]),
        replacement_suboperation_id: Schema.optional(Schema.String),
      }),
    ),
    outcome: Schema.optional(
      Schema.Literals(["success", "conflict", "unknown", "needs_safe_commit", "needs_safe_resume"]),
    ),
    observations: Schema.optional(
      Schema.Array(
        Schema.Struct({
          path: Schema.String,
          outcome: Schema.Literals(["success", "conflict", "unknown"]),
          reason: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
})
const SyncObservationSchema = Schema.Struct({
  binding_id: Schema.String,
  status: Schema.String,
  baseline_initialized: Schema.Boolean,
  baseline_generation: Schema.Number,
  common_content_id: Schema.NullOr(Schema.String),
  local_content_id: Schema.NullOr(Schema.String),
  remote_content_id: Schema.NullOr(Schema.String),
  remote_snapshot_id: Schema.NullOr(Schema.String),
  remote_version: Schema.NullOr(Schema.String),
  authoritative: Schema.Boolean,
})
const SyncLocalOperationSchema = Schema.Struct({
  ...PublicFields,
  domain: Schema.Literal("sync_local"),
  result: Schema.Struct({
    plan_id: Schema.String,
    bindings: Schema.Array(
      Schema.Struct({
        binding_id: Schema.String,
        page_id: Schema.String,
        stage: Schema.Literals(["prepared", "writing", "verified", "complete", "diverged"]),
        generation_before: Schema.Number,
        generation_after: Schema.optional(Schema.Number),
      }),
    ),
    failure_code: Schema.optional(Schema.String),
    observations: Schema.optional(Schema.Array(SyncObservationSchema)),
  }),
})
const ReviewOperationSchema = Schema.Struct({
  ...PublicFields,
  domain: Schema.Literal("review"),
  result: Schema.Struct({
    reason: OperationReviewSchema.fields.reason,
    provenance: OperationReviewSchema.fields.provenance,
    refs: OperationReviewSchema.fields.refs,
  }),
})
export const OperationSchema = Schema.Union([
  PublicationOperationSchema,
  SyncLocalOperationSchema,
  ReviewOperationSchema,
  UpstreamPublicOperationSchema,
  DatabaseInitOperationSchema,
])
export type Operation = typeof OperationSchema.Type

function publicationOperation(
  receipt: typeof PublicationReceiptSchema.Type,
): typeof PublicationOperationSchema.Type {
  const properties = receipt.context?.write_path === "@properties"
  const resume =
    (!receipt.body_completion || receipt.body_completion.phase === "verified") &&
    !receipt.conflict &&
    receipt.state !== "unknown" &&
    (!properties || receipt.state !== "completed")
  return {
    domain: "publication",
    operation_id: receipt.operation_id,
    state: receipt.state,
    verified: receipt.state === "completed" && !receipt.conflict,
    result: {
      operation: receipt.operation,
      ...(receipt.page_id ? { page_id: receipt.page_id } : {}),
      effects: receipt.intents.map(({ method, path, status }) => ({ method, path, status })),
      ...(receipt.body_completion
        ? {
            body_completion: {
              plan_id: receipt.body_completion.plan_id,
              phase: receipt.body_completion.phase,
              attempts: receipt.body_completion.attempts.length,
              completed_effects: receipt.body_completion.attempts.filter(
                (item) =>
                  item.disposition?.kind === "acknowledged_verified" ||
                  item.disposition?.kind === "observed_applied",
              ).length,
            },
          }
        : {}),
      creation_recovery: receipt.intents.flatMap((intent, intent_index) => {
        if (intent.path !== "v1/pages") return []
        const proof = creationProofFromBody(intent.body)
        return [
          {
            intent_index,
            status: intent.status,
            parent: property(intent.body).parent,
            ...(typeof property(intent.response).id === "string"
              ? { page_id: property(intent.response).id }
              : {}),
            ...(proof ? { proof } : { marker_kind: "legacy_original_intent" }),
          },
        ]
      }),
      creation_discovery: receipt.creation_discovery ?? [],
      upload_recovery: receipt.intents.flatMap((intent) =>
        intent.artifact
          ? [
              {
                ...intent.artifact,
                ...(typeof property(intent.response).id === "string"
                  ? { upload_id: String(property(intent.response).id) }
                  : {}),
                state:
                  intent.recovery?.kind === "remote_orphan"
                    ? ("remote_orphan" as const)
                    : property(intent.response).status === "uploaded"
                      ? ("uploaded" as const)
                      : ("pending" as const),
                ...(intent.recovery
                  ? { replacement_suboperation_id: intent.recovery.replacement_suboperation_id }
                  : {}),
              },
            ]
          : [],
      ),
      ...(receipt.failure ? { failure_code: receipt.failure.code } : {}),
    },
    next:
      receipt.body_completion && receipt.body_completion.phase !== "verified"
        ? {
            argv: [
              "ntn-skills-operator",
              "operation",
              "body-completion-reconcile",
              receipt.body_completion.plan_id,
            ],
            reason:
              "Observe the retained bounded completion before continuing the original publication.",
          }
        : (properties && receipt.state === "completed") || receipt.conflict
          ? {
              argv: ["ntn-skills", "read", receipt.page_id ?? receipt.operation_id, "--refresh"],
              reason: "Read the exact current target before authorizing a new change.",
            }
          : {
              argv: [
                "ntn-skills",
                "operation",
                resume ? "resume" : "reconcile",
                receipt.operation_id,
              ],
              reason: resume
                ? "Continue the retained publication under its original guards."
                : "Read back the saved intents before considering further writes.",
            },
    resume_supported:
      (!receipt.body_completion || receipt.body_completion.phase === "verified") &&
      !receipt.conflict &&
      (!properties || receipt.state === "running" || receipt.state === "completed"),
  }
}
function syncOperation(receipt: typeof ReceiptSchema.Type): typeof SyncLocalOperationSchema.Type {
  return {
    domain: "sync_local",
    operation_id: receipt.operation_id,
    state: receipt.status,
    verified: receipt.status === "complete",
    resume_supported: false,
    result: {
      plan_id: receipt.plan_id,
      bindings: receipt.bindings.map(
        ({ binding_id, page_id, stage, generation_before, generation_after }) => ({
          binding_id,
          page_id,
          stage,
          generation_before,
          ...(generation_after === undefined ? {} : { generation_after }),
        }),
      ),
      ...(receipt.failure ? { failure_code: receipt.failure.code } : {}),
    },
    next: {
      argv: ["ntn-skills", "operation", "reconcile", receipt.operation_id],
      reason:
        "Observe both sides without advancing a baseline; authorize changes with a new reviewed sync plan.",
    },
  }
}
function reviewOperation(
  review: typeof OperationReviewSchema.Type,
): typeof ReviewOperationSchema.Type {
  return {
    domain: "review",
    operation_id: review.operation_id,
    state: review.state,
    verified: false,
    resume_supported: false,
    result: { reason: review.reason, provenance: review.provenance, refs: review.refs },
    next: {
      argv: ["ntn-skills", "operation", "show", review.operation_id],
      reason: `Inspect retained migration evidence at ${review.provenance.audit_ref}; it cannot authorize replay.`,
    },
  }
}

function localOperations(id?: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const config = yield* configuration
    const keys = (prefix: string) =>
      id ? Effect.succeed([`${prefix}/${id}.json`]) : store.listKeys(prefix)
    const publications = (yield* Effect.forEach(yield* keys("publications"), (key) =>
      store.readJson(key, PublicationReceiptSchema),
    )).filter((entry) => entry !== undefined)
    const receipts = (yield* Effect.forEach(yield* keys("sync/receipts"), (key) =>
      store.readJson(key, ReceiptSchema),
    )).filter((entry) => entry !== undefined)
    const reviews = (yield* Effect.forEach(yield* keys("operation-reviews"), (key) =>
      store.readJson(key, OperationReviewSchema),
    )).filter((entry) => entry !== undefined)
    const bindings = config.sync_bindings ?? []
    const scopedReceipts = receipts.filter(
      (receipt) =>
        receipt.bindings.length > 0 &&
        receipt.bindings.every((entry) =>
          bindings.some(
            (binding) => binding.id === entry.binding_id && binding.page_id === entry.page_id,
          ),
        ),
    )
    const scope =
      publications.some((entry) => entry.scope !== undefined) || scopedReceipts.length > 0
        ? yield* authScope
        : undefined
    const operations: Operation[] = [
      ...reviews.map(reviewOperation),
      ...publications
        .filter((entry) => scope !== undefined && entry.scope === scope)
        .map(publicationOperation),
      ...scopedReceipts
        .filter((receipt) =>
          receipt.bindings.every((entry) =>
            bindings.some(
              (binding) =>
                binding.id === entry.binding_id &&
                binding.page_id === entry.page_id &&
                binding.scope === scope,
            ),
          ),
        )
        .map(syncOperation),
    ]
    return operations
  })
}
function uniqueOperations(operations: readonly Operation[]) {
  return Effect.gen(function* () {
    const byId = new Map<string, Operation>()
    for (const operation of operations) {
      const previous = byId.get(operation.operation_id)
      if (previous && previous.domain !== operation.domain)
        return yield* Effect.fail(
          fail(
            "OPERATION_ID_COLLISION",
            "This identity belongs to more than one operation domain.",
            { operation_id: operation.operation_id, domains: [previous.domain, operation.domain] },
          ),
        )
      byId.set(operation.operation_id, operation)
    }
    return [...byId.values()].sort((a, b) => a.operation_id.localeCompare(b.operation_id))
  })
}

export function updateSkill(
  input: string,
  options: {
    readonly name?: string
    readonly description?: string
    readonly defaultContext?: boolean
    readonly members?: readonly string[]
    readonly database?: string
    readonly dryRun?: boolean
  },
) {
  return Effect.gen(function* () {
    if (
      options.name === undefined &&
      options.description === undefined &&
      options.defaultContext === undefined &&
      options.members === undefined
    )
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Provide --name, --description, --default-context or Members."),
      )
    if (options.name !== undefined)
      yield* Effect.try({ try: () => aliasFor(options.name!), catch: (e) => e as SkillsError })
    if (options.description !== undefined)
      yield* Effect.try({
        try: () => validateDescription(options.description),
        catch: (e) => e as SkillsError,
      })
    const target = yield* Effect.try({
      try: () => parseTarget(input),
      catch: (e) => e as SkillsError,
    })
    if (!target.snapshot && !pageId(target.selector))
      return yield* Effect.fail(
        fail("EXACT_TARGET_REQUIRED", "Property updates require an exact page or pinned snapshot."),
      )
    const baseline = target.snapshot
      ? yield* targetSnapshot(target, options)
      : yield* openSkill(target.selector, { database: options.database, refresh: true })
    if (target.path && target.path !== baseline.entrypoint)
      return yield* Effect.fail(
        fail("EXACT_TARGET_REQUIRED", "Property updates require the selected record entrypoint."),
      )
    const api = yield* Notion
    const observations: Record<string, unknown> = {}
    observations[`v1/pages/${notionPage(baseline.record).locator.page_id}/markdown`] =
      yield* api.request(`v1/pages/${notionPage(baseline.record).locator.page_id}/markdown`)
    const current = yield* openSkill(notionPage(baseline.record).locator.page_id, {
      database: options.database,
      refresh: true,
    }).pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, requestOptions) =>
          api.request(path, body, requestOptions).pipe(
            Effect.tap((raw) =>
              Effect.sync(() => {
                observations[path] = JSON.parse(JSON.stringify(raw))
              }),
            ),
          ),
      }),
    )
    if (
      baseline.version_id !== current.version_id ||
      baseline.scope !== current.scope ||
      notionPage(baseline.record).locator.database_id !==
        notionPage(current.record).locator.database_id ||
      notionPage(baseline.record).locator.data_source_id !==
        notionPage(current.record).locator.data_source_id ||
      baseline.record.name !== current.record.name ||
      baseline.record.description !== current.record.description ||
      baseline.record.default_context !== current.record.default_context
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The remote Skill changed since the expected baseline."),
      )
    const raw = observations[`v1/pages/${notionPage(current.record).locator.page_id}`]
    const props = property(property(raw).properties)
    const values = Object.values(props).map(property)
    const title = values.find((p) => p.type === "title")
    const description =
      values.find((p) => p.id === "notion%3A%2F%2Fskills%2Fdescription_property") ??
      property(props.Description)
    if (typeof title?.id !== "string" || typeof description.id !== "string")
      return yield* Effect.fail(fail("INVALID_RESPONSE", "Skill properties are unavailable."))
    const defaultContext = property(props["Default Context"])
    if (
      options.defaultContext !== undefined &&
      (defaultContext.type !== "checkbox" || typeof defaultContext.id !== "string")
    )
      return yield* Effect.fail(
        fail("PROPERTY_UNAVAILABLE", "Default Context must be an existing checkbox property."),
      )
    const selectedMembers =
      options.members === undefined
        ? undefined
        : yield* resolveRouterMembers(
            options.members,
            notionPage(current.record).locator,
            current.record.kind,
          )
    for (const member of selectedMembers ?? [])
      observations[`v1/pages/${pageId(member.id)!}`] = member.metadata
    const members = selectedMembers?.map((member) => pageId(member.id)!)
    const memberProperty =
      members === undefined
        ? undefined
        : yield* Effect.try({
            try: () => String(membersProperty(raw).id),
            catch: (error) => error as SkillsError,
          })
    const authoredBefore = yield* snapshotAuthoredPortable(current)
    const changes = {
      ...(options.name === undefined
        ? {}
        : { [title.id]: { title: [{ text: { content: options.name } }] } }),
      ...(options.description === undefined
        ? {}
        : { [description.id]: { rich_text: [{ text: { content: options.description } }] } }),
      ...(options.defaultContext === undefined
        ? {}
        : { [String(defaultContext.id)]: { checkbox: options.defaultContext } }),
      ...(members === undefined
        ? {}
        : { [memberProperty!]: { relation: members.map((id) => ({ id })) } }),
    }
    const plan = {
      operation: "update",
      page_id: notionPage(current.record).locator.page_id,
      scope: current.scope,
      effects: { properties: Object.keys(changes) },
      previous_version_id: current.version_id,
    }
    if (options.dryRun) return { ...plan, dry_run: true, verified: false }
    const session = yield* beginPublication(
      authoredBefore,
      "write",
      {},
      { write_path: "@properties", previous_version_id: current.version_id },
    )
    yield* session.bind(
      {
        database_id: notionPage(current.record).locator.database_id,
        data_source_id: notionPage(current.record).locator.data_source_id,
        page_id: notionPage(current.record).locator.page_id,
      },
      current.scope,
    )
    return yield* session.finish(
      Effect.gen(function* () {
        yield* session.authorize(
          `v1/pages/${notionPage(current.record).locator.page_id}`,
          { properties: changes },
          current.scope,
          observations,
        )
        yield* session.run(
          "update-properties",
          session.notion.request(
            `v1/pages/${notionPage(current.record).locator.page_id}`,
            { properties: changes },
            { method: "PATCH" },
          ),
        )
        yield* invalidateSnapshotCache(notionPage(current.record).locator.page_id, current.scope)
        yield* session.notion.request(
          `v1/pages/${notionPage(current.record).locator.page_id}/markdown`,
        )
        const saved = yield* openSkill(notionPage(current.record).locator.page_id, {
          database: options.database,
          refresh: true,
        }).pipe(Effect.provideService(Notion, session.notion))
        if (
          (options.name !== undefined && saved.record.name !== options.name) ||
          (options.description !== undefined && saved.record.description !== options.description) ||
          saved.record.default_context !==
            (options.defaultContext ?? current.record.default_context)
        )
          return yield* Effect.fail(
            fail("WRITE_VERIFICATION_FAILED", "Saved properties differ from the requested update."),
          )
        if (members !== undefined) {
          const rawSaved = yield* session.notion.request(
            `v1/pages/${notionPage(saved.record).locator.page_id}`,
          )
          const actual = yield* Effect.try({
            try: () => memberIds(rawSaved),
            catch: (error) => error as SkillsError,
          })
          if (JSON.stringify(actual) !== JSON.stringify(members))
            return yield* Effect.fail(
              fail(
                "WRITE_VERIFICATION_FAILED",
                "Saved Router Members differ from the requested relation.",
              ),
            )
        }
        if (saved.references)
          yield* referencePagesMatch(saved, {
            ...authoredBefore,
            name: saved.record.name,
            description: saved.record.description,
          })
        const authoredAfter = yield* snapshotAuthoredPortable(saved)
        const beforeResources = authoredBefore.files.filter(
          (file) => file.path !== authoredBefore.main,
        )
        const afterResources = authoredAfter.files.filter(
          (file) => file.path !== authoredAfter.main,
        )
        if (beforeResources.length !== afterResources.length)
          return yield* Effect.fail(
            fail("WRITE_VERIFICATION_FAILED", "Property update changed authored resources."),
          )
        for (const file of beforeResources) {
          const actual = afterResources.find((entry) => entry.path === file.path)
          if (!actual || (yield* sha256(actual.bytes)) !== (yield* sha256(file.bytes)))
            return yield* Effect.fail(
              fail("WRITE_VERIFICATION_FAILED", "Property update changed an authored resource.", {
                path: file.path,
              }),
            )
        }
        return { ...snapshotInfo(saved), ...plan, verified: true }
      }),
    )
  })
}

export function showOperation(id: string) {
  return Effect.gen(function* () {
    const child = /^(uo_[a-f0-9]{64}):(0|[1-9][0-9]{0,9})$/.exec(id)
    if (!child && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Provide one exact operation ID."))
    const storedId = child ? (yield* publicationIdentityForUpstream(id)).id : id
    const operations = yield* localOperations(storedId)
    const upstream = yield* showUpstreamOperation(storedId)
    if (upstream) operations.push(upstream)
    if ((yield* (yield* Store).listKeys(`database-init/${storedId}/`)).length > 0) {
      const operation = yield* showDatabaseInitOperation(storedId)
      if (operation) operations.push(operation)
    }
    const selected = (yield* uniqueOperations(operations))[0]
    if (selected && (!child || selected.domain === "publication")) return selected
    if (child)
      return yield* Effect.fail(
        fail(
          "OPERATION_NOT_FOUND",
          "The child publication has no accessible receipt; inspect its original upstream operation.",
          {
            operation_id: id,
            publication_operation_id: storedId,
            parent_operation_id: child[1]!,
            next: {
              argv: ["ntn-skills", "operation", "show", child[1]!],
              reason:
                "A child can be recorded before its publication binds. Preserve the original upstream plan and outcome.",
            },
          },
        ),
      )
    return yield* Effect.fail(
      fail(
        "OPERATION_NOT_FOUND",
        "No recorded operation has this identity in the selected scope.",
        { operation_id: id },
      ),
    )
  })
}
export const listOperations = Effect.gen(function* () {
  const operations = yield* localOperations()
  operations.push(...(yield* listUpstreamOperations()))
  if ((yield* (yield* Store).listKeys("database-init/")).length > 0)
    operations.push(...(yield* listDatabaseInitOperations()))
  const selected = yield* uniqueOperations(operations)
  return {
    operations: selected,
    count: selected.length,
    source: "local" as const,
    coverage: {
      exhaustive: true as const,
      scope: "selected_authentication_and_configuration_with_local_reviews" as const,
    },
  }
})
export function reconcileOperation(inputId: string) {
  return Effect.gen(function* () {
    const operation = yield* showOperation(inputId)
    const id = operation.operation_id
    switch (operation.domain) {
      case "review":
        return operation
      case "database_init":
        return yield* reconcileDatabaseInitOperation(id)
      case "sync_upstream":
      case "subscription_add":
      case "subscription_update":
      case "subscription_remove":
      case "upstream_fork":
      case "upstream_track": {
        const reconciled = yield* reconcileUpstreamOperation(id)
        if (!reconciled)
          return yield* Effect.fail(
            fail("OPERATION_NOT_FOUND", "The scoped upstream operation is no longer available.", {
              operation_id: id,
            }),
          )
        return reconciled
      }
      case "sync_local": {
        const observations = (yield* Effect.forEach(operation.result.bindings, ({ binding_id }) =>
          syncStatus(binding_id, { refresh: true }),
        )).flatMap((status) =>
          status.bindings.map((entry) => ({
            binding_id: entry.binding.id,
            status: entry.status,
            baseline_initialized: entry.baseline_initialized,
            baseline_generation: entry.baseline_generation,
            common_content_id: entry.common_content_id,
            local_content_id: entry.local_content_id,
            remote_content_id: entry.remote_content_id,
            remote_snapshot_id: entry.remote_snapshot_id,
            remote_version: entry.remote_version,
            authoritative: entry.authoritative,
          })),
        )
        return {
          ...operation,
          verified:
            operation.state === "complete" &&
            observations.length === operation.result.bindings.length &&
            observations.length > 0 &&
            observations.every((entry) => entry.authoritative && entry.status === "unchanged"),
          result: { ...operation.result, observations },
        }
      }
      case "publication": {
        const reconciled = yield* reconcilePublication(id)
        const receipt = yield* (yield* Store).readJson(
          `publications/${id}.json`,
          PublicationReceiptSchema,
        )
        if (!receipt)
          return yield* Effect.fail(
            fail("OPERATION_NOT_FOUND", "The publication receipt is no longer available.", {
              operation_id: id,
            }),
          )
        const current = publicationOperation(receipt)
        if (!reconciled.verified && !receipt.owner && hasZeroListRepairCandidate(receipt)) {
          const repair = yield* observePublicationZeroListRepair(receipt, yield* Notion).pipe(
            Effect.result,
          )
          if (repair._tag === "Success")
            return {
              ...current,
              verified: false,
              resume_supported: true,
              next: {
                argv: ["ntn-skills", "operation", "resume", id],
                reason:
                  "Continue the original operation with its proven visible-zero representation; retain its fence for strict reassessment.",
              },
              result: {
                ...current.result,
                outcome: "needs_safe_resume" as const,
                observations: [
                  ...reconciled.observations,
                  {
                    path: "v1/pages/" + repair.success.repair.original.page_id + "/markdown",
                    outcome: "unknown" as const,
                    reason: "PUBLICATION_ZERO_LIST_REQUIRED",
                  },
                ],
              },
            }
        }
        if (!reconciled.verified && !receipt.owner && hasListRepairCandidate(receipt)) {
          const repair = yield* provePublicationListRepair(
            receipt,
            yield* Notion,
            !receipt.conflict,
          ).pipe(Effect.result)
          if (repair._tag === "Success")
            return {
              ...current,
              verified: false,
              resume_supported: true,
              next: {
                argv: ["ntn-skills", "operation", "resume", id],
                reason:
                  "Resume only the original derived list-start correction; the publication fence remains until strict reassessment.",
              },
              result: {
                ...current.result,
                outcome: "needs_safe_resume" as const,
                observations: [
                  ...reconciled.observations,
                  {
                    path: `v1/blocks/${repair.success.repair.block_id}`,
                    outcome: "unknown" as const,
                    reason: "PUBLICATION_LIST_REPAIR_REQUIRED",
                  },
                ],
              },
            }
        }
        return {
          ...current,
          verified: reconciled.verified,
          next: {
            argv: reconciled.next.argv,
            reason:
              reconciled.outcome === "needs_safe_commit"
                ? "The saved business intent matches; resume explicitly commits the publication marker under fresh guards."
                : reconciled.outcome === "success"
                  ? current.next.reason
                  : "Inspect the readback outcome before authorizing any further writes.",
          },
          result: {
            ...current.result,
            outcome: reconciled.outcome,
            observations: reconciled.observations,
          },
        }
      }
    }
  })
}
export function resumeOperation(inputId: string, options: PublicationOptions = {}) {
  return Effect.gen(function* () {
    const operation = yield* showOperation(inputId)
    const id = operation.operation_id
    if (options.retryMetadata && operation.domain !== "publication")
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "--retry-metadata applies only to an editable-file publication."),
      )
    if (operation.domain === "publication") {
      const receipt = yield* (yield* Store).readJson(
        `publications/${id}.json`,
        PublicationReceiptSchema,
      )
      if (options.retryMetadata && (!receipt?.context?.markdown_files || options.newArtifact))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "--retry-metadata requires an editable-file publication and cannot combine with --new-artifact.",
          ),
        )
      if (options.retryMetadata && receipt?.context?.markdown_files) {
        yield* resumePublication(id, options)
        return yield* showOperation(id)
      }
      if (receipt && (hasZeroListRepairCandidate(receipt) || hasListRepairCandidate(receipt))) {
        const repaired = yield* hasZeroListRepairCandidate(receipt)
          ? resumePublicationZeroListRepair(id)
          : resumePublicationListRepair(id, options)
        const current = yield* showOperation(id)
        if (current.domain !== "publication")
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "The repaired operation is no longer the same publication."),
          )
        return { ...current, verified: false as const, next: repaired.next }
      }
    }
    if (operation.domain === "review")
      return yield* Effect.fail(
        fail(
          "UNRESOLVED_NO_REPLAY",
          "Inspect retained evidence before authorizing a new operation. No request was replayed.",
          { operation_id: id, next: operation.next, provenance: operation.result.provenance },
        ),
      )
    if (!operation.resume_supported)
      return yield* Effect.fail(
        fail("OPERATION_NOT_RESUMABLE", operation.next.reason, {
          operation_id: id,
          next: operation.next,
        }),
      )
    switch (operation.domain) {
      case "database_init":
        return yield* resumeDatabaseInitOperation(id)
      case "sync_upstream":
      case "subscription_add":
      case "subscription_update":
      case "subscription_remove":
      case "upstream_fork":
      case "upstream_track": {
        const resumed = yield* resumeUpstreamOperation(id)
        if (!resumed)
          return yield* Effect.fail(
            fail("OPERATION_NOT_FOUND", "The scoped upstream operation is no longer available.", {
              operation_id: id,
            }),
          )
        return resumed
      }
      case "publication": {
        yield* resumePublication(id, options)
        return yield* showOperation(id)
      }
      case "sync_local":
        return yield* Effect.fail(
          fail("OPERATION_NOT_RESUMABLE", operation.next.reason, {
            operation_id: id,
            next: operation.next,
          }),
        )
    }
  })
}
