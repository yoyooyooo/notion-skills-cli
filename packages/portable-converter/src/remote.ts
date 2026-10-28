import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import { parse } from "effect/encoding/Yaml"
import { Buffer } from "node:buffer"
import { aliasFor, fail, notionPage, property, SnapshotSchema } from "../../core/src/model.ts"
import type { ContentKind, Snapshot } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { openSkill } from "../../core/src/snapshot.ts"
import { snapshotAuthoredPortable } from "../../core/src/export.ts"
import {
  replaceSkill,
  resumePreparedPublication,
  resumePublication,
} from "../../core/src/mutation.ts"
import { reconcilePublication } from "../../core/src/publication-reconcile.ts"
import { recoverPreparedPublication } from "../../core/src/publication-prepare-recovery.ts"
import { withLocalLocks } from "../../core/src/local-locks.ts"
import { PortableSourceDecoder } from "../../core/src/portable-source.ts"
import { MANIFEST, readPortable } from "../../core/src/portable.ts"
import { sha256, Store } from "../../core/src/store.ts"
import { publicationGuard, publicationOwnership } from "../../core/src/publication-integrity.ts"
import { canonical, persistExclusive } from "../../proof-converter/src/converter.ts"
import { convertPortable } from "./converter.ts"

const PlanSchema = Schema.Struct({
  format: Schema.Literals(["portable-remote-v1-to-v2", "portable-remote-reviewed-upgrade"]),
  page_id: Schema.String,
  database_id: Schema.String,
  kind: Schema.Literals(["skill", "router", "prompt"]),
  baseline: SnapshotSchema,
  guard: Schema.String,
  source_inventory: Schema.Array(
    Schema.Struct({ path: Schema.String, bytes: Schema.Number, sha256: Schema.String }),
  ),
  output: Schema.Array(Schema.Struct({ path: Schema.String, base64: Schema.String })),
  lineage: Schema.optional(
    Schema.Struct({
      plan_base64: Schema.String,
      plan_sha256: Schema.String,
      attempt_ledger: Schema.String,
    }),
  ),
})
const decoder = (kind: ContentKind) => ({
  rewriteSourceArchive: true,
  decode: (files: Parameters<typeof readPortable>[0]) => {
    const manifest = files.find((file) => file.path === MANIFEST)
    if (!manifest) return undefined
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes))
    return raw.version === 1 ? convertPortable(files, kind).portable : readPortable(files)
  },
})
function wireMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wireMetadata)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "request_id" && key !== "url" && key !== "expiry_time")
        .map(([key, item]) => [key, wireMetadata(item)]),
    )
  return value
}
function observe(page: string, database: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const observations: Record<string, unknown> = {}
    const snapshot = yield* openSkill(page, { database, refresh: true }).pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) =>
          api.request(path, body, options).pipe(
            Effect.tap((raw) =>
              Effect.sync(() => {
                observations[path] = raw
              }),
            ),
          ),
      }),
    )
    const raw = yield* api.request(`v1/pages/${page}`)
    observations[`v1/pages/${page}`] = raw
    const guard = canonical({
      wire: wireMetadata(raw),
      ownership: publicationOwnership(raw),
      properties: publicationGuard(raw),
      credential: yield* api.credentialIdentity,
    })
    return { snapshot, guard, observations }
  })
}
export function planRemote(page: string, database: string, kind: ContentKind) {
  return Effect.gen(function* () {
    const first = yield* observe(page, database)
    const portable = yield* snapshotAuthoredPortable(first.snapshot)
    const second = yield* observe(page, database)
    if (first.snapshot.version_id !== second.snapshot.version_id || first.guard !== second.guard)
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Page changed while inventorying; no writes performed."),
      )
    const locator = notionPage(first.snapshot.record).locator
    if (locator.page_id !== page || locator.database_id !== database || portable.kind !== kind)
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Explicit target/database/kind does not match observed source."),
      )
    return {
      format: "portable-remote-v1-to-v2" as const,
      page_id: page,
      database_id: database,
      kind,
      baseline: Schema.decodeUnknownSync(SnapshotSchema)(first.snapshot),
      guard: first.guard,
      source_inventory: first.snapshot.files.map(({ path, bytes, sha256 }) => ({
        path,
        bytes,
        sha256,
      })),
      output: portable.files.map((file) => ({
        path: file.path,
        base64: Buffer.from(file.bytes).toString("base64"),
      })),
    }
  }).pipe(Effect.provideService(PortableSourceDecoder, decoder(kind)))
}
function approvedPlan(bytes: string, expectedHash: string, recovering = false) {
  return Effect.gen(function* () {
    if ((yield* sha256(bytes)) !== expectedHash)
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Plan byte hash differs from approved hash."),
      )
    const plan = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(PlanSchema)(JSON.parse(bytes), { onExcessProperty: "error" }),
      catch: () => fail("CONVERSION_BLOCKED", "Plan does not have the reviewed conversion format."),
    })
    if ((plan.format === "portable-remote-reviewed-upgrade") !== Boolean(plan.lineage))
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Plan format and reviewed lineage differ."),
      )
    let reviewed = plan
    if (plan.lineage) {
      const originalBytes = Buffer.from(plan.lineage.plan_base64, "base64").toString("utf8")
      if ((yield* sha256(originalBytes)) !== plan.lineage.plan_sha256)
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "Original reviewed lineage hash differs."),
        )
      const original = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(PlanSchema)(JSON.parse(originalBytes), {
            onExcessProperty: "error",
          }),
        catch: () => fail("CONVERSION_BLOCKED", "Original reviewed lineage is invalid."),
      })
      if (
        original.lineage ||
        original.format !== "portable-remote-v1-to-v2" ||
        canonical(original.source_inventory) !== canonical(original.baseline.files) ||
        canonical(plan.output) !== canonical(original.output) ||
        plan.page_id !== original.page_id ||
        plan.database_id !== original.database_id ||
        plan.kind !== original.kind ||
        plan.guard !== original.guard ||
        plan.baseline.scope !== original.baseline.scope ||
        !(yield* sameRawAuthority(original.baseline, plan.baseline))
      )
        return yield* Effect.fail(
          fail(
            "CONVERSION_BLOCKED",
            "Successor plan differs from original reviewed raw authority or output.",
          ),
        )
      reviewed = original
    }
    const locator = notionPage(plan.baseline.record).locator
    if (
      locator.page_id !== plan.page_id ||
      locator.database_id !== plan.database_id ||
      plan.baseline.record.kind !== plan.kind ||
      canonical(plan.source_inventory) !== canonical(plan.baseline.files)
    )
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Plan identities or source inventory are inconsistent."),
      )
    const portable = yield* snapshotAuthoredPortable(plan.baseline).pipe(
      Effect.provideService(PortableSourceDecoder, decoder(plan.kind)),
    )
    if (!recovering) yield* verifyReviewedOutput(reviewed, portable)
    // Recovery consumes the reviewed bytes, not a newer formatter's rendering of old input.
    // The core binding checks these exact hashes against the original frozen receipt and integrity intent.
    return {
      plan,
      reviewed,
      portable: {
        ...portable,
        files: plan.output.map((file) => ({
          path: file.path,
          bytes: Buffer.from(file.base64, "base64"),
        })),
      },
    }
  })
}
function sameGeneratedName(oldBytes: Uint8Array, newBytes: Uint8Array, name: string) {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const oldText = decoder.decode(oldBytes)
    const newText = decoder.decode(newBytes)
    const oldHeader = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(oldText)
    const newHeader = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(newText)
    if (
      !oldHeader ||
      !newHeader ||
      oldText.slice(oldHeader[0].length) !== newText.slice(newHeader[0].length)
    )
      return false
    const { name: oldName, ...oldMetadata } = property(parse(oldHeader[1]!))
    const { name: newName, ...newMetadata } = property(parse(newHeader[1]!))
    return (
      oldName === aliasFor(name) &&
      newName === name &&
      oldName !== newName &&
      canonical(oldMetadata) === canonical(newMetadata)
    )
  } catch {
    return false
  }
}
function verifyReviewedOutput(
  plan: typeof PlanSchema.Type,
  portable: {
    readonly main: string
    readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[]
  },
) {
  return Effect.gen(function* () {
    const reviewed = plan.output.map((file) => ({
      path: file.path,
      bytes: Buffer.from(file.base64, "base64"),
    }))
    if (
      new Set(reviewed.map((file) => file.path)).size !== reviewed.length ||
      reviewed.length !== portable.files.length
    )
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Reviewed output differs from the frozen source inventory."),
      )
    for (const file of reviewed) {
      const expected = portable.files.find((item) => item.path === file.path)
      if (expected && Buffer.from(expected.bytes).equals(file.bytes)) continue
      const frozen = plan.baseline.files.find((item) => item.path === file.path)
      if (
        !expected ||
        file.path !== portable.main ||
        file.path !== plan.baseline.entrypoint ||
        !frozen ||
        frozen.bytes !== file.bytes.length ||
        (yield* sha256(file.bytes)) !== frozen.sha256 ||
        !reviewedGraphComplete(plan.baseline) ||
        !sameGeneratedName(file.bytes, expected.bytes, plan.baseline.record.name)
      )
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "Reviewed output differs from the frozen source inventory."),
        )
    }
  })
}
function reviewedGraphComplete(snapshot: Snapshot) {
  const pages = snapshot.references
  if (!pages?.length) return false
  const root = notionPage(snapshot.record).locator.page_id
  return (
    pages.filter((page) => page.id === root && page.path === snapshot.entrypoint).length === 1 &&
    new Set(pages.map((page) => page.id)).size === pages.length &&
    new Set(pages.map((page) => page.path)).size === pages.length &&
    pages.every((page) => snapshot.files.some((file) => file.path === page.path)) &&
    snapshot.files.every(
      (file) =>
        !/^references\/.*\.md$/i.test(file.path) || pages.some((page) => page.path === file.path),
    )
  )
}
/** Only the generated name representation may differ; raw authored authority stays exact. */
function sameRawAuthorityWithGeneratedName(baseline: Snapshot, current: Snapshot) {
  return Effect.gen(function* () {
    const before = baseline.references
    const after = current.references
    if (
      !reviewedGraphComplete(baseline) ||
      !reviewedGraphComplete(current) ||
      baseline.entrypoint !== current.entrypoint ||
      canonical(baseline.record) !== canonical(current.record) ||
      canonical(baseline.router_members) !== canonical(current.router_members) ||
      canonical(before) !== canonical(after)
    )
      return false
    if (
      canonical(baseline.files.filter((file) => file.path !== baseline.entrypoint)) !==
      canonical(current.files.filter((file) => file.path !== current.entrypoint))
    )
      return false
    const oldEntry = baseline.files.find((file) => file.path === baseline.entrypoint)
    const newEntry = current.files.find((file) => file.path === current.entrypoint)
    if (!oldEntry || !newEntry) return false
    const store = yield* Store
    const oldBytes = yield* store.readBytes(`objects/${oldEntry.sha256}`)
    const newBytes = yield* store.readBytes(`objects/${newEntry.sha256}`)
    if (
      oldBytes.length !== oldEntry.bytes ||
      newBytes.length !== newEntry.bytes ||
      (yield* sha256(oldBytes)) !== oldEntry.sha256 ||
      (yield* sha256(newBytes)) !== newEntry.sha256
    )
      return false
    return sameGeneratedName(oldBytes, newBytes, baseline.record.name)
  })
}
function sameRawAuthority(baseline: Snapshot, current: Snapshot) {
  return Effect.gen(function* () {
    if (
      !reviewedGraphComplete(baseline) ||
      !reviewedGraphComplete(current) ||
      baseline.entrypoint !== current.entrypoint ||
      canonical(baseline.record) !== canonical(current.record) ||
      canonical(baseline.references) !== canonical(current.references) ||
      canonical(baseline.router_members) !== canonical(current.router_members) ||
      canonical(baseline.source_projection) !== canonical(current.source_projection) ||
      canonical(baseline.source_files) !== canonical(current.source_files)
    )
      return false
    return (
      canonical(baseline.files) === canonical(current.files) ||
      (yield* sameRawAuthorityWithGeneratedName(baseline, current))
    )
  })
}
function noRetainedPublication(plan: typeof PlanSchema.Type) {
  return Effect.gen(function* () {
    const store = yield* Store
    for (const key of yield* store.listKeys("publications/")) {
      const receipt = yield* store.readJson(key, Schema.Unknown)
      if (
        property(receipt).page_id === plan.page_id &&
        property(receipt).scope === plan.baseline.scope
      )
        return yield* Effect.fail(
          fail(
            "CONVERSION_BLOCKED",
            "A retained publication exists for this page; recover its original operation.",
          ),
        )
    }
  })
}
export function replanRemote(bytes: string, expectedHash: string, ledger: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const originalLedger = path.resolve(ledger)
    if (yield* fs.exists(originalLedger))
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "An attempted plan cannot be superseded."),
      )
    const { plan } = yield* approvedPlan(bytes, expectedHash)
    return yield* Effect.gen(function* () {
      yield* noRetainedPublication(plan)
      if (plan.lineage)
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "A successor plan cannot be superseded again."),
        )
      const current = yield* observe(plan.page_id, plan.database_id)
      if (current.snapshot.version_id === plan.baseline.version_id)
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "Materialization version has not changed."),
        )
      if (
        current.guard !== plan.guard ||
        current.snapshot.scope !== plan.baseline.scope ||
        !(yield* sameRawAuthority(plan.baseline, current.snapshot))
      )
        return yield* Effect.fail(
          fail(
            "CONVERSION_BLOCKED",
            "Current raw authority differs from the original reviewed plan.",
          ),
        )
      yield* verifyReviewedOutput(plan, yield* snapshotAuthoredPortable(current.snapshot))
      return {
        ...plan,
        format: "portable-remote-reviewed-upgrade" as const,
        baseline: Schema.decodeUnknownSync(SnapshotSchema)(current.snapshot),
        source_inventory: current.snapshot.files.map(({ path, bytes, sha256 }) => ({
          path,
          bytes,
          sha256,
        })),
        lineage: {
          plan_base64: Buffer.from(bytes).toString("base64"),
          plan_sha256: expectedHash,
          attempt_ledger: originalLedger,
        },
      }
    }).pipe(Effect.provideService(PortableSourceDecoder, decoder(plan.kind)))
  })
}
function revalidate(plan: typeof PlanSchema.Type, recovering = false, reviewed = plan) {
  return Effect.gen(function* () {
    const current = yield* observe(plan.page_id, plan.database_id)
    const inventoryMatches =
      canonical(current.snapshot.files) === canonical(plan.source_inventory) ||
      (yield* sameRawAuthorityWithGeneratedName(plan.baseline, current.snapshot))
    if (
      current.snapshot.version_id !== plan.baseline.version_id ||
      current.snapshot.scope !== plan.baseline.scope ||
      current.guard !== plan.guard ||
      !inventoryMatches
    )
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Current page differs from approved complete inventory."),
      )
    if (recovering) return current
    const portable = yield* snapshotAuthoredPortable(current.snapshot)
    yield* verifyReviewedOutput(reviewed, portable)
    return current
  })
}
export function applyRemote(bytes: string, expectedHash: string, ledger: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path
    const attemptLedger = path.resolve(ledger)
    const { plan, portable, reviewed } = yield* approvedPlan(bytes, expectedHash)
    if (plan.lineage) {
      const fs = yield* FileSystem.FileSystem
      if (
        !path.isAbsolute(plan.lineage.attempt_ledger) ||
        attemptLedger === plan.lineage.attempt_ledger ||
        (yield* fs.exists(plan.lineage.attempt_ledger))
      )
        return yield* Effect.fail(
          fail("CONVERSION_BLOCKED", "Successor requires a new ledger and no original attempt."),
        )
      yield* noRetainedPublication(plan)
    }
    return yield* Effect.gen(function* () {
      const current = yield* revalidate(plan, false, reviewed)
      const crypto = yield* Crypto.Crypto
      const operationId = `p_${yield* crypto.randomUUIDv4()}`
      if (
        !(yield* persistExclusive(attemptLedger, {
          plan_hash: expectedHash,
          page_id: plan.page_id,
          state: "attempted",
          baseline: plan.baseline,
          operation_id: operationId,
        }))
      )
        return yield* Effect.fail(
          fail(
            "CONVERSION_BLOCKED",
            "Attempt already exists; use remote-reconcile or remote-resume with the original ledger.",
          ),
        )
      return yield* replaceSkill(portable, {
        target: current.snapshot,
        database: plan.database_id,
        operationId,
      })
    }).pipe(Effect.provideService(PortableSourceDecoder, decoder(plan.kind)))
  })
}
const AttemptSchema = Schema.Struct({
  plan_hash: Schema.String,
  page_id: Schema.String,
  state: Schema.Literal("attempted"),
  baseline: SnapshotSchema,
  operation_id: Schema.optional(Schema.String),
})
const RecoveryReviewSchema = Schema.Struct({
  format: Schema.Literal("portable-remote-recovery-review"),
  original_plan_sha256: Schema.String,
  original_plan_base64: Schema.String,
  original_ledger_sha256: Schema.String,
  original_ledger_path: Schema.String,
  operation_id: Schema.String,
  page_id: Schema.String,
  baseline: SnapshotSchema,
  guard: Schema.String,
  output: Schema.Array(Schema.Struct({ path: Schema.String, base64: Schema.String })),
})
export function planRecoveryRemote(
  bytes: string,
  expectedHash: string,
  ledger: string,
  expectedPage: string,
  operationId?: string,
) {
  return recoverRemote(
    bytes,
    expectedHash,
    ledger,
    expectedPage,
    operationId,
    false,
    undefined,
    undefined,
    true,
  ).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () =>
          Schema.decodeUnknownSync(RecoveryReviewSchema)(result, { onExcessProperty: "error" }),
        catch: () =>
          fail("NO_REPLAY", "Original operation did not produce a zero-intent recovery review."),
      }),
    ),
  )
}
function recoverRemote(
  bytes: string,
  expectedHash: string,
  ledger: string,
  expectedPage: string,
  operationId: string | undefined,
  resume: boolean,
  recoveryBytes?: string,
  expectedRecoveryHash?: string,
  makeReview = false,
) {
  return Effect.gen(function* () {
    const { plan, portable } = yield* approvedPlan(bytes, expectedHash, true)
    if (expectedPage !== plan.page_id)
      return yield* Effect.fail(
        fail("CONVERSION_BLOCKED", "Expected page differs from the original reviewed target."),
      )
    const store = yield* Store
    const path = yield* Path.Path
    const absoluteLedger = path.resolve(ledger)
    return yield* withLocalLocks(
      store.root,
      [`portable-ledger:${absoluteLedger}`],
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const raw = yield* fs.readFileString(absoluteLedger)
        const retained = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(AttemptSchema)(JSON.parse(raw), { onExcessProperty: "error" }),
          catch: () => fail("CONVERSION_BLOCKED", "Original attempt ledger is missing or invalid."),
        })
        if (
          retained.plan_hash !== expectedHash ||
          retained.page_id !== plan.page_id ||
          canonical(retained.baseline) !== canonical(plan.baseline) ||
          (retained.operation_id && operationId && retained.operation_id !== operationId)
        )
          return yield* Effect.fail(
            fail(
              "CONVERSION_BLOCKED",
              "Attempt ledger differs from the original plan or operation.",
            ),
          )
        const id = retained.operation_id ?? operationId
        if (!id)
          return yield* Effect.fail(
            fail(
              "CONVERSION_BLOCKED",
              "Legacy attempt requires explicit --operation-id; operation lookup or guessing is forbidden.",
            ),
          )
        if (Boolean(recoveryBytes) !== Boolean(expectedRecoveryHash))
          return yield* Effect.fail(
            fail("CONVERSION_BLOCKED", "Recovery review bytes and hash are required together."),
          )
        const review =
          recoveryBytes === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                if ((yield* sha256(recoveryBytes)) !== expectedRecoveryHash)
                  return yield* Effect.fail(
                    fail("CONVERSION_BLOCKED", "Recovery review hash differs."),
                  )
                const value = yield* Effect.try({
                  try: () =>
                    Schema.decodeUnknownSync(RecoveryReviewSchema)(JSON.parse(recoveryBytes), {
                      onExcessProperty: "error",
                    }),
                  catch: () => fail("CONVERSION_BLOCKED", "Recovery review is invalid."),
                })
                if (
                  value.original_plan_sha256 !== expectedHash ||
                  !Buffer.from(value.original_plan_base64, "base64").equals(Buffer.from(bytes)) ||
                  value.original_ledger_sha256 !== (yield* sha256(raw)) ||
                  value.original_ledger_path !== absoluteLedger ||
                  value.operation_id !== id ||
                  value.page_id !== plan.page_id ||
                  value.guard !== plan.guard ||
                  canonical(value.output) !== canonical(plan.output) ||
                  value.baseline.scope !== plan.baseline.scope ||
                  !(yield* sameRawAuthority(plan.baseline, value.baseline))
                )
                  return yield* Effect.fail(
                    fail(
                      "CONVERSION_BLOCKED",
                      "Recovery review differs from the original operation or raw authority.",
                    ),
                  )
                return value
              })
        let currentReview: typeof RecoveryReviewSchema.Type | undefined
        const capture = Effect.gen(function* () {
          const current = yield* observe(plan.page_id, plan.database_id)
          if (
            current.guard !== plan.guard ||
            current.snapshot.scope !== plan.baseline.scope ||
            !(yield* sameRawAuthority(plan.baseline, current.snapshot))
          )
            return yield* Effect.fail(
              fail(
                "CONVERSION_BLOCKED",
                "Current raw authority differs from the original operation.",
              ),
            )
          const baseline = Schema.decodeUnknownSync(SnapshotSchema)(current.snapshot)
          if (
            review &&
            (baseline.version_id !== review.baseline.version_id ||
              baseline.snapshot_id !== review.baseline.snapshot_id ||
              canonical(baseline.files) !== canonical(review.baseline.files) ||
              !(yield* sameRawAuthority(review.baseline, baseline)))
          )
            return yield* Effect.fail(
              fail(
                "CONVERSION_BLOCKED",
                "Current baseline differs from the explicit recovery review.",
              ),
            )
          yield* verifyReviewedOutput(plan, yield* snapshotAuthoredPortable(baseline))
          currentReview = {
            format: "portable-remote-recovery-review",
            original_plan_sha256: expectedHash,
            original_plan_base64: Buffer.from(bytes).toString("base64"),
            original_ledger_sha256: yield* sha256(raw),
            original_ledger_path: absoluteLedger,
            operation_id: id,
            page_id: plan.page_id,
            baseline,
            guard: plan.guard,
            output: plan.output,
          }
          return current.observations
        })
        const bounds = {
          baseline: plan.baseline,
          portable,
          ...(review ? { continuation_baseline: review.baseline } : {}),
          revalidate:
            makeReview || review
              ? capture
              : revalidate(plan, true).pipe(Effect.map((current) => current.observations)),
        }
        // Public typed core validation proves the frozen receipt/content link before legacy binding.
        const observation = yield* recoverPreparedPublication(id, bounds, {}, true)
        if (makeReview) {
          if (
            !currentReview ||
            !("state" in observation) ||
            observation.state !== "needs_prepare_revalidation"
          )
            return yield* Effect.fail(
              fail(
                "NO_REPLAY",
                "Recovery review requires a zero-intent unbound prepare operation.",
              ),
            )
          return currentReview
        }
        if (!retained.operation_id) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const staged = `${absoluteLedger}.${yield* (yield* Crypto.Crypto).randomUUIDv4()}.pending`
              const file = yield* fs.open(staged, { flag: "wx", mode: 0o600, noFollow: true })
              yield* file.writeAll(
                new TextEncoder().encode(
                  JSON.stringify({ ...retained, operation_id: id }, null, 2) + "\n",
                ),
              )
              yield* file.sync
              yield* fs.rename(staged, absoluteLedger)
              const path = yield* Path.Path
              yield* (yield* fs.open(path.dirname(absoluteLedger), { flag: "r" })).sync
            }),
          )
        }
        if ("state" in observation && observation.state === "needs_publication_resume")
          return resume ? yield* resumePublication(id) : yield* reconcilePublication(id)
        return resume ? yield* resumePreparedPublication(id, bounds) : observation
      }),
    ).pipe(Effect.provideService(PortableSourceDecoder, decoder(plan.kind)))
  })
}
export function reconcileRemote(
  bytes: string,
  expectedHash: string,
  ledger: string,
  expectedPage: string,
  operationId?: string,
) {
  return recoverRemote(bytes, expectedHash, ledger, expectedPage, operationId, false)
}
export function resumeRemote(
  bytes: string,
  expectedHash: string,
  ledger: string,
  expectedPage: string,
  operationId?: string,
  recoveryBytes?: string,
  expectedRecoveryHash?: string,
) {
  return recoverRemote(
    bytes,
    expectedHash,
    ledger,
    expectedPage,
    operationId,
    true,
    recoveryBytes,
    expectedRecoveryHash,
  )
}
