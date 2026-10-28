import { Effect } from "effect"
import { portableIdentity } from "./export.ts"

import { fail, SkillsError } from "./model.ts"

import { Store } from "./store.ts"

import { ProjectionOperationSchema, strictDecode, UpstreamPublisher } from "./upstream-model.ts"
import type {
  ProjectionOperation,
  UpstreamCommandOperation,
  UpstreamOperation,
  UpstreamPublicOperation,
} from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import {
  getSubscription,
  reconcileSubscriptionCommand,
  resumeSubscriptionCommand,
} from "./upstream-subscription.ts"

import { authScope } from "./catalog.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"

import { publicationIdentityForUpstream, publicationMemberKey } from "./upstream-content.ts"
import { applyUpstream } from "./upstream-apply.ts"
import { observeModeChild, resumeModeCommand } from "./upstream-mode-recovery.ts"
import { reconcilePublication } from "./publication-reconcile.ts"
const operationNext = (id: string, reason: string, action = "reconcile") => ({
  argv: ["ntn-skills", "operation", action, id],
  reason,
})
function publicRun(operation: UpstreamOperation): UpstreamPublicOperation {
  const verified =
    operation.state === "verified" &&
    operation.items.every((item) => ["verified", "retained", "fork"].includes(item.status)) &&
    (operation.projections?.entries.every((entry) => entry.status === "verified") ?? true)
  const blocked =
    operation.items.some((item) => item.status === "conflict") ||
    operation.projections?.entries.some((entry) => entry.status === "conflict") === true
  return {
    domain: "sync_upstream",
    operation_id: operation.operation_id,
    state: operation.state === "verified" && !verified ? "unknown" : operation.state,
    verified,
    result: {
      plan_id: operation.plan_id,
      subscription_id: operation.subscription_id,
      ...(operation.database_id ? { database_id: operation.database_id } : {}),
      ...(operation.target_database_id ? { target_database_id: operation.target_database_id } : {}),
      items: operation.items.map((item) => ({
        member_key: item.member_key,
        status: item.status,
        ...(item.page_id ? { page_id: item.page_id } : {}),
        ...(item.publication_operation_id
          ? { publication_operation_id: item.publication_operation_id }
          : {}),
        ...(item.error_code ? { error_code: item.error_code } : {}),
      })),
      projections: (operation.projections?.entries ?? []).map((entry) => ({
        subscription_id: entry.subscription_id,
        status: entry.status,
      })),
    },
    next: verified
      ? operationNext(operation.operation_id, "The saved upstream run is verified.", "show")
      : blocked
        ? {
            argv: ["ntn-skills", "sync", "upstream", "plan", operation.subscription_id],
            reason: "Resolve conflicts and review a new upstream plan.",
          }
        : operationNext(
            operation.operation_id,
            "Resume the exact frozen plan through its existing publication and baseline guards.",
            "resume",
          ),
    resume_supported: !verified && !blocked,
  }
}
function publicCommand(command: UpstreamCommandOperation): UpstreamPublicOperation {
  const evidence = {
    scope: command.scope,
    database_id: command.database_id,
    ...(command.domain === "subscription_add"
      ? {
          source_config_hash: command.input_hash,
          target_database_id: command.input.target_database_id,
        }
      : {}),
    ...(command.phase ? { phase: command.phase } : {}),
    ...(command.intent
      ? {
          intent: command.intent,
          source_config_hash: command.intent.source_config_hash,
          target_database_id: command.intent.target_database_id,
        }
      : {}),
    ...(command.observation ? { observation: command.observation } : {}),
    ...(command.adoption ? { adoption: command.adoption } : {}),
    ...(command.preparation_recovery ? { preparation_recovery: command.preparation_recovery } : {}),
  }
  const common = {
    operation_id: command.operation_id,
    state: command.state,
    verified: command.state === "verified",
    resume_supported:
      command.domain.startsWith("subscription_") &&
      command.state !== "verified" &&
      (command.phase === "preparing" ||
        (command.domain !== "subscription_add" && !!command.intent)),
    next: operationNext(
      command.operation_id,
      command.state === "verified"
        ? "The command is verified; inspect its recorded identity."
        : command.phase === "preparing" || (command.domain !== "subscription_add" && command.intent)
          ? "Resume original preparation or the retained exact known-target intent under its original version guard."
          : "Reconcile exact remote evidence or plan explicit adoption; an uncertain create is never replayed.",
      command.state === "verified"
        ? "show"
        : command.phase === "preparing" || (command.domain !== "subscription_add" && command.intent)
          ? "resume"
          : "reconcile",
    ),
  }
  if (command.domain === "upstream_fork" || command.domain === "upstream_track")
    return {
      ...common,
      resume_supported: true,
      outcome: command.state === "verified" ? "verified" : "not_observed",
      next: operationNext(
        command.operation_id,
        command.state === "verified"
          ? "Recheck the original completed mode operation without replaying writes."
          : "Resume the original frozen mode child after read-only reconciliation.",
        command.state === "verified" ? "show" : "resume",
      ),
      domain: command.domain,
      result: {
        database_id: command.database_id,
        subscription_id: command.subscription_id,
        page_id: command.page_id,
        member_key: command.member_key,
        children: [],
        mode: command.domain === "upstream_fork" ? "fork" : "tracked",
        expected_version: command.expected_version,
        ...(command.domain === "upstream_track"
          ? { content_hash: command.content_hash, revision: command.revision }
          : {}),
        ...(command.error_code ? { error_code: command.error_code } : {}),
      },
    }
  if (command.domain === "subscription_add")
    return {
      ...common,
      domain: command.domain,
      result: {
        database_id: command.database_id,
        ...(command.page_id ? { subscription_id: command.page_id, page_id: command.page_id } : {}),
        input_hash: command.input_hash,
        target_database_id: command.input.target_database_id,
        name: command.input.name,
        ...(command.version ? { version: command.version } : {}),
        evidence,
      },
    }
  return {
    ...common,
    domain: command.domain,
    result: {
      database_id: command.database_id,
      subscription_id: command.page_id,
      page_id: command.page_id,
      evidence,
    },
  }
}
function commandWithChildren(command: UpstreamCommandOperation) {
  return Effect.gen(function* () {
    const result = publicCommand(command)
    if (
      (command.domain !== "upstream_fork" && command.domain !== "upstream_track") ||
      (result.domain !== "upstream_fork" && result.domain !== "upstream_track") ||
      !result.result
    )
      return result
    const store = yield* Store
    const children: NonNullable<
      Extract<UpstreamPublicOperation, { domain: "upstream_fork" | "upstream_track" }>["result"]
    >["children"][number][] = []
    const publicationId = (yield* publicationIdentityForUpstream(command.operation_id)).id
    const receipt = yield* store.readJson(
      `publications/${publicationId}.json`,
      PublicationReceiptSchema,
    )
    const integrity = yield* store.integrity.inspect(publicationId)
    if (receipt && receipt.scope !== command.scope)
      return {
        ...result,
        state: "unknown",
        verified: false,
        next: operationNext(
          command.operation_id,
          "The publication child is outside the recorded authentication scope.",
        ),
      }
    if (command.publication_required || receipt)
      children.push({
        domain: "publication",
        operation_id: publicationId,
        state: receipt?.state ?? "not_recorded",
        ...(integrity ? { intended_hash: integrity.intended_hash } : {}),
        refs: { page_id: receipt?.page_id ?? command.page_id },
        next: operationNext(
          publicationId,
          receipt?.state === "completed"
            ? "Inspect the completed publication child."
            : "Reconcile the publication child without replaying its writes.",
          receipt?.state === "completed" ? "show" : "reconcile",
        ),
      })
    {
      const linked =
        command.domain === "upstream_fork" && !command.baseline
          ? [
              ...new Set([
                ...command.baseline_operation_ids,
                ...(yield* store.integrity.baselines(command.publisher_subscription_id))
                  .filter((entry) => !command.baseline_before_ids.includes(entry.operation_id))
                  .map((entry) => entry.operation_id),
              ]),
            ]
          : command.baseline_operation_ids
      for (const id of linked) {
        const baseline = yield* store.integrity.baseline(id)
        children.push({
          domain: "baseline",
          operation_id: id,
          state: baseline?.state ?? "not_recorded",
          refs: {
            ...(baseline?.page_id ? { page_id: baseline.page_id } : {}),
            ...(baseline ? { parent_page_id: baseline.parent_page_id } : {}),
          },
          next: operationNext(
            command.operation_id,
            "Inspect or reconcile the fork root to verify its immutable baseline child.",
          ),
        })
      }
    }
    const unresolved = children.some((child) =>
      child.domain === "publication" ? child.state !== "completed" : child.state !== "complete",
    )
    const projected: UpstreamPublicOperation = {
      ...result,
      state: unresolved && result.verified ? "unknown" : result.state,
      verified: result.verified && !unresolved,
      result: { ...result.result, children },
      ...(unresolved
        ? {
            next: operationNext(
              command.operation_id,
              "The original publication or baseline child is unresolved; reconcile the frozen parent evidence.",
            ),
          }
        : {}),
    }
    return projected
  })
}
const scopedUpstreamHistory = Effect.gen(function* () {
  const state = yield* UpstreamState
  if (!(yield* state.hasScopedHistory()))
    return {
      runs: [] as readonly UpstreamOperation[],
      commands: [] as readonly UpstreamCommandOperation[],
    }
  const scope = yield* authScope
  return {
    runs: yield* state.scopedOperations(scope),
    commands: yield* state.scopedCommands(scope),
  }
})
export function listUpstreamOperations(
  selection: { readonly domain?: UpstreamPublicOperation["domain"] } = {},
) {
  return Effect.gen(function* () {
    const history = yield* scopedUpstreamHistory
    const commands = yield* Effect.forEach(history.commands, commandWithChildren)
    return [...history.runs.map(publicRun), ...commands]
      .filter((operation) => !selection.domain || operation.domain === selection.domain)
      .sort((a, b) => a.operation_id.localeCompare(b.operation_id))
  })
}
export function showUpstreamOperation(operationId: string) {
  return Effect.map(listUpstreamOperations(), (operations) =>
    operations.find((operation) => operation.operation_id === operationId),
  )
}
/** Observe published content and native subscription maps without issuing remote writes. */
export function reconcileUpstreamOperation(operationId: string) {
  return Effect.gen(function* () {
    const history = yield* scopedUpstreamHistory
    const command = history.commands.find((entry) => entry.operation_id === operationId)
    const state = yield* UpstreamState
    if (command) {
      let verified: boolean
      let childOutcome: "unknown" | "needs_safe_resume" | "conflict" | undefined
      if (command.domain === "upstream_fork" || command.domain === "upstream_track") {
        const child = yield* observeModeChild(command)
        if (child && !child.proof.verified) {
          childOutcome =
            child.proof.outcome === "conflict"
              ? "conflict"
              : child.proof.outcome === "unknown"
                ? "unknown"
                : "needs_safe_resume"
          const result = yield* commandWithChildren(command)
          return {
            ...result,
            state: childOutcome === "conflict" ? "failed" : "unknown",
            verified: false,
            outcome: childOutcome,
            resume_supported: childOutcome !== "conflict",
            next: operationNext(
              operationId,
              childOutcome === "conflict"
                ? "The original publication guards observed an external change; mutation is fenced."
                : "Resume this original parent to recover its frozen mode child without source discovery or content replacement.",
              childOutcome === "conflict" ? "show" : "resume",
            ),
          }
        }
        const subscription = yield* getSubscription(command.subscription_id, command.database_id)
        const publisher = yield* UpstreamPublisher
        const current = yield* publisher.inspect(command.page_id)
        const owner = current.ownership
        const owned =
          owner?.subscription_id ===
            (subscription.source.publisher_subscription_id ?? subscription.subscription_id) &&
          owner.member_key === publicationMemberKey(subscription, command.member_key)
        if (command.domain === "upstream_fork") {
          const baseline = command.baseline
          verified =
            owned &&
            baseline !== undefined &&
            owner?.mode === "fork" &&
            JSON.stringify(owner.fork_baseline) === JSON.stringify(baseline)
          if (verified && baseline)
            verified =
              (yield* portableIdentity(yield* publisher.readBaseline(baseline.portable_ref))) ===
              baseline.content_hash
        } else
          verified =
            owned &&
            owner?.mode === "tracked" &&
            owner.published_hash === command.content_hash &&
            current.content_hash === command.content_hash &&
            owner.revision === command.revision
        const proof = yield* commandWithChildren({ ...command, state: "verified" })
        verified = verified && proof.verified
        const binding = (yield* state.bindings(command.subscription_id)).find(
          (entry) => entry.member_key === command.member_key,
        )
        let localVerified =
          binding?.page_id === command.page_id &&
          binding.mode === (command.domain === "upstream_fork" ? "fork" : "tracked") &&
          (command.domain === "upstream_fork"
            ? JSON.stringify(binding.fork_baseline) === JSON.stringify(command.baseline)
            : binding.published_hash === command.content_hash &&
              binding.revision === command.revision)
        if (localVerified && binding && child && command.domain === "upstream_track") {
          const frozen = {
            ...child.receipt.portable,
            kind: "skill" as const,
            files: child.receipt.portable.files.map((file) => ({
              path: file.path,
              hash: file.sha256,
            })),
          }
          const materialized = yield* state.command(`materialized:${binding.target_key}`)
          localVerified =
            JSON.stringify(binding.accepted) === JSON.stringify(frozen) &&
            JSON.stringify(binding.materialized) === JSON.stringify(frozen) &&
            JSON.stringify(materialized) ===
              JSON.stringify({
                portable: frozen,
                content_hash: command.content_hash,
                revision: command.revision,
              })
        }
        if (verified && !localVerified) {
          const result = yield* commandWithChildren(command)
          return {
            ...result,
            state: "unknown",
            verified: false,
            outcome: "needs_safe_resume" as const,
            resume_supported: true,
            next: operationNext(
              operationId,
              "The remote mode child is complete; resume the original parent to advance its guarded local baseline.",
              "resume",
            ),
          }
        }
        if (!verified && child) {
          const result = yield* commandWithChildren(command)
          return {
            ...result,
            state: "failed",
            verified: false,
            outcome: "conflict" as const,
            resume_supported: false,
            next: operationNext(
              operationId,
              "Remote content or provenance differs from the original frozen mode intent.",
              "show",
            ),
          }
        }
        if (verified) yield* state.saveCommand(operationId, { ...command, state: "verified" })
      } else verified = yield* reconcileSubscriptionCommand(command)
      const latest =
        (yield* state.scopedCommands(command.scope, command.database_id)).find(
          (entry) => entry.operation_id === operationId,
        ) ?? command
      const result = yield* commandWithChildren(verified ? latest : { ...latest, state: "unknown" })
      return verified
        ? result
        : {
            ...result,
            next: operationNext(
              operationId,
              "Remote evidence does not uniquely verify the frozen command. No mutation or create was replayed.",
            ),
          }
    }
    const operation = history.runs.find((entry) => entry.operation_id === operationId)
    if (!operation) return undefined
    const plan = yield* state.plan(operation.plan_id)
    if (!plan || plan.scope !== operation.scope || plan.database_id !== operation.database_id)
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The upstream operation has no matching scoped frozen plan."),
      )
    const subscription = yield* getSubscription(operation.subscription_id, operation.database_id)
    const publisher = yield* UpstreamPublisher
    const items: UpstreamOperation["items"][number][] = []
    for (let index = 0; index < operation.items.length; index++) {
      const item = operation.items[index]!,
        intended = plan.items[index]
      if (!intended || intended.member_key !== item.member_key)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Upstream operation member order differs from its frozen plan."),
        )
      if (intended.action === "conflict") {
        items.push({ ...item, status: "conflict" })
        continue
      }
      if (intended.action === "retain") {
        if (intended.page_id) yield* publisher.inspect(intended.page_id)
        items.push({
          ...item,
          status: subscription.published?.members.some(
            (member) => member.member_key === item.member_key,
          )
            ? "unknown"
            : "retained",
        })
        continue
      }
      if (
        item.publication_operation_id &&
        (item.status === "unknown" || item.status === "running")
      ) {
        const childId = (yield* publicationIdentityForUpstream(item.publication_operation_id)).id
        const receipt = yield* (yield* Store).readJson(
          `publications/${childId}.json`,
          PublicationReceiptSchema,
        )
        if (receipt) {
          if (
            receipt.scope !== operation.scope ||
            receipt.database_id !== plan.target_database_id ||
            (intended.page_id && receipt.page_id !== intended.page_id)
          )
            return yield* Effect.fail(
              fail("WRITE_CONFLICT", "The saved apply child differs from its frozen root target."),
            )
          const proof = yield* reconcilePublication(childId)
          if (!proof.verified) {
            items.push({
              ...item,
              status: proof.outcome === "conflict" ? "conflict" : "unknown",
              ...(proof.outcome === "conflict" ? { error_code: "WRITE_CONFLICT" } : {}),
            })
            continue
          }
        }
      }
      const publication =
        !item.page_id && !intended.page_id
          ? yield* publisher.reconcile(item.publication_operation_id ?? `${operationId}:${index}`)
          : undefined
      const pageId = item.page_id ?? intended.page_id ?? publication?.page_id
      if (!pageId) {
        items.push({ ...item, status: "unknown" })
        continue
      }
      const current = yield* publisher.inspect(pageId)
      const owner = current.ownership
      const owned =
        owner?.subscription_id === plan.publisher_subscription_id &&
        owner.member_key === publicationMemberKey(subscription, item.member_key)
      const matched =
        owned &&
        (intended.action === "fork"
          ? owner?.mode === "fork"
          : current.content_hash === intended.content_hash &&
            owner?.published_hash === intended.content_hash &&
            owner.mode === "tracked")
      items.push({
        ...item,
        page_id: pageId,
        status: matched ? (intended.action === "fork" ? "fork" : "verified") : "unknown",
      })
    }
    const savedProjection = yield* state.command(`${operationId}:projections`)
    let projection = savedProjection
      ? yield* Effect.try({
          try: () => strictDecode(ProjectionOperationSchema, savedProjection),
          catch: (e) => e as SkillsError,
        })
      : operation.projections
    if (projection) {
      const entries: ProjectionOperation["entries"][number][] = []
      for (const entry of projection.entries) {
        const current = yield* getSubscription(entry.subscription_id, operation.database_id)
        entries.push({
          ...entry,
          status:
            JSON.stringify(current.published) === JSON.stringify(entry.after)
              ? "verified"
              : "unknown",
        })
      }
      projection = { ...projection, entries }
    }
    const activeMap = subscription.published
    const mapVerified =
      activeMap?.plan_hash === plan.plan_hash &&
      activeMap.revision === plan.revision &&
      activeMap.publisher_subscription_id === plan.publisher_subscription_id &&
      items.every(
        (item) =>
          item.status !== "verified" ||
          activeMap.members.some(
            (member) =>
              member.member_key === item.member_key &&
              member.page_id === item.page_id &&
              member.content_hash ===
                plan.items.find((entry) => entry.member_key === item.member_key)?.content_hash,
          ),
      )
    const verified =
      mapVerified &&
      items.every((item) => ["verified", "retained", "fork"].includes(item.status)) &&
      (projection?.entries.every((entry) => entry.status === "verified") ?? true)
    const result = publicRun({
      ...operation,
      items,
      ...(projection ? { projections: projection } : {}),
      state: verified
        ? "verified"
        : items.some((item) => item.status === "unknown")
          ? "unknown"
          : "partial",
    })
    return verified
      ? result
      : {
          ...result,
          next: operationNext(
            operationId,
            "Remote evidence is incomplete. Resume uses the saved plan and existing no-replay publication guards.",
            "resume",
          ),
        }
  })
}
export function resumeUpstreamOperation(operationId: string) {
  return Effect.gen(function* () {
    const history = yield* scopedUpstreamHistory
    const command = history.commands.find((entry) => entry.operation_id === operationId)
    if (command?.domain === "upstream_fork" || command?.domain === "upstream_track") {
      if (command.state === "verified") {
        const observed = yield* reconcileUpstreamOperation(operationId)
        if (observed?.verified || observed?.outcome !== "needs_safe_resume") return observed
      }
      yield* resumeModeCommand(command)
      return yield* reconcileUpstreamOperation(operationId)
    }
    if (command) {
      yield* resumeSubscriptionCommand(command)
      return yield* reconcileUpstreamOperation(operationId)
    }
    const operation = yield* showUpstreamOperation(operationId)
    if (!operation) return undefined
    if (operation.domain !== "sync_upstream")
      return {
        ...operation,
        resume_supported: false,
        next: operationNext(
          operationId,
          "Resume is unsupported for this command. Reconcile its exact retained remote evidence.",
        ),
      }
    if (!operation.resume_supported || !operation.result) return operation
    return publicRun(yield* applyUpstream(operation.result.plan_id))
  })
}
