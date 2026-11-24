import { Crypto, Effect } from "effect"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import {
  LibraryInitializationPendingSchema,
  preservesTableBinding,
  type LibraryInitializationAction,
  type LibraryInitializationPending,
  type LibraryTableRole,
  type TableBinding,
} from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

export type LibraryInitializationMode = "create" | "reconcile" | "resume"

export function withLibraryInitialization<A, R>(
  parent: string,
  operation: string,
  mode: LibraryInitializationMode,
  use: (session: {
    readonly pending: () => LibraryInitializationPending
    readonly requireResumeState: () => Effect.Effect<void, SkillsError>
    readonly rememberRoot: (root: string) => Effect.Effect<void, SkillsError>
    readonly verifyTable: (
      role: LibraryTableRole,
      table: TableBinding,
    ) => Effect.Effect<void, SkillsError>
    readonly remember: (
      tables: LibraryInitializationPending["tables"],
      action: LibraryInitializationAction,
    ) => Effect.Effect<void, SkillsError>
    readonly perform: <B, R2>(
      action: LibraryInitializationAction,
      replay: "never" | "idempotent",
      work: Effect.Effect<B, SkillsError, R2 | Notion>,
    ) => Effect.Effect<B, SkillsError, R2 | Notion | Crypto.Crypto>
    readonly finish: () => Effect.Effect<void, SkillsError>
  }) => Effect.Effect<A, SkillsError, R>,
) {
  return Effect.gen(function* () {
    const store = yield* Store,
      api = yield* Notion,
      crypto = yield* Crypto.Crypto
    const scope = yield* sha256(
      canonicalSharedJson([
        api.apiOrigin ?? "https://api.notion.com",
        yield* api.version,
        yield* api.credentialIdentity,
        parent,
      ]),
    )
    const key = `operations/library-init-pending/${scope}/pending.json`
    return yield* withLocalLocks(
      store.root,
      [`library-init:${api.apiOrigin ?? "https://api.notion.com"}:${parent}`],
      Effect.gen(function* () {
        const saved = yield* store.readJson(key, LibraryInitializationPendingSchema)
        if (
          saved !== undefined &&
          (saved.scope !== scope ||
            saved.parent_page_id !== parent ||
            (mode !== "reconcile" && saved.operation_id !== operation))
        )
          return yield* Effect.fail(
            fail(
              "LIBRARY_INIT_INCOMPLETE",
              "An unfinished initialization already owns this parent. Preserve its state and resume its original operation.",
              { operation_id: saved.operation_id, parent_page_id: saved.parent_page_id },
            ),
          )
        let current: LibraryInitializationPending =
          saved?.operation_id === operation
            ? saved
            : {
                version: 2,
                scope,
                operation_id: operation,
                parent_page_id: parent,
                root_page_id: null,
                tables: {},
                in_flight: null,
              }
        let persisted = saved?.operation_id === operation
        const save = (next: LibraryInitializationPending) =>
          Effect.gen(function* () {
            yield* store.writeJson(key, next)
            current = next
            persisted = true
          })
        const requireResumeState = () =>
          mode === "resume" && !persisted
            ? Effect.fail(
                fail(
                  "LIBRARY_INIT_STATE_REQUIRED",
                  "Continuation needs this operation's original local state. Keep NTN_SKILLS_HOME and reconcile the known objects; an absent table is not permission to recreate it.",
                  { operation_id: operation, parent_page_id: parent },
                ),
              )
            : Effect.void
        const rememberRoot = (root: string) =>
          Effect.gen(function* () {
            if (current.root_page_id !== null && current.root_page_id !== root)
              return yield* Effect.fail(
                fail("LIBRARY_INIT_CONFLICT", "The known initialization root was replaced."),
              )
            if (mode === "reconcile") return
            const next = {
              ...current,
              root_page_id: root,
              in_flight: current.in_flight?.action === "create:root" ? null : current.in_flight,
            }
            if (canonicalSharedJson(next) !== canonicalSharedJson(current)) yield* save(next)
          })
        const verifyTable = (role: LibraryTableRole, table: TableBinding) => {
          const known = current.tables[role]
          return known !== undefined && !preservesTableBinding(known, table)
            ? Effect.fail(
                fail(
                  "LIBRARY_INIT_CONFLICT",
                  "A known initialization table or property identity changed.",
                  { role, operation_id: operation, database_id: known.database_id },
                ),
              )
            : Effect.void
        }
        const remember = (
          tables: LibraryInitializationPending["tables"],
          action: LibraryInitializationAction,
        ) =>
          Effect.gen(function* () {
            if (mode === "reconcile") return
            for (const role of ["Skills", "Files", "Records", "Sources"] as const) {
              const table = tables[role]
              if (table !== undefined) yield* verifyTable(role, table)
            }
            const next = {
              ...current,
              tables: { ...current.tables, ...tables },
              in_flight: current.in_flight?.action === action ? null : current.in_flight,
            }
            if (canonicalSharedJson(next) !== canonicalSharedJson(current)) yield* save(next)
          })
        const perform = <B, R2>(
          action: LibraryInitializationAction,
          replay: "never" | "idempotent",
          work: Effect.Effect<B, SkillsError, R2 | Notion>,
        ) =>
          work.pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) =>
                Effect.gen(function* () {
                  const method = options?.method ?? (body === undefined ? "GET" : "POST")
                  if (method === "GET") return yield* api.request(path, body, options)
                  if (mode === "reconcile")
                    return yield* Effect.fail(
                      fail("LIBRARY_INIT_INCOMPLETE", "Reconciliation cannot write."),
                    )
                  yield* requireResumeState()
                  const marker = {
                    action,
                    request_sha256: yield* sha256(canonicalSharedJson({ path, body, method })),
                  }
                  if (current.in_flight !== null) {
                    if (canonicalSharedJson(current.in_flight) !== canonicalSharedJson(marker))
                      return yield* Effect.fail(
                        fail(
                          "LIBRARY_INIT_CONFLICT",
                          "Reconcile the original initialization action before changing its input.",
                          { pending_action: current.in_flight.action },
                        ),
                      )
                    if (mode !== "resume" || replay === "never")
                      return yield* Effect.fail(
                        fail(
                          "LIBRARY_INIT_UNKNOWN",
                          "The original creation is not yet visible; absence cannot authorize a repeated write.",
                          { pending_action: action },
                        ),
                      )
                  }
                  yield* save({ ...current, in_flight: marker })
                  const result = yield* api.request(path, body, options).pipe(Effect.result)
                  if (result._tag === "Failure") {
                    const details = property(result.failure.details)
                    if (
                      details.phase === "input_rejected" ||
                      details.phase === "definitive_rejection" ||
                      result.failure.code === "REQUEST_BUDGET_EXHAUSTED"
                    )
                      yield* save({ ...current, in_flight: null })
                    return yield* Effect.fail(result.failure)
                  }
                  return result.success
                }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
            }),
          )
        return yield* use({
          pending: () => current,
          requireResumeState,
          rememberRoot,
          verifyTable,
          remember,
          perform,
          finish: () =>
            mode === "reconcile" || !persisted
              ? Effect.void
              : store.retireKeys([key]).pipe(Effect.asVoid),
        }).pipe(
          Effect.mapError((error) =>
            fail(error.code, error.message, {
              ...property(error.details),
              operation_id: operation,
              parent_page_id: parent,
              root_page_id: current.root_page_id,
              known_tables: Object.fromEntries(
                Object.entries(current.tables).map(([role, table]) => [role, table.database_id]),
              ),
              pending_action: current.in_flight?.action ?? null,
              reconcile: {
                argv: [
                  "ntn-skills",
                  "ctl",
                  "library",
                  "init",
                  "--parent",
                  parent,
                  "--operation",
                  operation,
                ],
              },
              resume: {
                argv: [
                  "ntn-skills",
                  "ctl",
                  "library",
                  "init",
                  "--parent",
                  parent,
                  "--operation",
                  operation,
                  "--resume",
                ],
              },
            }),
          ),
        )
      }),
    )
  })
}
