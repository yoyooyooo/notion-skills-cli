import { expandSharedOperationPlan, storedSharedOperationPlan } from "./shared-plan-storage.ts"
import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  SharedBodyWritePlanSchema,
  validateSharedBodyWritePlan,
  makeSharedBodyWritePlan,
} from "./shared-body-write-model.ts"
import {
  SharedFileManagementPlanSchema,
  validateSharedFileManagementPlan,
  type SharedFileManagementPlan,
} from "./shared-file-management-model.ts"
import {
  SharedMetadataWritePlanSchema,
  validateSharedMetadataWritePlan,
} from "./shared-metadata-write-model.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { restoreSharedNativeFileLinks } from "./shared-native-file-content.ts"
import { projectSharedNotionMarkdown } from "./shared-notion-projection.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const ReferenceCheckSchema = Schema.Struct({
  checked_files: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  local_references: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export const SharedApplyChangesManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  moves: Schema.optional(Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))),
  removes: Schema.optional(Schema.Array(Schema.String)),
  revives: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
  rewrites: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        start: Schema.Number,
        end: Schema.Number,
        from: Schema.String,
        to: Schema.String,
      }),
    ),
  ),
})
export type SharedApplyChangesManifest = typeof SharedApplyChangesManifestSchema.Type
const StageNameSchema = Schema.Literals([
  "allocate",
  "revive",
  "move",
  "retire",
  "author",
  "metadata",
])
export const SharedApplyBodyBindingSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("apply_body_binding"),
  operation_id: Schema.String.check(Schema.isPattern(/^apply-body-binding-[a-f0-9]{64}$/u)),
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  file_id: Identity,
  page_id: Schema.String,
  path: Schema.String,
  source_id: Schema.String,
  /** This logical body is never sent to Notion. Its old body and frontier stay frozen. */
  template: SharedBodyWritePlanSchema,
  existing_bindings: Schema.Array(Schema.Struct({ page_id: Schema.String, path: Schema.String })),
  allocations: Schema.Array(
    Schema.Struct({
      operation_id: Schema.String,
      file_id: Identity,
      path: Schema.String,
    }),
  ).check(Schema.isMinLength(1)),
})
export type SharedApplyBodyBinding = typeof SharedApplyBodyBindingSchema.Type
const SharedSkillApplyPlanV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_apply"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-apply-[a-f0-9]{64}\.[a-f0-9]{64}$/u)),
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  file_id: Identity,
  snapshot_id: Schema.String.check(Schema.isPattern(/^s_[a-f0-9]{64}$/u)),
  snapshot_version_id: Schema.String,
  snapshot_scope: Hash,
  source_id: Schema.String,
  bodies: Schema.Array(SharedBodyWritePlanSchema),
  metadata: Schema.optional(SharedMetadataWritePlanSchema),
})
const SharedSkillApplyPlanV2Schema = Schema.Struct({
  ...SharedSkillApplyPlanV1Schema.fields,
  version: Schema.Literal(2),
  baseline_tree_sha256: Hash,
  target_tree_sha256: Hash,
  membership_sha256: Hash,
  reference_check: ReferenceCheckSchema,
  final_files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Hash,
      bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      mode: Schema.optional(Schema.Literals(["100644", "100755"])),
    }),
  ),
  changes: Schema.NullOr(SharedApplyChangesManifestSchema),
  layout: Schema.Array(SharedFileManagementPlanSchema),
  /** Read-only evidence for an explicitly edited logical link whose native
   * target/body is already identical. These are not dispatched child operations. */
  unchanged_bodies: Schema.optional(Schema.Array(SharedBodyWritePlanSchema)),
  deferred_bodies: Schema.optional(Schema.Array(SharedApplyBodyBindingSchema)),
  stages: Schema.Array(
    Schema.Struct({
      name: StageNameSchema,
      operation_ids: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    }),
  ),
})
export const SharedSkillApplyPlanSchema = Schema.Union([
  SharedSkillApplyPlanV1Schema,
  SharedSkillApplyPlanV2Schema,
])
export type SharedSkillApplyPlan = typeof SharedSkillApplyPlanSchema.Type
export type SharedSkillApplyChild =
  | SharedSkillApplyPlan["bodies"][number]
  | NonNullable<SharedSkillApplyPlan["metadata"]>
  | SharedFileManagementPlan
  | SharedApplyBodyBinding
export const sharedSkillApplyPlansEntity = "skill-apply-plans-v1"
export const sharedSkillApplyOutcomesEntity = "skill-apply-outcomes-v1"
export const sharedSkillApplyOutcomeId = (operationId: string) => `outcome-${operationId}`
export const sharedSkillApplyProtection = {
  strategy: "frozen_sequential_child_operations",
  atomic: false,
  all_inputs_validated_before_dispatch: true,
  automatic_retry: false,
  automatic_rollback: false,
  original_children_required_for_recovery: true,
  notion_compare_and_swap: false,
} as const
const stageRank = {
  allocate: 0,
  revive: 1,
  move: 2,
  retire: 3,
  author: 4,
  metadata: 5,
} as const

export const applyChecked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_APPLY_INVALID", "The frozen shared apply operation is invalid."),
  })

export function sharedSkillApplyChildren(plan: {
  readonly version: 1 | 2
  readonly bodies: SharedSkillApplyPlan["bodies"]
  readonly metadata?: SharedSkillApplyPlan["metadata"]
  readonly layout?: Extract<SharedSkillApplyPlan, { version: 2 }>["layout"]
  readonly stages?: Extract<SharedSkillApplyPlan, { version: 2 }>["stages"]
  readonly deferred_bodies?: readonly SharedApplyBodyBinding[]
}): readonly SharedSkillApplyChild[] {
  if (plan.version !== 2 || plan.layout === undefined || plan.stages === undefined)
    return [...plan.bodies, ...(plan.metadata === undefined ? [] : [plan.metadata])]
  const byId = new Map<string, SharedSkillApplyChild>()
  for (const child of plan.layout) byId.set(child.operation_id, child)
  for (const child of plan.bodies) byId.set(child.operation_id, child)
  for (const child of plan.deferred_bodies ?? []) byId.set(child.operation_id, child)
  if (plan.metadata !== undefined) byId.set(plan.metadata.operation_id, plan.metadata)
  return plan.stages.flatMap((stage) =>
    stage.operation_ids.map((id) => {
      const child = byId.get(id)
      if (child === undefined)
        throw fail("SHARED_APPLY_INVALID", "An apply stage names a missing child operation.")
      return child
    }),
  )
}

export function sharedSkillApplyChildrenHash(operationId: string): string | undefined {
  return /^skill-apply-([a-f0-9]{64})\.[a-f0-9]{64}$/u.exec(operationId)?.[1]
}

function assertChildScope(plan: SharedSkillApplyPlan, child: SharedSkillApplyChild) {
  if (
    child.library_id !== plan.library_id ||
    child.skill_id !== plan.skill_id ||
    child.skill_page_id !== plan.skill_page_id
  )
    throw fail(
      "SHARED_APPLY_INVALID",
      "Every frozen child must belong to the exact original shared Skill.",
    )
  if (
    child.kind === "body_write" &&
    (child.action !== "write" ||
      child.source_id !== plan.source_id ||
      child.before.fingerprint.sha256 === child.candidate.content.sha256)
  )
    throw fail(
      "SHARED_APPLY_INVALID",
      "An apply body child must change one file without changing source selection.",
    )
  if (
    child.kind === "metadata_write" &&
    (child.file_id !== plan.file_id ||
      child.changes.some((change) => change.field === "Source") ||
      child.changes.every(
        (change) => canonicalSharedJson(change.before) === canonicalSharedJson(change.after),
      ))
  )
    throw fail(
      "SHARED_APPLY_INVALID",
      "Apply metadata must change nominated authoring fields; Source uses its explicit selector.",
    )
}

function assertLayoutStages(plan: Extract<SharedSkillApplyPlan, { version: 2 }>) {
  const children = sharedSkillApplyChildren(plan)
  const ids = children.map((child) => child.operation_id)
  if (new Set(ids).size !== ids.length || children.length === 0)
    throw fail("SHARED_APPLY_INVALID", "Apply stages must name each child operation once.")
  let previous = -1
  for (const stage of plan.stages) {
    const rank = stageRank[stage.name]
    if (rank <= previous)
      throw fail(
        "SHARED_APPLY_INVALID",
        "Apply stages must stay in allocate, revive, move, retire, author, metadata order.",
      )
    previous = rank
    for (const id of stage.operation_ids) {
      const child = children.find((value) => value.operation_id === id)
      if (child === undefined)
        throw fail("SHARED_APPLY_INVALID", "An apply stage names a missing child operation.")
      const matches =
        (stage.name === "allocate" && child.kind === "file_management" && child.action === "add") ||
        (stage.name === "revive" &&
          child.kind === "file_management" &&
          child.action === "undelete") ||
        (stage.name === "move" && child.kind === "file_management" && child.action === "move") ||
        (stage.name === "retire" &&
          child.kind === "file_management" &&
          child.action === "delete") ||
        (stage.name === "author" &&
          (child.kind === "body_write" || child.kind === "apply_body_binding")) ||
        (stage.name === "metadata" && child.kind === "metadata_write")
      if (!matches)
        throw fail(
          "SHARED_APPLY_INVALID",
          "An apply stage contains a child of the wrong operation kind.",
          { stage: stage.name, operation_id: id },
        )
    }
  }
  const covered = new Set(plan.stages.flatMap((stage) => stage.operation_ids))
  for (const child of [
    ...plan.layout,
    ...plan.bodies,
    ...(plan.deferred_bodies ?? []),
    ...(plan.metadata === undefined ? [] : [plan.metadata]),
  ])
    if (!covered.has(child.operation_id))
      throw fail("SHARED_APPLY_INVALID", "Every apply child must belong to one explicit stage.")
  for (const child of plan.layout) {
    if (
      child.snapshot_id !== plan.snapshot_id ||
      child.snapshot_version_id !== plan.snapshot_version_id ||
      child.snapshot_scope !== plan.snapshot_scope ||
      child.source_id !== plan.source_id ||
      child.tree_sha256 !== plan.baseline_tree_sha256 ||
      canonicalSharedJson(child.reference_check) !== canonicalSharedJson(plan.reference_check)
    )
      throw fail(
        "SHARED_APPLY_INVALID",
        "A layout child must cite the same frozen final reference check as its retained parent.",
      )
  }
}

export function validateSharedSkillApplyPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* applyChecked(() =>
      Schema.decodeUnknownSync(SharedSkillApplyPlanSchema)(expandSharedOperationPlan(input), {
        onExcessProperty: "error",
      }),
    )
    const children = sharedSkillApplyChildren(plan)
    yield* applyChecked(() => {
      if (
        pageId(plan.skill_page_id) !== plan.skill_page_id ||
        plan.snapshot_version_id === "" ||
        children.length === 0 ||
        new Set(children.map((child) => child.operation_id)).size !== children.length ||
        new Set(plan.bodies.map((child) => child.file_id)).size !== plan.bodies.length ||
        new Set(plan.bodies.map((child) => child.page_id)).size !== plan.bodies.length ||
        new Set(plan.bodies.map((child) => child.path)).size !== plan.bodies.length
      )
        throw fail(
          "SHARED_APPLY_INVALID",
          "An apply requires one exact Skill and distinct changed child identities.",
        )
      if (
        canonicalSharedJson(plan.bodies.map((child) => child.path)) !==
        canonicalSharedJson(plan.bodies.map((child) => child.path).sort())
      )
        throw fail("SHARED_APPLY_INVALID", "Apply body operations must use canonical path order.")
      for (const child of children) assertChildScope(plan, child)
      if (plan.version === 2) {
        assertLayoutStages(plan)
        const projections = plan.unchanged_bodies ?? []
        const allBodies = [...plan.bodies, ...projections, ...(plan.deferred_bodies ?? [])]
        if (
          ["path", "page_id", "file_id"].some(
            (key) =>
              new Set(
                allBodies.map((child) =>
                  key === "path" ? child.path : key === "page_id" ? child.page_id : child.file_id,
                ),
              ).size !== allBodies.length,
          )
        )
          throw fail(
            "SHARED_APPLY_INVALID",
            "Changed and unchanged body projections must have distinct paths and identities.",
          )
        for (const child of projections) {
          if (
            child.library_id !== plan.library_id ||
            child.skill_id !== plan.skill_id ||
            child.skill_page_id !== plan.skill_page_id ||
            child.source_id !== plan.source_id ||
            child.action !== "write" ||
            child.before.fingerprint.sha256 !== child.candidate.content.sha256
          )
            throw fail(
              "SHARED_APPLY_INVALID",
              "A read-only body projection must retain exactly the already observed native body.",
            )
        }
      }
    })
    for (const child of plan.bodies) yield* validateSharedBodyWritePlan(child)
    if (plan.version === 2) {
      for (const child of plan.layout) yield* validateSharedFileManagementPlan(child)
      for (const child of plan.unchanged_bodies ?? []) yield* validateSharedBodyWritePlan(child)
      for (const child of plan.deferred_bodies ?? []) {
        yield* validateSharedApplyBodyBinding(child)
        yield* applyChecked(() => {
          if (child.source_id !== plan.source_id || child.template.action !== "write")
            throw fail(
              "SHARED_APPLY_INVALID",
              "A deferred body must preserve the parent's source and authoring intent.",
            )
          for (const allocation of child.allocations) {
            const original = plan.layout.find(
              (item) => item.operation_id === allocation.operation_id,
            )
            if (
              original?.action !== "add" ||
              original.file_id !== allocation.file_id ||
              original.path !== allocation.path
            )
              throw fail(
                "SHARED_APPLY_INVALID",
                "A deferred native link must name an exact frozen allocation in its parent.",
              )
          }
        })
      }
    }
    if (plan.metadata !== undefined) yield* validateSharedMetadataWritePlan(plan.metadata)
    const childrenHash = yield* sha256(
      canonicalSharedJson(children.map((child) => child.operation_id)),
    )
    const { operation_id, ...description } = plan
    if (
      operation_id !==
      `skill-apply-${childrenHash}.${yield* sha256(canonicalSharedJson(description))}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_INVALID",
          "The original apply identity does not match its complete child plans.",
        ),
      )
    yield* applyChecked(() =>
      validateSharedRecordEnvelope(plan.operation_id, storedSharedOperationPlan(plan)),
    )
    return plan
  })
}

export function validateSharedApplyBodyBinding(input: unknown) {
  return Effect.gen(function* () {
    const binding = yield* applyChecked(() =>
      Schema.decodeUnknownSync(SharedApplyBodyBindingSchema)(input, { onExcessProperty: "error" }),
    )
    yield* validateSharedBodyWritePlan(binding.template)
    const { operation_id, ...description } = binding
    if (operation_id !== `apply-body-binding-${yield* sha256(canonicalSharedJson(description))}`)
      return yield* Effect.fail(
        fail("SHARED_APPLY_INVALID", "The deferred body differs from its frozen logical intent."),
      )
    yield* applyChecked(() => {
      for (const key of [
        "library_id",
        "skill_id",
        "skill_page_id",
        "file_id",
        "page_id",
        "path",
        "source_id",
      ] as const)
        if (binding[key] !== binding.template[key])
          throw fail(
            "SHARED_APPLY_INVALID",
            "The deferred body and its exact original template disagree.",
          )
      if (
        binding.template.action !== "write" ||
        new Set(binding.allocations.map((value) => value.path)).size !== binding.allocations.length
      )
        throw fail(
          "SHARED_APPLY_INVALID",
          "Deferred bindings require distinct allocated paths and a normal authoring write.",
        )
    })
    // Capacity only: UUID destinations have fixed encoded width. These temporary
    // identities are never retained, exposed or dispatched as page allocations.
    const capacityBindings = [
      ...binding.existing_bindings,
      ...binding.allocations.map((allocation, index) => ({
        path: allocation.path,
        page_id: `ffffffff-ffff-4fff-8fff-${index.toString(16).padStart(12, "0")}`,
      })),
    ]
    const capacityPlan = yield* bindSharedApplyBody(binding, capacityBindings)
    yield* applyChecked(() =>
      validateSharedRecordEnvelope(binding.operation_id, {
        version: 1,
        kind: "apply_body_binding_record",
        intent_sha256: "f".repeat(64),
        bindings: capacityBindings,
        body_plan: storedSharedOperationPlan(capacityPlan),
      }),
    )
    return binding
  })
}

export function bindSharedApplyBody(
  child: SharedApplyBodyBinding,
  bindings: readonly { readonly page_id: string; readonly path: string }[],
) {
  return Effect.gen(function* () {
    const template = child.template
    const projection = yield* applyChecked(() =>
      projectSharedNotionMarkdown(
        restoreSharedNativeFileLinks(
          template.input_projection?.input_markdown ?? template.candidate.markdown,
          child.path,
          bindings,
        ),
        template.input_projection === undefined
          ? {}
          : { version: template.input_projection.version },
      ),
    )
    return yield* makeSharedBodyWritePlan({
      library_id: child.library_id,
      skill_id: child.skill_id,
      skill_page_id: child.skill_page_id,
      file_id: child.file_id,
      page_id: child.page_id,
      path: child.path,
      source_id: child.source_id,
      action: "write",
      before: template.before,
      parents: template.event.parents,
      candidateMarkdown: projection.markdown,
      input_projection: projection,
      ...(template.authored_input_sha256 === undefined
        ? {}
        : { authored_input_sha256: template.authored_input_sha256 }),
    })
  })
}

export function makeSharedApplyBodyBinding(
  input: Omit<SharedApplyBodyBinding, "version" | "kind" | "operation_id">,
) {
  return Effect.gen(function* () {
    const description = { version: 1 as const, kind: "apply_body_binding" as const, ...input }
    return yield* validateSharedApplyBodyBinding({
      ...description,
      operation_id: `apply-body-binding-${yield* sha256(canonicalSharedJson(description))}`,
    })
  })
}

export function makeSharedSkillApplyPlan(
  input:
    | Omit<Extract<SharedSkillApplyPlan, { version: 1 }>, "version" | "kind" | "operation_id">
    | Omit<Extract<SharedSkillApplyPlan, { version: 2 }>, "version" | "kind" | "operation_id">,
) {
  return Effect.gen(function* () {
    const version = "layout" in input ? (2 as const) : (1 as const)
    const description = { version, kind: "skill_apply" as const, ...input }
    const childrenHash = yield* sha256(
      canonicalSharedJson(sharedSkillApplyChildren(description).map((child) => child.operation_id)),
    )
    const operation_id = `skill-apply-${childrenHash}.${yield* sha256(canonicalSharedJson(description))}`
    return yield* validateSharedSkillApplyPlan({ ...description, operation_id })
  })
}
