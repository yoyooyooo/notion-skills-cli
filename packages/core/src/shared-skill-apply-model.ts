import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  SharedBodyWritePlanSchema,
  validateSharedBodyWritePlan,
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
}): readonly SharedSkillApplyChild[] {
  if (plan.version !== 2 || plan.layout === undefined || plan.stages === undefined)
    return [...plan.bodies, ...(plan.metadata === undefined ? [] : [plan.metadata])]
  const byId = new Map<string, SharedSkillApplyChild>()
  for (const child of plan.layout) byId.set(child.operation_id, child)
  for (const child of plan.bodies) byId.set(child.operation_id, child)
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
        (stage.name === "author" && child.kind === "body_write") ||
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
      Schema.decodeUnknownSync(SharedSkillApplyPlanSchema)(input, { onExcessProperty: "error" }),
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
      if (plan.version === 2) assertLayoutStages(plan)
    })
    for (const child of plan.bodies) yield* validateSharedBodyWritePlan(child)
    if (plan.version === 2)
      for (const child of plan.layout) yield* validateSharedFileManagementPlan(child)
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
    yield* applyChecked(() => validateSharedRecordEnvelope(plan.operation_id, plan))
    return plan
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
