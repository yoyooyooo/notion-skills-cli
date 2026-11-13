import { fail } from "./model.ts"
import { normalizePath } from "./ref.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import { rewriteSharedMarkdownReferenceSpans } from "./shared-file-references.ts"
import type { SharedApplyChangesManifest } from "./shared-skill-apply-model.ts"
import type { CompositionFile } from "./shared-composition.ts"

export type MaintenanceTreeFile = {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mode?: "100644" | "100755"
}

export type ClassifiedMaintenance = {
  readonly adds: readonly MaintenanceTreeFile[]
  readonly edits: readonly MaintenanceTreeFile[]
  readonly moves: readonly {
    readonly from: string
    readonly to: string
    readonly bytes: Uint8Array
    readonly mode?: "100644" | "100755"
  }[]
  readonly removes: readonly string[]
  readonly revives: readonly MaintenanceTreeFile[]
  readonly finalFiles: readonly MaintenanceTreeFile[]
}

const decoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

export function maintenancePathIdentity(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US")
}

export function assertMaintenancePath(path: string): string {
  if (
    path === "" ||
    path !== path.normalize("NFC") ||
    normalizePath(path) !== path ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(path)
  )
    throw fail("INVALID_PATH", "Apply paths must be canonical NFC relative paths.", { path })
  return path
}

function assertIdentities(paths: readonly string[]) {
  const seen = new Map<string, string>()
  for (const path of paths) {
    const identity = maintenancePathIdentity(path)
    const previous = seen.get(identity)
    if (previous !== undefined && previous !== path)
      throw fail(
        "SHARED_APPLY_PATH_IDENTITY",
        "Two paths differ only by Unicode case or compatibility folding.",
        { paths: [previous, path].sort() },
      )
    seen.set(identity, path)
  }
}

function textOf(file: MaintenanceTreeFile): string {
  try {
    const text = decoder.decode(file.bytes)
    if (text.includes("\0")) throw new Error("nul")
    return text
  } catch {
    throw fail(
      "SHARED_APPLY_BYTES_UNAVAILABLE",
      "The file bytes are not complete UTF-8 text, so they were left unchanged and no write was planned.",
      { path: file.path },
    )
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false
  return true
}

function modeOf(
  file: MaintenanceTreeFile | undefined,
  requested: MaintenanceTreeFile,
): "100644" | "100755" | undefined {
  if (requested.mode === undefined) return file?.mode
  if (file?.mode !== undefined && file.mode !== requested.mode)
    throw fail(
      "SHARED_APPLY_MODE_CHANGED",
      "Apply does not change an existing file mode. Submit the original mode or omit it.",
      { path: requested.path },
    )
  return file === undefined ? requested.mode : file.mode
}

/** Omitted files stay. Missing input is not deletion, and equal bytes are not a move. */
export function classifyMaintenanceChanges(input: {
  readonly entrypoint: string
  readonly active: readonly MaintenanceTreeFile[]
  readonly tombstones: readonly MaintenanceTreeFile[]
  readonly requested: readonly MaintenanceTreeFile[]
  readonly explicitRemoves: readonly string[]
  readonly changes: SharedApplyChangesManifest | null
}): ClassifiedMaintenance {
  const changes = input.changes
  const moves = changes?.moves ?? []
  const manifestRemoves = changes?.removes ?? []
  const revives = (changes?.revives ?? []).map((item) => item.path)
  const rewrites = changes?.rewrites ?? []
  for (const path of [
    ...input.active.map((file) => file.path),
    ...input.tombstones.map((file) => file.path),
    ...input.requested.map((file) => file.path),
    ...input.explicitRemoves,
    ...manifestRemoves,
    ...moves.flatMap((move) => [move.from, move.to]),
    ...revives,
    ...rewrites.map((item) => item.path),
  ])
    assertMaintenancePath(path)
  const requested = new Map<string, MaintenanceTreeFile>()
  for (const file of input.requested) {
    if (requested.has(file.path))
      throw fail("INVALID_PATH", "Apply requires each canonical path once.", { path: file.path })
    requested.set(file.path, file)
  }
  const byRewrite = new Map<string, Array<(typeof rewrites)[number]>>()
  for (const rewrite of rewrites) {
    const group = [...(byRewrite.get(rewrite.path) ?? [])]
    group.push(rewrite)
    byRewrite.set(rewrite.path, group)
  }
  for (const [path, spans] of byRewrite) {
    const active = input.active.find((file) => file.path === path)
    const current = requested.get(path) ?? active
    if (current === undefined)
      throw fail(
        "SHARED_APPLY_REWRITE_SPAN",
        "A link rewrite names a path that is not in the selected tree or the submitted files.",
        { path },
      )
    const rewritten = rewriteSharedMarkdownReferenceSpans(path, textOf(current), spans)
    requested.set(path, {
      path,
      bytes: encoder.encode(rewritten),
      ...(current.mode === undefined ? {} : { mode: current.mode }),
    })
  }
  const explicitRemoves = [...new Set([...input.explicitRemoves, ...manifestRemoves])].sort()
  if (explicitRemoves.length !== input.explicitRemoves.length + manifestRemoves.length)
    throw fail("INVALID_PATH", "Name each explicit removal once.")
  const active = new Map(input.active.map((file) => [file.path, file]))
  const tombstones = new Map(input.tombstones.map((file) => [file.path, file]))
  for (const path of explicitRemoves) {
    if (path === input.entrypoint)
      throw fail("SHARED_MAIN_FILE_PROTECTED", "The main Skill body cannot be deleted.", { path })
    if (
      !active.has(path) ||
      requested.has(path) ||
      moves.some((move) => move.from === path || move.to === path)
    )
      throw fail(
        "INVALID_PATH",
        "Remove an existing supporting path once, without also writing or moving it.",
        { path },
      )
  }
  const classifiedMoves = moves.map((move) => {
    if (move.from === input.entrypoint || move.to === input.entrypoint)
      throw fail("SHARED_MAIN_FILE_PROTECTED", "The main Skill body cannot be moved.")
    const source = active.get(move.from)
    if (source === undefined || move.from === move.to)
      throw fail(
        "SHARED_APPLY_MOVE_UNKNOWN",
        "A move must name one existing path and a different destination.",
        {
          from: move.from,
          to: move.to,
        },
      )
    if (requested.has(move.from) || requested.has(move.to) || explicitRemoves.includes(move.from))
      throw fail(
        "SHARED_APPLY_MOVE_CONTENT",
        "A move keeps the original bytes. Change the body in a later apply; this one was not started.",
        { from: move.from, to: move.to },
      )
    if (active.has(move.to) || tombstones.has(move.to) || revives.includes(move.to))
      throw fail("SHARED_FILE_PATH_CONFLICT", "The move destination already has a stable path.", {
        path: move.to,
      })
    return {
      from: move.from,
      to: move.to,
      bytes: source.bytes,
      ...(source.mode === undefined ? {} : { mode: source.mode }),
    }
  })
  const classifiedRevives = revives.map((path) => {
    if (path === input.entrypoint)
      throw fail("SHARED_MAIN_FILE_PROTECTED", "The main Skill body cannot be undeleted.", { path })
    const tombstone = tombstones.get(path)
    if (tombstone === undefined || active.has(path))
      throw fail(
        "SHARED_FILE_NOT_TOMBSTONE",
        "Revive names one tombstoned path. An active path is not undeleted.",
        { path },
      )
    const submitted = requested.get(path)
    if (submitted !== undefined && !sameBytes(submitted.bytes, tombstone.bytes))
      throw fail(
        "SHARED_UNDELETE_BYTES_UNAVAILABLE",
        "Undelete restores the retained original bytes. A different body was not written.",
        { path },
      )
    const mode = modeOf(tombstone, submitted ?? tombstone)
    requested.delete(path)
    return { path, bytes: tombstone.bytes, ...(mode === undefined ? {} : { mode }) }
  })
  const adds: MaintenanceTreeFile[] = []
  const edits: MaintenanceTreeFile[] = []
  for (const file of [...requested.values()].sort((left, right) =>
    left.path < right.path ? -1 : 1,
  )) {
    const current = active.get(file.path)
    if (current === undefined) {
      if (tombstones.has(file.path))
        throw fail(
          "SHARED_FILE_PATH_CONFLICT",
          "A tombstone already owns this path. Revive it explicitly; a new row was not created.",
          { path: file.path },
        )
      const removedSame = explicitRemoves
        .map((path) => active.get(path))
        .find((removed) => removed !== undefined && sameBytes(removed.bytes, file.bytes))
      if (removedSame !== undefined)
        throw fail(
          "SHARED_APPLY_IMPLICIT_MOVE",
          "Equal bytes are not a move. Name the move explicitly; nothing was written.",
          { from: removedSame.path, to: file.path },
        )
      modeOf(undefined, file)
      adds.push(file)
      continue
    }
    const mode = modeOf(current, file)
    if (sameBytes(current.bytes, file.bytes)) continue
    edits.push({ path: file.path, bytes: file.bytes, ...(mode === undefined ? {} : { mode }) })
  }
  const removed = new Set(explicitRemoves)
  const movedFrom = new Set(classifiedMoves.map((move) => move.from))
  const finalFiles: MaintenanceTreeFile[] = []
  for (const file of input.active) {
    if (removed.has(file.path) || movedFrom.has(file.path)) continue
    const edit = edits.find((item) => item.path === file.path)
    finalFiles.push(edit ?? file)
  }
  for (const move of classifiedMoves)
    finalFiles.push({
      path: move.to,
      bytes: move.bytes,
      ...(move.mode === undefined ? {} : { mode: move.mode }),
    })
  for (const revive of classifiedRevives) finalFiles.push(revive)
  for (const add of adds) finalFiles.push(add)
  finalFiles.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  if (new Set(finalFiles.map((file) => file.path)).size !== finalFiles.length)
    throw fail("SHARED_FILE_PATH_CONFLICT", "The final tree contains a duplicate path.")
  assertIdentities(finalFiles.map((file) => file.path))
  const untouched = input.active.filter(
    (file) =>
      !removed.has(file.path) &&
      !movedFrom.has(file.path) &&
      !edits.some((edit) => edit.path === file.path),
  )
  for (const file of untouched) {
    const final = finalFiles.find((item) => item.path === file.path)
    if (final === undefined || !sameBytes(final.bytes, file.bytes) || final.mode !== file.mode)
      throw fail(
        "SHARED_APPLY_UNTOUCHED_CHANGED",
        "An omitted file's bytes or mode changed while planning the final tree.",
        { path: file.path },
      )
  }
  return {
    adds,
    edits,
    moves: classifiedMoves,
    removes: explicitRemoves,
    revives: classifiedRevives,
    finalFiles,
  }
}

export function assertMaintenanceReferences(files: readonly CompositionFile[]) {
  return assertSharedFileReferences(files)
}
