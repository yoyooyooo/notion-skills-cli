import { property } from "../src/model.ts"
import { gzipSync } from "fflate"
import { Effect, Schema } from "effect"
import { fail, SkillsError } from "../src/model.ts"
import type { UpstreamRepository } from "../src/upstream-state.ts"
import type { UpstreamBinding, UpstreamOperation, UpstreamPlan } from "../src/upstream-model.ts"
import { strictDecode, UpstreamCommandOperationSchema } from "../src/upstream-model.ts"
import { BaselineIntentSchema, IntegrityIntentSchema } from "../src/publication-integrity-state.ts"
import type { PublicationIntegrityRepository } from "../src/publication-integrity-state.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"

export const publicationSourceRows = {
  "Source Type": { id: "Source Type", type: "select", select: null },
  "Builtin ID": { id: "Builtin ID", type: "rich_text", rich_text: [] },
}
export const publicationSourceSchema = {
  "Source Type": {
    id: "Source Type",
    type: "select",
    select: { options: [{ name: "builtin" }, { name: "upstream" }, { name: "manual" }] },
  },
  "Builtin ID": { id: "Builtin ID", type: "rich_text", rich_text: {} },
}

export function integrityRepositoryFixture(
  persisted = new Map<string, unknown>(),
): PublicationIntegrityRepository {
  return {
    inspect: (id) =>
      Effect.try({
        try: () => {
          const value = persisted.get(`integrity/operations/${id}`)
          return value === undefined
            ? undefined
            : Schema.decodeUnknownSync(IntegrityIntentSchema)(structuredClone(value), {
                onExcessProperty: "error",
              })
        },
        catch: () => fail("STATE_CORRUPT", "Invalid integrity intent."),
      }),
    baseline: (id) =>
      Effect.try({
        try: () => {
          const value = persisted.get(`integrity/baselines/${id}`)
          return value === undefined
            ? undefined
            : Schema.decodeUnknownSync(BaselineIntentSchema)(structuredClone(value), {
                onExcessProperty: "error",
              })
        },
        catch: () => fail("STATE_CORRUPT", "Invalid baseline intent."),
      }),
    baselines: (parentPageId) =>
      Effect.try({
        try: () =>
          [...persisted.entries()]
            .filter(([key]) => key.startsWith("integrity/baselines/"))
            .map(([, value]) =>
              Schema.decodeUnknownSync(BaselineIntentSchema)(structuredClone(value), {
                onExcessProperty: "error",
              }),
            )
            .filter((intent) => intent.parent_page_id === parentPageId)
            .sort((a, b) => a.operation_id.localeCompare(b.operation_id)),
        catch: () => fail("STATE_CORRUPT", "Invalid baseline intent."),
      }),
    prepare: (value) =>
      Effect.try({
        try: () => {
          const intent = Schema.decodeUnknownSync(IntegrityIntentSchema)(value, {
            onExcessProperty: "error",
          })
          if (
            intent.marker.operation_id !== intent.operation_id ||
            intent.marker.intended_hash !== intent.intended_hash ||
            intent.marker.state !== "writing"
          )
            throw fail("PUBLICATION_INTENT_CONFLICT", "Prepared intent and remote marker disagree.")
          const saved = persisted.get(`integrity/operations/${intent.operation_id}`)
          const previous =
            saved === undefined
              ? undefined
              : Schema.decodeUnknownSync(IntegrityIntentSchema)(saved, {
                  onExcessProperty: "error",
                })
          if (previous && previous.intended_hash !== intent.intended_hash)
            throw fail(
              "PUBLICATION_INTENT_CONFLICT",
              "Publication identity already has another intended revision.",
            )
          if (!previous)
            persisted.set(`integrity/operations/${intent.operation_id}`, structuredClone(intent))
        },
        catch: (error) =>
          error instanceof SkillsError ? error : fail("STATE_CORRUPT", "Invalid integrity intent."),
      }),
    update: (value) =>
      Effect.try({
        try: () => {
          const intent = Schema.decodeUnknownSync(IntegrityIntentSchema)(value, {
            onExcessProperty: "error",
          })
          const saved = persisted.get(`integrity/operations/${intent.operation_id}`)
          const previous =
            saved === undefined
              ? undefined
              : Schema.decodeUnknownSync(IntegrityIntentSchema)(saved, {
                  onExcessProperty: "error",
                })
          if (
            !previous ||
            previous.intended_hash !== intent.intended_hash ||
            intent.marker.operation_id !== intent.operation_id ||
            intent.marker.intended_hash !== intent.intended_hash ||
            (previous.page_id && previous.page_id !== intent.page_id)
          )
            throw fail(
              "PUBLICATION_INTENT_CONFLICT",
              "Publication identity or exact target changed.",
            )
          if (
            previous.marker.state === "committed" &&
            JSON.stringify(previous.marker) !== JSON.stringify(intent.marker)
          )
            throw fail(
              "PUBLICATION_INTENT_CONFLICT",
              "An intended commit cannot be replaced or downgraded.",
            )
          persisted.set(`integrity/operations/${intent.operation_id}`, structuredClone(intent))
        },
        catch: (error) =>
          error instanceof SkillsError ? error : fail("STATE_CORRUPT", "Invalid integrity intent."),
      }),
    saveBaseline: (value) =>
      Effect.try({
        try: () => {
          const intent = Schema.decodeUnknownSync(BaselineIntentSchema)(value, {
            onExcessProperty: "error",
          })
          const saved = persisted.get(`integrity/baselines/${intent.operation_id}`)
          const previous =
            saved === undefined
              ? undefined
              : Schema.decodeUnknownSync(BaselineIntentSchema)(saved, { onExcessProperty: "error" })
          const ranks = { prepared: 0, unknown: 1, created: 2, complete: 3 }
          if (
            previous &&
            (previous.parent_page_id !== intent.parent_page_id ||
              previous.hash !== intent.hash ||
              previous.payload !== intent.payload ||
              (previous.page_id && previous.page_id !== intent.page_id) ||
              ranks[intent.state] < ranks[previous.state])
          )
            throw fail("BASELINE_INTENT_CONFLICT", "Baseline identity, target or payload changed.")
          persisted.set(`integrity/baselines/${intent.operation_id}`, structuredClone(intent))
        },
        catch: (error) =>
          error instanceof SkillsError ? error : fail("STATE_CORRUPT", "Invalid baseline intent."),
      }),
  }
}

export function upstreamRepositoryFixture(
  persisted = new Map<string, unknown>(),
): UpstreamRepository {
  const plans = new Map<string, UpstreamPlan>()
  const operations = new Map<string, UpstreamOperation>()
  const bindings = new Map<string, UpstreamBinding>()
  const targets = new Map<string, { page_id: string; publisher_subscription_id: string }>()
  const commands = new Map<string, unknown>()
  const key = (binding: UpstreamBinding) =>
    JSON.stringify([binding.subscription_id, binding.member_key])
  const saveOperation: UpstreamRepository["saveOperation"] = (operation) =>
    Effect.gen(function* () {
      const previous = operations.get(operation.plan_id)
      if (previous && previous.operation_id !== operation.operation_id)
        return yield* Effect.fail(
          fail("UPSTREAM_OPERATION_EXISTS", "A plan has one durable operation identity."),
        )
      operations.set(operation.plan_id, structuredClone(operation))
    })
  return {
    commitMapCheckpointAdoption: () =>
      Effect.fail(
        fail("UNSUPPORTED_OPERATION", "Map checkpoint adoption requires the real SQLite fixture."),
      ),
    contentAdoptionClaims: (pageId, targetKey, originalId, oldId) =>
      Effect.sync(() => {
        const publications = [...persisted.entries()]
          .filter(([key]) => key.startsWith("publications/"))
          .map(([, value]) => property(value))
        const integrity = [...persisted.entries()]
          .filter(([key]) => key.startsWith("integrity/operations/"))
          .map(([, value]) => property(value))
        return {
          original_intent_count: publications
            .filter((value) => value.operation_id === originalId || value.operation_id === oldId)
            .reduce(
              (count, value) => count + (Array.isArray(value.intents) ? value.intents.length : 0),
              0,
            ),
          publication_ids: publications
            .filter(
              (value) =>
                value.page_id === pageId ||
                value.operation_id === originalId ||
                value.operation_id === oldId,
            )
            .map((value) => String(value.operation_id))
            .sort(),
          integrity_ids: integrity
            .filter(
              (value) =>
                value.page_id === pageId ||
                value.operation_id === originalId ||
                value.operation_id === oldId,
            )
            .map((value) => String(value.operation_id))
            .sort(),
          upstream_operation_ids: [...operations.values()]
            .filter((value) => value.items.some((item) => item.page_id === pageId))
            .map((value) => value.operation_id)
            .sort(),
          bindings: [...bindings.values()]
            .filter((value) => value.page_id === pageId || value.target_key === targetKey)
            .sort(
              (a, b) =>
                a.subscription_id.localeCompare(b.subscription_id) ||
                a.member_key.localeCompare(b.member_key),
            ),
          targets: [...targets]
            .filter(([key, value]) => key === targetKey || value.page_id === pageId)
            .map(([target_key, value]) => ({ target_key, ...value }))
            .sort((a, b) => a.target_key.localeCompare(b.target_key)),
        }
      }),
    savePlan: (plan) =>
      Effect.sync(() => {
        plans.set(plan.plan_id, structuredClone(plan))
      }),
    plan: (id) => Effect.sync(() => plans.get(id)),
    bindings: (id) =>
      Effect.sync(() =>
        [...bindings.values()]
          .filter((binding) => binding.subscription_id === id)
          .sort((a, b) => a.member_key.localeCompare(b.member_key)),
      ),
    target: (id) => Effect.sync(() => targets.get(id)),
    operation: (id) => Effect.sync(() => operations.get(id)),
    operations: (id) =>
      Effect.sync(() =>
        [...operations.values()]
          .filter((operation) => operation.subscription_id === id)
          .sort((a, b) => a.operation_id.localeCompare(b.operation_id))
          .map((operation) => structuredClone(operation)),
      ),
    hasScopedHistory: () =>
      Effect.sync(() =>
        [...operations.values(), ...commands.values()].some(
          (value) => typeof (value as Record<string, unknown>).scope === "string",
        ),
      ),
    scopedOperations: (scope, databaseId) =>
      Effect.sync(() =>
        [...operations.values()]
          .filter(
            (operation) =>
              operation.scope === scope && (!databaseId || operation.database_id === databaseId),
          )
          .map((operation) => structuredClone(operation)),
      ),
    scopedCommands: (scope, databaseId) =>
      Effect.try({
        try: () =>
          [...commands.values()]
            .filter((value) => {
              const candidate = value as Record<string, unknown>
              return (
                candidate.scope === scope &&
                (!databaseId || candidate.database_id === databaseId) &&
                [
                  "subscription_add",
                  "subscription_update",
                  "subscription_remove",
                  "upstream_fork",
                  "upstream_track",
                ].includes(String(candidate.domain))
              )
            })
            .map((value) => strictDecode(UpstreamCommandOperationSchema, structuredClone(value))),
        catch: () => fail("STATE_CORRUPT", "Invalid scoped upstream command history."),
      }),
    saveOperation,
    replacePublicationPointer: (expected, itemIndex, expectedBinding, publicationId, pageId) =>
      Effect.gen(function* () {
        const canonical = (value: unknown): string =>
          JSON.stringify(value, (_key, item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
              : item,
          )
        const current = operations.get(expected.plan_id)
        const item = expected.items[itemIndex]
        if (
          !current ||
          canonical(current) !== canonical(expected) ||
          !item ||
          !["unknown", "running", "failed"].includes(item.status)
        )
          return yield* Effect.fail(
            fail("UPSTREAM_PLAN_STALE", "The exact original publication pointer changed."),
          )
        const binding = bindings.get(JSON.stringify([expected.subscription_id, item.member_key]))
        if (
          canonical(binding) !== canonical(expectedBinding) ||
          (item.page_id && item.page_id !== pageId) ||
          (expectedBinding && expectedBinding.page_id !== pageId)
        )
          return yield* Effect.fail(
            fail("UPSTREAM_PLAN_STALE", "The original member mapping generation or page changed."),
          )
        const proof = yield* Effect.try({
          try: () => {
            const rawReceipt = persisted.get(`publications/${publicationId}.json`)
            const rawIntegrity = persisted.get(`integrity/operations/${publicationId}`)
            return {
              receipt:
                rawReceipt === undefined
                  ? undefined
                  : Schema.decodeUnknownSync(PublicationReceiptSchema)(rawReceipt),
              integrity:
                rawIntegrity === undefined
                  ? undefined
                  : Schema.decodeUnknownSync(IntegrityIntentSchema)(rawIntegrity),
            }
          },
          catch: () => fail("STATE_CORRUPT", "Invalid replacement publication proof."),
        })
        if (
          proof.receipt?.state !== "completed" ||
          proof.receipt.page_id !== pageId ||
          proof.integrity?.marker.state !== "committed" ||
          proof.integrity.page_id !== pageId
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_UNVERIFIED",
              "Only a fully committed replacement publication can replace an unresolved pointer.",
            ),
          )
        operations.set(
          expected.plan_id,
          structuredClone({
            ...expected,
            items: expected.items.map((entry, index) =>
              index === itemIndex
                ? { ...entry, publication_operation_id: publicationId, page_id: pageId }
                : entry,
            ),
          }),
        )
      }),
    commitRebuild: (
      binding,
      expectedBinding,
      expectedTarget,
      publisher,
      publicationId,
      ownerMemberKey,
    ) =>
      Effect.gen(function* () {
        const canonical = (value: unknown): string =>
          JSON.stringify(value, (_key, item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
              : item,
          )
        const observedBinding = bindings.get(key(binding))
        const observedTarget = targets.get(binding.target_key)
        const nextTarget = { page_id: binding.page_id, publisher_subscription_id: publisher }
        const already =
          canonical(observedBinding) === canonical(binding) &&
          canonical(observedTarget) === canonical(nextTarget)
        if (
          !already &&
          (canonical(observedBinding) !== canonical(expectedBinding) ||
            canonical(observedTarget) !== canonical(expectedTarget))
        )
          return yield* Effect.fail(
            fail("UPSTREAM_PLAN_STALE", "The accepted member baseline changed."),
          )
        const proof = yield* Effect.try({
          try: () => {
            const rawReceipt = persisted.get(`publications/${publicationId}.json`)
            const rawIntegrity = persisted.get(`integrity/operations/${publicationId}`)
            return {
              receipt:
                rawReceipt === undefined
                  ? undefined
                  : Schema.decodeUnknownSync(PublicationReceiptSchema)(rawReceipt),
              integrity:
                rawIntegrity === undefined
                  ? undefined
                  : Schema.decodeUnknownSync(IntegrityIntentSchema)(rawIntegrity),
            }
          },
          catch: () => fail("STATE_CORRUPT", "Invalid rebuild publication proof."),
        })
        const ownership = proof.receipt?.context?.ownership
        const source = proof.receipt?.context?.source_intent
        const publishedFiles = new Map(
          binding.materialized.files.map((file) => [file.path, file.hash]),
        )
        const receiptFiles = new Map(
          proof.receipt?.portable.files.map((file) => [file.path, file.sha256]) ?? [],
        )
        const filesMatch =
          proof.receipt?.portable.main === binding.materialized.main &&
          receiptFiles.size === publishedFiles.size &&
          [...publishedFiles].every(([path, hash]) => receiptFiles.get(path) === hash)
        if (
          proof.receipt?.state !== "completed" ||
          proof.receipt.page_id !== binding.page_id ||
          proof.receipt.operation_id !== publicationId ||
          source?.mode !== "set" ||
          source.value.type !== "upstream" ||
          !filesMatch ||
          !ownership ||
          ownership.subscription_id !== publisher ||
          ownership.subscription_id !== binding.subscription_id ||
          ownership.member_key !== ownerMemberKey ||
          ownership.mode !== binding.mode ||
          ownership.published_hash !== binding.published_hash ||
          ownership.revision !== binding.revision ||
          canonical(ownership.fork_baseline) !== canonical(binding.fork_baseline) ||
          proof.integrity?.page_id !== binding.page_id ||
          proof.integrity.operation_id !== publicationId ||
          proof.integrity.marker.state !== "committed" ||
          proof.integrity.marker.operation_id !== publicationId ||
          proof.integrity.intended_hash !== binding.published_hash ||
          proof.integrity.marker.intended_hash !== binding.published_hash
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_UNVERIFIED",
              "Only the completed upstream publication and committed integrity can replace this member.",
            ),
          )
        if (already) return
        if (
          (expectedBinding?.generation ?? 0) + 1 !== binding.generation ||
          (expectedTarget !== undefined && expectedTarget.publisher_subscription_id !== publisher)
        )
          return yield* Effect.fail(
            fail("UPSTREAM_PLAN_STALE", "The rebuild generation or publisher changed."),
          )
        if (
          observedTarget &&
          (observedTarget.page_id !== binding.page_id ||
            observedTarget.publisher_subscription_id !== publisher) &&
          (observedTarget.page_id !== expectedTarget?.page_id ||
            observedTarget.publisher_subscription_id !== expectedTarget.publisher_subscription_id)
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_TARGET_CONFLICT",
              "Shared target already has another publication authority.",
            ),
          )
        targets.set(binding.target_key, nextTarget)
        bindings.set(key(binding), structuredClone(binding))
        commands.set(`materialized:${binding.target_key}`, {
          portable: structuredClone(binding.materialized),
          content_hash: binding.published_hash,
          revision: binding.revision,
        })
      }),
    setMode: (binding, expected) =>
      Effect.gen(function* () {
        if (
          (bindings.get(key(binding))?.generation ?? 0) !== expected ||
          binding.generation !== expected + 1
        )
          return yield* Effect.fail(
            fail("UPSTREAM_PLAN_STALE", "The accepted member baseline changed."),
          )
        bindings.set(key(binding), structuredClone(binding))
      }),
    advance: (binding, expected, publisher, operation) =>
      Effect.gen(function* () {
        if (
          !operation.items.some(
            (item) =>
              item.member_key === binding.member_key &&
              (item.status === "verified" || item.status === "retained"),
          )
        )
          return yield* Effect.fail(
            fail("UPSTREAM_UNVERIFIED", "Only a verified member can advance its baseline."),
          )
        if (
          (bindings.get(key(binding))?.generation ?? 0) !== expected ||
          binding.generation !== expected + 1
        )
          return yield* Effect.fail(
            fail("UPSTREAM_PLAN_STALE", "The accepted member baseline changed."),
          )
        const target = targets.get(binding.target_key)
        if (
          target &&
          (target.page_id !== binding.page_id || target.publisher_subscription_id !== publisher)
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_TARGET_CONFLICT",
              "Shared target already has another publication authority.",
            ),
          )
        yield* saveOperation(operation)
        targets.set(binding.target_key, {
          page_id: binding.page_id,
          publisher_subscription_id: publisher,
        })
        bindings.set(key(binding), structuredClone(binding))
      }),
    command: (id) => Effect.sync(() => commands.get(id)),
    saveCommand: (id, payload) =>
      Effect.sync(() => {
        commands.set(id, structuredClone(payload))
      }),
    createCommand: (id, payload) =>
      Effect.gen(function* () {
        if (commands.has(id))
          return yield* Effect.fail(
            fail("UPSTREAM_OPERATION_BUSY", "A durable command already claims this identity."),
          )
        commands.set(id, structuredClone(payload))
      }),
    sourceRichTextRepairClaims: (page, target) =>
      Effect.sync(() =>
        [...commands.entries()].flatMap(([id, value]) => {
          const plan = property(property(value).plan)
          return id.startsWith("source-rich-text-repair:member:") &&
            (property(plan.input).page_id === page || plan.target_key === target)
            ? [{ operation_id: id, value: structuredClone(value) }]
            : []
        }),
      ),
    sourceRootCompletionClaims: (page, target) =>
      Effect.sync(() =>
        [...commands.entries()].flatMap(([id, value]) => {
          const plan = property(property(value).plan)
          return id.startsWith("source-root-completion:member:") &&
            (property(plan.input).page_id === page || plan.target_key === target)
            ? [{ operation_id: id, value: structuredClone(value) }]
            : []
        }),
      ),
    sourceRootFidelityClaims: (page, target) =>
      Effect.sync(() =>
        [...commands.entries()].flatMap(([id, value]) => {
          const plan = property(property(value).plan)
          return id.startsWith("source-root-fidelity:member:") &&
            (plan.page_id === page || plan.target_key === target)
            ? [{ operation_id: id, value: structuredClone(value) }]
            : []
        }),
      ),
    contentAdoptionPlanClaims: (page, target) =>
      Effect.sync(() =>
        [...commands.entries()].flatMap(([id, value]) => {
          const plan = property(property(value).plan),
            items = property(plan.original_plan).items
          const item =
            Array.isArray(items) && typeof plan.item_index === "number"
              ? property(items[plan.item_index])
              : {}
          return id.startsWith("content-adoption:plan:") &&
            (plan.page_id === page || item.target_key === target)
            ? [id]
            : []
        }),
      ),
    claimCommand: (id, expected, payload, guard) =>
      Effect.gen(function* () {
        if (guard !== undefined && id.startsWith("source-root-fidelity:member:")) {
          const selected = property(property(commands.get(id)).plan),
            suffix = id.slice("source-root-fidelity:member:".length)
          const competing = [...commands].some(([key, value]) => {
            if (key === id || key === guard.operation_id) return false
            if (key === `content-adoption:member:${suffix}`) return true
            const plan = property(property(value).plan),
              items = property(plan.original_plan).items
            const item =
              Array.isArray(items) && typeof plan.item_index === "number"
                ? property(items[plan.item_index])
                : {}
            if (key.startsWith("content-adoption:plan:"))
              return plan.page_id === selected.page_id || item.target_key === selected.target_key
            if (key.startsWith("source-root-fidelity:member:"))
              return plan.page_id === selected.page_id || plan.target_key === selected.target_key
            if (
              key.startsWith("source-root-completion:member:") ||
              key.startsWith("source-rich-text-repair:member:")
            )
              return (
                property(plan.input).page_id === selected.page_id ||
                plan.target_key === selected.target_key
              )
            return false
          })
          if (guard.operation_id !== `source-root-completion:member:${suffix}` || competing)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_OPERATION_BUSY",
                "The exact fidelity parent or competing claim changed before CAS.",
              ),
            )
        }
        if (
          !commands.has(id) ||
          JSON.stringify(commands.get(id)) !== JSON.stringify(expected) ||
          (guard !== undefined &&
            (guard.operation_id === id ||
              !commands.has(guard.operation_id) ||
              JSON.stringify(commands.get(guard.operation_id)) !== JSON.stringify(guard.expected)))
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_OPERATION_BUSY",
              "The exact command intent was already claimed or changed; reconcile its saved evidence.",
            ),
          )
        commands.set(id, structuredClone(payload))
      }),
  }
}

export interface TarEntry {
  readonly name: string
  readonly content: string | Uint8Array
  readonly type?: string
}
export function tarGzip(entries: readonly TarEntry[]) {
  const chunks: Uint8Array[] = []
  const encoder = new TextEncoder()
  for (const entry of entries) {
    const content =
      typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content
    const header = new Uint8Array(512)
    const put = (offset: number, value: string) => header.set(encoder.encode(value), offset)
    put(0, entry.name)
    put(100, "0000600\0")
    put(108, "0000000\0")
    put(116, "0000000\0")
    put(124, content.length.toString(8).padStart(11, "0") + "\0")
    put(136, "00000000000\0")
    put(148, "        ")
    put(156, entry.type ?? "0")
    put(257, "ustar\0")
    put(263, "00")
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    put(148, checksum.toString(8).padStart(6, "0") + "\0 ")
    chunks.push(header, content, new Uint8Array((512 - (content.length % 512)) % 512))
  }
  chunks.push(new Uint8Array(1024))
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return gzipSync(bytes)
}

export const mainContent =
  "---\nname: sample-skill\ndescription: Use when reviewing sample resources.\n---\nRead references/guide.md\n"
export const skillBundle = tarGzip([
  { name: "sample-skill/SKILL.md", content: mainContent },
  { name: "sample-skill/references/guide.md", content: "\ufeff第一行\n第二行\n第三行" },
  { name: "sample-skill/assets/data.bin", content: new Uint8Array([0, 1, 2]) },
])
