import { Clock, Effect, Schema } from "effect"
import { fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { validateFixedFileManifest } from "./shared-fixed-resources.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { discoverSourceDefinition } from "./shared-source-adapters.ts"
import {
  guardedSourceMutation,
  listSourceMembers,
  readSourceDefinition,
  sourceChecked,
  sourceField,
  sourceRich,
  sourceTable,
} from "./shared-source-definitions.ts"
import {
  MemberReviewSchema,
  retainSourceFact,
  reviewSourceMembers,
} from "./shared-source-refresh.ts"
import { sha256 } from "./store.ts"

const BindingSchema = Schema.Struct({
  page_id: Schema.String,
  skill_id: Schema.String,
  origin: Schema.String,
  member: Schema.String,
  selected_version: Schema.String,
})
export const SourceMemberDecisionSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_member_decision"),
  plan_id: Schema.String,
  library_id: Schema.String,
  sources_data_source_id: Schema.String,
  source_id: Schema.String,
  source_page_id: Schema.String,
  source_fingerprint: Schema.String,
  provider_revision: Schema.String,
  created_at: Schema.Number,
  before: BindingSchema,
  action: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("rebind"),
      member: Schema.String,
      files: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          sha256: Schema.String,
          bytes: Schema.Number,
          mode: Schema.optional(Schema.Literals(["100644", "100755"])),
        }),
      ),
    }),
    Schema.Struct({
      kind: Schema.Literal("retain_removed"),
      detach_discovery: Schema.Literal(true),
    }),
  ]),
  member_review: MemberReviewSchema,
})
export type SourceMemberDecision = typeof SourceMemberDecisionSchema.Type

function readBinding(library: SharedLibrary, target: string) {
  return Effect.gen(function* () {
    if (pageId(target) !== target)
      return yield* Effect.fail(fail("SOURCE_TARGET_INVALID", "Use an exact Skill page UUID."))
    const row = property(yield* (yield* Notion).request(`v1/pages/${target}`))
    return yield* sourceChecked(() => {
      const ids = library.skills.property_ids
      if (
        row.object !== "page" ||
        row.id !== target ||
        row.archived ||
        row.in_trash ||
        property(row.parent).data_source_id !== library.skills.data_source_id ||
        property(sourceField(row, ids.Kind!).select).name !== "skill"
      )
        throw fail(
          "SOURCE_BINDING_SCOPE",
          "The selected enabled or disabled Skill is not in this library.",
        )
      const origin = sourceField(row, ids.Origin!)
      if (origin.has_more || !Array.isArray(origin.relation) || origin.relation.length > 1)
        throw fail("SOURCE_BINDING_CONFLICT", "Origin membership is incomplete or ambiguous.")
      const rich = (name: string) => {
        const value = sourceField(row, ids[name]!)
        if (value.has_more || !Array.isArray(value.rich_text) || value.rich_text.length >= 25)
          throw fail("SOURCE_BINDING_CONFLICT", "A required binding property is incomplete.")
        return text(value.rich_text)
      }
      const skillId = rich("Skill ID")
      if (!skillId)
        throw fail("SOURCE_BINDING_CONFLICT", "The Skill has no stable business identity.")
      return {
        page_id: target,
        skill_id: skillId,
        origin: origin.relation.length === 0 ? "none" : String(property(origin.relation[0]).id),
        member: rich("Source Member"),
        selected_version: rich("Source"),
      }
    })
  })
}

/** Rebinding changes discovery ownership only; retaining a removed member explicitly detaches discovery. */
export function prepareSourceMemberDecision(
  library: SharedLibrary,
  input: {
    readonly source: string
    readonly target: string
    readonly action:
      | { readonly kind: "rebind"; readonly member: string }
      | { readonly kind: "retain_removed" }
  },
  acquire: typeof discoverSourceDefinition = discoverSourceDefinition,
) {
  return Effect.gen(function* () {
    const source = yield* readSourceDefinition(library, input.source)
    const before = yield* readBinding(library, input.target)
    if (!source.enabled || before.origin !== source.page_id || !before.member)
      return yield* Effect.fail(
        fail("SOURCE_BINDING_SCOPE", "Review one exact existing member of an enabled Source."),
      )
    const membership = yield* listSourceMembers(library, source.page_id)
    if (
      !membership.items.some(
        (item) =>
          item.page_id === before.page_id &&
          item.skill_id === before.skill_id &&
          item.member === before.member,
      )
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBERS_CONFLICT",
          "The complete membership does not confirm this exact target.",
        ),
      )
    const acquired = yield* acquire(source, { metrics: (yield* Notion).metrics })
    if (!acquired.revision || (acquired.unavailable?.length ?? 0) !== 0)
      return yield* Effect.fail(
        fail(
          "SOURCE_BATCH_INCOMPLETE",
          "Member decisions require a complete provider observation.",
        ),
      )
    let action: SourceMemberDecision["action"]
    if (input.action.kind === "retain_removed") {
      if (acquired.members.some((member) => member.member_key === before.member))
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_PRESENT",
            "This exact member still exists; it is not a removed-member decision.",
          ),
        )
      action = { kind: "retain_removed", detach_discovery: true }
    } else {
      const key = input.action.member
      const matches = acquired.members.filter((member) => member.member_key === key)
      if (matches.length !== 1 || key === before.member)
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_UNAVAILABLE",
            "Select one exact different provider member; no rename is inferred.",
          ),
        )
      const member = matches[0]!
      action = {
        kind: "rebind",
        member: key,
        files: yield* Effect.forEach(member.portable.files, (file) =>
          Effect.gen(function* () {
            const mode =
              member.git_manifest?.files.find((entry) => entry.path === file.path)?.mode ??
              file.mode
            return {
              path: file.path,
              sha256: yield* sha256(file.bytes),
              bytes: file.bytes.length,
              ...(mode === undefined ? {} : { mode }),
            }
          }),
        ),
      }
    }
    const memberReview = yield* reviewSourceMembers(library, source.page_id, acquired, membership)
    if (
      (yield* readSourceDefinition(library, source.page_id)).fingerprint !== source.fingerprint ||
      canonicalSharedJson(yield* readBinding(library, input.target)) !== canonicalSharedJson(before)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_BINDING_CHANGED",
          "Source configuration or member identity changed during preparation.",
        ),
      )
    const contents = {
      version: 1 as const,
      kind: "source_member_decision" as const,
      library_id: library.library_id,
      sources_data_source_id: sourceTable(library).data_source_id,
      source_id: source.source_id,
      source_page_id: source.page_id,
      source_fingerprint: source.fingerprint,
      provider_revision: acquired.revision,
      created_at: yield* Clock.currentTimeMillis,
      before,
      action,
      member_review: memberReview,
    }
    return {
      ...contents,
      plan_id: `source-member-${yield* sha256(canonicalSharedJson(contents))}`,
    } satisfies SourceMemberDecision
  }).pipe(withReadOnlyNotion)
}

function validateDecision(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* sourceChecked(() =>
      Schema.decodeUnknownSync(SourceMemberDecisionSchema)(input, { onExcessProperty: "error" }),
    )
    const { plan_id, ...contents } = plan
    if (
      plan.library_id !== library.library_id ||
      plan.sources_data_source_id !== sourceTable(library).data_source_id ||
      pageId(plan.before.page_id) !== plan.before.page_id ||
      pageId(plan.source_page_id) !== plan.source_page_id ||
      plan.before.origin !== plan.source_page_id ||
      !plan.source_id ||
      !/^[a-f0-9]{64}$/u.test(plan.source_fingerprint) ||
      !plan.before.skill_id ||
      !plan.before.member ||
      !plan.provider_revision ||
      !Number.isSafeInteger(plan.created_at) ||
      plan.created_at < 0 ||
      plan_id !== `source-member-${yield* sha256(canonicalSharedJson(contents))}`
    )
      return yield* Effect.fail(
        fail("SOURCE_MEMBER_PLAN_INVALID", "The frozen member decision identity differs."),
      )
    if (plan.action.kind === "rebind") {
      const action = plan.action
      if (!action.member || action.member === plan.before.member || action.files.length === 0)
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_PLAN_INVALID",
            "Rebinding requires a different exact member and its complete nonempty manifest.",
          ),
        )
      yield* sourceChecked(() => validateFixedFileManifest({ version: 1, files: action.files }))
    }
    return plan
  })
}

/** The original Sources mutation owns retry semantics, including an acknowledged but unseen PATCH. */
export function executeSourceMemberDecision(
  library: SharedLibrary,
  input: unknown,
  options: { readonly dryRun?: boolean; readonly reconcile?: boolean } = {},
) {
  const run = Effect.gen(function* () {
    const plan = yield* validateDecision(library, input)
    const source = yield* readSourceDefinition(library, plan.source_page_id)
    if (source.source_id !== plan.source_id || source.fingerprint !== plan.source_fingerprint)
      return yield* Effect.fail(
        fail("SOURCE_DEFINITION_CHANGED", "The reviewed Source definition changed."),
      )
    const after = {
      ...plan.before,
      origin: plan.action.kind === "rebind" ? plan.source_page_id : "none",
      member: plan.action.kind === "rebind" ? plan.action.member : "",
    }
    const ids = library.skills.property_ids
    const body = {
      properties: {
        [ids.Origin!]: { relation: after.origin === "none" ? [] : [{ id: after.origin }] },
        [ids["Source Member"]!]: { rich_text: sourceRich(after.member) },
      },
    }
    const assertBefore = Effect.gen(function* () {
      if (
        (yield* readSourceDefinition(library, plan.source_page_id)).fingerprint !==
          plan.source_fingerprint ||
        canonicalSharedJson(yield* readBinding(library, plan.before.page_id)) !==
          canonicalSharedJson(plan.before)
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_BINDING_CHANGED",
            "The original binding or selected version changed before dispatch.",
          ),
        )
    })
    const recordId = `decision-${plan.plan_id}`
    const result = yield* guardedSourceMutation(
      library,
      {
        identity: `source-member:${plan.before.page_id}`,
        path: `v1/pages/${plan.before.page_id}`,
        method: "PATCH",
        body,
        dryRun: options.dryRun || options.reconcile,
        repeat: "never",
        beforeDispatch: Effect.gen(function* () {
          yield* assertBefore
          yield* retainSourceFact(library, {
            recordId,
            operationId: plan.plan_id,
            skillPageId: plan.before.page_id,
            entityId: recordId,
            kind: "source",
            payload: plan,
          })
          yield* assertBefore
        }),
      },
      Effect.gen(function* () {
        const current = yield* readBinding(library, plan.before.page_id)
        return canonicalSharedJson(current) === canonicalSharedJson(after) ? current : undefined
      }),
    )
    if (options.dryRun && result.status === "planned") yield* assertBefore
    const facts = options.reconcile
      ? yield* querySharedRecords(library, {
          skillPageId: plan.before.page_id,
          kind: "source",
          entityId: recordId,
        })
      : undefined
    return {
      plan_id: plan.plan_id,
      action: plan.action.kind,
      original: result,
      ...(facts === undefined ? {} : { retained_decisions: facts.length }),
      verified:
        ("verified" in result && result.verified === true) ||
        ("original_outcome" in result && result.original_outcome === "applied"),
      selected_version_changed: false,
      body_writes: 0,
      user_relations_changed: false,
      ...(options.dryRun || options.reconcile ? { remote_writes: 0 } : {}),
      retained_removed:
        plan.action.kind === "retain_removed"
          ? {
              requested_discovery: "detached",
              current_binding_observed: result.status !== "planned",
              selected_version: plan.before.selected_version,
              native_files_and_pins_preserved: true,
            }
          : null,
    }
  })
  return options.dryRun || options.reconcile ? run.pipe(withReadOnlyNotion) : run
}
