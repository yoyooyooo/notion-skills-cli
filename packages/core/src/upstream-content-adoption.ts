import { contentAdoptionDownloadFenceCandidate } from "./publication-content-adoption-download.ts"
import { assertNoPendingSourceRichTextRepair } from "./upstream-source-rich-text-repair-model.ts"
import { assertNoPendingSourceRootCompletion } from "./upstream-source-root-completion-model.ts"
import { assertNoPendingSourceRootFidelity } from "./upstream-source-root-fidelity-model.ts"
import {
  contentAdoptionPropertyComparison,
  contentAdoptionEditTimeFenceCandidate,
} from "./publication-content-adoption-metadata.ts"
import {
  contentAdoptionDescriptionMatches,
  contentAdoptionDescriptorBounds,
  deriveContentAdoptionDescriptionMigration,
} from "./publication-content-adoption-description.ts"
import { Clock, Crypto, Effect, FileSystem, Path, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { hostname } from "node:os"
import { authScope, explicitSource } from "./catalog.ts"
import {
  aliasFor,
  decode,
  PageSchema,
  property,
  recordFromPage,
  fail,
  type SkillsError,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { Store, sha256 } from "./store.ts"
import { withLocalLocks } from "./local-locks.ts"
import { beginPublication, publicationSession, type PublicationOptions } from "./publication.ts"
import { PublicationReceiptSchema, type Receipt } from "./publication-model.ts"
import { publicationMarker, publicationOwnership } from "./publication-integrity.ts"
import type { IntegrityIntent, PublicationMarker } from "./publication-integrity-state.ts"
import { snapshotInfo } from "./snapshot.ts"
import { canonical } from "./publication-effect-proof.ts"
import { metadata, observation, publicationPropertiesMatch } from "./publication-observation.ts"
import { getSubscription } from "./upstream-subscription.ts"
import {
  publicationMemberKey,
  subscriptionConfigHash,
  targetKey,
  thawPortable,
} from "./upstream-content.ts"
import { portableIdentity } from "./export.ts"
import type { PortableSkill } from "./portable.ts"
import type { UpstreamPlan, UpstreamOperation } from "./upstream-model.ts"
import {
  ContentAdoptionInputSchema,
  ContentAdoptionPlanSchema,
  ContentAdoptionAttemptSchema,
  adoptionRefusal,
  adoptionTry,
  contentAdoptionPlanKey,
  contentAdoptionMemberKey,
  contentAdoptionPublicationKey,
  contentAdoptionWriting,
  contentAdoptionMarkerBody,
  contentAdoptionHandoffBody,
  contentAdoptionJournal,
  loadContentAdoptionPlan,
  type ContentAdoptionInput,
  type ContentAdoptionPlan,
} from "./publication-content-adoption-authority.ts"
import {
  readContentAdoptionProof,
  type ContentAdoptionReadProof,
} from "./publication-content-adoption-proof.ts"
import {
  contentAdoptionSourceField,
  contentAdoptionSourceAttachmentBody,
  prepareContentAdoptionSourceInstallation,
  loadContentAdoptionSourceInstallation,
  contentAdoptionCommittedCount,
  contentAdoptionOwnershipCount,
  contentAdoptionSourceInstalled,
} from "./publication-content-adoption-source.ts"
import {
  bindPublicationSource,
  publicationGuardComparison,
  publicationMetadataProperties,
  publicationSourcePropertiesComparison,
  rejectPublicationSourceOverride,
} from "./publication-source.ts"

const receiptKey = (id: string) => `publications/${id}.json`
type AdoptionEnvironment =
  | Store
  | Notion
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
function frozenIntended(portable: PortableSkill) {
  return Effect.gen(function* () {
    const files: Array<readonly [string, number, string]> = []
    for (const file of [...portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      if (
        !file.path ||
        /[\\\0]/.test(file.path) ||
        file.path.startsWith("/") ||
        file.path.split("/").some((part) => !part || part === "." || part === "..")
      )
        return yield* Effect.fail(adoptionRefusal("An original source path is invalid."))
      const source = yield* adoptionTry(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
      )
      if (source.includes("\0"))
        return yield* Effect.fail(
          adoptionRefusal("Content adoption accepts pure text source only."),
        )
      files.push([file.path, file.bytes.length, yield* sha256(file.bytes)])
    }
    if (
      portable.kind !== "skill" ||
      !files.length ||
      files.length > 10000 ||
      new Set(files.map((file) => file[0])).size !== files.length ||
      !files.some((file) => file[0] === portable.main) ||
      files.reduce((total, file) => total + file[1], 0) > 128 * 1024 * 1024
    )
      return yield* Effect.fail(adoptionRefusal("The complete pure-text skill source is invalid."))
    return yield* sha256(
      canonical([portable.kind, portable.name, portable.description, portable.main, files]),
    )
  })
}
export function readContentAdoptionOriginalInput(
  input: ContentAdoptionInput,
  adoption?: ContentAdoptionPlan,
) {
  return Effect.gen(function* () {
    if (
      (input.descriptor_migration && !input.install_source_bundle) ||
      (adoption && input.descriptor_migration !== adoption.descriptor_migration?.kind)
    )
      return yield* Effect.fail(
        adoptionRefusal(
          "The explicit Description migration must retain its exact source-installation selection.",
        ),
      )
    const store = yield* Store
    const plan = yield* store.upstream.plan(input.original_plan_id)
    const operation = yield* store.upstream.operation(input.original_plan_id)
    if (!plan || !operation || !plan.scope || !plan.database_id)
      return yield* Effect.fail(
        adoptionRefusal("The exact original bound upstream plan is required."),
      )
    const { plan_id: _id, plan_hash: _hash, ...body } = plan
    if (
      plan.plan_id !== `up_${plan.plan_hash}` ||
      (yield* sha256(JSON.stringify(body))) !== plan.plan_hash ||
      operation.operation_id !== `uo_${yield* sha256(plan.plan_id)}` ||
      operation.plan_id !== plan.plan_id ||
      operation.scope !== plan.scope ||
      operation.database_id !== plan.database_id ||
      operation.subscription_id !== plan.subscription_id ||
      operation.target_database_id !== plan.target_database_id ||
      operation.items.length !== plan.items.length ||
      operation.items.some((item, index) => item.member_key !== plan.items[index]?.member_key)
    )
      return yield* Effect.fail(
        adoptionRefusal("The original plan or ordered operation identity changed."),
      )
    const matches = plan.items.flatMap((item, index) =>
      item.member_key === input.member_key ? [index] : [],
    )
    if (matches.length !== 1)
      return yield* Effect.fail(adoptionRefusal("Select exactly one original member."))
    const index = matches[0]!,
      item = plan.items[index]!,
      prior = operation.items[index]!
    const alias = `${operation.operation_id}:${index}`,
      originalId = `p_${yield* sha256(alias)}`
    const linked =
      !!adoption &&
      prior.publication_operation_id === adoption.new_operation_id &&
      prior.page_id === input.page_id
    if (
      item.action !== "create" ||
      item.generation !== 0 ||
      item.page_id !== undefined ||
      item.expected_version !== undefined ||
      item.expected_hash !== undefined ||
      !item.candidate ||
      !item.accepted ||
      canonical(item.candidate) !== canonical(item.accepted) ||
      item.candidate.kind !== "skill" ||
      !item.content_hash ||
      !plan.source_manifest ||
      plan.source_manifest.source_id !== plan.subscription_id ||
      plan.source_manifest.revision !== plan.revision ||
      plan.source_manifest.members.filter((member) => member.member_key === input.member_key)
        .length !== 1 ||
      (!linked &&
        (!["unknown", "running"].includes(prior.status) ||
          prior.error_code !== "CREATE_CONFLICT" ||
          prior.page_id !== undefined ||
          prior.publication_operation_id !== alias)) ||
      (linked && !["running", "unknown", "failed", "verified"].includes(prior.status))
    )
      return yield* Effect.fail(adoptionRefusal("The selected original create conflict changed."))
    const portable = yield* thawPortable(item.candidate)
    const intended = yield* frozenIntended(portable)
    if ((yield* portableIdentity(portable)) !== item.content_hash)
      return yield* Effect.fail(adoptionRefusal("The original portable identity changed."))
    const original = yield* store.readJson(receiptKey(originalId), PublicationReceiptSchema)
    const originalIntegrity = yield* store.integrity.inspect(originalId)
    const old = yield* store.readJson(receiptKey(input.old_operation_id), PublicationReceiptSchema)
    const oldIntegrity = yield* store.integrity.inspect(input.old_operation_id)
    if (
      original ||
      old ||
      oldIntegrity ||
      input.old_operation_id === originalId ||
      !originalIntegrity ||
      canonical(originalIntegrity) !==
        canonical({
          version: 1,
          operation_id: originalId,
          intended_hash: intended,
          marker: {
            version: 2,
            operation_id: originalId,
            intended_hash: intended,
            state: "writing",
          },
        })
    )
      return yield* Effect.fail(
        adoptionRefusal("Original or old publication history is no longer absent and untouched."),
      )
    const claims = yield* store.upstream.contentAdoptionClaims(
      input.page_id,
      item.target_key,
      originalId,
      input.old_operation_id,
    )
    if (
      claims.original_intent_count !== 0 ||
      claims.publication_ids.some((id) => id !== adoption?.new_operation_id) ||
      claims.integrity_ids.some((id) => id !== originalId && id !== adoption?.new_operation_id) ||
      claims.upstream_operation_ids.some((id) => !linked || id !== operation.operation_id)
    )
      return yield* Effect.fail(
        adoptionRefusal("Another retained publication claims this page or original operation."),
      )
    const binding = (yield* store.upstream.bindings(plan.subscription_id)).find(
      (binding) => binding.member_key === input.member_key,
    )
    const expectedBinding =
      adoption && linked && prior.status === "verified"
        ? {
            subscription_id: plan.subscription_id,
            member_key: input.member_key,
            target_key: item.target_key,
            page_id: input.page_id,
            generation: 1,
            mode: "tracked",
            active: true,
            revision: plan.revision,
            published_hash: item.content_hash,
            accepted: item.accepted,
            materialized: item.candidate,
          }
        : undefined
    if (
      canonical(binding) !== canonical(expectedBinding) ||
      canonical(claims.bindings) !== canonical(expectedBinding ? [expectedBinding] : []) ||
      (claims.targets.length > 0 &&
        !(
          expectedBinding &&
          claims.targets.length === 1 &&
          canonical(claims.targets[0]) ===
            canonical({
              target_key: item.target_key,
              page_id: input.page_id,
              publisher_subscription_id: plan.publisher_subscription_id,
            })
        ))
    )
      return yield* Effect.fail(
        adoptionRefusal("The original member, page or target acquired another native claim."),
      )
    if (
      adoption &&
      (canonical(plan) !== canonical(adoption.original_plan) ||
        index !== adoption.item_index ||
        originalId !== adoption.original_publication_id ||
        intended !== adoption.intended_hash ||
        canonical(originalIntegrity) !== canonical(adoption.original_integrity))
    )
      return yield* Effect.fail(
        adoptionRefusal("The native adoption no longer binds its original immutable source."),
      )
    if (adoption?.descriptor_migration) {
      const derived = yield* adoptionTry(() =>
        deriveContentAdoptionDescriptionMigration(
          portable,
          intended,
          adoption.old_marker,
          adoption.evidence.raw[`v1/pages/${adoption.page_id}`],
        ),
      )
      if (
        adoption.old_marker.operation_id !== input.old_operation_id ||
        !adoption.source_installation ||
        canonical(derived) !== canonical(adoption.descriptor_migration)
      )
        return yield* Effect.fail(
          adoptionRefusal(
            "The retained Description migration is not derived from the complete original source and old marker.",
          ),
        )
    }
    const subscription = yield* getSubscription(plan.subscription_id, plan.database_id)
    const config = yield* subscriptionConfigHash(subscription)
    const accepted =
      linked &&
      prior.status === "verified" &&
      (yield* store.upstream.command(`${plan.plan_id}:accepted-config`)) === config &&
      subscription.source.accepted_ref === plan.revision &&
      subscription.published?.plan_hash === plan.plan_hash
    if (
      !subscription.enabled ||
      subscription.removed ||
      (config !== plan.config_hash && !accepted) ||
      subscription.target_database_id !== plan.target_database_id ||
      (subscription.source.publisher_subscription_id ?? subscription.subscription_id) !==
        plan.publisher_subscription_id ||
      targetKey(subscription, input.member_key) !== item.target_key
    )
      return yield* Effect.fail(
        adoptionRefusal("The original subscription configuration or publisher changed."),
      )
    const maps = [
      yield* store.upstream.command(`${plan.plan_id}:subscription-map`),
      yield* store.upstream.command(`${plan.plan_id}:subscription-map:intended`),
    ]
    if (
      !maps.some(
        (value) => canonical(value) === canonical(subscription.published ?? { unpublished: true }),
      )
    )
      return yield* Effect.fail(adoptionRefusal("The original published member map changed."))
    const selectedMap = subscription.published?.members.find(
      (member) => member.member_key === input.member_key,
    )
    if (
      selectedMap &&
      (!linked ||
        selectedMap.page_id !== input.page_id ||
        selectedMap.content_hash !== item.content_hash)
    )
      return yield* Effect.fail(
        adoptionRefusal("The selected member already has another published page."),
      )
    const ownership = {
      subscription_id: plan.publisher_subscription_id,
      member_key: publicationMemberKey(subscription, input.member_key),
      mode: "tracked" as const,
      published_hash: item.content_hash,
      revision: plan.revision,
    }
    if (adoption && canonical(ownership) !== canonical(adoption.ownership))
      return yield* Effect.fail(adoptionRefusal("The frozen ownership changed."))
    return {
      plan,
      operation,
      index,
      item,
      prior,
      originalId,
      originalIntegrity,
      portable,
      intended,
      ownership,
      claims,
      linked,
    }
  })
}
function originalInput(input: ContentAdoptionInput, adoption?: ContentAdoptionPlan) {
  return Effect.gen(function* () {
    const original = yield* readContentAdoptionOriginalInput(input, adoption)
    yield* assertNoPendingSourceRichTextRepair(
      original.plan.plan_id,
      original.index,
      input.page_id,
      original.item.target_key,
    )
    yield* assertNoPendingSourceRootCompletion(
      original.plan.plan_id,
      original.index,
      input.page_id,
      original.item.target_key,
    )
    yield* assertNoPendingSourceRootFidelity(
      original.plan.plan_id,
      original.index,
      input.page_id,
      original.item.target_key,
    )
    return original
  })
}
export function assertContentAdoptionUniquePage(
  plan: UpstreamPlan,
  portable: PortableSkill,
  id: string,
  dataSource: string,
) {
  return Effect.gen(function* () {
    const source = yield* explicitSource(plan.target_database_id)
    if (source.data_source_ids.length !== 1 || source.data_source_ids[0] !== dataSource)
      return yield* Effect.fail(adoptionRefusal("The exact single target data source changed."))
    const api = yield* Notion,
      ids = new Set<string>(),
      matches: string[] = [],
      cursors = new Set<string>()
    let cursor: string | undefined
    for (let count = 0; count < 1000; count++) {
      const page = property(
        yield* api.request(
          `v1/data_sources/${dataSource}/query`,
          {
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          },
          { method: "POST" },
        ),
      )
      if (!Array.isArray(page.results) || typeof page.has_more !== "boolean")
        return yield* Effect.fail(adoptionRefusal("The full target catalog is invalid."))
      for (const value of page.results) {
        const raw = property(value)
        if (typeof raw.id !== "string" || ids.has(raw.id))
          return yield* Effect.fail(adoptionRefusal("A catalog page repeats."))
        ids.add(raw.id)
        if (raw.archived === true || raw.in_trash === true) continue
        const record = yield* adoptionTry(() =>
          recordFromPage(decode(PageSchema, value), source, dataSource),
        )
        if (record.alias === aliasFor(portable.name)) matches.push(record.locator.page_id)
      }
      if (!page.has_more) {
        if (
          (page.next_cursor !== null && page.next_cursor !== undefined) ||
          canonical(matches) !== canonical([id])
        )
          return yield* Effect.fail(
            adoptionRefusal("The original alias does not have exactly this one existing page."),
          )
        return
      }
      if (
        typeof page.next_cursor !== "string" ||
        !page.next_cursor ||
        cursors.has(page.next_cursor)
      )
        return yield* Effect.fail(adoptionRefusal("The catalog cursor is missing or repeated."))
      cursor = page.next_cursor
      cursors.add(cursor)
    }
    return yield* Effect.fail(adoptionRefusal("The target catalog was not completely read."))
  })
}
const uniqueExistingPage = assertContentAdoptionUniquePage
const inputFor = (plan: ContentAdoptionPlan): ContentAdoptionInput => ({
  original_plan_id: plan.original_plan.plan_id,
  member_key: plan.original_plan.items[plan.item_index]!.member_key,
  page_id: plan.page_id,
  old_operation_id: plan.old_operation_id,
  ...(plan.source_installation ? { install_source_bundle: true as const } : {}),
  ...(plan.descriptor_migration ? { descriptor_migration: plan.descriptor_migration.kind } : {}),
})
const descriptorBounds = (plan: ContentAdoptionPlan, portable: PortableSkill, count = 0) =>
  adoptionTry(() =>
    contentAdoptionDescriptorBounds(
      portable,
      plan.intended_hash,
      plan.descriptor_migration,
      count > 0,
    ),
  )
const lockKeys = (plan: ContentAdoptionPlan) => [
  `publication:${plan.new_operation_id}`,
  `publication:${plan.original_publication_id}`,
  `publication:${plan.old_operation_id}`,
  `upstream-subscription:${plan.original_plan.subscription_id}`,
  ...plan.original_plan.items.map((item) => `upstream-target:${item.target_key}`),
]
function idle(receipt: Receipt) {
  if (!receipt.owner) return true
  const owner = receipt.owner
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return property(error).code === "ESRCH"
  }
}
export function planContentAdoption(input: ContentAdoptionInput) {
  return Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(ContentAdoptionInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() => adoptionRefusal("Select strict original content adoption identities.")),
    )
    const store = yield* Store
    const original = yield* originalInput(input)
    return yield* withLocalLocks(
      store.root,
      [
        `publication:${original.originalId}`,
        `publication:${input.old_operation_id}`,
        `upstream-subscription:${original.plan.subscription_id}`,
        ...original.plan.items.map((item) => `upstream-target:${item.target_key}`),
      ],
      Effect.gen(function* () {
        const current = yield* originalInput(input)
        const memberKey = contentAdoptionMemberKey(current.plan.plan_id, current.index)
        const existing = property(yield* store.upstream.command(memberKey))
        if (typeof existing.plan_id === "string") {
          const value = yield* store.upstream.command(contentAdoptionPlanKey(existing.plan_id))
          const saved = yield* adoptionTry(() =>
            Schema.decodeUnknownSync(ContentAdoptionAttemptSchema)(value, {
              onExcessProperty: "error",
            }),
          )
          yield* loadContentAdoptionPlan({
            plan_id: saved.plan.plan_id,
            plan_hash: saved.plan.plan_hash,
          })
          if (
            saved.plan.page_id !== input.page_id ||
            saved.plan.old_operation_id !== input.old_operation_id ||
            !!saved.plan.source_installation !== !!input.install_source_bundle ||
            saved.plan.descriptor_migration?.kind !== input.descriptor_migration
          )
            return yield* Effect.fail(
              adoptionRefusal("The original member already has another retained adoption attempt."),
            )
          return adoptionSummary(saved.plan, saved.state)
        }
        const scope = yield* authScope
        if (scope !== current.plan.scope)
          return yield* Effect.fail(adoptionRefusal("The original authentication scope changed."))
        const source = yield* explicitSource(current.plan.target_database_id)
        if (source.data_source_ids.length !== 1)
          return yield* Effect.fail(adoptionRefusal("One exact target data source is required."))
        const dataSource = source.data_source_ids[0]!
        yield* uniqueExistingPage(current.plan, current.portable, input.page_id, dataSource)
        const raw = yield* (yield* Notion).request(`v1/pages/${input.page_id}`)
        const marker = yield* adoptionTry(() => publicationMarker(raw))
        if (
          !marker ||
          marker.state !== "writing" ||
          marker.operation_id !== input.old_operation_id ||
          (!input.descriptor_migration && marker.intended_hash !== current.intended)
        )
          return yield* Effect.fail(
            adoptionRefusal(
              "The exact old writing marker does not match the original intended bytes.",
            ),
          )
        const migration = input.descriptor_migration
          ? yield* adoptionTry(() =>
              deriveContentAdoptionDescriptionMigration(
                current.portable,
                current.intended,
                marker,
                raw,
              ),
            )
          : undefined
        const archive = input.install_source_bundle
          ? yield* prepareContentAdoptionSourceInstallation(current.portable, raw)
          : undefined
        const proof = yield* readContentAdoptionProof({
          page_id: input.page_id,
          database_id: current.plan.target_database_id,
          data_source_id: dataSource,
          scope,
          ...(yield* adoptionTry(() =>
            contentAdoptionDescriptorBounds(current.portable, current.intended, migration),
          )),
          old_marker: marker,
          marker,
          planned_ownership: current.ownership,
          ...(archive
            ? { source_installation: archive.installation, source_installed: false }
            : {}),
        })
        const again = yield* originalInput(input)
        if (canonical(again) !== canonical(current))
          return yield* Effect.fail(
            adoptionRefusal("Original native inputs changed during planning."),
          )
        if (archive) {
          if (proof.source_bytes_verified || proof.evidence.source_proof !== "not_installed")
            return yield* Effect.fail(
              adoptionRefusal(
                "The missing source archive was not explicitly retained as unverified evidence.",
              ),
            )
          yield* store.writeBytes(`objects/${archive.installation.sha256}`, archive.bytes)
        }
        const crypto = yield* Crypto.Crypto
        const token = yield* crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError(() =>
              adoptionRefusal("Could not allocate an adoption publication identity."),
            ),
          )
        const body = {
          format: 1 as const,
          domain: "content_adoption" as const,
          original_plan: current.plan,
          original_operation: current.operation,
          item_index: current.index,
          original_publication_id: current.originalId,
          original_integrity: current.originalIntegrity,
          old_operation_id: marker.operation_id,
          old_marker: marker,
          old_history: "absent_in_current_database" as const,
          page_id: input.page_id,
          database_id: current.plan.target_database_id,
          data_source_id: dataSource,
          scope,
          frozen: current.item.candidate!,
          intended_hash: current.intended,
          ownership: current.ownership,
          evidence: proof.evidence,
          ...(archive ? { source_installation: archive.installation } : {}),
          ...(migration ? { descriptor_migration: migration } : {}),
          new_operation_id: `p_${token}`,
        }
        const hash = yield* sha256(canonical(body))
        const plan = yield* adoptionTry(() =>
          Schema.decodeUnknownSync(ContentAdoptionPlanSchema)(
            { ...body, plan_id: `ca_${hash}`, plan_hash: hash },
            { onExcessProperty: "error" },
          ),
        )
        yield* store.upstream.saveCommand(contentAdoptionPlanKey(plan.plan_id), {
          plan,
          state: "planned",
        })
        yield* store.upstream.saveCommand(memberKey, { plan_id: plan.plan_id })
        yield* store.upstream.saveCommand(contentAdoptionPublicationKey(plan.new_operation_id), {
          plan_id: plan.plan_id,
        })
        return adoptionSummary(plan, "planned")
      }),
    )
  })
}
function adoptionSummary(plan: ContentAdoptionPlan, state: string) {
  return {
    kind: "content_adoption" as const,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    state,
    original_plan_id: plan.original_plan.plan_id,
    member_key: plan.original_plan.items[plan.item_index]!.member_key,
    page_id: plan.page_id,
    old_operation_id: plan.old_operation_id,
    old_history: plan.old_history,
    publication_operation_id: plan.new_operation_id,
    ...(plan.descriptor_migration ? { descriptor_migration: plan.descriptor_migration } : {}),
    complete_file_count:
      plan.source_installation && ["publication_committed", "linked"].includes(state)
        ? plan.frozen.files.length
        : plan.evidence.files.length,
    reference_page_count: plan.evidence.page_ids.length - 1,
    content_writes: plan.source_installation ? 1 : 0,
    page_creations: 0,
    ...(plan.source_installation
      ? {
          source_installation: {
            state: ["publication_committed", "linked"].includes(state) ? "verified" : "pending",
            frozen_file_count: plan.frozen.files.length,
            archive_sha256: plan.source_installation.sha256,
            archive_bytes: plan.source_installation.byte_length,
            independently_verified: ["publication_committed", "linked"].includes(state),
          },
        }
      : {}),
  }
}
function phaseMarker(
  plan: ContentAdoptionPlan,
  count: number,
  integrity: IntegrityIntent,
): PublicationMarker {
  if (count === 0) return plan.old_marker
  if (count < contentAdoptionCommittedCount(plan)) return contentAdoptionWriting(plan)
  if (integrity.marker.state !== "committed")
    throw adoptionRefusal("The exact intended commit is missing.")
  return integrity.marker
}
function proveProgress(receipt: Receipt, api?: Notion["Service"]) {
  return Effect.gen(function* () {
    const reference = receipt.context?.content_adoption
    if (!reference)
      return yield* Effect.fail(
        adoptionRefusal("The publication has no persisted adoption context."),
      )
    const attempt = yield* loadContentAdoptionPlan(reference),
      plan = attempt.plan
    if (attempt.state === "planned")
      return yield* Effect.fail(
        adoptionRefusal("The native adoption attempt has not been claimed."),
      )
    const store = yield* Store,
      transport = api ?? (yield* Notion)
    yield* bindPublicationSource(receipt, plan.data_source_id, transport)
    const nativeBefore = yield* originalInput(inputFor(plan), plan)
    if (plan.source_installation)
      yield* loadContentAdoptionSourceInstallation(plan, nativeBefore.portable)
    yield* uniqueExistingPage(
      nativeBefore.plan,
      nativeBefore.portable,
      plan.page_id,
      plan.data_source_id,
    )
    const integrity = yield* store.integrity.inspect(receipt.operation_id)
    if (
      !integrity ||
      integrity.page_id !== plan.page_id ||
      integrity.operation_id !== plan.new_operation_id ||
      integrity.intended_hash !== plan.intended_hash ||
      (integrity.marker.state === "writing" &&
        canonical(integrity.marker) !== canonical(contentAdoptionWriting(plan)))
    )
      return yield* Effect.fail(
        adoptionRefusal("The new integrity identity differs from the claimed adoption."),
      )
    const journal = contentAdoptionJournal(receipt, plan, integrity.marker)
    if (!journal)
      return yield* Effect.fail(
        adoptionRefusal("The adoption journal contains an unrelated or unproved effect."),
      )
    const rootPath = `v1/pages/${plan.page_id}`
    const raw = yield* transport.request(rootPath)
    const marker = yield* adoptionTry(() => publicationMarker(raw))
    const owner = yield* adoptionTry(() => publicationOwnership(raw))
    const emptyOwner = { upstream: [], mode: "", key: "", hash: "", revision: "", baseline: "" }
    const wantedOwner = {
      upstream: [plan.ownership.subscription_id],
      mode: "tracked",
      key: plan.ownership.member_key,
      hash: plan.ownership.published_hash,
      revision: plan.ownership.revision,
      baseline: "",
    }
    const matches = (count: number) =>
      canonical(marker) === canonical(phaseMarker(plan, count, integrity)) &&
      canonical(owner) ===
        canonical(count >= contentAdoptionOwnershipCount(plan) ? wantedOwner : emptyOwner) &&
      (count < contentAdoptionOwnershipCount(plan) ||
        publicationPropertiesMatch(raw, publicationMetadataProperties(receipt))) &&
      (!plan.descriptor_migration ||
        contentAdoptionDescriptionMatches(raw, {
          migration: plan.descriptor_migration,
          restored: count > 0,
        }))
    let completed = journal.completed,
      observedApplied = false
    let observedUpload: { readonly id: string; readonly status: "uploaded" } | undefined
    if (journal.pending_kind === "allocation")
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
          "The original allocation has no acknowledged identity; source installation cannot replay it.",
        ),
      )
    if (journal.pending_kind === "attachment") {
      const field = yield* adoptionTry(() =>
        contentAdoptionSourceField(raw, plan.source_installation),
      )
      if (field.files.length === 1) {
        completed++
        observedApplied = true
      } else if (field.files.length !== 0)
        return yield* Effect.fail(
          adoptionRefusal(
            "The pending Files effect has neither its exact empty before-state nor its single planned attachment.",
          ),
        )
      if (!matches(completed))
        return yield* Effect.fail(
          adoptionRefusal(
            "The pending source attachment changed another ownership or marker phase.",
          ),
        )
    } else if (
      journal.pending_index !== undefined &&
      journal.pending_kind !== "send" &&
      matches(completed + 1)
    ) {
      completed++
      observedApplied = true
    } else if (!matches(completed))
      return yield* Effect.fail(
        adoptionRefusal(
          "Current marker or owner is not the exact before/after of the saved journal.",
        ),
      )
    const proof = yield* readContentAdoptionProof({
      page_id: plan.page_id,
      database_id: plan.database_id,
      data_source_id: plan.data_source_id,
      scope: plan.scope,
      ...(yield* descriptorBounds(plan, nativeBefore.portable, completed)),
      old_marker: plan.old_marker,
      marker: phaseMarker(plan, completed, integrity),
      planned_ownership: plan.ownership,
      ...(completed >= contentAdoptionOwnershipCount(plan) ? { ownership: plan.ownership } : {}),
      metadata: receipt,
      ...(plan.source_installation
        ? {
            source_installation: plan.source_installation,
            source_installed: contentAdoptionSourceInstalled(plan, completed),
          }
        : {}),
      evidence: plan.evidence,
      changed_root: completed > 0,
    }).pipe(Effect.provideService(Notion, transport))
    for (const [path, expected] of Object.entries(receipt.guards)) {
      const value = proof.raw[path] ?? (yield* transport.request(path))
      const actual = observation(path, value)
      if (path === rootPath && observedApplied) {
        const intent = receipt.intents[journal.pending_index!]!
        const fields = Object.keys(property(property(intent.body).properties))
        const unchanged = (raw: unknown) => {
          const value = structuredClone(property(raw))
          delete value.last_edited_time
          const properties = property(value.properties)
          for (const [name, raw] of Object.entries(properties)) {
            const field = property(raw)
            if (fields.includes(name) || fields.includes(String(field.id)))
              delete field[String(field.type)]
          }
          value.properties =
            receipt.source_binding?.status === "bound"
              ? publicationSourcePropertiesComparison(receipt.source_binding, properties).map(
                  ([identity, field]) => [
                    identity,
                    contentAdoptionPropertyComparison(field, property(raw).last_edited_time),
                  ],
                )
              : Object.fromEntries(
                  Object.entries(properties).map(([name, field]) => [
                    name,
                    contentAdoptionPropertyComparison(field, property(raw).last_edited_time),
                  ]),
                )
          return value
        }
        if (canonical(unchanged(actual)) !== canonical(unchanged(expected)))
          return yield* Effect.fail(
            adoptionRefusal("An unrequested field changed alongside the pending property write."),
          )
      } else if (
        publicationGuardComparison(receipt, path, actual) !==
        publicationGuardComparison(receipt, path, expected)
      )
        return yield* Effect.fail(
          adoptionRefusal("A retained publication guard changed.", { path }),
        )
    }
    if (journal.pending_kind === "send") {
      const intent = receipt.intents[journal.pending_index!]!
      const uploadPath = intent.path.slice(0, -"/send".length)
      const uploaded = property(yield* transport.request(uploadPath))
      if (uploaded.id !== uploadPath.split("/")[2] || uploaded.status !== "uploaded")
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
            "The original send has no complete uploaded observation; it cannot be replayed.",
          ),
        )
      observedUpload = { id: String(uploaded.id), status: "uploaded" }
      completed++
      observedApplied = true
    }
    const nativeAfter = yield* originalInput(inputFor(plan), plan)
    if (canonical(nativeBefore) !== canonical(nativeAfter))
      return yield* Effect.fail(
        adoptionRefusal("Native adoption inputs changed during the whole proof."),
      )
    yield* uniqueExistingPage(
      nativeAfter.plan,
      nativeAfter.portable,
      plan.page_id,
      plan.data_source_id,
    )
    return {
      plan,
      attempt,
      integrity,
      journal,
      completed,
      observedApplied,
      observedUpload,
      proof,
      native: nativeAfter,
    }
  })
}

/** Called by the ordinary session for every mutation of this typed context. */
export function authorizeContentAdoptionMutation(
  receipt: Receipt,
  path: string,
  body: unknown,
  method: string,
  api: Notion["Service"],
  request: {
    readonly file?: string
    readonly artifact?: Receipt["intents"][number]["artifact"]
  } = {},
): Effect.Effect<boolean, SkillsError, AdoptionEnvironment> {
  return Effect.gen(function* () {
    const progress = yield* proveProgress(receipt, api)
    const { plan, journal, integrity, completed } = progress
    if (journal.pending_index !== undefined || completed >= contentAdoptionCommittedCount(plan))
      return yield* Effect.fail(
        adoptionRefusal(
          "The next adoption mutation is blocked by an unresolved or complete journal.",
        ),
      )
    const source = plan.source_installation
    if (source && completed === 1) {
      const artifact = {
        suboperation_id: `${receipt.operation_id}:upload:${receipt.intents.length}`,
        filename: source.filename,
        sha256: source.sha256,
        byte_length: source.byte_length,
      }
      if (
        path !== "v1/file_uploads" ||
        method !== "POST" ||
        request.file !== undefined ||
        canonical(body) !== canonical({ filename: source.filename, mode: "single_part" }) ||
        canonical(request.artifact) !== canonical(artifact)
      )
        return yield* Effect.fail(
          adoptionRefusal("The allocation differs from the exact frozen source artifact."),
        )
      return false
    }
    const allocation = source
      ? receipt.intents.find(
          (intent) => intent.path === "v1/file_uploads" && intent.status === "completed",
        )
      : undefined
    const id = property(allocation?.response).id
    if (source && completed === 2) {
      const store = yield* Store,
        paths = yield* Path.Path
      if (
        typeof id !== "string" ||
        path !== `v1/file_uploads/${id}/send` ||
        method !== "POST" ||
        body !== undefined ||
        request.artifact !== undefined ||
        request.file !== paths.join(store.root, `uploads/${source.sha256}/${source.filename}`)
      )
        return yield* Effect.fail(
          adoptionRefusal(
            "The send differs from the acknowledged allocation and its frozen local bytes.",
          ),
        )
      const input = yield* store.readBytes(`uploads/${source.sha256}/${source.filename}`)
      if (input.length !== source.byte_length || (yield* sha256(input)) !== source.sha256)
        return yield* Effect.fail(
          adoptionRefusal("The upload input differs from the planned source archive."),
        )
      return false
    }
    if (
      method !== "PATCH" ||
      path !== `v1/pages/${plan.page_id}` ||
      request.file !== undefined ||
      request.artifact !== undefined
    )
      return yield* Effect.fail(
        adoptionRefusal("The next adoption mutation is not its exact root property effect."),
      )
    const ownershipBefore = contentAdoptionOwnershipCount(plan) - 1
    const expected =
      completed === 0
        ? contentAdoptionHandoffBody(plan)
        : source && completed === 3 && typeof id === "string"
          ? contentAdoptionSourceAttachmentBody(source, id)
          : completed === ownershipBefore
            ? { properties: publicationMetadataProperties(receipt) }
            : integrity.marker.state === "committed"
              ? contentAdoptionMarkerBody(integrity.marker)
              : undefined
    if (
      !expected ||
      canonical(body) !== canonical(expected) ||
      (completed >= ownershipBefore && !progress.proof.source_bytes_verified)
    )
      return yield* Effect.fail(
        adoptionRefusal(
          "The property request differs from the exact next effect or lacks complete source bytes.",
        ),
      )
    return completed === 0
  })
}
export function verifyContentAdoptionReadback(
  receipt: Receipt,
  api: Notion["Service"],
): Effect.Effect<void, SkillsError, AdoptionEnvironment> {
  return proveProgress(receipt, api).pipe(
    Effect.asVoid,
    Effect.mapError((error) =>
      error.code === "CONTENT_ADOPTION_REFUSED"
        ? fail("WRITE_CONFLICT", error.message, error.details)
        : error,
    ),
  )
}

function settleObserved(
  receipt: Receipt,
  progress: Effect.Success<ReturnType<typeof proveProgress>>,
) {
  const index = progress.journal.pending_index
  if (index === undefined || !progress.observedApplied) return
  const intent = receipt.intents[index]!
  intent.response = progress.observedUpload
    ? { ...progress.observedUpload, prior_status: intent.status, recovery: "observed_uploaded" }
    : { id: progress.plan.page_id, prior_status: intent.status, recovery: "observed_applied" }
  intent.status = "completed"
  if (!progress.observedUpload)
    receipt.guards[`v1/pages/${progress.plan.page_id}`] = metadata(
      progress.proof.raw[`v1/pages/${progress.plan.page_id}`],
    )
}
function completeReceipt(receipt: Receipt, proof: ContentAdoptionReadProof) {
  receipt.state = "completed"
  const result = {
    ...snapshotInfo(proof.snapshot),
    operation_id: receipt.operation_id,
    operation: "replace",
    action: "adopt",
    reused: true,
    verified: true,
    content_writes: proof.evidence.source_proof === "verified" ? 1 : 0,
  }
  receipt.result = result
  delete receipt.owner
  return result
}
/** Called under reconcilePublication's existing publication lock, scope/owner checks. */
export function reconcileContentAdoption(receipt: Receipt) {
  return Effect.gen(function* () {
    const store = yield* Store
    if (receipt.conflict) {
      let refusal: SkillsError | undefined
      const downloadCandidate = contentAdoptionDownloadFenceCandidate(receipt)
      if (downloadCandidate) {
        const checked = yield* Effect.gen(function* () {
          const durable = yield* store.readJson(
            receiptKey(receipt.operation_id),
            PublicationReceiptSchema,
          )
          if (!durable || canonical(durable) !== canonical(receipt))
            return yield* Effect.fail(
              adoptionRefusal("The original download-fenced adoption receipt changed."),
            )
          const progress = yield* proveProgress(receipt)
          const source = progress.plan.source_installation
          const current = metadata(progress.proof.raw[downloadCandidate.rootPath])
          const attachment = progress.proof.evidence.attachments[0]
          if (
            !source ||
            progress.attempt.state !== "applying" ||
            progress.completed !== 4 ||
            progress.observedApplied ||
            progress.journal.completed !== 4 ||
            progress.journal.pending_index !== undefined ||
            progress.journal.retry_index !== undefined ||
            !progress.proof.source_bytes_verified ||
            progress.proof.evidence.source_proof !== "verified" ||
            progress.proof.evidence.attachments.length !== 1 ||
            !attachment ||
            attachment.index !== 0 ||
            attachment.name !== source.filename ||
            attachment.bytes !== source.byte_length ||
            attachment.sha256 !== source.sha256 ||
            canonical(current) !== canonical(downloadCandidate.acknowledged) ||
            property(current).last_edited_time !== downloadCandidate.acknowledged.last_edited_time
          )
            return yield* Effect.fail(
              adoptionRefusal(
                "The original source attachment ACK, exact root revision or complete source bytes changed.",
              ),
            )
          return {
            progress,
            checkpoint: {
              version: 1 as const,
              operation_id: receipt.operation_id,
              page_id: progress.plan.page_id,
              plan_id: progress.plan.plan_id,
              plan_hash: progress.plan.plan_hash,
              intended_hash: progress.plan.intended_hash,
              original_intent_count: 4 as const,
              original_receipt_sha256: yield* sha256(canonical(receipt)),
              original_journal_sha256: yield* sha256(canonical(receipt.intents)),
              original_guards_sha256: yield* sha256(canonical(receipt.guards)),
              original_plan_sha256: yield* sha256(canonical(progress.plan)),
              original_portable_sha256: yield* sha256(canonical(receipt.portable)),
              integrity_sha256: yield* sha256(canonical(progress.integrity)),
              native_inputs_sha256: yield* sha256(canonical(progress.native)),
              content_proof_sha256: yield* sha256(canonical(progress.proof.evidence)),
              root_acknowledged_revision: String(downloadCandidate.acknowledged.last_edited_time),
              root_acknowledged_sha256: yield* sha256(canonical(downloadCandidate.acknowledged)),
              root_fresh_sha256: yield* sha256(canonical(current)),
              archive_sha256: source.sha256,
              archive_bytes: source.byte_length,
            },
          }
        }).pipe(Effect.result)
        if (checked._tag === "Success") {
          const durable = yield* store.readJson(
            receiptKey(receipt.operation_id),
            PublicationReceiptSchema,
          )
          if (!durable || canonical(durable) !== canonical(receipt))
            return yield* Effect.fail(
              adoptionRefusal(
                "The original download-fenced adoption changed before recording its proof.",
              ),
            )
          const corrected = structuredClone(receipt)
          corrected.conflict_history = [
            ...(receipt.conflict_history ?? []),
            {
              observed_at_ms: yield* Clock.currentTimeMillis,
              conflict: true,
              state: receipt.state,
              stages: [...receipt.stages],
              ...(receipt.failure ? { failure: structuredClone(receipt.failure) } : {}),
              guard_paths: Object.keys(receipt.guards),
              intent_count: receipt.intents.length,
              intended_hash: checked.success.progress.plan.intended_hash,
              content_adoption_download_checkpoint: checked.success.checkpoint,
            },
          ]
          corrected.state = "running"
          delete corrected.conflict
          delete corrected.owner
          yield* store.writeJson(receiptKey(receipt.operation_id), corrected)
          return {
            operation_id: receipt.operation_id,
            kind: "publication" as const,
            state: corrected.state,
            outcome: "needs_safe_resume" as const,
            verified: false as const,
            unresolved: false,
            observations: [
              {
                path: downloadCandidate.rootPath,
                outcome: "success" as const,
                reason:
                  "All four original ACKs, the exact root revision, full content graph and independently downloaded source bytes are unchanged. The former download failure is retained in history.",
              },
            ],
            next: { argv: ["ntn-skills", "operation", "resume", receipt.operation_id] },
          }
        }
        refusal = checked.failure
      }
      const candidate = contentAdoptionEditTimeFenceCandidate(receipt)
      if (candidate) {
        // An ACK already stored this exact root guard before the old strict
        // metadata comparison failed. A later revision cannot authorize the
        // correction, even when an automatic property follows that revision.
        const checked = yield* Effect.gen(function* () {
          const durable = yield* store.readJson(
            receiptKey(receipt.operation_id),
            PublicationReceiptSchema,
          )
          if (!durable || canonical(durable) !== canonical(receipt))
            return yield* Effect.fail(
              adoptionRefusal("The original fenced adoption receipt changed."),
            )
          const progress = yield* proveProgress(receipt)
          const current = metadata(progress.proof.raw[candidate.rootPath])
          const original = metadata(progress.plan.evidence.raw[candidate.rootPath])
          if (
            progress.plan.source_installation ||
            progress.attempt.state !== "applying" ||
            progress.completed !== 1 ||
            progress.observedApplied ||
            progress.journal.completed !== 1 ||
            progress.journal.pending_index !== undefined ||
            progress.journal.retry_index !== undefined ||
            canonical(original) !== canonical(candidate.before) ||
            canonical(current) !== canonical(candidate.acknowledged) ||
            property(current).last_edited_time !== candidate.acknowledged.last_edited_time
          )
            return yield* Effect.fail(
              adoptionRefusal(
                "The original marker ACK and its retained root revision are not exact.",
              ),
            )
          const fields = []
          for (const field of candidate.fields)
            fields.push({
              name: field.name,
              id: field.id,
              definition_sha256: yield* sha256(canonical(field.definition)),
            })
          return {
            progress,
            checkpoint: {
              version: 1 as const,
              operation_id: receipt.operation_id,
              page_id: progress.plan.page_id,
              plan_id: progress.plan.plan_id,
              plan_hash: progress.plan.plan_hash,
              intended_hash: progress.plan.intended_hash,
              original_intent_count: 1 as const,
              original_receipt_sha256: yield* sha256(canonical(receipt)),
              original_journal_sha256: yield* sha256(canonical(receipt.intents)),
              original_guards_sha256: yield* sha256(canonical(receipt.guards)),
              original_plan_sha256: yield* sha256(canonical(progress.plan)),
              original_portable_sha256: yield* sha256(canonical(receipt.portable)),
              integrity_sha256: yield* sha256(canonical(progress.integrity)),
              native_inputs_sha256: yield* sha256(canonical(progress.native)),
              content_proof_sha256: yield* sha256(canonical(progress.proof.evidence)),
              root_before_revision: String(candidate.before.last_edited_time),
              root_acknowledged_revision: String(candidate.acknowledged.last_edited_time),
              root_before_sha256: yield* sha256(canonical(candidate.before)),
              root_acknowledged_sha256: yield* sha256(canonical(candidate.acknowledged)),
              root_fresh_sha256: yield* sha256(canonical(current)),
              fields,
            },
          }
        }).pipe(Effect.result)
        if (checked._tag === "Success") {
          const durable = yield* store.readJson(
            receiptKey(receipt.operation_id),
            PublicationReceiptSchema,
          )
          if (!durable || canonical(durable) !== canonical(receipt))
            return yield* Effect.fail(
              adoptionRefusal("The original fenced adoption changed before recording its proof."),
            )
          const corrected = structuredClone(receipt)
          corrected.conflict_history = [
            ...(receipt.conflict_history ?? []),
            {
              observed_at_ms: yield* Clock.currentTimeMillis,
              conflict: true,
              state: receipt.state,
              stages: [...receipt.stages],
              ...(receipt.failure ? { failure: structuredClone(receipt.failure) } : {}),
              guard_paths: Object.keys(receipt.guards),
              intent_count: receipt.intents.length,
              intended_hash: checked.success.progress.plan.intended_hash,
              content_adoption_edit_time_checkpoint: checked.success.checkpoint,
            },
          ]
          corrected.state = "running"
          delete corrected.conflict
          delete corrected.owner
          yield* store.writeJson(receiptKey(receipt.operation_id), corrected)
          return {
            operation_id: receipt.operation_id,
            kind: "publication" as const,
            state: corrected.state,
            outcome: "needs_safe_resume" as const,
            verified: false as const,
            unresolved: false,
            observations: [
              {
                path: candidate.rootPath,
                outcome: "success" as const,
                reason:
                  "The original marker ACK, its exact root revision and complete source proof are unchanged. Its automatic edit-time comparison failure is retained in history.",
              },
            ],
            next: { argv: ["ntn-skills", "operation", "resume", receipt.operation_id] },
          }
        }
        refusal = checked.failure
      }
      return {
        operation_id: receipt.operation_id,
        kind: "publication" as const,
        state: receipt.state,
        outcome: "conflict" as const,
        observations: refusal
          ? [
              {
                path: `v1/pages/${receipt.page_id}`,
                outcome: "conflict" as const,
                reason: refusal.code,
                message: refusal.message,
              },
            ]
          : [],
        verified: false as const,
        unresolved: true,
        next: {
          argv: ["ntn-skills", "read", receipt.page_id ?? receipt.operation_id, "--refresh"],
        },
      }
    }
    const result = yield* proveProgress(receipt).pipe(Effect.result)
    if (result._tag === "Failure") {
      if (result.failure.code === "CONTENT_ADOPTION_REFUSED") {
        receipt.conflict = true
        receipt.state = "failed"
      } else receipt.state = "unknown"
      receipt.failure = {
        code: result.failure.code,
        message: result.failure.message,
        details: result.failure.details,
      }
      delete receipt.owner
      yield* store.writeJson(receiptKey(receipt.operation_id), receipt)
      return {
        operation_id: receipt.operation_id,
        kind: "publication" as const,
        state: receipt.state,
        outcome: receipt.conflict ? ("conflict" as const) : ("unknown" as const),
        observations: [
          {
            path: `v1/pages/${receipt.page_id}`,
            outcome: receipt.conflict ? ("conflict" as const) : ("unknown" as const),
            reason: result.failure.code,
            message: result.failure.message,
          },
        ],
        verified: false as const,
        unresolved: true,
        next: { argv: ["ntn-skills", "operation", "reconcile", receipt.operation_id] },
      }
    }
    const progress = result.success
    settleObserved(receipt, progress)
    if (progress.completed === contentAdoptionCommittedCount(progress.plan))
      completeReceipt(receipt, progress.proof)
    else {
      receipt.state = "running"
      delete receipt.owner
    }
    yield* store.writeJson(receiptKey(receipt.operation_id), receipt)
    return {
      operation_id: receipt.operation_id,
      kind: "publication" as const,
      state: receipt.state,
      outcome:
        progress.completed === contentAdoptionCommittedCount(progress.plan)
          ? ("success" as const)
          : ("needs_safe_resume" as const),
      observations: [
        {
          path: `v1/pages/${receipt.page_id}`,
          outcome: "success" as const,
          reason: progress.proof.source_bytes_verified
            ? "Complete original source bytes and the exact adoption journal are verified."
            : "The exact live body and native adoption journal are verified; source archive installation remains pending.",
        },
      ],
      verified: progress.completed === contentAdoptionCommittedCount(progress.plan),
      unresolved: false,
      next: { argv: ["ntn-skills", "operation", "resume", receipt.operation_id] },
    }
  })
}
function prepareUnsentAdoption(receipt: Receipt) {
  return Effect.gen(function* () {
    const reference = receipt.context?.content_adoption
    if (!reference) return yield* Effect.fail(adoptionRefusal("The adoption context is missing."))
    const { plan, state } = yield* loadContentAdoptionPlan(reference)
    const store = yield* Store,
      integrity = yield* store.integrity.inspect(receipt.operation_id)
    if (integrity?.page_id) return
    if (
      state !== "applying" ||
      !integrity ||
      receipt.intents.length ||
      Object.keys(receipt.guards).length ||
      contentAdoptionJournal(receipt, plan, undefined)?.completed !== 0 ||
      canonical(integrity) !==
        canonical({
          version: 1,
          operation_id: plan.new_operation_id,
          intended_hash: plan.intended_hash,
          marker: {
            version: 2,
            operation_id: plan.new_operation_id,
            intended_hash: plan.intended_hash,
            state: "writing",
          },
        })
    )
      return yield* Effect.fail(
        adoptionRefusal("The exact unsent adoption preparation is unavailable."),
      )
    const original = yield* originalInput(inputFor(plan), plan)
    yield* uniqueExistingPage(original.plan, original.portable, plan.page_id, plan.data_source_id)
    yield* readContentAdoptionProof({
      page_id: plan.page_id,
      database_id: plan.database_id,
      data_source_id: plan.data_source_id,
      scope: plan.scope,
      ...(yield* descriptorBounds(plan, original.portable)),
      old_marker: plan.old_marker,
      marker: plan.old_marker,
      planned_ownership: plan.ownership,
      evidence: plan.evidence,
      ...(plan.source_installation
        ? { source_installation: plan.source_installation, source_installed: false }
        : {}),
    })
    yield* store.integrity.update({
      ...integrity,
      page_id: plan.page_id,
      marker: contentAdoptionWriting(plan),
    })
  })
}
function continueAdoption(receipt: Receipt, options: PublicationOptions) {
  return Effect.gen(function* () {
    const store = yield* Store
    if (!idle(receipt))
      return yield* Effect.fail(
        fail("PUBLICATION_LOCKED", "A live or unverifiable process owns the adoption publication."),
      )
    if (receipt.conflict)
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The adoption publication retains its external-edit fence."),
      )
    yield* prepareUnsentAdoption(receipt)
    const progress = yield* proveProgress(receipt)
    settleObserved(receipt, progress)
    if (progress.completed === contentAdoptionCommittedCount(progress.plan)) {
      const result = completeReceipt(receipt, progress.proof)
      yield* store.writeJson(receiptKey(receipt.operation_id), receipt)
      return result
    }
    if (progress.journal.pending_index !== undefined && !progress.observedApplied) {
      const intent = receipt.intents[progress.journal.pending_index]!
      intent.response = {
        prior_status: intent.status,
        recovery: "known_not_applied",
        replayed_by_intent: receipt.intents.length,
      }
      intent.status = "failed"
    }
    receipt.state = "running"
    receipt.owner = { pid: process.pid, host: hostname() }
    yield* store.writeJson(receiptKey(receipt.operation_id), receipt)
    const session = yield* publicationSession(receipt, { ...options, modeOnly: true })
    return yield* session.finish(
      session.run(
        "verify",
        Effect.gen(function* () {
          if (!receipt.intents.length)
            yield* readContentAdoptionProof({
              page_id: progress.plan.page_id,
              database_id: progress.plan.database_id,
              data_source_id: progress.plan.data_source_id,
              scope: progress.plan.scope,
              ...(yield* descriptorBounds(progress.plan, progress.native.portable)),
              old_marker: progress.plan.old_marker,
              marker: progress.plan.old_marker,
              planned_ownership: progress.plan.ownership,
              evidence: progress.plan.evidence,
              ...(progress.plan.source_installation
                ? {
                    source_installation: progress.plan.source_installation,
                    source_installed: false,
                  }
                : {}),
            }).pipe(Effect.provideService(Notion, session.notion))
          if (progress.completed === 0)
            yield* session.notion.request(
              `v1/pages/${progress.plan.page_id}`,
              contentAdoptionHandoffBody(progress.plan),
              { method: "PATCH" },
            )
          let current = yield* proveProgress(receipt, session.notion)
          if (
            current.plan.source_installation &&
            !contentAdoptionSourceInstalled(current.plan, current.completed)
          ) {
            const bytes = yield* loadContentAdoptionSourceInstallation(
              current.plan,
              current.native.portable,
            )
            const uploaded = yield* session.run(
              "source_bundle",
              session.upload({ bytes }, current.plan.source_installation.filename),
            )
            yield* session.run(
              "source_attachment",
              session.notion.request(
                `v1/pages/${current.plan.page_id}`,
                contentAdoptionSourceAttachmentBody(
                  current.plan.source_installation,
                  uploaded.file_upload.id,
                ),
                { method: "PATCH" },
              ),
            )
            current = yield* proveProgress(receipt, session.notion)
          }
          if (!current.proof.source_bytes_verified)
            return yield* Effect.fail(
              adoptionRefusal("Ownership cannot follow an unverified source installation."),
            )
          return {
            ...snapshotInfo(current.proof.snapshot),
            action: "adopt",
            reused: true,
            verified: true,
            content_writes: current.plan.source_installation ? 1 : 0,
          }
        }),
      ),
    )
  })
}
export function resumeContentAdoption(operationId: string, options: PublicationOptions = {}) {
  return Effect.gen(function* () {
    yield* rejectPublicationSourceOverride(options)
    const store = yield* Store
    const receipt = yield* store.readJson(receiptKey(operationId), PublicationReceiptSchema)
    if (!receipt?.context?.content_adoption)
      return yield* Effect.fail(
        adoptionRefusal("No persisted content adoption publication exists."),
      )
    const { plan } = yield* loadContentAdoptionPlan(receipt.context.content_adoption)
    return yield* withLocalLocks(
      store.root,
      lockKeys(plan),
      Effect.gen(function* () {
        const current = yield* store.readJson(receiptKey(operationId), PublicationReceiptSchema)
        if (!current || canonical(current) !== canonical(receipt))
          return yield* Effect.fail(
            adoptionRefusal("The publication changed before its recovery lock."),
          )
        const result = yield* continueAdoption(current, options)
        return { ...result, adoption: yield* linkCompletedAdoption(plan) }
      }),
    )
  })
}
export function applyContentAdoption(
  planId: string,
  planHash: string,
  options: PublicationOptions = {},
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const initial = yield* loadContentAdoptionPlan({ plan_id: planId, plan_hash: planHash })
    const plan = initial.plan
    return yield* withLocalLocks(
      store.root,
      lockKeys(plan),
      Effect.gen(function* () {
        let attempt = yield* loadContentAdoptionPlan({ plan_id: planId, plan_hash: planHash })
        let receipt = yield* store.readJson(
          receiptKey(plan.new_operation_id),
          PublicationReceiptSchema,
        )
        if (attempt.state === "planned") {
          if (receipt)
            return yield* Effect.fail(
              adoptionRefusal("An unclaimed adoption already has a receipt."),
            )
          const original = yield* originalInput(inputFor(plan), plan)
          yield* uniqueExistingPage(
            original.plan,
            original.portable,
            plan.page_id,
            plan.data_source_id,
          )
          yield* readContentAdoptionProof({
            page_id: plan.page_id,
            database_id: plan.database_id,
            data_source_id: plan.data_source_id,
            scope: plan.scope,
            ...(yield* descriptorBounds(plan, original.portable)),
            old_marker: plan.old_marker,
            marker: plan.old_marker,
            planned_ownership: plan.ownership,
            evidence: plan.evidence,
            ...(plan.source_installation
              ? { source_installation: plan.source_installation, source_installed: false }
              : {}),
          })
          const claimed = { plan, state: "applying" as const }
          yield* store.upstream.claimCommand(contentAdoptionPlanKey(planId), attempt, claimed)
          attempt = claimed
        }
        if (!receipt) {
          if (attempt.state !== "applying")
            return yield* Effect.fail(adoptionRefusal("The committed adoption lost its receipt."))
          const original = yield* originalInput(inputFor(plan), plan)
          yield* uniqueExistingPage(
            original.plan,
            original.portable,
            plan.page_id,
            plan.data_source_id,
          )
          const session = yield* beginPublication(
            original.portable,
            "replace",
            {
              ...options,
              operationId: plan.new_operation_id,
              ownership: plan.ownership,
              source: { type: "upstream" },
              modeOnly: true,
            },
            { content_adoption: { plan_id: plan.plan_id, plan_hash: plan.plan_hash } },
          )
          yield* session.bind(
            {
              database_id: plan.database_id,
              data_source_id: plan.data_source_id,
              page_id: plan.page_id,
            },
            plan.scope,
          )
          const integrity = yield* store.integrity.inspect(plan.new_operation_id)
          if (!integrity)
            return yield* Effect.fail(adoptionRefusal("The new integrity record is missing."))
          yield* store.integrity.update({
            ...integrity,
            page_id: plan.page_id,
            marker: contentAdoptionWriting(plan),
          })
          receipt = yield* store.readJson(
            receiptKey(plan.new_operation_id),
            PublicationReceiptSchema,
          )
          if (!receipt)
            return yield* Effect.fail(adoptionRefusal("The bound adoption receipt is missing."))
          delete receipt.owner
          yield* store.writeJson(receiptKey(plan.new_operation_id), receipt)
        }
        yield* continueAdoption(receipt, options)
        return yield* linkCompletedAdoption(plan)
      }),
    )
  })
}
function linkCompletedAdoption(plan: ContentAdoptionPlan) {
  return Effect.gen(function* () {
    const store = yield* Store
    let attempt = yield* loadContentAdoptionPlan({
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
    })
    const complete = yield* store.readJson(
      receiptKey(plan.new_operation_id),
      PublicationReceiptSchema,
    )
    if (!complete || complete.state !== "completed")
      return yield* Effect.fail(adoptionRefusal("The new adoption publication has not completed."))
    const final = yield* proveProgress(complete)
    if (
      final.completed !== contentAdoptionCommittedCount(plan) ||
      final.integrity.marker.state !== "committed"
    )
      return yield* Effect.fail(adoptionRefusal("The final adoption is not committed."))
    if (attempt.state === "applying") {
      const next = { plan, state: "publication_committed" as const }
      yield* store.upstream.claimCommand(contentAdoptionPlanKey(plan.plan_id), attempt, next)
      attempt = next
    }
    const current = yield* originalInput(inputFor(plan), plan)
    if (!current.linked)
      yield* store.upstream.replacePublicationPointer(
        current.operation,
        plan.item_index,
        undefined,
        plan.new_operation_id,
        plan.page_id,
      )
    if (attempt.state !== "linked")
      yield* store.upstream.claimCommand(contentAdoptionPlanKey(plan.plan_id), attempt, {
        plan,
        state: "linked",
      })
    return {
      ...adoptionSummary(plan, "linked"),
      verified: true,
      next: {
        argv: [
          "ntn-skills",
          "sync",
          "upstream",
          "apply",
          plan.original_plan.plan_id,
          "--member",
          plan.original_plan.items[plan.item_index]!.member_key,
        ],
      },
    }
  })
}
