import { Clock, Effect, FileSystem, Option } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { fail, SkillsError } from "./model.ts"
import { RequestBudget } from "./request-budget.ts"
import { readCurrentSourceGitOrigin } from "./shared-current-source.ts"
import { validateCurrentSourceInput } from "./shared-current-source-input.ts"
import type { CurrentSourceManagement } from "./shared-current-source-management.ts"
import { canonicalGitUrl, gitRemoteUrl, isGithubGitUrl } from "./shared-git-origin.ts"
import { makeBoundedImmutableReadCoalescer } from "./shared-immutable-read.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { runSourceGit } from "./upstream-source.ts"

const REF_OUTPUT_LIMIT = 32 * 1024
const BATCH_ENTRIES = 256
const oid = /^[a-f0-9]{40}$/u
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_CHECK_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current Source check is invalid."),
  })

/** Same normalized declaration identity used by preparation, with no discovery or
 * Notion reads. It includes selection, options and complete member contributions. */
export function currentSourceConfigurationFingerprint(input: unknown) {
  return checked(() => validateCurrentSourceInput(input)).pipe(
    Effect.flatMap((declaration) => sha256(canonicalSharedJson(declaration))),
  )
}

export type CurrentSourceRefObservation = {
  readonly url: string
  readonly ref: string
  readonly resolved_ref: string
  /** Advertised candidate. Full preparation still verifies that this is a commit
   * and validates its complete selected tree before any publication. */
  readonly resolved_commit: string
  readonly observed_at: number
}

export type CurrentSourceCheckBatch = {
  readonly run: (
    identity: string,
    execute: Effect.Effect<CurrentSourceRefObservation, SkillsError>,
  ) => Effect.Effect<CurrentSourceRefObservation, SkillsError>
}

/** Create once per invocation. Scheduling owns the interval; this is neither a
 * cross-run TTL nor an authorization cache. Only successful observations survive
 * within this bounded batch, and pending callers share cancellation ownership. */
export function makeCurrentSourceCheckBatch(): Effect.Effect<CurrentSourceCheckBatch> {
  return Effect.gen(function* () {
    const pending = yield* makeBoundedImmutableReadCoalescer<CurrentSourceRefObservation>({
      entries: BATCH_ENTRIES,
      bytes: BATCH_ENTRIES * REF_OUTPUT_LIMIT,
    })
    const complete = new Map<string, CurrentSourceRefObservation>()
    return {
      run: (identity, execute) =>
        Effect.suspend(() => {
          const observed = complete.get(identity)
          if (observed !== undefined) return Effect.succeed(observed)
          return pending.run(
            identity,
            REF_OUTPUT_LIMIT,
            execute.pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  if (complete.size >= BATCH_ENTRIES) {
                    const first = complete.keys().next()
                    if (!first.done) complete.delete(first.value)
                  }
                  complete.set(identity, value)
                }),
              ),
            ),
          )
        }),
    } satisfies CurrentSourceCheckBatch
  })
}

function validRefName(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 4096 &&
    ref !== "@" &&
    !ref.startsWith("-") &&
    !ref.endsWith(".") &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !/[\u0000-\u0020\u007f-\u009f~^:?*\[\\]/u.test(ref) &&
    ref.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  )
}

function exactRefs(ref: string): readonly string[] {
  if (!validRefName(ref) || oid.test(ref))
    throw invalid("Use HEAD, an exact branch or tag, or an unambiguous short Git ref.")
  if (ref === "HEAD") return [ref]
  if (ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) return [ref]
  if (ref.startsWith("refs/"))
    throw invalid("Only exact branch and tag namespaces support upstream checks.")
  return [`refs/heads/${ref}`, `refs/tags/${ref}`]
}

function parseRefObservation(bytes: Uint8Array, ref: string, refs: readonly string[]) {
  const advertised = new Map<string, string>()
  const symbolic = new Map<string, string>()
  const allowed = new Set(refs.flatMap((name) => [name, `${name}^{}`]))
  const output = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  for (const line of output.split("\n")) {
    if (line === "") continue
    const parts = line.split("\t")
    const value = parts[0],
      name = parts[1]
    if (parts.length !== 2 || value === undefined || name === undefined || !allowed.has(name))
      throw invalid("Git returned an unexpected ref advertisement.")
    if (value.startsWith("ref: ")) {
      const target = value.slice(5)
      if (
        !validRefName(target) ||
        !target.startsWith("refs/") ||
        symbolic.has(name) ||
        name.endsWith("^{}")
      )
        throw invalid("Git returned an invalid symbolic ref advertisement.")
      symbolic.set(name, target)
    } else {
      if (!oid.test(value) || advertised.has(name))
        throw invalid("Git returned an invalid or repeated exact object identity.")
      advertised.set(name, value)
    }
  }
  const selected = refs.filter((name) => advertised.has(name))
  const name = selected[0]
  if (name === undefined)
    throw fail("CURRENT_SOURCE_REF_MISSING", "The exact upstream ref is not advertised.", { ref })
  if (selected.length !== 1)
    throw fail("CURRENT_SOURCE_REF_AMBIGUOUS", "Use refs/heads/ or refs/tags/ for this ref.", {
      ref,
      candidates: selected,
    })
  for (const key of advertised.keys())
    if (key.endsWith("^{}") && !advertised.has(key.slice(0, -3)))
      throw invalid("Git returned a peeled object without its exact tag.")
  const commit = advertised.get(`${name}^{}`) ?? advertised.get(name)
  if (commit === undefined) throw invalid("Git did not identify the selected ref.")
  return { resolved_ref: symbolic.get(name) ?? name, resolved_commit: commit }
}

type RefRuntime = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

/** One ls-remote reads only ref advertisements. It neither fetches a repository
 * tree nor uses a provider-specific REST API. The existing Git process boundary
 * owns credentials, cancellation, timeouts, output limits and invocation budget. */
export function observeCurrentSourceRef(input: {
  readonly url: string
  readonly ref: string
  /** Opaque invocation access scope. Never share a batch across credentials. */
  readonly scope: string
  readonly batch?: CurrentSourceCheckBatch
}): Effect.Effect<CurrentSourceRefObservation, SkillsError, RefRuntime> {
  return Effect.gen(function* () {
    const { url, ref, refs, scope, batch } = yield* checked(() => {
      if (!input.scope || input.scope.length > 8192)
        throw invalid("An upstream observation requires a bounded access scope.")
      return {
        url: canonicalGitUrl(input.url),
        ref: input.ref,
        refs: exactRefs(input.ref),
        scope: input.scope,
        batch: input.batch,
      }
    })
    const budget = yield* Effect.serviceOption(RequestBudget)
    if (Option.isSome(budget)) yield* budget.value.check
    const observe = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "ntn-source-ref-" })
          .pipe(
            Effect.mapError(() =>
              invalid("Cannot create an isolated Git ref observation directory."),
            ),
          )
        const bytes = yield* runSourceGit(
          directory,
          [
            ...(isGithubGitUrl(url) ? ["-c", "http.version=HTTP/1.1"] : []),
            "ls-remote",
            "--symref",
            "--",
            gitRemoteUrl(url),
            ...refs.flatMap((name) =>
              name.startsWith("refs/tags/") ? [name, `${name}^{}`] : [name],
            ),
          ],
          REF_OUTPUT_LIMIT,
        )
        const selected = yield* checked(() => parseRefObservation(bytes, ref, refs))
        return Object.freeze({
          url,
          ref,
          ...selected,
          observed_at: yield* Clock.currentTimeMillis,
        })
      }),
    )
    if (batch === undefined) return yield* observe
    const identity = canonicalSharedJson([
      scope,
      Option.isSome(budget) ? budget.value.identity : null,
      url,
      ref,
    ])
    const context = yield* Effect.context<RefRuntime>()
    return yield* batch.run(identity, observe.pipe(Effect.provide(context)))
  })
}

type CheckIdentity = {
  readonly source_id: string
  readonly source_page_id: string
  readonly configuration_sha256: string
  readonly current_configuration_sha256: string
}
type CheckedUpstream = {
  readonly selected_commit: string | null
  readonly observation: CurrentSourceRefObservation
}
export type CurrentSourceCheckResult = CheckIdentity &
  (
    | { readonly status: "skipped"; readonly reason: "disabled" | "pinned" | "fixed_ref" }
    | (CheckedUpstream & { readonly status: "upstream_unchanged" })
    | (CheckedUpstream & {
        readonly status: "update_available"
        readonly reason:
          | "configuration_changed"
          | "origin_changed"
          | "upstream_changed"
          | "selection_unsupported"
      })
  )

/** The coordinator owns complete pending-owner preflight and the last successful
 * configuration receipt. This result compares current inputs and upstream only;
 * upstream_unchanged does not certify current targets or reading projections. */
export function checkCurrentSource(
  library: SharedLibrary,
  input: {
    readonly current: CurrentSourceManagement
    readonly declaration?: unknown
    readonly scope: string
    readonly batch?: CurrentSourceCheckBatch
  },
) {
  return Effect.gen(function* () {
    const current = yield* checked(() => validateCurrentSourceInput(input.current.declaration))
    const declaration = yield* checked(() =>
      validateCurrentSourceInput(input.declaration ?? current),
    )
    const definition = declaration.definition
    yield* checked(() => {
      if (definition.source_id !== current.definition.source_id)
        throw invalid("A Source check cannot change its selected stable identity.")
      if (input.current.state.state !== "ready")
        throw fail("CURRENT_SOURCE_CHECK_PENDING", "Resume the current Source operation first.", {
          source_id: definition.source_id,
          operation_id: input.current.state.operation_id,
        })
    })
    const identity: CheckIdentity = {
      source_id: definition.source_id,
      source_page_id: input.current.page_id,
      configuration_sha256: yield* sha256(canonicalSharedJson(declaration)),
      current_configuration_sha256: yield* sha256(canonicalSharedJson(current)),
    }
    if (!definition.enabled)
      return {
        ...identity,
        status: "skipped",
        reason: "disabled",
      } satisfies CurrentSourceCheckResult
    if (definition.policy === "pinned")
      return { ...identity, status: "skipped", reason: "pinned" } satisfies CurrentSourceCheckResult
    if (definition.adapter.type !== "git")
      return yield* Effect.fail(invalid("Only current Git declarations support upstream checks."))
    if (definition.options.accepted_ref !== undefined || oid.test(definition.adapter.ref))
      return {
        ...identity,
        status: "skipped",
        reason: "fixed_ref",
      } satisfies CurrentSourceCheckResult
    const selected = yield* readCurrentSourceGitOrigin(library, {
      source_id: definition.source_id,
      page_id: input.current.page_id,
      revision: input.current.revision,
      content: input.current.content,
    })
    const observation = yield* observeCurrentSourceRef({
      url: definition.adapter.url,
      ref: definition.adapter.ref,
      scope: input.scope,
      batch: input.batch,
    })
    const observed = { ...identity, selected_commit: selected?.commit ?? null, observation }
    const reason =
      identity.configuration_sha256 !== identity.current_configuration_sha256
        ? "configuration_changed"
        : selected === undefined
          ? "selection_unsupported"
          : canonicalGitUrl(selected.url) !== observation.url
            ? "origin_changed"
            : selected.commit !== observation.resolved_commit
              ? "upstream_changed"
              : undefined
    return reason === undefined
      ? ({ ...observed, status: "upstream_unchanged" } satisfies CurrentSourceCheckResult)
      : ({ ...observed, status: "update_available", reason } satisfies CurrentSourceCheckResult)
  })
}

export type CurrentSourceRefObserver = typeof observeCurrentSourceRef
export type CurrentSourceChecker = typeof checkCurrentSource
