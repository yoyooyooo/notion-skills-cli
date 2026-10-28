import { Effect, FileSystem, Path } from "effect"
import { authScope } from "./catalog.ts"
import { portableIdentity } from "./export.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { canonical } from "./publication-effect-proof.ts"
import { publicationMarker } from "./publication-integrity.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { metadata } from "./publication-observation.ts"
import { sha256, Store } from "./store.ts"
import {
  publicationMemberKey,
  subscriptionConfigHash,
  targetKey,
  thawPortable,
} from "./upstream-content.ts"
import {
  strictDecode,
  UpstreamOperationSchema,
  UpstreamPublisher,
  type PublishedMembers,
  type UpstreamOperation,
  type UpstreamPlan,
} from "./upstream-model.ts"
import type { MapCheckpointAdoptionCommit } from "./upstream-state.ts"
import {
  decodePublishedMembers,
  decodeSubscription,
  getSubscription,
} from "./upstream-subscription.ts"
import {
  AdoptedMapCheckpointSchema,
  MapCheckpointAdoptionInputSchema,
  MapCheckpointAdoptionPlanSchema,
  MapCheckpointAdoptionReceiptSchema,
  MapCheckpointCaptureCommandSchema,
  MapCheckpointCaptureSchema,
  MapCheckpointNativeInputsSchema,
  mapCheckpointAdoptionPlanKey,
  mapCheckpointAdoptionReceiptKey,
  mapCheckpointAdoptionReceipt,
  type MapCheckpointAdoptionInput,
  type MapCheckpointAdoptionPlan,
} from "./upstream-map-checkpoint-adoption-model.ts"
import type { PortableSkill } from "./portable.ts"

type Capture = typeof MapCheckpointCaptureSchema.Type
type NativeInputs = typeof MapCheckpointNativeInputsSchema.Type
type NativeProof = {
  inputs: NativeInputs
  publications: MapCheckpointAdoptionCommit["publications"]
  baseline: PublishedMembers
}
const refusal = (message: string) => fail("UPSTREAM_MAP_ADOPTION_REFUSED", message)
const attempt = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : refusal("Map adoption evidence is invalid."),
  })
const digest = (value: unknown) => sha256(canonical(value))

function captureSuccess(input: MapCheckpointAdoptionInput) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const strings: Record<string, string> = {}
    const hashes: Record<string, string> = {}
    for (const [name, file] of Object.entries(input.success_capture)) {
      if (!path.isAbsolute(file) || path.normalize(file) !== file)
        return yield* Effect.fail(refusal("Capture files require exact normalized absolute paths."))
      const bytes = yield* fs
        .readFile(file)
        .pipe(Effect.mapError(() => refusal(`Could not read the ${name} capture.`)))
      if (!bytes.length || bytes.length > 1024 * 1024)
        return yield* Effect.fail(
          refusal("Each original capture must be nonempty and at most 1 MiB."),
        )
      strings[name] = yield* attempt(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      hashes[name] = yield* sha256(bytes)
    }
    const command = yield* attempt(() =>
      strictDecode(MapCheckpointCaptureCommandSchema, JSON.parse(strings.command!)),
    )
    const raw = yield* attempt(() => property(JSON.parse(strings.stdout!)))
    const { ok, ...body } = raw
    const historical = yield* attempt(() => strictDecode(UpstreamOperationSchema, body))
    const finished = strings.finished_at!.trim()
    const startedMs = Date.parse(command.started_at),
      finishedMs = Date.parse(finished)
    if (
      ok !== true ||
      strings.exit_code!.trim() !== "0" ||
      !Number.isFinite(startedMs) ||
      !Number.isFinite(finishedMs) ||
      finishedMs < startedMs
    )
      return yield* Effect.fail(
        refusal("The original capture must be a successful, bounded CLI run."),
      )
    const argv = command.argv
    const executable = (value: string | undefined, name: string) =>
      !!value && path.basename(value) === name
    const prefix =
      executable(argv[0], "node") && executable(argv[1], "ntn-skills.js")
        ? 2
        : executable(argv[0], "ntn-skills")
          ? 1
          : -1
    const tail = prefix < 0 ? [] : argv.slice(prefix)
    if (
      tail.length !== 6 ||
      tail[0] !== "sync" ||
      tail[1] !== "upstream" ||
      tail[2] !== "apply" ||
      tail[3] !== input.original_plan_id ||
      tail[4] !== "--member" ||
      !tail[5] ||
      historical.items.find((item) => item.member_key === tail[5])?.status !== "verified"
    )
      return yield* Effect.fail(
        refusal("The capture must be the exact original selected-member apply command."),
      )
    return yield* attempt(() =>
      strictDecode(MapCheckpointCaptureSchema, {
        input,
        sha256: hashes,
        command,
        finished_at: finished,
        historical_operation: historical,
        selected_member: tail[5],
      }),
    )
  })
}

function validOperationIdentity(plan: UpstreamPlan, operation: UpstreamOperation, id: string) {
  return (
    operation.operation_id === id &&
    operation.plan_id === plan.plan_id &&
    operation.subscription_id === plan.subscription_id &&
    operation.scope === plan.scope &&
    operation.database_id === plan.database_id &&
    operation.target_database_id === plan.target_database_id &&
    operation.items.length === plan.items.length &&
    operation.items.every((item, index) => item.member_key === plan.items[index]?.member_key) &&
    (operation.projections === undefined ||
      (operation.projections.operation_id === `${id}:projections` &&
        operation.projections.entries.length === 0))
  )
}
function verifiedMap(plan: UpstreamPlan, operation: UpstreamOperation): PublishedMembers {
  return {
    version: 1,
    revision: plan.revision,
    plan_hash: plan.plan_hash,
    publisher_subscription_id: plan.publisher_subscription_id,
    source_manifest: plan.source_manifest!,
    members: operation.items.flatMap((item, index) => {
      if (item.status !== "verified") return []
      if (!item.page_id || !item.publication_operation_id || !plan.items[index]?.content_hash)
        throw refusal("A verified outcome has no exact page, publication or content identity.")
      return [
        {
          member_key: item.member_key,
          page_id: item.page_id,
          content_hash: plan.items[index]!.content_hash!,
          revision: plan.revision,
        },
      ]
    }),
  }
}

function readNative(planId: string, capture: Capture) {
  return Effect.gen(function* () {
    const store = yield* Store
    const plan = yield* store.upstream.plan(planId)
    const operation = yield* store.upstream.operation(planId)
    if (!plan || !operation || !plan.scope || !plan.database_id || plan.plan_id !== planId)
      return yield* Effect.fail(
        refusal("The exact original bound plan and operation are required."),
      )
    const { plan_id: _id, plan_hash: _hash, ...body } = plan
    const operationId = `uo_${yield* sha256(plan.plan_id)}`
    if (
      plan.plan_id !== `up_${plan.plan_hash}` ||
      (yield* sha256(JSON.stringify(body))) !== plan.plan_hash ||
      plan.publisher_subscription_id !== plan.subscription_id ||
      !plan.source_manifest ||
      plan.source_manifest.source_id !== plan.subscription_id ||
      plan.source_manifest.revision !== plan.revision ||
      !plan.items.length ||
      new Set(plan.items.map((item) => item.member_key)).size !== plan.items.length ||
      new Set(plan.items.map((item) => item.target_key)).size !== plan.items.length ||
      plan.items.some(
        (item) =>
          item.action !== "create" ||
          item.generation !== 0 ||
          item.page_id !== undefined ||
          item.expected_version !== undefined ||
          item.expected_hash !== undefined ||
          !item.candidate ||
          !item.accepted ||
          item.candidate.kind !== "skill" ||
          !item.content_hash ||
          canonical(item.candidate) !== canonical(item.accepted),
      ) ||
      !validOperationIdentity(plan, operation, operationId) ||
      operation.state === "verified" ||
      !validOperationIdentity(plan, capture.historical_operation, operationId) ||
      capture.historical_operation.state === "verified"
    )
      return yield* Effect.fail(
        refusal(
          "Only an original partial all-create plan with its full ordered outcomes is supported.",
        ),
      )
    const historical = capture.historical_operation
    for (let index = 0; index < historical.items.length; index++) {
      const item = historical.items[index]!
      if (
        ["retained", "fork", "conflict"].includes(item.status) ||
        ["retained", "fork", "conflict"].includes(operation.items[index]!.status) ||
        (item.status === "verified" && canonical(item) !== canonical(operation.items[index]))
      )
        return yield* Effect.fail(
          refusal("A historical verified outcome or original create identity changed."),
        )
    }
    const baseline = yield* attempt(() => verifiedMap(plan, historical))
    if (!baseline.members.length || baseline.members.length >= plan.items.length)
      return yield* Effect.fail(refusal("A complete historical partial map is required."))
    const mapKey = `${plan.plan_id}:subscription-map`
    const saved = yield* store.upstream.command(mapKey)
    const rawIntended = yield* store.upstream.command(`${mapKey}:intended`)
    const accepted = yield* store.upstream.command(`${plan.plan_id}:accepted-config`)
    const checkpoint = yield* store.upstream.command(`${mapKey}:checkpoint`)
    const projection = yield* store.upstream.command(`${operationId}:projections`)
    if (
      canonical(saved) !== canonical({ unpublished: true }) ||
      accepted !== undefined ||
      checkpoint !== undefined ||
      (projection !== undefined &&
        canonical(projection) !==
          canonical({ operation_id: `${operationId}:projections`, entries: [] }))
    )
      return yield* Effect.fail(
        refusal(
          "The original unpublished map, empty projections and absent checkpoint must be unchanged.",
        ),
      )
    const intended = yield* attempt(() => decodePublishedMembers(JSON.stringify(rawIntended)))
    const currentMap = yield* attempt(() => verifiedMap(plan, operation))
    if (
      !intended ||
      canonical(intended) !== canonical(currentMap) ||
      intended.members.length <= baseline.members.length
    )
      return yield* Effect.fail(
        refusal(
          "The retained pending map must be the complete later verified-member map of this original plan.",
        ),
      )
    const bindings = yield* store.upstream.bindings(plan.subscription_id)
    if (bindings.length !== currentMap.members.length)
      return yield* Effect.fail(refusal("The complete current native binding set changed."))
    for (const binding of bindings) {
      const index = plan.items.findIndex((item) => item.member_key === binding.member_key)
      const item = plan.items[index],
        outcome = operation.items[index]
      if (
        !item ||
        outcome?.status !== "verified" ||
        canonical(binding) !==
          canonical({
            subscription_id: plan.subscription_id,
            member_key: item.member_key,
            target_key: item.target_key,
            page_id: outcome.page_id,
            generation: 1,
            mode: "tracked",
            active: true,
            revision: plan.revision,
            published_hash: item.content_hash,
            accepted: item.accepted,
            materialized: item.candidate,
          })
      )
        return yield* Effect.fail(
          refusal("A native binding no longer matches its original verified create."),
        )
    }
    const targets: MapCheckpointAdoptionCommit["targets"][number][] = []
    for (const item of plan.items) {
      const claim = (yield* store.upstream.target(item.target_key)) ?? null
      const binding = bindings.find((value) => value.member_key === item.member_key)
      if (
        canonical(claim) !==
        canonical(
          binding
            ? {
                page_id: binding.page_id,
                publisher_subscription_id: plan.publisher_subscription_id,
              }
            : null,
        )
      )
        return yield* Effect.fail(refusal("An original target acquired another native claim."))
      targets.push({ target_key: item.target_key, claim })
    }
    const publications: MapCheckpointAdoptionCommit["publications"][number][] = []
    const publicationHashes: NativeInputs["publications"][number][] = []
    for (let index = 0; index < historical.items.length; index++) {
      const item = historical.items[index]!
      if (item.status !== "verified") continue
      const id = `p_${yield* sha256(`${operationId}:${index}`)}`
      const receipt = yield* store.readJson(`publications/${id}.json`, PublicationReceiptSchema)
      const integrity = yield* store.integrity.inspect(id)
      const frozen = plan.items[index]!.candidate!
      if (
        item.publication_operation_id !== id ||
        !receipt ||
        !integrity ||
        receipt.operation_id !== id ||
        receipt.operation !== "create" ||
        receipt.state !== "completed" ||
        receipt.result?.verified !== true ||
        receipt.result.operation_id !== id ||
        receipt.page_id !== item.page_id ||
        receipt.scope !== plan.scope ||
        receipt.database_id !== plan.target_database_id ||
        !receipt.data_source_id ||
        integrity.operation_id !== id ||
        integrity.page_id !== item.page_id ||
        integrity.marker.operation_id !== id ||
        integrity.marker.state !== "committed" ||
        integrity.marker.intended_hash !== integrity.intended_hash ||
        canonical(receipt.portable) !==
          canonical({
            ...frozen,
            files: frozen.files.map((file) => ({ path: file.path, sha256: file.hash })),
          })
      )
        return yield* Effect.fail(
          refusal(
            "A historical member lacks its exact completed original publication and committed integrity proof.",
          ),
        )
      publications.push({ operation_id: id, receipt, integrity })
      publicationHashes.push({
        operation_id: id,
        receipt_sha256: yield* digest(receipt),
        integrity_sha256: yield* digest(integrity),
      })
    }
    const inputs = yield* attempt(() =>
      strictDecode(MapCheckpointNativeInputsSchema, {
        original_plan: plan,
        original_operation: operation,
        bindings,
        targets,
        commands: {
          saved,
          intended,
          accepted_config: null,
          checkpoint: null,
          projection: projection ?? null,
        },
        publications: publicationHashes,
      }),
    )
    return { inputs, publications, baseline }
  })
}

function sourceFingerprint(portable: PortableSkill) {
  return Effect.gen(function* () {
    const files: Array<readonly [string, number, string]> = []
    let total = 0
    for (const file of [...portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      const value = yield* attempt(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
      )
      total += file.bytes.length
      if (value.includes("\0") || file.bytes.length > 1024 * 1024 || total > 5 * 1024 * 1024)
        return yield* Effect.fail(
          refusal("The entire original skill must remain within the pure-text source limits."),
        )
      files.push([file.path, file.bytes.length, yield* sha256(file.bytes)])
    }
    return yield* digest([portable.kind, portable.name, portable.description, portable.main, files])
  })
}
function subscriptionSnapshot(plan: UpstreamPlan) {
  return Effect.gen(function* () {
    const first = yield* getSubscription(plan.subscription_id, plan.database_id)
    const raw = yield* (yield* Notion).request(`v1/pages/${plan.subscription_id}`)
    const second = yield* decodeSubscription(raw, first.database_id, first.data_source_id)
    const edited = property(raw).last_edited_time
    if (
      canonical(first) !== canonical(second) ||
      typeof edited !== "string" ||
      !Number.isFinite(Date.parse(edited))
    )
      return yield* Effect.fail(refusal("Subscription metadata changed during its exact read."))
    return { subscription: second, last_edited_time: edited }
  })
}
function readRemote(native: NativeProof, capture: Capture) {
  return Effect.gen(function* () {
    const plan = native.inputs.original_plan
    const snapshot = yield* subscriptionSnapshot(plan)
    const subscription = snapshot.subscription
    const editedMs = Date.parse(snapshot.last_edited_time)
    if (
      !subscription.enabled ||
      subscription.removed ||
      subscription.status !== "partial" ||
      subscription.source.shared_target_set !== undefined ||
      (subscription.source.publisher_subscription_id ?? subscription.subscription_id) !==
        plan.subscription_id ||
      subscription.target_database_id !== plan.target_database_id ||
      (yield* subscriptionConfigHash(subscription)) !== plan.config_hash ||
      canonical(subscription.published) !== canonical(native.baseline) ||
      editedMs < Date.parse(capture.command.started_at) ||
      editedMs > Date.parse(capture.finished_at)
    )
      return yield* Effect.fail(
        refusal(
          "The entire current map and subscription must match the captured successful partial publication.",
        ),
      )
    const api = yield* Notion,
      publisher = yield* UpstreamPublisher
    const members: MapCheckpointAdoptionPlan["remote_evidence"]["members"][number][] = []
    for (const member of native.baseline.members) {
      const item = plan.items.find((item) => item.member_key === member.member_key)!
      const proof = native.publications.find((proof) => proof.receipt.page_id === member.page_id)!
      const ownership = {
        subscription_id: plan.subscription_id,
        member_key: publicationMemberKey(subscription, item.member_key),
        mode: "tracked" as const,
        published_hash: item.content_hash!,
        revision: plan.revision,
      }
      if (
        targetKey(subscription, item.member_key) !== item.target_key ||
        canonical(proof.receipt.context?.ownership) !== canonical(ownership)
      )
        return yield* Effect.fail(
          refusal("The original publication ownership or target derivation changed."),
        )
      const frozen = yield* thawPortable(item.candidate!)
      if (
        (yield* portableIdentity(frozen)) !== item.content_hash ||
        (yield* sourceFingerprint(frozen)) !== proof.integrity.intended_hash
      )
        return yield* Effect.fail(
          refusal("The committed publication does not prove the complete original frozen source."),
        )
      const path = `v1/pages/${member.page_id}`
      const before = yield* api.request(path)
      const marker = yield* attempt(() => publicationMarker(before))
      const raw = property(before)
      if (
        raw.id !== member.page_id ||
        raw.archived === true ||
        raw.in_trash === true ||
        property(raw.parent).data_source_id !== proof.receipt.data_source_id ||
        marker?.state !== "committed" ||
        canonical(marker) !== canonical(proof.integrity.marker)
      )
        return yield* Effect.fail(
          refusal("The current page no longer carries its original committed publication marker."),
        )
      const inspected = yield* publisher.inspect(member.page_id)
      const after = yield* api.request(path)
      if (
        canonical(metadata(before)) !== canonical(metadata(after)) ||
        inspected.page_id !== member.page_id ||
        inspected.content_hash !== member.content_hash ||
        (yield* portableIdentity(inspected.portable)) !== member.content_hash ||
        canonical(inspected.ownership) !== canonical(ownership)
      )
        return yield* Effect.fail(
          refusal("Current member bytes, ownership or page metadata changed during proof."),
        )
      members.push({
        member_key: member.member_key,
        page_id: member.page_id,
        publication_operation_id: proof.operation_id,
        version: inspected.version,
        content_hash: inspected.content_hash,
        ownership,
        marker,
        metadata_sha256: yield* digest(metadata(after)),
        observed_portable_sha256: yield* sourceFingerprint(inspected.portable),
      })
    }
    // Reading later members can expose a long window for an earlier page to change.
    // Revisit the complete set before closing the subscription observation bracket.
    for (const member of members) {
      const current = yield* api.request(`v1/pages/${member.page_id}`)
      if (
        (yield* digest(metadata(current))) !== member.metadata_sha256 ||
        canonical(yield* attempt(() => publicationMarker(current))) !== canonical(member.marker)
      )
        return yield* Effect.fail(
          refusal("A member changed while the remaining baseline members were inspected."),
        )
    }
    const last = yield* subscriptionSnapshot(plan)
    if (canonical(last) !== canonical(snapshot))
      return yield* Effect.fail(
        refusal("The subscription changed while its complete member proof was read."),
      )
    return { ...snapshot, members }
  })
}
function originalLockKeys(plan: UpstreamPlan) {
  return Effect.gen(function* () {
    const id = `uo_${yield* sha256(plan.plan_id)}`
    const keys = [
      `upstream-plan:${plan.plan_id}`,
      `upstream-subscription:${plan.subscription_id}`,
      ...plan.items.map((item) => `upstream-target:${item.target_key}`),
    ]
    for (let index = 0; index < plan.items.length; index++)
      keys.push(`publication:p_${yield* sha256(`${id}:${index}`)}`)
    return keys
  })
}
function summary(plan: MapCheckpointAdoptionPlan) {
  return {
    kind: plan.domain,
    authority: plan.authority,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    original_plan_id: plan.native_inputs.original_plan.plan_id,
    original_operation_id: plan.native_inputs.original_operation.operation_id,
    subscription_id: plan.checkpoint.subscription_id,
    expected_version: plan.checkpoint.version,
    member_count: plan.checkpoint.published.members.length,
    native_inputs_sha256: plan.native_inputs_sha256,
    evidence_sha256: plan.evidence_sha256,
    notion_writes: 0,
    original_history_changed: false,
    plan,
  }
}
export function planMapCheckpointAdoption(input: MapCheckpointAdoptionInput) {
  return Effect.gen(function* () {
    yield* attempt(() => strictDecode(MapCheckpointAdoptionInputSchema, input))
    const store = yield* Store
    const original = yield* store.upstream.plan(input.original_plan_id)
    if (!original) return yield* Effect.fail(refusal("The exact original plan does not exist."))
    return yield* withLocalLocks(
      store.root,
      yield* originalLockKeys(original),
      Effect.gen(function* () {
        const capture = yield* captureSuccess(input)
        const native = yield* readNative(input.original_plan_id, capture)
        const scope = yield* authScope
        if (scope !== native.inputs.original_plan.scope)
          return yield* Effect.fail(refusal("The original authentication scope changed."))
        const remote = yield* readRemote(native, capture)
        const repeated = yield* readNative(input.original_plan_id, capture)
        if (
          canonical(repeated.inputs) !== canonical(native.inputs) ||
          canonical(yield* captureSuccess(input)) !== canonical(capture)
        )
          return yield* Effect.fail(
            refusal("The original native inputs or capture files changed during planning."),
          )
        const body = {
          format: 1 as const,
          domain: "upstream_map_checkpoint_adoption" as const,
          authority: "adopt_observed_complete_baseline" as const,
          scope,
          capture,
          native_inputs: native.inputs,
          native_inputs_sha256: yield* digest(native.inputs),
          remote_evidence: remote,
          evidence_sha256: yield* digest({ capture, remote }),
          checkpoint: {
            subscription_id: remote.subscription.subscription_id,
            version: remote.subscription.version,
            published: native.baseline,
          },
        }
        const hash = yield* digest(body)
        const plan = yield* attempt(() =>
          strictDecode(MapCheckpointAdoptionPlanSchema, {
            ...body,
            plan_id: `mca_${hash}`,
            plan_hash: hash,
          }),
        )
        const key = mapCheckpointAdoptionPlanKey(plan.plan_id)
        const existing = yield* store.upstream.command(key)
        if (existing !== undefined && canonical(existing) !== canonical(plan))
          return yield* Effect.fail(
            refusal("The immutable adoption plan identity is already occupied."),
          )
        if (existing === undefined) yield* store.upstream.saveCommand(key, plan)
        return summary(plan)
      }),
    )
  })
}

export function applyMapCheckpointAdoption(planId: string, planHash: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const storedPlan = yield* store.upstream.command(mapCheckpointAdoptionPlanKey(planId))
    const plan = yield* attempt(() => strictDecode(MapCheckpointAdoptionPlanSchema, storedPlan))
    const { plan_id: _id, plan_hash: _hash, ...body } = plan
    if (
      plan.plan_id !== planId ||
      plan.plan_hash !== planHash ||
      planId !== `mca_${planHash}` ||
      (yield* digest(body)) !== planHash ||
      (yield* authScope) !== plan.scope ||
      (yield* digest(plan.native_inputs)) !== plan.native_inputs_sha256 ||
      (yield* digest({ capture: plan.capture, remote: plan.remote_evidence })) !==
        plan.evidence_sha256
    )
      return yield* Effect.fail(
        refusal("The exact reviewed adoption plan or authentication scope changed."),
      )
    const locks = yield* originalLockKeys(plan.native_inputs.original_plan)
    return yield* withLocalLocks(
      store.root,
      [...locks, `map-checkpoint-adoption:${planId}`],
      Effect.gen(function* () {
        const receipt = yield* attempt(() => mapCheckpointAdoptionReceipt(plan))
        const saved = yield* store.upstream.command(mapCheckpointAdoptionReceiptKey(planId))
        if (saved !== undefined) {
          if (
            canonical(
              yield* attempt(() => strictDecode(MapCheckpointAdoptionReceiptSchema, saved)),
            ) !== canonical(receipt)
          )
            return yield* Effect.fail(
              refusal("The retained recovery receipt differs from this exact reviewed plan."),
            )
          const rawCheckpoint = yield* store.upstream.command(
            `${plan.native_inputs.original_plan.plan_id}:subscription-map:checkpoint`,
          )
          const checkpoint = yield* attempt(() =>
            strictDecode(AdoptedMapCheckpointSchema, rawCheckpoint),
          )
          if (!checkpoint.version || checkpoint.subscription_id !== plan.checkpoint.subscription_id)
            return yield* Effect.fail(
              refusal(
                "The adopted checkpoint is missing, corrupt or belongs to another subscription.",
              ),
            )
          return { receipt, reused: true }
        }
        const capture = yield* captureSuccess(plan.capture.input)
        if (canonical(capture) !== canonical(plan.capture))
          return yield* Effect.fail(refusal("An original capture file changed after planning."))
        const native = yield* readNative(plan.native_inputs.original_plan.plan_id, capture)
        if (canonical(native.inputs) !== canonical(plan.native_inputs))
          return yield* Effect.fail(refusal("Original native inputs changed after planning."))
        const remote = yield* readRemote(native, capture)
        if (canonical(remote) !== canonical(plan.remote_evidence))
          return yield* Effect.fail(
            refusal("A frozen subscription or member version, byte or ownership proof changed."),
          )
        const expectedCheckpoint = {
          subscription_id: remote.subscription.subscription_id,
          version: remote.subscription.version,
          published: native.baseline,
        }
        if (canonical(expectedCheckpoint) !== canonical(plan.checkpoint))
          return yield* Effect.fail(
            refusal(
              "The reviewed checkpoint differs from the complete baseline proved by this apply.",
            ),
          )
        if (canonical(yield* captureSuccess(capture.input)) !== canonical(capture))
          return yield* Effect.fail(
            refusal("An original capture file changed during verification."),
          )
        const finalSubscription = yield* subscriptionSnapshot(native.inputs.original_plan)
        if (
          canonical(finalSubscription) !==
          canonical({
            subscription: remote.subscription,
            last_edited_time: remote.last_edited_time,
          })
        )
          return yield* Effect.fail(
            refusal("The exact subscription baseline changed before native commitment."),
          )
        const result = yield* store.upstream.commitMapCheckpointAdoption({
          adoption_id: planId,
          adoption_plan: plan,
          receipt,
          original_plan: native.inputs.original_plan,
          original_operation: native.inputs.original_operation,
          bindings: native.inputs.bindings,
          targets: native.inputs.targets,
          commands: native.inputs.commands,
          publications: native.publications,
          checkpoint: plan.checkpoint,
        })
        return { receipt, reused: result.reused }
      }),
    )
  })
}
