import { Clock, Effect, FileSystem, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property, SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { pageId } from "../../core/src/ref.ts"
import { sharedRecordFromPage } from "../../core/src/shared-content.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import type { SharedLibrary } from "../../core/src/shared-library-model.ts"
import { createRequestMetrics } from "../../core/src/request-metrics.ts"
import {
  bindSharedLocalResource,
  clearSharedHttpLocations,
  configureSharedHttpLocations,
  configureSharedHttpOrigins,
  loadSharedSourceOptions,
  sharedSourceResourceConfiguration,
  unbindSharedLocalResource,
} from "../../core/src/shared-source-config.ts"
import { registerSourcePlanBinding } from "../../core/src/shared-source-plan-binding.ts"
import { reconcileSharedSourceRegistration } from "../../core/src/shared-source-registration-reconcile.ts"
import {
  inspectSharedSourcePlan,
  materializeSharedSourcePlan,
  sharedSourcePlanId,
} from "../../core/src/shared-source-plan.ts"
import {
  applySharedSourceSelection,
  prepareSharedSourceSelection,
  validateSharedSourceSelectionPlan,
} from "../../core/src/shared-source-selection.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

const entry = requiredSingleton("entry", "Exact shared library database entry")
function checked<A>(operation: () => A) {
  return Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "INVALID_SOURCE_MANIFEST",
            "The selected JSON input is not a valid fixed source or original operation.",
          ),
  })
}
function readJsonInput(filename: string) {
  return Effect.gen(function* () {
    const content = yield* (yield* FileSystem.FileSystem)
      .readFileString(filename)
      .pipe(
        Effect.mapError(() =>
          fail(
            "SOURCE_MANIFEST_UNAVAILABLE",
            "The explicit source manifest or original operation file could not be read.",
          ),
        ),
      )
    return yield* checked(() => {
      if (content.length > 4 * 1024 * 1024)
        throw fail(
          "SOURCE_MANIFEST_TOO_LARGE",
          "The selected source JSON exceeds the supported input size.",
        )
      return JSON.parse(content) as unknown
    })
  })
}
function exactPage(input: string) {
  return checked(() => {
    const id = pageId(input)
    if (!id) throw fail("INVALID_ARGUMENT", "Choose an exact shared Skill page ID or URL.")
    return id
  })
}
function sourceTarget(library: SharedLibrary, input: string, enabled = true) {
  return Effect.gen(function* () {
    const id = yield* exactPage(input)
    const raw = yield* (yield* Notion).request(`v1/pages/${id}`)
    yield* checked(() => {
      const record = sharedRecordFromPage(
        raw,
        {
          alias: library.library_id,
          database_id: library.skills.database_id,
          data_source_ids: [library.skills.data_source_id],
          title: "",
          role: "content",
          shared_library: library,
        },
        library.skills.data_source_id,
      )
      if (record.locator.page_id !== id || (enabled && !record.enabled))
        throw fail("SHARED_SOURCE_SCOPE", "The exact Skill is unavailable in this shared library.")
    })
    return id
  })
}

const compositionInspect = defineCommand(
  "inspect",
  {
    manifest: Argument.String("manifest"),
    verify: switchFlag(
      "verify",
      "Read all fixed source bytes under this machine's resource policy and verify their identities",
    ),
  },
  ({ manifest, verify }) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const raw = yield* readJsonInput(manifest)
      const inspected = yield* checked(() => inspectSharedSourcePlan(property(raw).plan ?? raw))
      const sourceId = yield* sharedSourcePlanId(inspected.plan)
      if (!verify) {
        yield* emit({
          source_plan_id: sourceId,
          revision: sourceId,
          ...inspected,
          metadata_only: true,
        })
        return
      }
      const metrics = createRequestMetrics()
      const localRequired =
        inspected.plan.base?.kind === "local" ||
        inspected.plan.mounts.some((mount) => mount.resource.kind === "local")
      const options = yield* loadSharedSourceOptions({ localRequired })
      const materialized = yield* materializeSharedSourcePlan(inspected.plan, {
        ...options,
        metrics,
      })
      yield* emit({
        source_plan_id: materialized.source_plan_id,
        revision: materialized.source_plan_id,
        paths: materialized.paths,
        local_paths: materialized.local_paths,
        verified: true,
        file_count: materialized.files.length,
        total_bytes: materialized.files.reduce((total, file) => total + file.bytes.byteLength, 0),
        elapsed_ms: (yield* Clock.currentTimeMillis) - startedAt,
        request_metrics: metrics.snapshot(),
      })
    }),
).pipe(
  Command.withDescription(
    "Inspect one fixed composition layout. --verify materializes exact bytes without executing or uploading them; local access and HTTP origins come only from machine configuration.",
  ),
)

const compositionRegister = defineCommand(
  "register",
  {
    target: Argument.String("target"),
    entry,
    manifest: requiredSingleton(
      "manifest",
      "Fixed composition plan JSON or composition inspect output",
    ),
    reconcile: switchFlag(
      "reconcile",
      "Observe the same frozen registration without repeating an unknown create",
    ),
  },
  ({ target, entry, manifest, reconcile }) =>
    Effect.gen(function* () {
      const raw = yield* readJsonInput(manifest)
      const inspected = yield* checked(() => inspectSharedSourcePlan(property(raw).plan ?? raw))
      const library = yield* loadSharedLibrary(entry)
      const skillPageId = yield* sourceTarget(library, target, !reconcile)
      const result = yield* registerSourcePlanBinding(library, {
        skillPageId,
        plan: inspected.plan,
        mode: reconcile ? "reconcile" : "create",
      })
      yield* emit({
        ...result,
        paths: inspected.paths,
        declared_local_paths: inspected.local_paths,
        metadata_only: true,
        selected: false,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Register a complete immutable Git/HTTP/local composition for one Skill. Registration reads metadata only. Select its returned ID explicitly; machine roots and signed retrieval addresses are never written into shared Records.",
  ),
)

export const librarySourceCompositionCommand = defineCommand("composition").pipe(
  Command.withSubcommands([compositionInspect, compositionRegister]),
)

export const librarySourceReconcileCommand = defineCommand(
  "reconcile",
  {
    target: Argument.String("target"),
    entry,
    source: requiredSingleton(
      "source",
      "Exact original source- or source-plan- identity returned by registration",
    ),
  },
  ({ target, entry, source }) =>
    Effect.gen(function* () {
      const library = yield* loadSharedLibrary(entry)
      const skillPageId = yield* sourceTarget(library, target, false)
      yield* emit({
        ...(yield* reconcileSharedSourceRegistration(library, { skillPageId, sourceId: source })),
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Reconcile the original frozen registration by exact ID. This never re-inspects a provider, rereads a mutable manifest, or repeats a create request.",
  ),
)

const selectPrepare = defineCommand(
  "prepare",
  {
    target: Argument.String("target"),
    entry,
    source: singleton("source", "Exact registered immutable source or source-plan ID"),
    native: switchFlag("native", "Explicitly use native Notion content and clear Source"),
    output: singleton(
      "output",
      "Save the complete frozen Source-only operation JSON for apply or reconcile",
    ),
  },
  ({ target, entry, source, native, output }) =>
    Effect.gen(function* () {
      const sourceId = Option.getOrUndefined(source)
      if ((sourceId !== undefined) === native)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Choose exactly one of --source or --native."),
        )
      const library = yield* loadSharedLibrary(entry)
      const prepared = yield* prepareSharedSourceSelection({
        library,
        skillPageId: yield* exactPage(target),
        sourceId: native ? null : (sourceId ?? ""),
      })
      const destination = Option.getOrUndefined(output)
      const saved =
        destination === undefined
          ? undefined
          : yield* (yield* Store).output(
              destination,
              new TextEncoder().encode(JSON.stringify(prepared.plan, null, 2) + "\n"),
            )
      yield* emit({
        ...prepared,
        ...(saved === undefined ? {} : { output: saved }),
        metadata_only: true,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Prepare a reviewable Source-only operation from current native metadata. This reads the exact registered source and saves before/after values; no Notion properties or bodies are written.",
  ),
)

function selectionCommand(mode: "create" | "reconcile") {
  return defineCommand(
    mode === "create" ? "apply" : "reconcile",
    {
      plan: Argument.String("plan"),
      entry,
      dryRun: switchFlag("dry-run", "Verify the original plan and selected source without writing"),
    },
    ({ plan, entry, dryRun }) =>
      Effect.gen(function* () {
        if (mode === "reconcile" && dryRun)
          return yield* Effect.fail(
            fail(
              "INVALID_ARGUMENT",
              "Reconcile is already read-only; --dry-run applies only to apply.",
            ),
          )
        const raw = yield* readJsonInput(plan)
        const frozen = yield* validateSharedSourceSelectionPlan(property(raw).plan ?? raw)
        const library = yield* loadSharedLibrary(entry)
        yield* emit({
          ...(yield* applySharedSourceSelection({ library, plan: frozen, mode, dryRun })),
          request_metrics: (yield* Notion).requestMetrics?.(),
        })
      }),
  ).pipe(
    Command.withDescription(
      mode === "create"
        ? "Apply one frozen Source-only plan through the common metadata journal. Source properties use native last-writer behavior; this is not a conditional write. An unknown prior dispatch can only reconcile."
        : "Resolve the original Source operation outcome without replaying PATCH. Current Source equality alone does not prove an unknown original request completed.",
    ),
  )
}

export const librarySourceSelectCommand = defineCommand("select").pipe(
  Command.withSubcommands([
    selectPrepare,
    selectionCommand("create"),
    selectionCommand("reconcile"),
  ]),
)

const resourceShow = defineCommand("show", {}, () =>
  Effect.gen(function* () {
    yield* emit({
      source_resources: yield* sharedSourceResourceConfiguration(),
      machine_only: true,
    })
  }),
).pipe(
  Command.withDescription(
    "Show configured resource identities and authorized origins without local roots, retrieval URLs, or credentials.",
  ),
)
const resourceBind = defineCommand(
  "bind-local",
  {
    binding: Argument.String("binding"),
    machine: singleton(
      "machine-scope",
      "Explicit machine identity on first configuration; an existing identity cannot be replaced",
    ),
    workspace: requiredSingleton(
      "workspace-scope",
      "Explicit workspace identity referenced by local source plans",
    ),
    workspaceRoot: requiredSingleton(
      "workspace-root",
      "Existing directory that defines the current workspace boundary",
    ),
    root: requiredSingleton("root", "Existing directory containing this fixed local resource"),
  },
  ({ binding, machine, workspace, workspaceRoot, root }) =>
    Effect.gen(function* () {
      yield* emit(
        yield* bindSharedLocalResource({
          bindingKey: binding,
          machineScope: Option.getOrUndefined(machine),
          workspaceScope: workspace,
          workspaceRoot,
          root,
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Explicitly authorize one local resource directory for this machine/workspace. No file bytes are read, executed, uploaded, or added to a shared source plan.",
  ),
)
const resourceUnbind = defineCommand(
  "unbind-local",
  {
    binding: Argument.String("binding"),
    workspace: requiredSingleton("workspace-scope", "Exact configured workspace identity"),
  },
  ({ binding, workspace }) =>
    Effect.gen(function* () {
      yield* emit({
        source_resources: yield* unbindSharedLocalResource({
          bindingKey: binding,
          workspaceScope: workspace,
        }),
        machine_only: true,
      })
    }),
).pipe(
  Command.withDescription(
    "Remove one exact machine/workspace binding. Existing object identities and local archive restrictions remain retained.",
  ),
)
const resourceOrigins = defineCommand(
  "http-policy",
  {
    origins: Flag.String("origin").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Authorize an exact public HTTPS origin; repeat for each origin in the replacement policy",
      ),
    ),
    denyAll: switchFlag("deny-all", "Explicitly deny every HTTP origin"),
  },
  ({ origins, denyAll }) =>
    Effect.gen(function* () {
      if (origins.length > 0 === denyAll)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Supply one or more --origin values, or --deny-all."),
        )
      yield* emit({
        source_resources: yield* configureSharedHttpOrigins(origins),
        machine_only: true,
      })
    }),
).pipe(
  Command.withDescription(
    "Replace this machine's HTTP origin allowlist. Only exact public HTTPS origins are accepted; this policy does not claim DNS-rebinding isolation. Revoked origins also lose their local retrieval overrides.",
  ),
)
const resourceLocations = defineCommand(
  "http-locations",
  {
    manifest: requiredSingleton(
      "manifest",
      "Fixed-file manifest JSON with logical path, SHA-256, and exact byte length",
    ),
    locations: requiredSingleton(
      "locations",
      "Machine-only JSON array of exact {sha256,url} retrieval addresses",
    ),
  },
  ({ manifest, locations }) =>
    Effect.gen(function* () {
      yield* emit(
        yield* configureSharedHttpLocations({
          manifest: yield* readJsonInput(manifest),
          locations: yield* readJsonInput(locations),
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Configure runtime retrieval addresses for one exact file manifest. Signed query parameters stay on this machine, and every downloaded byte must still match the shared fixed content identity.",
  ),
)
const resourceClearLocations = defineCommand(
  "clear-http-locations",
  { manifest: Argument.String("manifest") },
  ({ manifest }) =>
    Effect.gen(function* () {
      yield* emit({
        source_resources: yield* clearSharedHttpLocations(manifest),
        machine_only: true,
      })
    }),
).pipe(
  Command.withDescription(
    "Remove runtime retrieval overrides for one exact files- identity without clearing verified object bytes.",
  ),
)
export const librarySourceResourceCommand = defineCommand("resource").pipe(
  Command.withSubcommands([
    resourceShow,
    resourceBind,
    resourceUnbind,
    resourceOrigins,
    resourceLocations,
    resourceClearLocations,
  ]),
)
