import { Effect, FileSystem, Path, Schema } from "effect"
import { loadImport, type ImportFile } from "../../core/src/import.ts"
import { ContentKindSchema, fail, type ContentKind } from "../../core/src/model.ts"
import { MANIFEST, portableFiles, portableZip, readPortable } from "../../core/src/portable.ts"
import { sha256 } from "../../core/src/store.ts"

// This historical schema is reachable only from the separately built operator artifact.
const OldManifest = Schema.Struct({
  format: Schema.Literal("ntn-skills"),
  version: Schema.Literal(1),
  name: Schema.String,
  description: Schema.String,
  main: Schema.String,
  projection: Schema.optional(Schema.Unknown),
})
const encoder = new TextEncoder()
export function convertPortable(input: readonly ImportFile[], selectedKind?: ContentKind) {
  const manifests = input.filter((file) => file.path === MANIFEST)
  if (manifests.length !== 1)
    throw fail("INVALID_ARCHIVE", "Conversion requires exactly one manifest.")
  const manifest = Schema.decodeUnknownSync(OldManifest)(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifests[0]!.bytes)),
    { onExcessProperty: "error" },
  )
  const kind = Schema.decodeUnknownSync(ContentKindSchema)(selectedKind ?? "skill")
  // Reuse the current complete path/main/projection validator only after explicit conversion.
  const converted = input.map((file) =>
    file.path === MANIFEST
      ? {
          path: MANIFEST,
          bytes: encoder.encode(JSON.stringify({ ...manifest, version: 2, kind }) + "\n"),
        }
      : file,
  )
  const portable = readPortable(converted)!
  return {
    portable,
    files: portableFiles(portable, true),
    kindSelection: selectedKind === undefined ? "audited-default-skill" : "explicit",
  }
}

export function convertPath(input: string, output: string, kind?: ContentKind) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const source = path.resolve(input)
    const destination = path.resolve(output)
    if (destination === source || destination.startsWith(source + path.sep))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Output must be new and outside the input."),
      )
    if (yield* fs.exists(destination))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Output already exists; original input is never overwritten."),
      )
    const { files } = yield* loadImport(source)
    const converted = yield* Effect.try({
      try: () => convertPortable(files, kind),
      catch: (error) => error,
    })
    const inventory = yield* Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        return { path: file.path, bytes: file.bytes.length, sha256: yield* sha256(file.bytes) }
      }),
    )
    const outputInventory = yield* Effect.forEach(converted.files, (file) =>
      Effect.gen(function* () {
        return { path: file.path, bytes: file.bytes.length, sha256: yield* sha256(file.bytes) }
      }),
    )
    const audit = {
      format: "portable-v1-to-v2",
      input: source,
      output: destination,
      kind: converted.portable.kind,
      kind_selection: converted.kindSelection,
      input_inventory: inventory,
      output_inventory: outputInventory,
      remote_writes: 0,
    }
    // A new container holds both output and audit; input bytes are never written.
    yield* fs.makeDirectory(destination, { recursive: false })
    yield* fs.writeFile(
      path.join(destination, "converted.zip"),
      portableZip(converted.portable, true),
      { flag: "wx" },
    )
    yield* fs.writeFileString(
      path.join(destination, "audit.json"),
      JSON.stringify(audit, null, 2) + "\n",
      { flag: "wx" },
    )
    return audit
  })
}
