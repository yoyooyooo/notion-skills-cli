import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { defineBuiltin, publishBuiltin } from "../src/builtin.ts"
import { applySkill, createPortable, replaceSkill, resumePublication } from "../src/mutation.ts"
import { portableIdentity } from "../src/export.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { join } from "node:path"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import { property } from "../src/model.ts"
import { UpstreamPublisher } from "../src/upstream-model.ts"
import type { RouterFixture } from "./router-authoring.node.test.ts"
import {
  OperationSchema,
  showOperation,
  reconcileOperation,
  resumeOperation,
} from "../src/command-operations.ts"

const database = "11111111-1111-4111-8111-111111111111"
const page = "33333333-3333-4333-8333-333333333333"
const builtin = defineBuiltin("notion/editable_provenance%2B中文", "fixture", [
  {
    path: "SKILL.md",
    bytes: new TextEncoder().encode(
      "---\nname: editable_provenance+中文\ndescription: Use for editable provenance.\n---\n\n# Exact editable instructions\n",
    ),
  },
])

export function registerPublicationSourceTests(
  fixture: (upstream?: boolean) => Promise<RouterFixture>,
) {
  test("public operations reach the retained upstream child publication without creating a new identity", async () => {
    const f = await fixture(true)
    try {
      const child = `uo_${"1".repeat(64)}:0`
      const stored = "p_a66feca68d14db538a23ddad0aec848480dff7333b7fcc07d0acb576bcce6b93"
      const published = await f.run(
        Effect.gen(function* () {
          const publisher = yield* UpstreamPublisher
          return yield* publisher.publish({
            operation_id: child,
            portable: builtin.portable,
            target_database_id: database,
            ownership: {
              subscription_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              member_key: "public-child",
              mode: "tracked",
              revision: "child-r1",
              published_hash: yield* portableIdentity(builtin.portable),
            },
          })
        }),
      )
      expect(published.publication_operation_id).toBe(stored)
      const before = f.writes.length
      const shown = await f.run(showOperation(child))
      expect(Schema.decodeUnknownSync(OperationSchema)(shown)).toMatchObject({
        operation_id: stored,
        domain: "publication",
        verified: true,
      })
      const reconciled = await f.run(reconcileOperation(child))
      expect(reconciled, JSON.stringify(reconciled.result)).toMatchObject({
        operation_id: stored,
        domain: "publication",
        verified: true,
      })
      expect(await f.run(resumeOperation(child))).toMatchObject({
        operation_id: stored,
        domain: "publication",
        verified: true,
      })
      expect(f.writes.length).toBe(before)
      const reads = f.requests.length
      for (const invalid of [
        "p_demo:0",
        `uo_${"1".repeat(64)}:01`,
        `uo_${"1".repeat(64)}:-1`,
        `uo_${"1".repeat(64)}:0/other`,
        `uo_${"1".repeat(64)}:0:1`,
        "../p_demo",
      ])
        expect(await f.run(showOperation(invalid).pipe(Effect.result))).toMatchObject({
          _tag: "Failure",
          failure: { code: "INVALID_ARGUMENT" },
        })
      expect(f.requests.length).toBe(reads)
      expect(f.writes.length).toBe(before)
    } finally {
      await f.close()
    }
  }, 30000)

  test("editable apply changes only the requested checkbox and an equal repeat leaves file blocks untouched", async () => {
    const f = await fixture(true)
    try {
      await f.run(createPortable(builtin.portable, { database, storage: "markdown_files" }))
      const baseline = await f.run(openSkill(page, { refresh: true }))
      const before = f.writes.length
      const applied = await f.run(applySkill(baseline.snapshot_id, { defaultContext: true }))
      expect(applied).toMatchObject({
        verified: true,
        action: "update",
        storage: "markdown_files",
        reused: false,
      })
      const current = await f.run(openSkill(page, { refresh: true }))
      expect(current.record.default_context).toBe(true)
      expect(f.writes.slice(before).every((write) => write.path === `v1/pages/${page}`)).toBe(true)
      expect(await f.run(readSkill(current.snapshot_id))).toMatchObject({
        content: expect.stringContaining("# Exact editable instructions"),
      })
      const repeatedAt = f.writes.length
      expect(await f.run(applySkill(current.snapshot_id, { defaultContext: true }))).toMatchObject({
        verified: true,
        reused: true,
      })
      expect(f.writes.length).toBe(repeatedAt)
    } finally {
      await f.close()
    }
  }, 30000)

  test("editable apply publishes body, resource and allowed properties as one complete edit", async () => {
    const f = await fixture(true)
    try {
      await f.run(createPortable(builtin.portable, { database, storage: "markdown_files" }))
      const baseline = await f.run(openSkill(page, { refresh: true }))
      await f.put(
        "editable-change/SKILL.md",
        "# Edited instructions\n\nRead [guide](references/guide.md).\n",
      )
      await f.put("editable-change/references/guide.md", "# Guide\n\nComplete editable resource.\n")
      const applied = await f.run(
        applySkill(baseline.snapshot_id, {
          input: join(f.input, "editable-change"),
          description: "Use the complete editable update.",
          defaultContext: true,
        }),
      )
      expect(applied).toMatchObject({
        verified: true,
        storage: "markdown_files",
        changes: { files: ["SKILL.md", "references/guide.md"], removed: [] },
      })
      const current = await f.run(openSkill(page, { refresh: true }))
      expect(current.record).toMatchObject({
        description: "Use the complete editable update.",
        default_context: true,
      })
      expect(await f.run(readSkill(current.snapshot_id))).toMatchObject({
        content: expect.stringContaining("# Edited instructions"),
      })
      expect(
        await f.run(readSkill(current.snapshot_id, { path: "references/guide.md" })),
      ).toMatchObject({ content: "# Guide\n\nComplete editable resource.\n" })
    } finally {
      await f.close()
    }
  }, 30000)

  test("editable checkbox loss before apply stays unknown until the original effect is observed", async () => {
    const f = await fixture(true)
    try {
      await f.run(createPortable(builtin.portable, { database, storage: "markdown_files" }))
      const baseline = await f.run(openSkill(page, { refresh: true }))
      const before = f.writes.length
      const checkboxWrites = () =>
        f.writes
          .slice(before)
          .filter((write) => Object.hasOwn(property(property(write.body).properties), "default"))
      f.losePropertyResponseBeforeApply()
      const stopped = await f.run(
        applySkill(baseline.snapshot_id, { defaultContext: true }).pipe(Effect.result),
      )
      if (stopped._tag !== "Failure")
        throw new Error("Expected the original checkbox request to be unresolved")
      expect(stopped.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
      const operationId = String(property(stopped.failure.details).operation_id)
      expect(checkboxWrites()).toHaveLength(1)
      expect(await f.run(reconcilePublication(operationId))).toMatchObject({ outcome: "unknown" })
      const pending = await f.run(resumePublication(operationId).pipe(Effect.result))
      expect(pending._tag === "Failure" && pending.failure.code).toBe("PUBLICATION_UNRESOLVED")
      expect(checkboxWrites()).toHaveLength(1)
      expect(property(f.properties["Default Context"]).checkbox).toBe(false)
      // The same timed-out request can become visible later; its original journal remains authoritative.
      property(f.properties["Default Context"]).checkbox = true
      expect(await f.run(resumePublication(operationId))).toMatchObject({
        verified: true,
        operation_id: operationId,
      })
      expect(checkboxWrites()).toHaveLength(1)
      expect((await f.run(openSkill(page, { refresh: true }))).record.default_context).toBe(true)
    } finally {
      await f.close()
    }
  }, 30000)

  test("editable checkbox response loss resumes the original operation without replay and completed drift fails", async () => {
    const f = await fixture(true)
    try {
      await f.run(createPortable(builtin.portable, { database, storage: "markdown_files" }))
      const baseline = await f.run(openSkill(page, { refresh: true }))
      const before = f.writes.length
      const checkboxWrites = () =>
        f.writes
          .slice(before)
          .filter((write) => Object.hasOwn(property(property(write.body).properties), "default"))
      f.losePropertyResponse()
      const stopped = await f.run(
        applySkill(baseline.snapshot_id, { defaultContext: true }).pipe(Effect.result),
      )
      if (stopped._tag !== "Failure")
        throw new Error("Expected the applied checkbox response to be lost")
      expect(stopped.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
      const operationId = String(property(stopped.failure.details).operation_id)
      expect(checkboxWrites()).toHaveLength(1)
      const resumed = await f.run(resumePublication(operationId))
      expect(resumed).toMatchObject({
        verified: true,
        operation_id: operationId,
        storage: "markdown_files",
      })
      expect(checkboxWrites()).toHaveLength(1)
      expect(f.writes.slice(before).every((write) => write.path === `v1/pages/${page}`)).toBe(true)
      expect((await f.run(openSkill(page, { refresh: true }))).record.default_context).toBe(true)
      const complete = f.writes.length
      expect(await f.run(resumePublication(operationId))).toMatchObject({
        verified: true,
        operation_id: operationId,
      })
      expect(f.writes.length).toBe(complete)
      f.properties["Default Context"] = { id: "default", type: "checkbox", checkbox: false }
      const drift = await f.run(resumePublication(operationId).pipe(Effect.result))
      expect(drift._tag === "Failure" && drift.failure.code).toBe("WRITE_CONFLICT")
      expect(await f.run(reconcilePublication(operationId))).toMatchObject({ outcome: "conflict" })
      expect(f.writes.length).toBe(complete)
    } finally {
      await f.close()
    }
  }, 30000)

  test("editable builtin metadata-only publication and dry run preserve all code blocks; complete repeat has no writes", async () => {
    const f = await fixture(true)
    try {
      await f.run(createPortable(builtin.portable, { database, storage: "markdown_files" }))
      expect(property(f.properties["Source Type"]).select).toEqual({ name: "manual" })
      const before = f.writes.length
      expect(await f.run(publishBuiltin(builtin, { target: page, dryRun: true }))).toMatchObject({
        action: "update",
        reused: false,
      })
      expect(f.writes.length).toBe(before)
      const result = await f.run(publishBuiltin(builtin, { target: page }))
      expect(result).toMatchObject({
        action: "update",
        reused: false,
        storage: "markdown_files",
        verified: true,
      })
      expect(f.writes.slice(before).length).toBeGreaterThan(0)
      expect(f.writes.slice(before).every((write) => write.path === `v1/pages/${page}`)).toBe(true)
      expect(property(f.properties["Source Type"]).select).toEqual({ name: "builtin" })
      expect(property(f.properties["Builtin ID"]).rich_text).toEqual([
        { type: "text", text: { content: builtin.id }, plain_text: builtin.id },
      ])
      const classified = f.writes.length
      expect(await f.run(publishBuiltin(builtin, { target: page, dryRun: true }))).toMatchObject({
        action: "reuse",
        reused: true,
      })
      expect(await f.run(publishBuiltin(builtin, { target: page }))).toMatchObject({
        action: "reuse",
        reused: true,
      })
      expect(await f.run(replaceSkill(builtin.portable, { target: page }))).toMatchObject({
        action: "reuse",
        reused: true,
      })
      expect(f.writes.length).toBe(classified)
      property(f.properties["Builtin ID"]).rich_text = [
        { type: "text", text: { content: "notion/external" }, plain_text: "notion/external" },
      ]
      const drift = await f.run(resumePublication(result.operation_id).pipe(Effect.result))
      expect(drift._tag === "Failure" && drift.failure.code).toBe("PUBLICATION_INCOMPLETE")
      expect(f.writes.length).toBe(classified)
    } finally {
      await f.close()
    }
  }, 30000)

  test("complete upstream reuse returns the proven existing marker identity; fork and ordinary refresh retain upstream origin", async () => {
    const f = await fixture(true)
    try {
      await f.run(
        Effect.gen(function* () {
          const publisher = yield* UpstreamPublisher
          const hash = yield* portableIdentity(builtin.portable)
          const ownership = {
            subscription_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            member_key: "origin-fixture",
            mode: "tracked" as const,
            published_hash: hash,
            revision: "source-r1",
          }
          const first = yield* publisher.publish({
            operation_id: "p_provenance-upstream-first",
            portable: builtin.portable,
            target_database_id: database,
            ownership,
          })
          const current = yield* publisher.inspect(first.page_id)
          const before = f.writes.length
          const reused = yield* publisher.publish({
            operation_id: "p_provenance-upstream-repeat",
            portable: builtin.portable,
            target_database_id: database,
            ownership,
            expected: { page_id: first.page_id, version: current.version, hash },
          })
          expect(reused).toMatchObject({
            page_id: first.page_id,
            verified: true,
            content_hash: hash,
            publication_operation_id: first.publication_operation_id,
          })
          expect(f.writes.length).toBe(before)
          expect(yield* publisher.reconcile("p_provenance-upstream-repeat")).toMatchObject({
            publication_operation_id: first.publication_operation_id,
            verified: true,
          })
          const baseline = yield* publisher.recoverableBaseline(first.page_id, current.version, {
            portable: builtin.portable,
            content_hash: hash,
            revision: "source-r1",
          })
          const latest = yield* publisher.inspect(first.page_id)
          yield* publisher.setMode({
            operation_id: "p_provenance-fork",
            page_id: first.page_id,
            expected_version: latest.version,
            mode: "fork",
            fork_baseline: {
              version: 1,
              original_ref: "original",
              revision: "source-r1",
              content_hash: hash,
              portable_ref: baseline,
            },
          })
          expect(property(f.properties["Source Type"]).select).toEqual({ name: "upstream" })
          expect(property(f.properties["Builtin ID"]).rich_text).toEqual([])
          expect(property(f.properties["Sync Mode"]).select).toEqual({ name: "fork" })
          const forked = f.writes.length
          expect(yield* replaceSkill(builtin.portable, { target: page })).toMatchObject({
            action: "reuse",
            reused: true,
          })
          expect(f.writes.length).toBe(forked)
          expect(property(f.properties["Source Type"]).select).toEqual({ name: "upstream" })
        }),
      )
    } finally {
      await f.close()
    }
  }, 30000)
}
