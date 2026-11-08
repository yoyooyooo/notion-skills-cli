import { Effect } from "effect"
import { decode, fail, property, SkillsError } from "./model.ts"
import { readImportZip } from "./import.ts"
import { loadRetainedBody } from "./shared-file-observer.ts"
import { isResourceContent, loadSharedResourceContent } from "./shared-resource-content.ts"
import { RetainedContentSchema, type FileEvent, type RetainedContent } from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { inspectRetainedSource } from "./shared-retained-source.ts"
import {
  inspectSharedSnapshotHistory,
  loadSharedRetainedByteFile,
} from "./shared-snapshot-history.ts"
import { sha256, Store } from "./store.ts"
import { auditFinding, type AuditFinding, type AuditHistoryObject } from "./shared-audit-model.ts"
import { auditFailureCoverage, isAuditPause } from "./shared-audit-inventory.ts"

function cachedBytes(hash: string, bytes: number) {
  return Effect.gen(function* () {
    const result = yield* (yield* Store).readBytes(`objects/${hash}`).pipe(Effect.result)
    return (
      result._tag === "Success" &&
      result.success.length === bytes &&
      (yield* sha256(result.success)) === hash
    )
  })
}

/** Only exact content-reference shapes are followed. Unknown operation fields
 * are not an invitation to fetch arbitrary URLs or inferred objects. */
export function retainedReferences(value: unknown): readonly RetainedContent[] {
  const output = new Map<string, RetainedContent>()
  const visit = (value: unknown, depth: number) => {
    if (depth > 48 || value === null || typeof value !== "object") return
    const object = property(value)
    if (
      typeof object.object_id === "string" &&
      typeof object.sha256 === "string" &&
      typeof object.bytes === "number"
    ) {
      try {
        const content = decode(RetainedContentSchema, object)
        output.set(content.object_id, content)
      } catch {
        /* Original-plan decoders own malformed references. */
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(object))
      visit(child, depth + 1)
  }
  visit(value, 0)
  return [...output.values()]
}

export function auditRetainedHistory(
  library: SharedLibrary,
  input: {
    readonly skill_page_id: string
    readonly events: readonly FileEvent[]
    readonly pins: readonly string[]
    readonly bundles: readonly string[]
    readonly operations: readonly { readonly operation_id: string; readonly plan: unknown }[]
  },
) {
  return Effect.gen(function* () {
    const findings: AuditFinding[] = []
    const history: AuditHistoryObject[] = []
    const scope = `skill:${input.skill_page_id}`
    const failed = (id: string, error: SkillsError) =>
      findings.push(
        auditFinding({
          code: "HISTORY_REMOTE_UNAVAILABLE",
          severity: "warning",
          object_id: id,
          scope_key: scope,
          location: `history/${id}`,
          message:
            "The exact retained object could not be verified remotely; local bytes do not replace that proof.",
          evidence: { code: error.code, details: error.details ?? null },
          coverage: auditFailureCoverage(error),
        }),
      )
    const custom = new Map<string, { content: RetainedContent; retained_by: string[] }>()
    const remember = (content: RetainedContent, retainedBy: string) => {
      const previous = custom.get(content.object_id)
      if (previous) previous.retained_by.push(retainedBy)
      else custom.set(content.object_id, { content, retained_by: [retainedBy] })
    }
    for (const event of input.events) {
      if ("content" in event) remember(event.content, event.event_id)
      if ("retained" in event && event.retained !== null) remember(event.retained, event.event_id)
    }
    for (const operation of input.operations)
      for (const content of retainedReferences(operation.plan))
        remember(content, operation.operation_id)
    for (const [id, { content, retained_by }] of custom) {
      const cached_available = yield* cachedBytes(content.sha256, content.bytes)
      const result = yield* (
        isResourceContent(content)
          ? loadSharedResourceContent(library, { skillPageId: input.skill_page_id, content }).pipe(
              Effect.asVoid,
            )
          : loadRetainedBody(library, input.skill_page_id, content).pipe(Effect.asVoid)
      ).pipe(Effect.result)
      if (result._tag === "Failure") {
        if (isAuditPause(result.failure)) return yield* Effect.fail(result.failure)
        failed(id, result.failure)
      }
      history.push({
        object_id: id,
        owner_page_id: input.skill_page_id,
        kind: "custom_history",
        cached_available,
        remote_status: result._tag === "Success" ? "verified" : "unavailable",
        sha256: content.sha256,
        bytes: content.bytes,
        retained_by,
      })
    }
    for (const pin of [...new Set(input.pins)].sort()) {
      const inspected = yield* inspectSharedSnapshotHistory(library, {
        skillPageId: input.skill_page_id,
        pinId: pin,
      }).pipe(Effect.result)
      if (inspected._tag === "Failure") {
        if (isAuditPause(inspected.failure)) return yield* Effect.fail(inspected.failure)
        failed(pin, inspected.failure)
        history.push({
          object_id: pin,
          owner_page_id: input.skill_page_id,
          kind: "snapshot_manifest",
          cached_available: null,
          remote_status: "unavailable",
          sha256: null,
          bytes: null,
          retained_by: [pin],
        })
        continue
      }
      for (const file of inspected.success.manifest.files) {
        const id = `${pin}/${file.path}`
        const cached_available = yield* cachedBytes(file.sha256, file.bytes)
        // Always query exact remote chunks, independently of a warm Store.
        const loaded = yield* loadSharedRetainedByteFile(library, {
          skillPageId: input.skill_page_id,
          ...file,
        }).pipe(Effect.result)
        if (loaded._tag === "Failure") {
          if (isAuditPause(loaded.failure)) return yield* Effect.fail(loaded.failure)
          failed(id, loaded.failure)
        }
        history.push({
          object_id: id,
          owner_page_id: input.skill_page_id,
          kind: "snapshot_file",
          cached_available,
          remote_status: loaded._tag === "Success" ? "verified" : "unavailable",
          sha256: file.sha256,
          bytes: file.bytes,
          retained_by: [pin, ...file.chunks.map((chunk) => chunk.object_id)],
        })
      }
    }
    for (const bundle of [...new Set(input.bundles)].sort()) {
      let cached_available: boolean | null = null
      const loaded = yield* Effect.gen(function* () {
        const source = yield* inspectRetainedSource(library, {
          skillPageId: input.skill_page_id,
          sourceId: bundle,
        })
        cached_available = (yield* Effect.forEach(source.files, (file) =>
          cachedBytes(file.sha256, file.bytes),
        )).every(Boolean)
        const archive = yield* loadSharedRetainedByteFile(library, {
          skillPageId: input.skill_page_id,
          ...source.archive,
        })
        const files = yield* Effect.try({
          try: () => readImportZip(archive),
          catch: () => fail("RETAINED_SOURCE_INVALID", "The retained archive cannot be decoded."),
        })
        const expected = new Map(source.files.map((file) => [file.path, file]))
        if (
          files.length !== source.files.length ||
          new Set(files.map((file) => file.path)).size !== files.length
        )
          return yield* Effect.fail(
            fail(
              "RETAINED_SOURCE_INVALID",
              "The complete archive differs from its retained manifest.",
            ),
          )
        for (const file of files) {
          const entry = expected.get(file.path)
          if (
            entry === undefined ||
            file.bytes.length !== entry.bytes ||
            (entry.mode !== undefined && file.mode !== entry.mode) ||
            (yield* sha256(file.bytes)) !== entry.sha256
          )
            return yield* Effect.fail(
              fail(
                "RETAINED_SOURCE_INVALID",
                "A retained archive member differs from its declared path, size, mode or content digest.",
                { path: file.path },
              ),
            )
        }
        return source
      }).pipe(Effect.result)
      if (loaded._tag === "Failure") {
        if (isAuditPause(loaded.failure)) return yield* Effect.fail(loaded.failure)
        failed(bundle, loaded.failure)
      }
      history.push({
        object_id: bundle,
        owner_page_id: input.skill_page_id,
        kind: "retained_bundle",
        cached_available,
        remote_status: loaded._tag === "Success" ? "verified" : "unavailable",
        sha256: loaded._tag === "Success" ? loaded.success.archive.sha256 : null,
        bytes: loaded._tag === "Success" ? loaded.success.archive.bytes : null,
        retained_by: [bundle],
      })
    }
    return { findings, history }
  })
}
