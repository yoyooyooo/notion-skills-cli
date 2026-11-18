import { Crypto, Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { createChecked, type SharedCreatePlan } from "./shared-create-model.ts"
import type { SharedCreateBinding } from "./shared-create-outcome.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { withObservedBody } from "./shared-create-import-readback.ts"
import { observeSharedCreatePrefixBody } from "./shared-create-recovery-prefix-model.ts"
import {
  prepareSharedCreateText,
  readSharedCreateTextPayload,
  retainSharedCreateText,
} from "./shared-create-text-retention.ts"
import { sharedMarkdownReferences } from "./shared-file-references.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import {
  assertImportedLocalLinksRepairable,
  assertImportedLocalFragmentContent,
  assertImportedMarkdownContent,
  assertImportedTablePlusRepairable,
} from "./shared-import-markdown.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  materializeSharedNativeFile,
  restoreSharedNativeFileLinks,
  sharedNativeLocalHrefs,
} from "./shared-native-file-content.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
} from "./shared-notion-projection.ts"
import { appendSharedRecord, canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { guardedSourceMutation } from "./shared-source-definitions.ts"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"
import { sha256, Store } from "./store.ts"

type NativeFile = SharedCreatePlan["files"][number]
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const SharedCreateTablePlusRepairSchema = Schema.Struct({
  file_id: Schema.String,
  path: Schema.String,
  input_sha256: Hash,
  mode: Schema.Union([Schema.String, Schema.Null]),
  before_markdown: Schema.String,
  before_sha256: Hash,
  before_bytes: Schema.Number,
  changed_literals: Schema.Number,
})
type TablePlusRepair = typeof SharedCreateTablePlusRepairSchema.Type
type Identity = {
  readonly review_id: string
  readonly skill_page_id: string
  readonly original_outcome_sha256?: string | null
} & (
  | { readonly table_plus?: undefined; readonly bindings?: readonly SharedCreateBinding[] }
  | { readonly table_plus: TablePlusRepair; readonly bindings: readonly SharedCreateBinding[] }
)
const TextReference = Schema.Struct({
  object_id: Schema.String,
  sha256: Hash,
  bytes: Schema.Number,
})
export const SharedCreateLinkRepairReferenceSchema = Schema.Struct({
  file_id: Schema.String,
  page_id: Schema.String,
  record_id: Schema.String,
  hash: Hash,
})
export type SharedCreateLinkRepairReference = typeof SharedCreateLinkRepairReferenceSchema.Type
const ProofFields = {
  review_id: Schema.String,
  original_operation_id: Schema.String,
  skill_page_id: Schema.String,
  file_id: Schema.String,
  path: Schema.String,
  page_id: Schema.String,
  bindings_sha256: Hash,
  before: TextReference,
  after: TextReference,
  acknowledgement: Schema.Struct({
    version: Schema.Literal(1),
    operation_id: Schema.String,
    request_hash: Hash,
    response_hash: Hash,
    acknowledged_at: Schema.Number,
    response_metadata: Schema.Unknown,
  }),
}
const ProofSchema = Schema.Union([
  Schema.Struct({
    ...ProofFields,
    version: Schema.Literal(1),
    kind: Schema.Literal("original_create_local_link_repair"),
  }),
  Schema.Struct({
    ...ProofFields,
    version: Schema.Literal(2),
    kind: Schema.Literal("original_create_table_plus_repair"),
    original_input_sha256: Hash,
  }),
])
const StateSchema = Schema.Struct({
  version: Schema.Literal(1),
  review_id: Schema.String,
  original_operation_id: Schema.String,
  skill_page_id: Schema.String,
  file_id: Schema.String,
  page_id: Schema.String,
  input_sha256: Hash,
  before_markdown: Schema.String,
})
export const sharedCreateLinkRepairProofsEntity = "skill-create-link-repair-proofs-v1"
const recordId = (operation: string, file: string, identity: Identity) =>
  `${identity.table_plus === undefined ? "link-repair" : "table-plus-repair"}-${operation}:${file}`
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const refusal = (message: string) =>
  Effect.fail(fail("SHARED_CREATE_LINK_REPAIR_REQUIRED", message))
const bindingFacts = (bindings: readonly SharedCreateBinding[]) =>
  bindings.map(({ file_id, path, page_id }) => ({ file_id, path, page_id }))
function repairBindingFacts(identity: Identity, bindings: readonly SharedCreateBinding[]) {
  if (identity.table_plus === undefined) return bindingFacts(bindings)
  const prefix = identity.bindings
  if (
    prefix.length === 0 ||
    prefix.length > bindings.length ||
    prefix.some((item, at) => {
      const current = bindings[at]
      return !current || !same(bindingFacts([item]), bindingFacts([current]))
    })
  )
    throw fail(
      "SHARED_CREATE_LINK_REPAIR_REQUIRED",
      "The table-literal repair lost its exact original acknowledged file prefix.",
    )
  return bindingFacts(prefix)
}
function repairedCreateFile(
  identity: Identity,
  file: NativeFile,
  bindings: readonly SharedCreateBinding[],
) {
  return identity.table_plus === undefined ? linkedCreateFile(file, bindings) : file
}

function repairFragmentHrefs(
  identity: Identity,
  file: NativeFile,
  bindings: readonly SharedCreateBinding[],
) {
  return identity.table_plus === undefined
    ? sharedNativeLocalHrefs(file.projection.markdown, file.path, bindings)
    : []
}

export function sharedCreateLocalLinks(plan: SharedCreatePlan) {
  const paths = new Set([...plan.files, ...(plan.resources ?? [])].map((file) => file.path))
  return plan.files.flatMap((file) =>
    sharedMarkdownReferences(file.path, file.projection.markdown)
      .filter((reference) => paths.has(reference.target))
      .map(({ from, href, target }) => ({ from, href, target })),
  )
}
export function assertCreateLocalLinkPreimage(
  plan: SharedCreatePlan,
  file: NativeFile,
  markdown: string,
) {
  return assertImportedLocalLinksRepairable(
    file.projection.markdown,
    markdown,
    sharedCreateLocalLinks(plan)
      .filter((reference) => reference.from === file.path)
      .filter((reference) => !reference.href.startsWith("#") && !reference.href.startsWith("?"))
      .map((reference) => reference.href),
  )
}
export function assertCreateBodyRepairPreimage(
  plan: SharedCreatePlan,
  file: NativeFile,
  markdown: string,
  identity: Identity,
) {
  const selected = identity.table_plus
  if (selected === undefined) return assertCreateLocalLinkPreimage(plan, file, markdown)
  if (file.file_id !== selected.file_id) {
    assertImportedMarkdownContent(file.projection.markdown, markdown)
    return 0
  }
  if (
    file.path === plan.entrypoint ||
    file.path !== selected.path ||
    file.input.sha256 !== selected.input_sha256 ||
    (file.input.mode ?? null) !== selected.mode ||
    markdown !== selected.before_markdown ||
    assertImportedTablePlusRepairable(file.projection.markdown, markdown) !==
      selected.changed_literals
  )
    throw fail(
      "SHARED_CREATE_LINK_REPAIR_REQUIRED",
      "The complete original supporting-file table-literal preimage changed.",
    )
  return selected.changed_literals
}
export function linkedCreateFile(file: NativeFile, bindings: readonly SharedCreateBinding[]) {
  return {
    ...file,
    projection: {
      ...file.projection,
      markdown: restoreSharedNativeFileLinks(file.projection.markdown, file.path, bindings),
    },
  }
}
function linkedWire(file: NativeFile, bindings: readonly SharedCreateBinding[]) {
  return restoreSharedNativeFileLinks(
    sharedNotionMarkdownWire(file.projection),
    file.path,
    bindings,
  )
}
function bodyRequest(
  plan: SharedCreatePlan,
  identity: Identity,
  file: NativeFile,
  page: string,
  before: string,
  bindings: readonly SharedCreateBinding[],
) {
  return {
    // Keep unknown link PATCHes inside the original create's existing replay barrier.
    identity: `${plan.operation_id}:${identity.table_plus === undefined ? "link-repair" : "table-plus-repair"}:${identity.review_id}:${file.file_id}`,
    path: `v1/pages/${page}/markdown`,
    method: "PATCH" as const,
    body: {
      type: "update_content",
      markdown_version: "v2",
      update_content: {
        content_updates: [
          {
            old_str: before,
            new_str:
              identity.table_plus === undefined
                ? linkedWire(file, bindings)
                : sharedNotionMarkdownWire(
                    projectSharedNotionMarkdown(file.projection.input_markdown, {
                      version: 17,
                      purpose: "data_source_create",
                    }),
                  ),
          },
        ],
      },
    },
  }
}
function readBody(file: NativeFile, page: string) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/pages/${page}/markdown?markdown_version=v2`)
    const observation = yield* observeSharedCreatePrefixBody(file.file_id, page, raw)
    return { raw, markdown: String(property(raw).markdown), observation }
  })
}
function stateKey(plan: SharedCreatePlan, file: NativeFile) {
  return Effect.gen(function* () {
    return `operations/shared-create-link-repairs/${yield* authScope}/${plan.operation_id}/${file.file_id}.json`
  })
}
function acknowledgementKey(library: SharedLibrary, request: ReturnType<typeof bodyRequest>) {
  return Effect.gen(function* () {
    const namespace = yield* hash([
      yield* (yield* Notion).credentialIdentity,
      library.library_id,
      library.sources?.data_source_id ?? null,
    ])
    return `operations/shared-sources/${namespace}/source-ack-${yield* hash(request)}.json`
  })
}
function validateAck(
  plan: SharedCreatePlan,
  identity: Identity,
  file: NativeFile,
  page: string,
  before: string,
  bindings: readonly SharedCreateBinding[],
  input: unknown,
) {
  return Effect.gen(function* () {
    const acknowledgement = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceMutationAcknowledgementSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const request = bodyRequest(plan, identity, file, page, before, bindings)
    const operation = "source-op-" + (yield* hash(request))
    if (
      acknowledgement.operation_id !== operation ||
      acknowledgement.request_hash !== (yield* hash({ version: 1, operation, ...request })) ||
      acknowledgement.response_hash !== (yield* hash(acknowledgement.response)) ||
      !Number.isSafeInteger(acknowledgement.acknowledged_at) ||
      acknowledgement.acknowledged_at < 0
    )
      return yield* refusal(
        "The local-link PATCH lacks its exact original request and durable ACK.",
      )
    yield* observeSharedCreatePrefixBody(file.file_id, page, acknowledgement.response)
    const markdown = String(property(acknowledgement.response).markdown)
    yield* createChecked(() => {
      assertImportedLocalFragmentContent(
        repairedCreateFile(identity, file, bindings).projection.markdown,
        markdown,
        repairFragmentHrefs(identity, file, bindings),
      )
      assertImportedLocalFragmentContent(
        file.projection.markdown,
        materializeSharedNativeFile(markdown, file.path, bindings),
        identity.table_plus === undefined
          ? sharedCreateLocalLinks(plan)
              .filter((reference) => reference.from === file.path)
              .map((reference) => reference.href)
          : [],
      )
    })
    return { acknowledgement, markdown }
  })
}
function retainedText(library: SharedLibrary, owner: string, reference: typeof TextReference.Type) {
  return Effect.gen(function* () {
    if (reference.object_id !== `input-${reference.sha256}`)
      return yield* refusal("A link-repair body reference has another immutable identity.")
    const rows = yield* querySharedRecords(library, {
      skillPageId: owner,
      kind: "object",
      entityId: reference.object_id,
      recordId: reference.object_id,
      payloadContainsBody: true,
    })
    if (rows.length !== 1 || rows[0]!.operation_id !== `retain-input-${reference.sha256}`)
      return yield* refusal(
        "The complete original link-repair preimage or response is unavailable.",
      )
    return yield* readSharedCreateTextPayload(
      library,
      owner,
      { kind: "input", sha256: reference.sha256, bytes: reference.bytes },
      rows[0]!.payload,
    )
  })
}

/** Complete proof uses the original retained bytes to reconstruct the request and
 * the exact ACK, including its full response hash. Current equality is not proof. */
export function readSharedCreateLinkRepair(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  identity: Identity,
  file: NativeFile,
  bindings: readonly SharedCreateBinding[],
  expected?: SharedCreateLinkRepairReference,
) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: identity.skill_page_id,
      kind: "operation",
      entityId: sharedCreateLinkRepairProofsEntity,
      recordId: recordId(plan.operation_id, file.file_id, identity),
    })
    if (rows.length === 0 && expected === undefined) return undefined
    if (rows.length !== 1)
      return yield* refusal("A complete local-link repair proof is missing or duplicated.")
    const row = rows[0]!,
      proof = yield* createChecked(() =>
        Schema.decodeUnknownSync(ProofSchema)(row.payload, { onExcessProperty: "error" }),
      )
    const binding = bindings.find(
      (item) => item.file_id === file.file_id && item.path === file.path,
    )
    const reference = {
      file_id: file.file_id,
      page_id: proof.page_id,
      record_id: row.record_id,
      hash: row.hash,
    }
    const committedBindings = yield* createChecked(() => repairBindingFacts(identity, bindings))
    if (
      (identity.table_plus === undefined
        ? proof.version !== 1
        : proof.version !== 2 || proof.original_input_sha256 !== file.input.sha256) ||
      !binding ||
      proof.review_id !== identity.review_id ||
      row.operation_id !== identity.review_id ||
      proof.original_operation_id !== plan.operation_id ||
      proof.skill_page_id !== identity.skill_page_id ||
      proof.file_id !== file.file_id ||
      proof.path !== file.path ||
      proof.page_id !== binding.page_id ||
      proof.bindings_sha256 !== (yield* hash(committedBindings)) ||
      (expected !== undefined && !same(expected, reference))
    )
      return yield* refusal(
        "The local-link proof belongs to another original file, review or complete owner tree.",
      )
    const before = yield* retainedText(library, identity.skill_page_id, proof.before),
      after = yield* retainedText(library, identity.skill_page_id, proof.after)
    yield* createChecked(() => assertCreateBodyRepairPreimage(plan, file, before, identity))
    const metadata = property(proof.acknowledgement.response_metadata)
    if (Object.hasOwn(metadata, "markdown"))
      return yield* refusal("Response metadata cannot replace the retained complete ACK body.")
    const { response_metadata: _metadata, ...acknowledgement } = proof.acknowledgement
    const verified = yield* validateAck(plan, identity, file, binding.page_id, before, bindings, {
      ...acknowledgement,
      response: { ...metadata, markdown: after },
    })
    return {
      reference,
      before,
      markdown: verified.markdown,
      acknowledgement: verified.acknowledgement,
    }
  })
}

/** Capture an unpublished allocation without accepting a broken href. A changed
 * preimage is accepted only with the exact separately acknowledged repair. */
export function observeSharedCreateLinkFile(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  identity: Identity,
  file: NativeFile,
  page: string,
  bindings: readonly SharedCreateBinding[],
  retain = true,
) {
  return Effect.gen(function* () {
    const current = yield* readBody(file, page)
    if (identity.table_plus !== undefined && file.file_id !== identity.table_plus.file_id) {
      yield* createChecked(() =>
        assertImportedMarkdownContent(file.projection.markdown, current.markdown),
      )
      return { ...current, phase: "before" as const }
    }
    const complete =
      identity.table_plus !== undefined ||
      bindings.length === plan.files.length + (plan.resources?.length ?? 0)
    const proof = complete
      ? yield* readSharedCreateLinkRepair(library, plan, identity, file, bindings)
      : undefined
    if (proof !== undefined) {
      if (current.markdown !== proof.markdown)
        return yield* refusal("An acknowledged linked body changed after repair.")
      return { ...current, phase: "after" as const }
    }
    const store = yield* Store,
      key = yield* stateKey(plan, file)
    const saved = yield* store.readJson(key, StateSchema)
    const fields = {
      version: 1 as const,
      review_id: identity.review_id,
      original_operation_id: plan.operation_id,
      skill_page_id: identity.skill_page_id,
      file_id: file.file_id,
      page_id: page,
      input_sha256: file.input.sha256,
    }
    if (saved !== undefined) {
      const { before_markdown, ...previous } = saved
      if (!same(previous, fields))
        return yield* refusal(
          "The original link-repair preimage belongs to another operation or page.",
        )
      if (before_markdown !== current.markdown) {
        if (!complete)
          return yield* refusal(
            "An incomplete original owner tree cannot authorize a changed local-link body.",
          )
        const request = bodyRequest(plan, identity, file, page, before_markdown, bindings)
        const ack = yield* store.readJson(
          yield* acknowledgementKey(library, request),
          SourceMutationAcknowledgementSchema,
        )
        if (ack === undefined)
          return yield* refusal(
            "A changed local-link body has no original PATCH ACK; never repeat an unknown write.",
          )
        const verified = yield* validateAck(
          plan,
          identity,
          file,
          page,
          before_markdown,
          bindings,
          ack,
        )
        if (verified.markdown !== current.markdown)
          return yield* refusal(
            "The current body differs from the exact acknowledged repair response.",
          )
        return { ...current, phase: "after" as const }
      }
    }
    yield* createChecked(() =>
      assertCreateBodyRepairPreimage(plan, file, current.markdown, identity),
    )
    if (saved === undefined && retain)
      yield* store.writeJson(key, { ...fields, before_markdown: current.markdown })
    return { ...current, phase: "before" as const }
  })
}

export function repairSharedCreateLinkFile(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  identity: Identity,
  file: NativeFile,
  page: string,
  bindings: readonly SharedCreateBinding[],
  beforeDispatch: Effect.Effect<void, SkillsError, Notion | Store | Crypto.Crypto>,
  observed: (file: Effect.Success<ReturnType<typeof withObservedBody>>, markdown: string) => void,
) {
  return Effect.gen(function* () {
    const existing = yield* readSharedCreateLinkRepair(library, plan, identity, file, bindings)
    if (existing !== undefined) {
      const current = yield* readBody(file, page)
      if (current.markdown !== existing.markdown)
        return yield* refusal("The completed linked body changed.")
      const resolved = yield* withObservedBody(
        repairedCreateFile(identity, file, bindings),
        normalizeObservedBody(existing.markdown),
        repairFragmentHrefs(identity, file, bindings),
      )
      observed(resolved, normalizeObservedBody(existing.markdown))
      return existing.reference
    }
    const store = yield* Store
    const state = yield* store.readJson(yield* stateKey(plan, file), StateSchema)
    if (
      state === undefined ||
      state.review_id !== identity.review_id ||
      state.page_id !== page ||
      state.input_sha256 !== file.input.sha256
    )
      return yield* refusal("The original complete link-repair preimage is unavailable.")
    const before = state.before_markdown
    yield* createChecked(() => assertCreateBodyRepairPreimage(plan, file, before, identity))
    const request = bodyRequest(plan, identity, file, page, before, bindings)
    const assertBefore = Effect.gen(function* () {
      yield* beforeDispatch
      if ((yield* readBody(file, page)).markdown !== before)
        return yield* refusal("The complete body changed before its exact local-link PATCH.")
    })
    const recordDispatch = yield* sharedCreateDispatch(
      library,
      { operation_id: identity.review_id, skill_id: plan.skill_id },
      assertBefore,
    )
    const retainBefore = Effect.gen(function* () {
      yield* assertBefore
      yield* retainSharedCreateText(library, identity.skill_page_id, before, "input", "create")
    }).pipe(Effect.provideService(Notion, recordDispatch.api))
    const result = yield* guardedSourceMutation(
      library,
      {
        ...request,
        repeat: "never",
        beforeDispatch: retainBefore,
        observeAcknowledged: (response) =>
          Effect.gen(function* () {
            yield* observeSharedCreatePrefixBody(file.file_id, page, response)
            const markdown = String(property(response).markdown)
            yield* createChecked(() =>
              assertImportedLocalFragmentContent(
                repairedCreateFile(identity, file, bindings).projection.markdown,
                markdown,
                repairFragmentHrefs(identity, file, bindings),
              ),
            )
            return { page_id: page, sha256: yield* sha256(markdown) }
          }),
      },
      Effect.succeed(undefined),
    )
    const acknowledgedResume =
      (identity.table_plus !== undefined || identity.original_outcome_sha256 === null) &&
      result.status === "observed_current" &&
      "original_outcome" in result &&
      result.original_outcome === "applied"
    if (!("verified" in result && result.verified === true) && !acknowledgedResume)
      return yield* refusal("The exact local-link PATCH remains unknown.")
    const ack = yield* store.readJson(
      yield* acknowledgementKey(library, request),
      SourceMutationAcknowledgementSchema,
    )
    const verified = yield* validateAck(plan, identity, file, page, before, bindings, ack)
    const current = yield* readBody(file, page)
    if (current.markdown !== verified.markdown)
      return yield* refusal(
        "The repaired current body differs from the original PATCH acknowledgement.",
      )
    const resolved = yield* withObservedBody(
      repairedCreateFile(identity, file, bindings),
      normalizeObservedBody(verified.markdown),
      repairFragmentHrefs(identity, file, bindings),
    )
    observed(resolved, normalizeObservedBody(verified.markdown))
    const beforeText = yield* prepareSharedCreateText(before, "input"),
      afterText = yield* prepareSharedCreateText(verified.markdown, "input")
    const reference = (value: typeof beforeText) => ({
      object_id: value.object_id,
      sha256: value.sha256,
      bytes: value.bytes,
    })
    const { response, ...metadata } = verified.acknowledgement
    const { markdown: _markdown, ...response_metadata } = property(response)
    const committedBindings = yield* createChecked(() => repairBindingFacts(identity, bindings))
    const proof = {
      ...(identity.table_plus === undefined
        ? { version: 1 as const, kind: "original_create_local_link_repair" as const }
        : {
            version: 2 as const,
            kind: "original_create_table_plus_repair" as const,
            original_input_sha256: file.input.sha256,
          }),
      review_id: identity.review_id,
      original_operation_id: plan.operation_id,
      skill_page_id: identity.skill_page_id,
      file_id: file.file_id,
      path: file.path,
      page_id: page,
      bindings_sha256: yield* hash(committedBindings),
      before: reference(beforeText),
      after: reference(afterText),
      acknowledgement: { ...metadata, response_metadata },
    }
    const afterDispatch = yield* sharedCreateDispatch(
      library,
      { operation_id: identity.review_id, skill_id: plan.skill_id },
      beforeDispatch,
    )
    yield* Effect.gen(function* () {
      yield* retainSharedCreateText(
        library,
        identity.skill_page_id,
        verified.markdown,
        "input",
        "create",
      )
      yield* appendSharedRecord(library, {
        mode: "create",
        recordId: recordId(plan.operation_id, file.file_id, identity),
        operationId: identity.review_id,
        skillPageId: identity.skill_page_id,
        kind: "operation",
        entityId: sharedCreateLinkRepairProofsEntity,
        payload: proof,
      })
    }).pipe(Effect.provideService(Notion, afterDispatch.api))
    return {
      file_id: file.file_id,
      page_id: page,
      record_id: recordId(plan.operation_id, file.file_id, identity),
      hash: yield* hash({ version: 1, operation_id: identity.review_id, payload: proof }),
    }
  })
}
