import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { property, text } from "../../packages/core/src/model.ts"
import { canonicalSharedJson } from "../../packages/core/src/shared-records.ts"
import type { AuthoringContinuation } from "./authoring.ts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const string = (value: unknown, label: string) => {
  assert.equal(typeof value, "string", label)
  assert.ok(String(value).length > 0, label)
  return String(value)
}
function operation(result: Record<string, unknown>) {
  return string(
    result.operation_id ?? result.apply_operation_id,
    "The actual result must name its original operation",
  )
}

/** Extends the existing installed-author fixture; neither expected bodies nor
 * source rows are copied into the consumer Store to make the assertions pass. */
export async function checkProgressiveMaintenance(input: AuthoringContinuation) {
  const { target, database, directory, root, invoke, noWrites, observe } = input
  const initial = property(
    await noWrites("mnt-initial-author-pin", [
      "read",
      target,
      "--database",
      database,
      "--authoring",
      "--json",
      "--read-only",
    ]),
  )
  const originalRef = string(initial.ref, "Initial fixed ref"),
    originalBody = string(initial.content, "Initial complete body")
  const selectedRows = () =>
    observe()
      .files.map(property)
      .filter((row) => {
        const relation = property(property(row.properties).skill).relation
        return Array.isArray(relation) && relation.some((value) => property(value).id === target)
      })
  const fileIdentity = (path: string) => {
    const rows = selectedRows().filter(
      (row) => text(property(property(row.properties).path).rich_text) === path,
    )
    assert.equal(rows.length, 1, `One physical owned File at ${path}`)
    return {
      page_id: string(rows[0]!.id, "Native File page"),
      file_id: string(
        text(property(property(rows[0]!.properties).file_id).rich_text),
        "Stable File identity",
      ),
    }
  }
  const states: unknown[] = []
  const snapshot = (stage: string) => {
    const observed = observe()
    const value = {
      stage,
      skills: observed.skills.length,
      files: observed.files.length,
      records: observed.records.length,
      source_sha256: hash(
        canonicalSharedJson({
          skills: observed.skills,
          files: observed.files,
          records: observed.records,
          bodies: observed.bodies,
        }),
      ),
    }
    states.push(value)
    return value
  }
  const firstPath = "references/maintenance-one.md",
    secondPath = "references/maintenance-two.md"
  const referenceOne = "# First maintenance reference\n\nEXACT MNT REFERENCE ONE.\n"
  const referenceTwo = "# Second maintenance reference\n\nEXACT MNT REFERENCE TWO.\n"
  const splitMain =
    originalBody.trimEnd() +
    `\n\n## Focused references\n\n[First reference](${firstPath})\n\n[Second reference](${secondPath})\n`
  const changes = await directory("maintenance-split-input", {
    "SKILL.md": splitMain,
    [firstPath]: referenceOne,
    [secondPath]: referenceTwo,
  })
  await chmod(join(changes, firstPath), 0o644)
  await chmod(join(changes, secondPath), 0o755)
  const before = snapshot("before-split")
  const preview = property(
    await noWrites("mnt-split-preview", ["apply", originalRef, "--input", changes, "--dry-run"]),
  )
  assert.equal(preview.dry_run, true)
  assert.equal(snapshot("after-preview").source_sha256, before.source_sha256)
  const result = property(
    await invoke("mnt-split-apply", ["apply", originalRef, "--input", changes]),
  )
  assert.equal(result.verified, true)
  const first = fileIdentity(firstPath),
    second = fileIdentity(secondPath)
  assert.notEqual(first.file_id, second.file_id)
  assert.notEqual(first.page_id, second.page_id)
  const afterSplit = snapshot("after-split")
  assert.equal(afterSplit.skills, before.skills)
  assert.equal(afterSplit.files, before.files + 2)
  const refreshed = property(
    await noWrites("mnt-split-current", [
      "read",
      target,
      "--database",
      database,
      "--authoring",
      "--json",
      "--read-only",
    ]),
  )
  const splitRef = string(refreshed.ref, "Complete split pin")
  assert.ok(string(refreshed.content, "Split main").includes(originalBody.trimEnd()))
  assert.ok(
    String(refreshed.content).includes(firstPath) && String(refreshed.content).includes(secondPath),
  )
  const inventoryRef = new URL(splitRef)
  inventoryRef.pathname = "/"
  inventoryRef.searchParams.delete("file_id")
  const files = property(await noWrites("mnt-split-files", ["files", inventoryRef.href]))
  assert.ok(Array.isArray(files.files))
  const observedFiles: Record<string, unknown>[] = files.files.map(property)
  const sameInput: Record<string, string> = {
    "SKILL.md": string(refreshed.content, "Actual split main"),
  }
  for (const [path, expected, identity] of [
    [firstPath, referenceOne, first],
    [secondPath, referenceTwo, second],
  ] as const) {
    const row = observedFiles.find((value) => value.path === path)
    assert.ok(row)
    assert.equal(row.mode, path === firstPath ? "100644" : "100755")
    const ref = string(row.ref, "Visible fixed resource ref")
    const read = property(
      await noWrites("mnt-read-" + identity.file_id, ["read", ref, "--json", "--read-only"]),
    )
    assert.equal(string(read.content, "Entire reference body").trimEnd(), expected.trimEnd())
    sameInput[path] = String(read.content)
    assert.equal(fileIdentity(path).file_id, identity.file_id)
  }
  const shown = property(
    await noWrites("mnt-operation-show", [
      "ctl",
      "operation",
      "show",
      operation(result),
      "--target",
      target,
      "--entry",
      database,
    ]),
  )
  assert.equal(shown.operation_id, operation(result))
  assert.equal(shown.verified, false, "An original plan does not claim the terminal outcome")
  const next = property(shown.next).argv
  assert.ok(
    Array.isArray(next) &&
      next.every((value) => typeof value === "string") &&
      next[0] === "ntn-skills",
  )
  const reconciled = property(await noWrites("mnt-operation-reconcile", next.slice(1)))
  assert.equal(reconciled.operation_id, operation(result))
  assert.equal(reconciled.verified, true)
  assert.equal(snapshot("after-operation-observation").source_sha256, afterSplit.source_sha256)
  const old = property(
    await noWrites("mnt-original-pin", ["read", originalRef, "--json", "--read-only"]),
  )
  assert.equal(old.content, originalBody)
  const unchangedInput = await directory("maintenance-noop-input", sameInput)
  await chmod(join(unchangedInput, firstPath), 0o644)
  await chmod(join(unchangedInput, secondPath), 0o755)
  const noOpBefore = snapshot("before-noop")
  const unchanged = property(
    await noWrites("mnt-exact-noop", ["apply", splitRef, "--input", unchangedInput]),
  )
  assert.equal(unchanged.status, "unchanged")
  assert.equal(unchanged.verified, true)
  assert.equal(snapshot("after-noop").source_sha256, noOpBefore.source_sha256)
  const movedPath = "references/maintenance-renamed.md"
  const moveManifest = join(root, "maintenance-move.json")
  await writeFile(
    moveManifest,
    JSON.stringify({ version: 1, moves: [{ from: firstPath, to: movedPath }] }),
  )
  const movedMain = String(refreshed.content).replace(`](${firstPath})`, `](${movedPath})`)
  assert.notEqual(movedMain, refreshed.content)
  const moveInput = await directory("maintenance-move-input", { "SKILL.md": movedMain })
  const moved = property(
    await invoke("mnt-move-with-reference", [
      "apply",
      splitRef,
      "--input",
      moveInput,
      "--changes",
      moveManifest,
    ]),
  )
  assert.equal(moved.verified, true)
  assert.deepEqual(fileIdentity(movedPath), first)
  const moveRead = property(
    await noWrites("mnt-moved-current", [
      "read",
      target,
      "--database",
      database,
      "--authoring",
      "--read-only",
      "--json",
    ]),
  )
  assert.ok(String(moveRead.content).includes(movedPath))
  assert.equal(snapshot("after-move").files, afterSplit.files)
  const deleteManifest = join(root, "maintenance-delete.json")
  await writeFile(deleteManifest, JSON.stringify({ version: 1, removes: [secondPath] }))
  const deletedMain = String(moveRead.content).replace(`[Second reference](${secondPath})`, "")
  assert.notEqual(deletedMain, moveRead.content)
  const deleteInput = await directory("maintenance-delete-input", { "SKILL.md": deletedMain })
  const removed = property(
    await invoke("mnt-delete-with-reference", [
      "apply",
      string(moveRead.ref, "Move pin"),
      "--input",
      deleteInput,
      "--changes",
      deleteManifest,
    ]),
  )
  assert.equal(removed.verified, true)
  const deleteRead = property(
    await noWrites("mnt-deleted-current", [
      "read",
      target,
      "--database",
      database,
      "--authoring",
      "--read-only",
      "--json",
    ]),
  )
  const deletedFiles = property(
    await noWrites("mnt-deleted-files", [
      "files",
      string(deleteRead.snapshot_id, "Deleted complete snapshot"),
    ]),
  )
  assert.ok(Array.isArray(deletedFiles.files))
  assert.equal(
    deletedFiles.files.some((value) => property(value).path === secondPath),
    false,
  )
  assert.deepEqual(
    fileIdentity(secondPath),
    second,
    "A tombstone retains its native row and stable identity",
  )
  const beforeRevive = snapshot("before-revive")
  const reviveManifest = join(root, "maintenance-revive.json")
  await writeFile(reviveManifest, JSON.stringify({ version: 1, revives: [{ path: secondPath }] }))
  const reviveInput = await directory("maintenance-revive-input", {
    "SKILL.md": string(moveRead.content, "Main with restored reference"),
  })
  const reviveArgs = [
    "apply",
    string(deleteRead.ref, "Deleted pin"),
    "--input",
    reviveInput,
    "--changes",
    reviveManifest,
  ]
  const revivePreview = property(await noWrites("mnt-revive-preview", [...reviveArgs, "--dry-run"]))
  assert.equal(revivePreview.dry_run, true)
  assert.equal(snapshot("after-revive-preview").source_sha256, beforeRevive.source_sha256)
  const restored = property(await invoke("mnt-revive-with-reference", reviveArgs))
  assert.equal(restored.verified, true)
  assert.deepEqual(fileIdentity(secondPath), second)
  assert.equal(snapshot("after-revive").files, beforeRevive.files)
  const restoredRead = property(
    await noWrites("mnt-restored-current", [
      "read",
      target,
      "--database",
      database,
      "--authoring",
      "--read-only",
      "--json",
    ]),
  )
  const restoredFiles = property(
    await noWrites("mnt-restored-files", [
      "files",
      string(restoredRead.snapshot_id, "Restored complete snapshot"),
    ]),
  )
  assert.ok(Array.isArray(restoredFiles.files))
  assert.equal(restoredRead.content, moveRead.content)
  const restoredEntry = restoredFiles.files.map(property).find((value) => value.path === secondPath)
  assert.ok(restoredEntry)
  assert.equal(restoredEntry.mode, "100755")
  assert.equal(
    restoredFiles.files.map(property).find((value) => value.path === movedPath)?.mode,
    "100644",
  )
  const restoredBody = property(
    await noWrites("mnt-restored-original-bytes", [
      "read",
      string(restoredEntry.ref, "Restored fixed ref"),
      "--read-only",
      "--json",
    ]),
  )
  assert.equal(String(restoredBody.content).trimEnd(), referenceTwo.trimEnd())
  const historicalFiles = property(
    await noWrites("mnt-deleted-pin-unchanged", [
      "files",
      string(deleteRead.snapshot_id, "Deleted complete snapshot"),
    ]),
  )
  assert.ok(Array.isArray(historicalFiles.files))
  assert.equal(
    historicalFiles.files.some((value) => property(value).path === secondPath),
    false,
  )
  const report = {
    status: "passed",
    original_ref: originalRef,
    split_ref: splitRef,
    original_operation: operation(result),
    source_original_sha256: hash(originalBody),
    intended_main_sha256: hash(splitMain),
    references: [
      { path: firstPath, ...first, source_sha256: hash(referenceOne) },
      { path: secondPath, ...second, source_sha256: hash(referenceTwo) },
    ],
    snapshots: states,
    old_pin_preserved: true,
    explicit_reference_bodies_verified: true,
    identical_apply_added_rows: 0,
    move_preserved_identity: true,
    delete_preserved_native_page: true,
    undelete_same_identity_and_bytes: true,
    revive_parent_operation: operation(restored),
    revive_preserved_original_modes: true,
    revive_restored_main_reference: true,
    old_deleted_pin_preserved: true,
    raw_source: "same live owned service used by installed authoring; no product state seeded",
    boundaries: { installed_node: true, actual_http: true, real_notion: false, real_pi: false },
  }
  await writeFile(
    join(root, "progressive-maintenance.json"),
    JSON.stringify(report, null, 2) + "\n",
  )
  return report
}
