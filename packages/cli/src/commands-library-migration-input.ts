import { Effect, FileSystem, Path, Schema } from "effect"
import { loadImport } from "../../core/src/import.ts"
import { fail, property, SkillsError } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import { MANIFEST, readPortable } from "../../core/src/portable.ts"
import type { SharedLibrary } from "../../core/src/shared-library-model.ts"
import {
  reviewSharedMigrationCreateInput,
  selectSharedMigrationReviewPolicy,
} from "../../core/src/shared-migration-create-binding.ts"
import {
  MigrationNativePreimageSchema,
  type MigrationConversionInput,
  type MigrationSourceFile,
} from "../../core/src/shared-migration-conversion.ts"
import { SharedMigrationInputSchema } from "../../core/src/shared-migration-plan.ts"

const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "MIGRATION_INPUT_INVALID",
            "The frozen migration input or retained evidence is invalid.",
          ),
  })
function bytesAt(filename: string) {
  return Effect.gen(function* () {
    if (!filename)
      return yield* Effect.fail(
        fail("MIGRATION_INPUT_INVALID", "Provide a nonempty exact input path."),
      )
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      location = path.resolve(filename)
    const info = yield* fs
      .stat(location)
      .pipe(
        Effect.mapError(() =>
          fail(
            "MIGRATION_INPUT_READ_FAILED",
            "Could not inspect the frozen migration input file.",
            { input: location },
          ),
        ),
      )
    if (info.type !== "File")
      return yield* Effect.fail(
        fail("MIGRATION_INPUT_NOT_FILE", "Input must identify one regular file.", {
          input: location,
        }),
      )
    return yield* fs.readFile(location).pipe(
      Effect.mapError(() =>
        fail("MIGRATION_INPUT_READ_FAILED", "Could not read the frozen migration input file.", {
          input: location,
        }),
      ),
    )
  })
}
export function readMigrationJson(filename: string) {
  return Effect.gen(function* () {
    const bytes = yield* bytesAt(filename)
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () =>
        fail(
          "MIGRATION_INPUT_INVALID_UTF8",
          "The frozen input must contain valid UTF-8; invalid original bytes were not replaced.",
        ),
    })
    return yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () =>
        fail("MIGRATION_INPUT_INVALID_JSON", "The frozen migration input is not valid JSON."),
    })
  })
}

/** Read explicit exported/retained trees only. No SQLite lookup, live native
 * read, provider fetch, classification or approval modification is performed. */
export function readMigrationRetained(input: {
  readonly migrationInput: unknown
  readonly legacyId: string
  readonly library: SharedLibrary
  readonly files: string
  readonly preimages: string
  readonly sourceFiles?: string
}) {
  return Effect.gen(function* () {
    const frozen = yield* checked(() =>
      Schema.decodeUnknownSync(SharedMigrationInputSchema)(input.migrationInput, {
        onExcessProperty: "error",
      }),
    )
    const matches = frozen.catalog.entries.filter((entry) => entry.legacy_id === input.legacyId),
      selected = matches[0]
    if (matches.length !== 1 || selected === undefined)
      return yield* Effect.fail(
        fail(
          "MIGRATION_INPUT_INVALID",
          "Select one exact observed legacy identity from the frozen input.",
        ),
      )
    const imported = yield* loadImport(input.files)
    const files = yield* checked(() =>
      selected.files.map((file) => {
        const matches = imported.files.filter((item) => item.path === file.path),
          retained = matches[0]
        if (matches.length !== 1 || retained === undefined || file.body === undefined)
          throw fail(
            "SHARED_MIGRATION_CONVERSION_ORIGINAL",
            "Every declared managed file must have its exact retained bytes.",
            { path: file.path },
          )
        return {
          legacy_id: file.legacy_id,
          retention_ref: file.body.retention_ref,
          bytes: retained.bytes,
        }
      }),
    )
    const executionPolicy = selectSharedMigrationReviewPolicy(selected)
    const prepared = yield* reviewSharedMigrationCreateInput(
      {
        migration_input: frozen,
        legacy_id: input.legacyId,
        library: input.library,
        files,
      },
      executionPolicy,
    )
    const path = yield* Path.Path
    const nativeFiles: MigrationConversionInput["files"][number][] = []
    for (const file of selected.files) {
      const descriptor = property(property(file.raw).native_preimage)
      const selection = yield* checked(() => {
        const page = typeof descriptor.page_id === "string" ? pageId(descriptor.page_id) : undefined
        if (
          !page ||
          page !== descriptor.page_id ||
          (descriptor.markdown_version !== "default" && descriptor.markdown_version !== "v2")
        )
          throw fail(
            "SHARED_MIGRATION_CONVERSION_PREIMAGE",
            "Freeze the actual native preimage descriptor before review. A materialized snapshot is not a raw response.",
            { path: file.path },
          )
        return { page, version: descriptor.markdown_version }
      })
      const raw = yield* bytesAt(
        path.join(input.preimages, `${selection.page}.${selection.version}.json`),
      )
      const responseJson = yield* checked(() =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw),
      )
      const native = yield* checked(() => {
        const {
          response_sha256: _hash,
          response_bytes: _bytes,
          body_sha256: _body,
          ...request
        } = descriptor
        return Schema.decodeUnknownSync(MigrationNativePreimageSchema)(
          { ...request, response_json: responseJson },
          { onExcessProperty: "error" },
        )
      })
      const retained = files.find((item) => item.legacy_id === file.legacy_id)
      if (!retained)
        return yield* Effect.fail(
          fail("MIGRATION_INPUT_INVALID", "A selected retained file is unavailable."),
        )
      nativeFiles.push({ ...retained, native_preimage: native })
    }
    const sourceFiles: MigrationSourceFile[] = [],
      unselectedSourcePaths: string[] = []
    if (prepared.source === null) {
      if (input.sourceFiles !== undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CONVERSION_SOURCE",
            "This frozen target has no selected Source; do not attach unrelated source files.",
          ),
        )
    } else {
      if (input.sourceFiles === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CONVERSION_SOURCE",
            "Supply --source-files with the complete exact retained fixed Source tree.",
          ),
        )
      const source = yield* loadImport(input.sourceFiles)
      // A standard export container is accepted without treating its manifest
      // as Git content. Its bytes never select metadata, ownership or a body.
      const portable = prepared.source.files.some((file) => file.path === MANIFEST)
        ? undefined
        : yield* checked(() => readPortable(source.files))
      const retainedSourceFiles = portable?.files ?? source.files
      if (portable !== undefined) unselectedSourcePaths.push(MANIFEST)
      if (retainedSourceFiles.length !== prepared.source.files.length)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CONVERSION_SOURCE",
            "The retained Source tree must have exactly the inspected fixed paths, including non-page assets.",
          ),
        )
      for (const expected of prepared.source.files) {
        const matches = retainedSourceFiles.filter((file) => file.path === expected.path),
          actual = matches[0]
        if (matches.length !== 1 || !actual)
          return yield* Effect.fail(
            fail(
              "SHARED_MIGRATION_CONVERSION_SOURCE",
              "An inspected Source path is missing or duplicated.",
              { path: expected.path },
            ),
          )
        sourceFiles.push({
          path: actual.path,
          retention_ref: `git-blob:${expected.git_oid}`,
          bytes: actual.bytes,
        })
      }
    }
    return {
      input: {
        migration_input: frozen,
        legacy_id: input.legacyId,
        library: input.library,
        execution_policy: executionPolicy,
        files: nativeFiles,
        source_files: sourceFiles,
      } satisfies MigrationConversionInput,
      unselected_input_paths: imported.files
        .filter((file) => !selected.files.some((declared) => declared.path === file.path))
        .map((file) => file.path)
        .sort(),
      unselected_source_input_paths: unselectedSourcePaths,
    }
  })
}
