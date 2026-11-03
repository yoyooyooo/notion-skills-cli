import { Effect, Schema } from "effect"
import { PreparedNodeSchema, type PrepareDirectoryEntry } from "./graph-prepare-model.ts"
import { fail, property, snapshotMembers, type Snapshot } from "./model.ts"
import { currentMaterializationVersion } from "./materialization.ts"
import { fileRef } from "./ref.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

export const GRAPH_DIRECTORY_COMPILER_VERSION = 1
const DirectorySchema = Schema.Struct({
  files: PreparedNodeSchema.fields.files,
  required: PreparedNodeSchema.fields.required,
  candidates: PreparedNodeSchema.fields.candidates,
  references: PreparedNodeSchema.fields.references,
  unresolved_references: PreparedNodeSchema.fields.unresolved_references,
})
const ReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  compiler_version: Schema.Literal(1),
  scope: Schema.String,
  parent_id: Schema.String,
  snapshot_id: Schema.String,
  body_sha256: Schema.String,
  relations_sha256: Schema.String,
  input_sha256: Schema.String,
  output_sha256: Schema.String,
  directory: DirectorySchema,
})
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export const relationDirectory = (
  relations: Snapshot["required"],
): readonly PrepareDirectoryEntry[] =>
  (relations ?? [])
    .map((entry) => {
      const meta = property(entry.metadata)
      return {
        id: entry.id,
        ref: entry.ref,
        kind: meta.kind === "router" || meta.kind === "prompt" ? meta.kind : "skill",
        name: typeof meta.name === "string" ? meta.name : entry.id,
        description: typeof meta.description === "string" ? meta.description : "",
        availability: meta.enabled === false ? "disabled" : "available",
      } satisfies PrepareDirectoryEntry
    })
    .sort((a, b) => compare(a.id, b.id) || compare(a.ref, b.ref))

/**
 * Pure node-local derivation over an already verified snapshot. This cache never contains
 * instruction bytes, freshness, graph selection, or a prepared/loaded receipt.
 */
export function derivedGraphDirectory(snapshot: Snapshot, bodySha256: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const relations = {
      required: snapshot.required ?? [],
      members: snapshotMembers(snapshot) ?? [],
    }
    const relationsSha = yield* sha256(canonicalSharedJson(relations))
    const inputSha = yield* sha256(
      canonicalSharedJson({
        version: 1,
        compiler_version: GRAPH_DIRECTORY_COMPILER_VERSION,
        materialization_version: currentMaterializationVersion(snapshot.record.id),
        scope: snapshot.scope,
        record: snapshot.record,
        snapshot_id: snapshot.snapshot_id,
        version_id: snapshot.version_id,
        entrypoint: snapshot.entrypoint,
        body_sha256: bodySha256,
        relations_sha256: relationsSha,
        files: snapshot.files,
        bindings: snapshot.file_bindings ?? [],
        native_index: snapshot.native_references ?? null,
      }),
    )
    const identity = {
      version: 1 as const,
      compiler_version: GRAPH_DIRECTORY_COMPILER_VERSION,
      scope: snapshot.scope,
      parent_id: snapshot.record.id,
      snapshot_id: snapshot.snapshot_id,
      body_sha256: bodySha256,
      relations_sha256: relationsSha,
      input_sha256: inputSha,
    }
    const key = `cache/shared-derived-graphs/${snapshot.scope}/${yield* sha256(snapshot.record.id)}/${inputSha}.json`
    const saved = yield* store.readJson(key, ReceiptSchema)
    if (saved !== undefined) {
      const { directory, output_sha256, ...header } = saved
      if (
        canonicalSharedJson(header) !== canonicalSharedJson(identity) ||
        (yield* sha256(canonicalSharedJson(directory))) !== output_sha256
      )
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "A derived graph directory has a different input or checksum."),
        )
      return { directory, hit: true }
    }
    const directory: typeof DirectorySchema.Type = {
      files: snapshot.files.map((file) => ({
        ...file,
        ref: fileRef(
          snapshot.record.id,
          file.path,
          snapshot.snapshot_id,
          snapshot.file_bindings?.find((binding) => binding.path === file.path)?.file_id,
        ),
      })),
      required: relationDirectory(snapshot.required),
      candidates: relationDirectory(snapshotMembers(snapshot)),
      references: snapshot.native_references?.entries ?? [],
      unresolved_references: snapshot.native_references?.unresolved ?? [],
    }
    yield* store.writeJson(key, {
      ...identity,
      output_sha256: yield* sha256(canonicalSharedJson(directory)),
      directory,
    })
    return { directory, hit: false }
  })
}
