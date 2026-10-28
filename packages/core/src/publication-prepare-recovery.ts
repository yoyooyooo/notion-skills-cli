import { Effect } from "effect"
import { hostname } from "node:os"
import { authScope, explicitSource } from "./catalog.ts"
import { fail, notionPage, property } from "./model.ts"
import type { SkillsError, Snapshot } from "./model.ts"
import { Store, sha256 } from "./store.ts"
import { withLocalLocks } from "./local-locks.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { canonical, keyFor, observation } from "./publication-observation.ts"
import { publicationSession } from "./publication.ts"
import type { Publication, PublicationOptions } from "./publication.ts"
import { preparePublicationIntegrity } from "./publication-integrity.ts"
import type { PortableSkill } from "./portable.ts"
import { Notion } from "./notion.ts"
import { rejectPublicationSourceOverride, verifyPublicationMetadata } from "./publication-source.ts"

/** Original reviewed bounds, never an unreviewed current snapshot. The revalidator is read-only. */
export interface PreparedPublicationRecovery<R, E> {
  readonly baseline: Snapshot
  /** Tool-proven materialization update; revalidate must prove unchanged remote authority. */
  readonly continuation_baseline?: Snapshot
  readonly portable: PortableSkill
  readonly revalidate: Effect.Effect<Readonly<Record<string, unknown>>, E, R>
}

/** Reprepare only without requests; acknowledged requests may be classified for existing recovery. */
export function recoverPreparedPublication<
  A extends object,
  E,
  R,
  E2 extends SkillsError = never,
  R2 = never,
>(
  operationId: string,
  bounds: PreparedPublicationRecovery<R, E>,
  options: PublicationOptions,
  acknowledgedContinuation = false,
  continuation?: (session: Publication, baseline: Snapshot) => Effect.Effect<A, E2, R2>,
) {
  return Effect.gen(function* () {
    yield* rejectPublicationSourceOverride(options)
    if (!/^p_[a-zA-Z0-9-]{1,100}$/.test(operationId))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Invalid publication operation ID."))
    const store = yield* Store
    return yield* withLocalLocks(
      store.root,
      [`publication:${operationId}`],
      Effect.gen(function* () {
        const receipt = yield* store.readJson(keyFor(operationId), PublicationReceiptSchema)
        const locator = notionPage(bounds.baseline.record).locator
        if (
          !receipt ||
          receipt.operation_id !== operationId ||
          receipt.operation !== "replace" ||
          receipt.page_id !== locator.page_id ||
          receipt.database_id !== locator.database_id ||
          receipt.data_source_id !== locator.data_source_id ||
          receipt.scope !== bounds.baseline.scope ||
          receipt.scope !== (yield* authScope) ||
          receipt.context?.write_path ||
          receipt.context?.ownership ||
          receipt.conflict
        )
          return yield* Effect.fail(
            fail(
              "CONVERSION_BLOCKED",
              "Original publication does not match the reviewed replacement bounds.",
            ),
          )
        if (receipt.owner) {
          const owner = receipt.owner
          const dead = yield* Effect.sync(() => {
            if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
              return false
            try {
              process.kill(owner.pid, 0)
              return false
            } catch (error) {
              return property(error).code === "ESRCH"
            }
          })
          if (!dead)
            return yield* Effect.fail(
              fail("PUBLICATION_LOCKED", "A live or unverifiable process owns this publication."),
            )
        }
        const files = []
        for (const file of bounds.portable.files)
          files.push({ path: file.path, sha256: yield* sha256(file.bytes) })
        if (
          canonical(receipt.portable) !==
          canonical({
            kind: bounds.portable.kind,
            name: bounds.portable.name,
            description: bounds.portable.description,
            main: bounds.portable.main,
            files,
          })
        )
          return yield* Effect.fail(
            fail(
              "CONVERSION_BLOCKED",
              "Frozen publication content differs from the reviewed output.",
            ),
          )
        for (const file of receipt.portable.files) {
          if ((yield* sha256(yield* store.readBytes(`objects/${file.sha256}`))) !== file.sha256)
            return yield* Effect.fail(
              fail("STATE_CORRUPT", "Frozen publication object failed its content hash."),
            )
        }
        const integrity = yield* store.integrity.inspect(operationId)
        if (!integrity)
          return yield* Effect.fail(
            fail(
              "PUBLICATION_UNRESOLVED",
              "Original publication has no retained intended content.",
            ),
          )
        // Existing integrity record must match; this call never changes an existing record.
        yield* preparePublicationIntegrity(operationId, bounds.portable)
        const executionBaseline = bounds.continuation_baseline ?? bounds.baseline
        if (bounds.continuation_baseline !== undefined) {
          if (
            receipt.intents.length !== 0 ||
            integrity.marker.state !== "writing" ||
            integrity.page_id !== undefined
          )
            return yield* Effect.fail(
              fail(
                "NO_REPLAY",
                "A continuation baseline requires an original publication without mutation requests or a committed revision.",
                { operation_id: operationId },
              ),
            )
          const authority = (snapshot: Snapshot) => ({
            scope: snapshot.scope,
            record: snapshot.record,
            entrypoint: snapshot.entrypoint,
            files: snapshot.files.map((file) =>
              file.path === snapshot.entrypoint ? { path: file.path } : file,
            ),
            source_files: snapshot.source_files,
            source_projection: snapshot.source_projection,
            router_members: snapshot.router_members,
            references: snapshot.references,
          })
          if (canonical(authority(executionBaseline)) !== canonical(authority(bounds.baseline)))
            return yield* Effect.fail(
              fail(
                "CONVERSION_BLOCKED",
                "Continuation baseline differs from the original reviewed authority.",
                { operation_id: operationId },
              ),
            )
        }
        if (receipt.state === "completed" && receipt.result) {
          yield* verifyPublicationMetadata(receipt, yield* Notion)
          return receipt.result
        }
        if (
          acknowledgedContinuation &&
          !continuation &&
          receipt.intents.length > 0 &&
          receipt.intents.every((intent) => intent.status === "completed") &&
          integrity.page_id === receipt.page_id
        )
          return {
            operation_id: operationId,
            page_id: receipt.page_id,
            state: "needs_publication_resume",
            remote_writes: 0,
          }
        // Includes failed requests and allocations: absence of reported effects alone is insufficient.
        if (
          receipt.intents.length !== 0 ||
          integrity.marker.state !== "writing" ||
          integrity.page_id !== undefined
        )
          return yield* Effect.fail(
            fail(
              "NO_REPLAY",
              "A mutation request or committed revision exists; prepare recovery cannot replay it.",
              { operation_id: operationId },
            ),
          )
        const source = yield* explicitSource(locator.database_id)
        if (!source.data_source_ids.includes(locator.data_source_id))
          return yield* Effect.fail(
            fail(
              "PUBLICATION_SOURCE_MISMATCH",
              "Original data source no longer belongs to the bound database.",
            ),
          )
        const api = yield* Notion
        const observations = yield* bounds.revalidate.pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              return method === "GET" || path === "v1/search" || path.endsWith("/query")
                ? api.request(path, body, options)
                : Effect.fail(fail("NO_REPLAY", "Prepare revalidation must be read-only."))
            },
          }),
        )
        if (!continuation)
          return {
            operation_id: operationId,
            page_id: receipt.page_id,
            state: "needs_prepare_revalidation",
            remote_writes: 0,
          }
        const session = yield* publicationSession(receipt, options)
        return yield* session.finish(
          session.run(
            "prepare_revalidation",
            Effect.gen(function* () {
              // Observations were compared with the original plan, then collected under the same fence.
              // validate performs another full comparison before installing any new guard.
              yield* session.validate(
                Effect.gen(function* () {
                  for (const [path, raw] of Object.entries(observations)) {
                    if (observation(path, raw) === undefined) continue
                    const actual = yield* session.notion.request(path)
                    if (canonical(observation(path, actual)) !== canonical(observation(path, raw)))
                      return yield* Effect.fail(
                        fail(
                          "CONVERSION_BLOCKED",
                          "Page changed after original-plan revalidation.",
                          { path },
                        ),
                      )
                  }
                }),
              )
              yield* session.bind(locator, bounds.baseline.scope)
              return yield* continuation(session, executionBaseline)
            }),
          ),
        )
      }),
    )
  })
}
