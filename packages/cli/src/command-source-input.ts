import { Effect, FileSystem } from "effect"
import { fail } from "../../core/src/model.ts"
import { sourceChecked } from "../../core/src/shared-source-definitions.ts"

export function readSourceJson(path: string, maximumBytes = 48 * 1024 * 1024) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs
      .stat(path)
      .pipe(
        Effect.mapError(() =>
          fail("SOURCE_INPUT_UNAVAILABLE", "Cannot inspect the selected source JSON input."),
        ),
      )
    if (info.type !== "File" || Number(info.size) > maximumBytes)
      return yield* Effect.fail(
        fail("SOURCE_INPUT_TOO_LARGE", "The selected source JSON is not a bounded regular file."),
      )
    const raw = yield* fs
      .readFileString(path)
      .pipe(
        Effect.mapError(() =>
          fail("SOURCE_INPUT_UNAVAILABLE", "Cannot read the selected source JSON input."),
        ),
      )
    if (Buffer.byteLength(raw) > maximumBytes)
      return yield* Effect.fail(
        fail("SOURCE_INPUT_TOO_LARGE", "Source input exceeds its selected byte limit."),
      )
    return yield* sourceChecked(() => JSON.parse(raw) as unknown)
  })
}
