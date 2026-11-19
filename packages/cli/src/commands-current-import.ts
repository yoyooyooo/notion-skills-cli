import { Crypto, Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { importDocument, loadImport, type ImportFile } from "../../core/src/import.ts"
import { entrypointFor, fail, SkillsError } from "../../core/src/model.ts"
import { MANIFEST, readPortable } from "../../core/src/portable.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { currentWriteIdentity } from "../../core/src/shared-current-write-input.ts"
import {
  inspectCurrentSkillWrite,
  prepareCurrentSkillWrite,
  writeCurrentSkill,
} from "../../core/src/shared-current-write.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

type ImportOptions = {
  readonly skillId: string
  readonly name?: string
  readonly description?: string
}

function currentImportInput(
  loaded: {
    readonly kind: "markdown" | "directory" | "zip"
    readonly files: readonly ImportFile[]
  },
  options: ImportOptions,
) {
  const manifest = loaded.files.find((file) => file.path === MANIFEST)
  if (manifest !== undefined) {
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes),
    )
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw fail("INVALID_ARCHIVE", "The current portable manifest must be one JSON object.")
    if (
      !("format" in raw) ||
      raw.format !== "ntn-skills" ||
      !("version" in raw) ||
      raw.version !== 2
    )
      throw fail(
        "CURRENT_IMPORT_UNSUPPORTED",
        "Import accepts only the current ntn-skills portable manifest version 2.",
      )
    const allowed = new Set(["format", "version", "kind", "name", "description", "main"])
    const unsupported = Object.keys(raw).filter((key) => !allowed.has(key))
    if (unsupported.length)
      throw fail(
        "CURRENT_IMPORT_UNSUPPORTED",
        "This import preserves the complete current file tree. Portable relations, retained projections and unknown manifest fields require an explicit supported writer; they are never discarded.",
        { fields: unsupported },
      )
    const portable = readPortable(loaded.files)
    if (portable === undefined) throw fail("INVALID_ARCHIVE", "The portable manifest is missing.")
    if (portable.main !== entrypointFor(portable.kind))
      throw fail(
        "CURRENT_IMPORT_ENTRYPOINT",
        "The portable main must use its kind's canonical entrypoint. Multi-file paths are preserved exactly.",
        { main: portable.main, required: entrypointFor(portable.kind) },
      )
    return {
      skill_id: options.skillId,
      kind: portable.kind,
      name: options.name ?? portable.name,
      description: options.description ?? portable.description,
      files: portable.files,
    }
  }
  const original =
    loaded.kind === "markdown"
      ? loaded.files[0]
      : loaded.files.find((file) => file.path === "SKILL.md")
  if (original === undefined)
    throw fail(
      "CURRENT_IMPORT_ENTRYPOINT",
      "A directory or ZIP must contain SKILL.md at its root. Import a single Markdown file explicitly to name its entrypoint SKILL.md.",
    )
  const metadata = importDocument(original, options)
  return {
    skill_id: options.skillId,
    kind: "skill" as const,
    name: metadata.name,
    description: metadata.description,
    files: loaded.kind === "markdown" ? [{ ...original, path: "SKILL.md" }] : loaded.files,
  }
}

/** Finish complete local admission before any library or Notion request. */
export function prepareCurrentImport(input: string, options: ImportOptions) {
  return Effect.gen(function* () {
    const loaded = yield* loadImport(input)
    const admitted = yield* Effect.try({
      try: () => currentImportInput(loaded, options),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_ARCHIVE", "Could not decode the complete current import input."),
    })
    const plan = yield* prepareCurrentSkillWrite(admitted)
    return {
      plan,
      input: {
        kind: loaded.kind,
        files: plan.files.length,
        bytes: plan.files.reduce((size, file) => size + file.bytes.byteLength, 0),
        entrypoint: plan.main,
        ...(loaded.kind === "markdown" && loaded.files[0]!.path !== plan.main
          ? { renamed_entrypoint_from: loaded.files[0]!.path }
          : {}),
      },
    }
  })
}

export const currentImportCommand = defineCommand(
  "import",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription("Complete local directory, portable ZIP, or one Markdown file"),
    ),
    entry: requiredSingleton("entry", "Current Skills database ID, URL or exact registered alias"),
    skillId: requiredSingleton(
      "skill-id",
      "Exact stable Skill ID to create or replace in this library",
    ),
    operation: singleton(
      "operation",
      "Stable operation identity; required when resuming the same complete input",
    ),
    resume: switchFlag(
      "resume",
      "Reconcile and continue this exact current import using --operation",
    ),
    dryRun: switchFlag(
      "dry-run",
      "Inspect complete input and current target without allocating an operation or writing Notion",
    ),
    name: singleton(
      "name",
      "Override the Notion display name while preserving original file bytes",
    ),
    description: singleton(
      "description",
      "Override Notion metadata while preserving original file bytes",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const selectedOperation = Option.getOrUndefined(options.operation)
      if (options.resume && (selectedOperation === undefined || options.dryRun))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "--resume requires --operation and cannot be combined with --dry-run.",
          ),
        )
      if (selectedOperation !== undefined)
        yield* Effect.try({
          try: () => currentWriteIdentity(selectedOperation, "Operation ID"),
          catch: (error) => error as SkillsError,
        })
      const prepared = yield* prepareCurrentImport(options.input, {
        skillId: options.skillId,
        name: Option.getOrUndefined(options.name),
        description: Option.getOrUndefined(options.description),
      })
      const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
      if (options.dryRun) {
        yield* emit({
          ...(yield* inspectCurrentSkillWrite(library, prepared.plan)),
          input: prepared.input,
          dry_run: true,
        })
        return
      }
      const operation = selectedOperation ?? (yield* (yield* Crypto.Crypto).randomUUIDv4())
      yield* emit({
        ...(yield* writeCurrentSkill(library, {
          plan: prepared.plan,
          operation_id: operation,
          mode: options.resume ? "resume" : "apply",
        })),
        input: prepared.input,
      })
    }),
).pipe(
  withConstraints([exclusiveFlags(["resume", "dryRun"])]),
  Command.withDescription(
    "Import one complete current Skill under an exact stable Skill ID. Existing files absent from the input are removed by the current writer. Every original file keeps its exact bytes and executable mode as a Notion resource with a readable page projection. A plain directory or ZIP requires root SKILL.md; a current portable manifest may select Skill, Router or Prompt with its canonical entrypoint. Only an explicitly selected single Markdown file is renamed to SKILL.md. Symbolic links, changing trees, unsupported portable relations/projections and oversized input are rejected before Notion access. --dry-run only inspects. Resume with the same input and --operation ID --resume; no name matching, automatic retry of unknown writes or historical recovery route.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library import ./skill --entry LIBRARY_ID --skill-id my-skill --dry-run",
      description: "Review the complete current replacement without writing",
    },
    {
      command:
        "ntn-skills ctl library import ./skill --entry LIBRARY_ID --skill-id my-skill --operation IMPORT_ID",
      description: "Apply the complete original file tree under one current operation",
    },
    {
      command:
        "ntn-skills ctl library import ./skill --entry LIBRARY_ID --skill-id my-skill --operation IMPORT_ID --resume",
      description: "Reconcile and continue the same current import",
    },
  ]),
)
