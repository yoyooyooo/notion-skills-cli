import { Clock, Effect, Schema } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { Store, sha256 } from "./store.ts"
import { PublicationReceiptSchema, type Receipt } from "./publication-model.ts"
import {
  creationMarkerProof,
  creationProofFromBody,
  creationProofMatchesIntent,
} from "./publication-create-identity.ts"
import {
  canonical,
  publicationGuardRoles,
  publicationJournalSettled,
  publicationMarkerAuthority,
} from "./publication-effect-proof.ts"
import { publicationMarker } from "./publication-integrity.ts"
import { observation, publicationMarkdownMatches } from "./publication-observation.ts"
import { projectNotionBlockTree } from "./markdown.ts"
import {
  bodyCompletionAckMatches,
  bodyCompletionStageMatches,
  bodyCompletionTransition,
  bodyCompletionTree,
  comparableBodyCompletionSnapshot,
  deriveBodyCompletion,
  stableBodyCompletionSnapshot,
  type BodyCompletionDerivation,
  type BodyCompletionSnapshot,
} from "./publication-body-completion-proof.ts"
import {
  BodyCompletionJournalSchema,
  BodyCompletionPlanSchema,
  bodyCompletionPlanKey,
  type BodyCompletionAttempt,
  type BodyCompletionJournal,
  type BodyCompletionPlan,
} from "./publication-body-completion-model.ts"

const key = (id: string) => `publications/${id}.json`
const refusal = (message: string, details?: unknown) =>
  fail("PUBLICATION_BODY_COMPLETION_REFUSED", message, details)
const attempt = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError ? error : refusal("Invalid body-completion evidence."),
  })
const strict = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  attempt(() => Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" }))
const digest = (value: unknown) => sha256(canonical(value))
const snapshotDigest = (value: BodyCompletionSnapshot) =>
  digest(comparableBodyCompletionSnapshot(value))
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right)
const copy = <A>(value: A): A => structuredClone(value)
const failure = (error: SkillsError) => ({
  code: error.code,
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details }),
})
const sourceFile = /^[^\\\x00]+$/
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
const readable = new RegExp(
  `^v1/(?:pages/${uuid}(?:/markdown|/properties/[^\\s/?]+(?:\\?[^\\s#]+)?)?|blocks/${uuid}(?:/children\\?page_size=100(?:&start_cursor=[^\\s#]+)?)?)$`,
)
const pagePath = new RegExp(`^v1/pages/${uuid}$`)
const childPath = (id: string) => `v1/blocks/${id}/children?page_size=100`

/** This path retains an original, settled create publication. It does not
 * manufacture publication authority from a current page or from the plan. */
function authority(original: Receipt, historical = false) {
  return Effect.gen(function* () {
    const store = yield* Store
    if (
      original.operation !== "create" ||
      original.portable.kind !== "skill" ||
      original.state !== "failed" ||
      original.conflict !== true ||
      original.owner ||
      original.body_completion ||
      !original.scope ||
      !original.database_id ||
      !original.data_source_id ||
      !original.page_id ||
      original.result ||
      original.context?.content_adoption ||
      original.context?.members?.length ||
      original.portable.files.length < 2 ||
      original.portable.files.length > 100 ||
      !publicationJournalSettled(original) ||
      original.intents.some((item) => item.status === "pending" || item.status === "unknown")
    )
      return yield* Effect.fail(
        refusal("Only a fenced, settled original skill create may complete its acknowledged body."),
      )
    if ((yield* authScope) !== original.scope)
      return yield* Effect.fail(
        refusal("The authentication scope differs from the original publication."),
      )
    const source = yield* explicitSource(original.database_id)
    if (!source.data_source_ids.includes(original.data_source_id))
      return yield* Effect.fail(
        refusal("The original data source no longer belongs to its database."),
      )
    const integrity = yield* store.integrity.inspect(original.operation_id)
    if (
      !integrity ||
      integrity.operation_id !== original.operation_id ||
      (!historical && integrity.marker.state !== "writing") ||
      (integrity.page_id !== undefined && integrity.page_id !== original.page_id)
    )
      return yield* Effect.fail(
        refusal("The original publication has no unchanged writing integrity intent."),
      )
    const files: Array<readonly [string, number, string]> = [],
      sources = new Map<string, string>()
    let total = 0
    for (const file of [...original.portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      if (
        !sourceFile.test(file.path) ||
        file.path.startsWith("/") ||
        file.path.split("/").some((part) => !part || part === "." || part === "..") ||
        sources.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        return yield* Effect.fail(refusal("The original frozen source manifest is invalid."))
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      total += bytes.length
      if (
        bytes.length > 1024 * 1024 ||
        total > 5 * 1024 * 1024 ||
        (yield* sha256(bytes)) !== file.sha256
      )
        return yield* Effect.fail(
          refusal("The original complete text source is missing, changed or exceeds its bounds."),
        )
      const text = yield* attempt(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      if (text.includes("\0"))
        return yield* Effect.fail(refusal("Binary source cannot authorize a text body completion."))
      sources.set(file.path, text)
      files.push([file.path, bytes.length, file.sha256])
    }
    if (
      !sources.has(original.portable.main) ||
      (yield* digest([
        original.portable.kind,
        original.portable.name,
        original.portable.description,
        original.portable.main,
        files,
      ])) !== integrity.intended_hash
    )
      return yield* Effect.fail(
        refusal("The original complete source does not reproduce its native intended hash."),
      )
    const index = original.intents.length - 1,
      intent = original.intents[index]
    const page = intent && new RegExp(`^v1/pages/(${uuid})/markdown$`).exec(intent.path)?.[1]
    const body = property(intent?.body),
      replacement = property(body.replace_content),
      target = replacement.new_str
    if (
      !intent ||
      !page ||
      page === original.page_id ||
      intent.method !== "PATCH" ||
      intent.status !== "completed" ||
      property(intent.response).id !== page ||
      intent.typed_links ||
      intent.artifact ||
      intent.recovery ||
      intent.list_start_repair ||
      intent.zero_list_repair ||
      body.markdown_version !== "v2" ||
      body.type !== "replace_content" ||
      Object.keys(body).length !== 3 ||
      Object.keys(replacement).length !== 1 ||
      typeof target !== "string"
    )
      return yield* Effect.fail(
        refusal(
          "The terminal effect is not a real acknowledged complete reference Markdown request.",
        ),
      )
    const proof = yield* attempt(() => creationMarkerProof(target))
    const creation = proof && original.intents[proof.intent_index]
    const marker = target.split("\n", 1)[0]!
    if (
      !proof ||
      !Number.isSafeInteger(proof.intent_index) ||
      proof.role !== "reference" ||
      !creation ||
      creation.method !== "POST" ||
      creation.path !== "v1/pages" ||
      creation.status !== "completed" ||
      property(creation.response).id !== page ||
      creation.recovery ||
      !creationProofMatchesIntent(proof, original, proof.intent_index) ||
      !equal(creationProofFromBody(creation.body), proof) ||
      proof.intended_hash !== integrity.intended_hash ||
      !sources.has(proof.path) ||
      target !== `${marker}\n\n${sources.get(proof.path)}` ||
      original.intents.filter(
        (item) => item.path === "v1/pages" && property(item.response).id === page,
      ).length !== 1 ||
      original.failure?.code !== "WRITE_PARTIAL" ||
      property(original.failure.details).cause_code !== "WRITE_VERIFICATION_FAILED" ||
      property(original.failure.details).stage !== `body:${proof.path}`
    )
      return yield* Effect.fail(
        refusal(
          "The original ACK, creation identity, failure stage and exact frozen reference do not agree.",
        ),
      )
    const roles = publicationGuardRoles(original)
    const pages = Object.keys(original.guards)
      .filter((path) => pagePath.test(path))
      .sort()
    if (
      roles.readOnlyDependencies.size ||
      pages.length !== roles.ownedMutationTargets.size ||
      !pages.includes(`v1/pages/${page}`) ||
      !pages.includes(`v1/pages/${original.page_id}`) ||
      pages.some(
        (path) =>
          !roles.ownedMutationTargets.has(path) ||
          typeof original.guards[`${path}/markdown`] !== "string",
      ) ||
      Object.keys(original.guards).some((path) => !readable.test(path))
    )
      return yield* Effect.fail(
        refusal("The complete original guard set does not close over its owned page graph."),
      )
    return {
      integrity,
      intent,
      index,
      page_id: page,
      source_path: proof.path,
      source_sha256: proof.source_sha256,
      source: sources.get(proof.path)!,
      marker,
      pages,
    }
  })
}

function selectedObservations(snapshot: BodyCompletionSnapshot, pageId: string) {
  const tree = bodyCompletionTree(snapshot, pageId)
  if (!tree) throw refusal("The complete selected physical tree is not closed or stable.")
  const values: Record<string, unknown> = {
    [`v1/pages/${pageId}`]: observation(`v1/pages/${pageId}`, snapshot.page_after),
    [`v1/pages/${pageId}/markdown`]: observation(`v1/pages/${pageId}/markdown`, snapshot.markdown),
  }
  for (const [path, raw] of Object.entries(snapshot.inventories))
    values[path] = observation(path, raw)
  for (const root of tree)
    for (const node of [root, ...root.children])
      values[`v1/blocks/${node.raw.id}`] = observation(`v1/blocks/${node.raw.id}`, node.raw)
  return { tree, values }
}

const checkpointGuards = (original: Receipt, snapshot: BodyCompletionSnapshot, pageId: string) => {
  if (!bodyCompletionTree(snapshot, pageId)) return undefined
  const { values } = selectedObservations(snapshot, pageId)
  return Object.fromEntries(
    Object.entries(original.guards).map(([path, value]) => [
      path,
      Object.hasOwn(values, path) ? values[path] : value,
    ]),
  )
}

function originallyOwnedBlock(original: Receipt, path: string, pageId: string) {
  if (!/^v1\/blocks\/[^/]+$/.test(path)) return false
  const seen = new Set<string>()
  let current: string | undefined = path
  while (current && !seen.has(current)) {
    seen.add(current)
    const raw = property(original.guards[current]),
      parent = property(raw.parent)
    if (parent.type === "page_id") return parent.page_id === pageId
    current =
      parent.type === "block_id" && typeof parent.block_id === "string"
        ? `v1/blocks/${parent.block_id}`
        : undefined
  }
  return false
}

/** Every retained guard is freshly read. Metadata brackets enclose the complete
 * read of all owned pages; the selected page additionally consumes every raw
 * physical node. No existing guard is advanced during this read. */
function capture(original: Receipt, bound: Effect.Success<ReturnType<typeof authority>>) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      raw: Record<string, unknown> = {}
    const before = new Map<string, Record<string, unknown>>()
    yield* Effect.forEach(
      bound.pages,
      (path) =>
        api.request(path).pipe(
          Effect.flatMap((value) => strict(Schema.Record(Schema.String, Schema.Unknown), value)),
          Effect.map((value) => {
            before.set(path, value)
            raw[path] = value
          }),
        ),
      { concurrency: 4 },
    )
    yield* Effect.forEach(
      Object.keys(original.guards).filter((path) => !pagePath.test(path)),
      (path) =>
        api.request(path).pipe(
          Effect.map((value) => {
            raw[path] = value
          }),
        ),
      { concurrency: 4 },
    )
    const inventories: Record<string, Record<string, unknown>> = {}
    const inventory = (id: string) =>
      Effect.gen(function* () {
        const path = childPath(id)
        const value = yield* strict(
          Schema.Record(Schema.String, Schema.Unknown),
          raw[path] ?? (yield* api.request(path)),
        )
        inventories[path] = value
        raw[path] = value
        return value
      })
    const roots = yield* inventory(bound.page_id)
    if (!Array.isArray(roots.results))
      return yield* Effect.fail(refusal("The selected root inventory is incomplete."))
    for (const node of roots.results) {
      const block = property(node)
      if (block.type === "table" && block.has_children === true && typeof block.id === "string")
        yield* inventory(block.id)
    }
    const after = new Map<string, Record<string, unknown>>()
    yield* Effect.forEach(
      bound.pages,
      (path) =>
        api.request(path).pipe(
          Effect.flatMap((value) => strict(Schema.Record(Schema.String, Schema.Unknown), value)),
          Effect.map((value) => {
            after.set(path, value)
          }),
        ),
      { concurrency: 4 },
    )
    for (const path of bound.pages)
      if (!equal(observation(path, before.get(path)), observation(path, after.get(path))))
        return yield* Effect.fail(
          refusal("An owned page changed during the complete guard read.", { path }),
        )
    const selectedPath = `v1/pages/${bound.page_id}`
    const snapshot: BodyCompletionSnapshot = {
      page_before: before.get(selectedPath)!,
      page_after: after.get(selectedPath)!,
      markdown: yield* strict(
        Schema.Record(Schema.String, Schema.Unknown),
        raw[`${selectedPath}/markdown`],
      ),
      inventories,
    }
    const selection = yield* attempt(() => selectedObservations(snapshot, bound.page_id))
    const guards: Record<string, unknown> = {}
    for (const [path, expected] of Object.entries(original.guards)) {
      const actual = yield* attempt(() => observation(path, raw[path]))
      guards[path] = actual
      if (
        originallyOwnedBlock(original, path, bound.page_id) &&
        !Object.hasOwn(selection.values, path)
      )
        return yield* Effect.fail(
          refusal("An original selected block is absent from its complete current inventory.", {
            path,
          }),
        )
      if (Object.hasOwn(selection.values, path)) {
        if (!equal(actual, selection.values[path]))
          return yield* Effect.fail(
            refusal("A selected block guard disagrees with the complete physical inventory.", {
              path,
            }),
          )
      } else if (!equal(actual, expected))
        return yield* Effect.fail(refusal("An unrelated original guard changed.", { path }))
    }
    if (
      !(yield* attempt(() =>
        publicationMarkerAuthority(
          original,
          raw[`v1/pages/${original.page_id}`],
          bound.integrity,
          publicationMarker,
        ),
      )) ||
      property(snapshot.page_before.parent).type !== "page_id" ||
      property(snapshot.page_before.parent).page_id !== original.page_id
    )
      return yield* Effect.fail(
        refusal("The original publication marker or retained reference parent changed."),
      )
    return { snapshot: comparableBodyCompletionSnapshot(snapshot), guards }
  })
}

function matches(
  bound: Effect.Success<ReturnType<typeof authority>>,
  derived: BodyCompletionDerivation,
  stage: number,
  snapshot: BodyCompletionSnapshot,
) {
  const tree = bodyCompletionTree(snapshot, derived.page_id),
    target = derived.markdown[stage]
  if (!tree || !target || !bodyCompletionStageMatches(derived, stage, snapshot)) return false
  const blocks = tree.flatMap((root) => [root.raw, ...root.children.map((node) => node.raw)])
  return publicationMarkdownMatches(
    bound.intent,
    String(snapshot.markdown.markdown),
    target,
    projectNotionBlockTree(derived.page_id, blocks),
  )
}

function decodePlan(raw: unknown) {
  return Effect.gen(function* () {
    const plan = yield* strict(BodyCompletionPlanSchema, raw)
    const { plan_id, plan_hash, ...body } = plan
    if (plan_id !== `pbc_${plan_hash}` || (yield* digest(body)) !== plan_hash)
      return yield* Effect.fail(refusal("The retained completion plan hash is invalid."))
    return plan
  })
}
function loadPlan(id: string, hash?: string) {
  return Effect.gen(function* () {
    if (!/^pbc_[a-f0-9]{64}$/.test(id) || (hash !== undefined && id !== `pbc_${hash}`))
      return yield* Effect.fail(
        refusal("The exact reviewed body-completion plan hash is required."),
      )
    const store = yield* Store
    const plan = yield* decodePlan(yield* store.upstream.command(bodyCompletionPlanKey(id)))
    if (plan.plan_id !== id)
      return yield* Effect.fail(refusal("The retained plan is stored under another identity."))
    return plan
  })
}
function reproduce(plan: BodyCompletionPlan, historical = false) {
  return Effect.gen(function* () {
    const original = yield* strict(PublicationReceiptSchema, plan.original_receipt),
      bound = yield* authority(original, historical)
    const derived = yield* attempt(() =>
      deriveBodyCompletion(bound.source, bound.marker, plan.before),
    )
    if (
      !derived ||
      original.operation_id !== plan.operation_id ||
      original.scope !== plan.scope ||
      original.database_id !== plan.database_id ||
      original.data_source_id !== plan.data_source_id ||
      original.page_id !== plan.root_page_id ||
      bound.page_id !== plan.page_id ||
      bound.index !== plan.original_intent_index ||
      bound.source_path !== plan.source_path ||
      bound.source_sha256 !== plan.source_sha256 ||
      bound.integrity.intended_hash !== plan.intended_hash ||
      (!historical && !equal(bound.integrity, plan.integrity)) ||
      (yield* digest(plan.integrity)) !== plan.integrity_sha256 ||
      property(plan.integrity).operation_id !== plan.operation_id ||
      property(plan.integrity).intended_hash !== plan.intended_hash ||
      property(property(plan.integrity).marker).state !== "writing" ||
      (yield* digest(original)) !== plan.original_receipt_sha256 ||
      (yield* snapshotDigest(plan.before)) !== plan.before_sha256 ||
      (yield* digest(original.guards)) !== plan.guards_sha256 ||
      !equal(derived.requests, plan.requests) ||
      !equal(checkpointGuards(original, plan.before, plan.page_id), original.guards) ||
      !equal(yield* Effect.forEach(derived.models, digest), plan.models_sha256) ||
      !equal(yield* Effect.forEach(derived.markdown, sha256), plan.markdown_sha256) ||
      !(yield* attempt(() => matches(bound, derived, 0, plan.before)))
    )
      return yield* Effect.fail(
        refusal(
          "The reviewed requests cannot be reconstructed from the original complete source and native publication.",
        ),
      )
    return { original, bound, derived }
  })
}

/** The plan is immutable native command evidence; it authorizes no send until
 * apply has acquired the original publication lock and re-read every guard. */
export function planPublicationBodyCompletion(operationId: string) {
  return Effect.gen(function* () {
    if (!/^p_[a-f0-9]{64}$/.test(operationId))
      return yield* Effect.fail(refusal("Invalid original publication identity."))
    const store = yield* Store
    return yield* withLocalLocks(
      store.root,
      [`publication:${operationId}`],
      Effect.gen(function* () {
        const original = yield* store.readJson(key(operationId), PublicationReceiptSchema)
        if (!original || original.operation_id !== operationId)
          return yield* Effect.fail(refusal("The original native publication is missing."))
        const bound = yield* authority(original),
          captured = yield* capture(original, bound)
        if (!equal(captured.guards, original.guards))
          return yield* Effect.fail(
            refusal("The selected page no longer equals its original acknowledged guard."),
          )
        const derived = yield* attempt(() =>
          deriveBodyCompletion(bound.source, bound.marker, captured.snapshot),
        )
        if (!derived || !(yield* attempt(() => matches(bound, derived, 0, captured.snapshot))))
          return yield* Effect.fail(
            refusal(
              "The exact finite three-effect completion cannot explain the full current source-bound body.",
            ),
          )
        const body = {
          version: 1 as const,
          domain: "publication_body_completion" as const,
          operation_id: operationId,
          scope: original.scope!,
          database_id: original.database_id!,
          data_source_id: original.data_source_id!,
          root_page_id: original.page_id!,
          page_id: bound.page_id,
          source_path: bound.source_path,
          source_sha256: bound.source_sha256,
          intended_hash: bound.integrity.intended_hash,
          original_intent_index: bound.index,
          original_receipt: copy(original),
          original_receipt_sha256: yield* digest(original),
          integrity: copy(bound.integrity),
          integrity_sha256: yield* digest(bound.integrity),
          before: captured.snapshot,
          before_sha256: yield* snapshotDigest(captured.snapshot),
          guards_sha256: yield* digest(original.guards),
          requests: derived.requests,
          models_sha256: yield* Effect.forEach(derived.models, digest),
          markdown_sha256: yield* Effect.forEach(derived.markdown, sha256),
        }
        const hash = yield* digest(body),
          plan = yield* strict(BodyCompletionPlanSchema, {
            ...body,
            plan_id: `pbc_${hash}`,
            plan_hash: hash,
          })
        const current = yield* store.readJson(key(operationId), PublicationReceiptSchema)
        if (
          !equal(current, original) ||
          !equal(yield* store.integrity.inspect(operationId), bound.integrity)
        )
          return yield* Effect.fail(
            refusal("The original native publication changed while planning."),
          )
        const retained = yield* store.upstream.command(bodyCompletionPlanKey(plan.plan_id))
        if (retained === undefined)
          yield* store.upstream.createCommand(bodyCompletionPlanKey(plan.plan_id), plan)
        else if (!equal(retained, plan))
          return yield* Effect.fail(
            refusal("A different plan already occupies this immutable identity."),
          )
        return {
          plan_id: plan.plan_id,
          plan_hash: plan.plan_hash,
          operation_id: operationId,
          page_id: plan.page_id,
          requests: plan.requests,
          original_history_preserved: true,
          remote_mutations: 0,
          plan,
        }
      }),
    )
  })
}

function originalUnchanged(receipt: Receipt, original: Receipt) {
  const { body_completion: _journal, ...body } = receipt
  return !receipt.owner && equal(body, original)
}
const completed = (item: BodyCompletionAttempt) =>
  item.disposition?.kind === "acknowledged_verified" ||
  item.disposition?.kind === "observed_applied"
const fitsAttemptBudget = (attempts: readonly BodyCompletionAttempt[]) => {
  const last = attempts.at(-1)
  // Reserve one attempt for each remaining effect. Row retries may not consume
  // the two append slots and leave a successful row impossible to complete.
  return attempts.length + (last ? 2 - last.step : 3) <= 12
}

/** Validate the whole append-only attempt chain, including every earlier
 * allocation, before selecting a next step. No pending append is replayable. */
function replayJournal(
  plan: BodyCompletionPlan,
  original: Receipt,
  bound: Effect.Success<ReturnType<typeof authority>>,
  derived: BodyCompletionDerivation,
  journal: BodyCompletionJournal,
) {
  return Effect.gen(function* () {
    if (
      journal.plan_id !== plan.plan_id ||
      journal.plan_hash !== plan.plan_hash ||
      journal.original_receipt_sha256 !== plan.original_receipt_sha256 ||
      !fitsAttemptBudget(journal.attempts)
    )
      return yield* Effect.fail(
        refusal("The retained body-completion journal identity is invalid."),
      )
    if ((journal.phase === "verified") !== (journal.certificate !== undefined))
      return yield* Effect.fail(refusal("The journal phase and completion certificate disagree."))
    let step = 0,
      snapshot = plan.before
    for (const [index, item] of journal.attempts.entries()) {
      if (
        item.index !== index ||
        item.step !== step ||
        !equal(item.request, derived.requests[step]) ||
        (yield* digest(item.request)) !== item.request_sha256 ||
        (yield* snapshotDigest(item.before)) !== item.before_sha256 ||
        (yield* digest(checkpointGuards(original, item.before, plan.page_id))) !==
          item.before_guards_sha256 ||
        !(yield* attempt(() => matches(bound, derived, step, item.before))) ||
        !stableBodyCompletionSnapshot(item.before, snapshot) ||
        (item.response !== undefined && item.transport !== "acknowledged") ||
        (item.transport === "acknowledged" && item.response === undefined)
      )
        return yield* Effect.fail(
          refusal(
            "The retained attempt no longer matches its exact request and complete preimage.",
          ),
        )
      const disposition = item.disposition
      if (!disposition) {
        if (index !== journal.attempts.length - 1)
          return yield* Effect.fail(refusal("An unresolved effect precedes a later attempt."))
        if (journal.phase === "verified")
          return yield* Effect.fail(
            refusal("A verified journal cannot contain an unresolved effect."),
          )
        return { step, snapshot, unresolved: item }
      }
      const proof = disposition.proof,
        proofHash = yield* snapshotDigest(proof.after)
      if (
        proof.first_sha256 !== proofHash ||
        proof.second_sha256 !== proofHash ||
        (yield* digest(checkpointGuards(original, proof.after, plan.page_id))) !==
          proof.guards_sha256
      )
        return yield* Effect.fail(refusal("The retained stable dual read certificate is invalid."))
      if (disposition.kind === "known_not_applied") {
        if (
          step !== 0 ||
          item.transport === "acknowledged" ||
          disposition.successor_index !== index + 1 ||
          !journal.attempts[index + 1] ||
          !stableBodyCompletionSnapshot(item.before, proof.after)
        )
          return yield* Effect.fail(
            refusal("Only an exact no-effect row PATCH may have an explicitly recorded successor."),
          )
      } else {
        if (
          !bodyCompletionTransition(derived, step, item.before, proof.after) ||
          !(yield* attempt(() => matches(bound, derived, step + 1, proof.after))) ||
          (disposition.kind === "acknowledged_verified" &&
            (item.transport !== "acknowledged" ||
              !bodyCompletionAckMatches(derived, step, item.response, item.before, proof.after))) ||
          (disposition.kind === "observed_applied" && item.transport === "acknowledged")
        )
          return yield* Effect.fail(
            refusal("A retained effect is not proven by its exact complete transition."),
          )
        snapshot = proof.after
        step++
      }
    }
    if (step > 3 || journal.phase === "unknown" || (journal.phase === "verified" && step !== 3))
      return yield* Effect.fail(
        refusal("The journal phase does not match its complete effect chain."),
      )
    return { step, snapshot, unresolved: undefined }
  })
}

function summary(plan: BodyCompletionPlan, journal: BodyCompletionJournal, reused = false) {
  return {
    domain: plan.domain,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    operation_id: plan.operation_id,
    page_id: plan.page_id,
    phase: journal.phase,
    completed_effects: journal.attempts.filter(completed).length,
    attempts: journal.attempts.length,
    original_history_preserved: true,
    publication_completed: false,
    outcome: journal.phase === "verified" ? "needs_safe_resume" : "unknown",
    next: {
      argv:
        journal.phase === "verified"
          ? ["ntn-skills", "operation", "resume", plan.operation_id]
          : ["ntn-skills-operator", "operation", "body-completion-reconcile", plan.plan_id],
      reason:
        journal.phase === "verified"
          ? "Continue the original publication after the bounded body checkpoint."
          : "Observe the retained effect without replaying an unknown append.",
    },
    ...(reused ? { reused: true, proof: "retained_historical_result" } : {}),
  }
}

function runCompletion(planId: string, hash: string | undefined, sending: boolean) {
  return Effect.gen(function* () {
    const plan = yield* loadPlan(planId, hash),
      store = yield* Store,
      api = yield* Notion
    return yield* withLocalLocks(
      store.root,
      [`publication:${plan.operation_id}`],
      Effect.gen(function* () {
        let current = yield* store.readJson(key(plan.operation_id), PublicationReceiptSchema)
        if (!current || current.operation_id !== plan.operation_id || current.owner)
          return yield* Effect.fail(
            refusal("The original publication is missing or owned by another process."),
          )
        const { original, bound, derived } = yield* reproduce(
          plan,
          current.body_completion?.phase === "verified",
        )
        const save = (next: Receipt) =>
          Effect.gen(function* () {
            const durable = yield* store.readJson(key(plan.operation_id), PublicationReceiptSchema)
            if (
              !equal(durable, current) ||
              !equal(yield* store.integrity.inspect(plan.operation_id), plan.integrity) ||
              !equal(yield* store.upstream.command(bodyCompletionPlanKey(plan.plan_id)), plan)
            )
              return yield* Effect.fail(
                refusal(
                  "Native receipt, integrity or immutable plan changed before the checkpoint.",
                ),
              )
            const decoded = yield* strict(PublicationReceiptSchema, next)
            yield* store.writeJson(key(plan.operation_id), decoded)
            current = decoded
          })
        let journal: BodyCompletionJournal = current.body_completion ?? {
          version: 1,
          plan_id: plan.plan_id,
          plan_hash: plan.plan_hash,
          original_receipt_sha256: plan.original_receipt_sha256,
          phase: "running",
          attempts: [],
        }
        journal = yield* strict(BodyCompletionJournalSchema, journal)
        let progress = yield* replayJournal(plan, original, bound, derived, journal)
        if (journal.phase === "verified") {
          // A later ordinary resume may have advanced this publication. A replay
          // returns the retained result and must not restore its old checkpoints.
          const certificate = journal.certificate
          const finalGuards = checkpointGuards(original, progress.snapshot, plan.page_id)
          const finalCheckpoints = Object.entries(finalGuards ?? {})
            .filter(([path, value]) => !equal(original.guards[path], value))
            .map(([path, value]) => ({ path, before: original.guards[path], after: value }))
          if (
            progress.step !== 3 ||
            progress.unresolved !== undefined ||
            !certificate ||
            certificate.operation_id !== plan.operation_id ||
            certificate.page_id !== plan.page_id ||
            certificate.intended_hash !== plan.intended_hash ||
            certificate.source_sha256 !== plan.source_sha256 ||
            certificate.original_journal_sha256 !== (yield* digest(original.intents)) ||
            certificate.original_guards_sha256 !== plan.guards_sha256 ||
            certificate.final_snapshot_sha256 !== (yield* snapshotDigest(progress.snapshot)) ||
            certificate.final_guards_sha256 !== (yield* digest(finalGuards)) ||
            !equal(certificate.checkpoints, finalCheckpoints) ||
            current.intents.length < original.intents.length ||
            !equal(current.intents.slice(0, original.intents.length), original.intents) ||
            !equal(current.portable, original.portable) ||
            current.scope !== original.scope ||
            current.page_id !== original.page_id ||
            !current.conflict_history?.some((item) => item.body_completion_plan_id === plan.plan_id)
          )
            return yield* Effect.fail(
              refusal(
                "The historical completion certificate is inconsistent with the original operation.",
              ),
            )
          return summary(plan, journal, true)
        }
        if (!originalUnchanged(current, original))
          return yield* Effect.fail(
            refusal(
              "The original receipt or guards changed outside the bounded completion journal.",
            ),
          )
        const saveJournal = (next: BodyCompletionJournal) =>
          Effect.gen(function* () {
            if (!current)
              return yield* Effect.fail(refusal("The original publication disappeared."))
            if (!fitsAttemptBudget(next.attempts))
              return yield* Effect.fail(
                refusal(
                  "The bounded attempt budget must retain one slot for each remaining effect.",
                ),
              )
            yield* save({ ...current, body_completion: next })
            journal = next
          })
        const readTwice = () =>
          Effect.gen(function* () {
            const freshAuthority = yield* authority(original)
            if (!equal(freshAuthority.integrity, plan.integrity))
              return yield* Effect.fail(refusal("The writing integrity changed."))
            const first = yield* capture(original, freshAuthority),
              second = yield* capture(original, freshAuthority)
            if (
              !stableBodyCompletionSnapshot(first.snapshot, second.snapshot) ||
              !equal(first.guards, second.guards)
            )
              return yield* Effect.fail(
                refusal(
                  "The complete physical body or original guards changed between two fresh observations.",
                ),
              )
            const proof = {
              observed_at_ms: yield* Clock.currentTimeMillis,
              first_sha256: yield* snapshotDigest(first.snapshot),
              second_sha256: yield* snapshotDigest(second.snapshot),
              guards_sha256: yield* digest(second.guards),
              after: second.snapshot,
            }
            return { ...second, proof }
          })
        for (;;) {
          progress = yield* replayJournal(plan, original, bound, derived, journal)
          const sampled = yield* readTwice()
          const pending = progress.unresolved
          if (pending) {
            if (
              bodyCompletionTransition(derived, pending.step, pending.before, sampled.snapshot) &&
              (yield* attempt(() => matches(bound, derived, pending.step + 1, sampled.snapshot)))
            ) {
              if (
                pending.transport === "acknowledged" &&
                !bodyCompletionAckMatches(
                  derived,
                  pending.step,
                  pending.response,
                  pending.before,
                  sampled.snapshot,
                )
              )
                return yield* Effect.fail(
                  refusal("The recorded real ACK does not name precisely the observed allocation."),
                )
              const updated: BodyCompletionAttempt = {
                ...pending,
                disposition: {
                  kind:
                    pending.transport === "acknowledged"
                      ? "acknowledged_verified"
                      : "observed_applied",
                  proof: sampled.proof,
                },
              }
              yield* saveJournal({
                ...journal,
                phase: "running",
                attempts: [...journal.attempts.slice(0, -1), updated],
              })
              if (!sending && pending.step < 2) return summary(plan, journal)
              continue
            }
            if (
              !stableBodyCompletionSnapshot(sampled.snapshot, pending.before) ||
              !(yield* attempt(() => matches(bound, derived, pending.step, sampled.snapshot)))
            )
              return yield* Effect.fail(
                refusal(
                  "The effect is neither its exact complete BEFORE nor its exact complete AFTER; no replay is permitted.",
                ),
              )
            // Allocation requests are not idempotent. Even an unchanged visible
            // BEFORE cannot prove that an unknown append will never arrive later.
            if (!sending || pending.step !== 0 || pending.transport === "acknowledged") {
              yield* saveJournal({ ...journal, phase: "unknown" })
              return summary(plan, journal)
            }
            const successor: BodyCompletionAttempt = {
              index: journal.attempts.length,
              step: 0,
              request: derived.requests[0]!,
              request_sha256: yield* digest(derived.requests[0]),
              before: sampled.snapshot,
              before_sha256: sampled.proof.second_sha256,
              before_guards_sha256: sampled.proof.guards_sha256,
              transport: "pending",
            }
            const observed: BodyCompletionAttempt = {
              ...pending,
              disposition: {
                kind: "known_not_applied",
                successor_index: successor.index,
                proof: sampled.proof,
              },
            }
            yield* saveJournal({
              ...journal,
              phase: "running",
              attempts: [...journal.attempts.slice(0, -1), observed, successor],
            })
          } else {
            if (
              !stableBodyCompletionSnapshot(sampled.snapshot, progress.snapshot) ||
              !(yield* attempt(() => matches(bound, derived, progress.step, sampled.snapshot)))
            )
              return yield* Effect.fail(
                refusal("The complete acknowledged checkpoint changed before the next effect."),
              )
            if (progress.step === 0 && !equal(sampled.guards, original.guards))
              return yield* Effect.fail(
                refusal("The complete original guard set no longer equals the reviewed BEFORE."),
              )
            if (progress.step === 3) {
              const checkpoints = Object.entries(sampled.guards)
                .filter(([path, value]) => !equal(original.guards[path], value))
                .map(([path, value]) => ({ path, before: original.guards[path], after: value }))
              const certificate = {
                operation_id: plan.operation_id,
                page_id: plan.page_id,
                intended_hash: plan.intended_hash,
                source_sha256: plan.source_sha256,
                original_journal_sha256: yield* digest(original.intents),
                original_guards_sha256: plan.guards_sha256,
                verified_at_ms: sampled.proof.observed_at_ms,
                final_snapshot_sha256: sampled.proof.second_sha256,
                final_guards_sha256: sampled.proof.guards_sha256,
                checkpoints,
              }
              const verified: BodyCompletionJournal = { ...journal, phase: "verified", certificate }
              if (!current)
                return yield* Effect.fail(refusal("The original publication disappeared."))
              const next: Receipt = {
                ...current,
                state: "running",
                conflict: false,
                guards: copy(sampled.guards),
                body_completion: verified,
                stages: [...original.stages, "body_completion_verified"],
                conflict_history: [
                  ...(original.conflict_history ?? []),
                  {
                    observed_at_ms: certificate.verified_at_ms,
                    conflict: true,
                    state: original.state,
                    stages: [...original.stages],
                    ...(original.failure ? { failure: original.failure } : {}),
                    guard_paths: Object.keys(original.guards).sort(),
                    intent_count: original.intents.length,
                    intended_hash: plan.intended_hash,
                    body_completion_plan_id: plan.plan_id,
                  },
                ],
              }
              // Preserve the prior failure in conflict_history and in the frozen
              // plan. Completion is not publication commit or source verification.
              delete next.failure
              yield* save(next)
              journal = verified
              return summary(plan, journal)
            }
            if (!sending) return summary(plan, journal)
            const nextAttempt: BodyCompletionAttempt = {
              index: journal.attempts.length,
              step: progress.step,
              request: derived.requests[progress.step]!,
              request_sha256: yield* digest(derived.requests[progress.step]),
              before: sampled.snapshot,
              before_sha256: sampled.proof.second_sha256,
              before_guards_sha256: sampled.proof.guards_sha256,
              transport: "pending",
            }
            yield* saveJournal({
              ...journal,
              phase: "running",
              attempts: [...journal.attempts, nextAttempt],
            })
          }
          // A durable pending record precedes the exact one send. Persist the raw
          // real response before any verification GET can fail or the process die.
          const item = journal.attempts.at(-1)!
          const result = yield* api
            .request(item.request.path, item.request.body, { method: "PATCH" })
            .pipe(Effect.result)
          if (result._tag === "Failure") {
            const unknown: BodyCompletionAttempt = {
              ...item,
              transport: "unknown",
              failure: failure(result.failure),
            }
            yield* saveJournal({
              ...journal,
              phase: "unknown",
              attempts: [...journal.attempts.slice(0, -1), unknown],
            })
            return yield* Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "The exact completion effect has an unresolved transport outcome; reconcile its retained journal.",
                {
                  plan_id: plan.plan_id,
                  operation_id: plan.operation_id,
                  step: item.step,
                  cause: result.failure.code,
                },
              ),
            )
          }
          const acknowledged: BodyCompletionAttempt = {
            ...item,
            transport: "acknowledged",
            response: result.success,
          }
          yield* saveJournal({
            ...journal,
            attempts: [...journal.attempts.slice(0, -1), acknowledged],
          })
        }
      }),
    )
  })
}

export const applyPublicationBodyCompletion = (planId: string, expectedHash: string) =>
  runCompletion(planId, expectedHash, true)
export const reconcilePublicationBodyCompletion = (planId: string) =>
  runCompletion(planId, undefined, false)
