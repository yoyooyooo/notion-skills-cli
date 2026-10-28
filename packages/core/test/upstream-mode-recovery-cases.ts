import { expect, test } from "vitest"
import { Effect } from "effect"
import { readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { portableIdentity, snapshotAuthoredPortable } from "../src/export.ts"
import { Notion } from "../src/notion.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { BUNDLE, MANIFEST, readPortable } from "../src/portable.ts"
import { authScope } from "../src/catalog.ts"
import { fail, property } from "../src/model.ts"
import { Store, sha256 } from "../src/store.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { UpstreamPublisher, type UpstreamCommandOperation } from "../src/upstream-model.ts"
import { freezePortable } from "../src/upstream-content.ts"
import { forkUpstream } from "../src/upstream-conversion.ts"
import { publicationMarker } from "../src/publication-integrity.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { reconcileOperation, resumeOperation, showOperation } from "../src/command-operations.ts"
import type { RouterFixture } from "./router-authoring.node.test.ts"
import { registerPrepublicationRecoveryTests } from "./upstream-prepublication-recovery-cases.ts"

const database = "11111111-1111-4111-8111-111111111111"
const router = "33333333-3333-4333-8333-333333333333"
const foreign = "66666666-6666-4666-8666-666666666666"
const upstreamDatabase = "88888888-8888-4888-8888-888888888888"
const subscription = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const rich = (content: string) => ({
  type: "rich_text",
  rich_text: [{ plain_text: content, text: { content } }],
})
const counts = (requests: RouterFixture["requests"]) => ({
  GET: requests.filter(({ method }) => method === "GET").length,
  POST: requests.filter(({ method }) => method === "POST").length,
  PATCH: requests.filter(({ method }) => method === "PATCH").length,
})

export function registerUpstreamRecoveryTests(
  fixture: (upstream: boolean) => Promise<RouterFixture>,
) {
  registerPrepublicationRecoveryTests(fixture)

  test("live upstream create and replace render the main page and References natively while retaining binary Files", async () => {
    const f = await fixture(true)
    try {
      const initial = readPortable(
        await Promise.all(
          [MANIFEST, "SKILL.md", "references/guide.md", "assets/data.bin"].map(async (path) => ({
            path,
            bytes: new Uint8Array(await readFile(join(f.input, path))),
          })),
        ),
      )!
      const replacement = {
        ...initial,
        files: initial.files.map((file) => ({
          ...file,
          bytes:
            file.path === "SKILL.md"
              ? new TextEncoder().encode(
                  "# Revised upstream instructions\n\nRead [guide](references/guide.md).\n",
                )
              : file.path === "references/guide.md"
                ? new TextEncoder().encode(
                    "# Revised upstream guide\n\nUse the revised reference.\n",
                  )
                : file.path === "assets/data.bin"
                  ? new Uint8Array([9, 0, 255, 128])
                  : file.bytes,
        })),
      }
      let expected: { page_id: string; version: string; hash: string } | undefined
      for (const [index, portable] of [initial, replacement].entries()) {
        const hash = await f.run(portableIdentity(portable))
        const result = await f.run(
          Effect.flatMap(UpstreamPublisher, (publisher) =>
            publisher.publish({
              operation_id: `native-upstream-${index}`,
              portable,
              target_database_id: database,
              ...(expected ? { expected } : {}),
              ownership: {
                subscription_id: subscription,
                member_key: "fixture/native",
                mode: "tracked",
                published_hash: hash,
                revision: `native-r${index}`,
              },
            }),
          ),
        )
        expect(result).toMatchObject({ page_id: router, content_hash: hash, verified: true })
        const heading = index ? "Revised upstream instructions" : "Frozen mode bytes"
        const guideHeading = index ? "Revised upstream guide" : "Own guide"
        const root = property(
          await f.run(
            Effect.flatMap(Notion, (notion) => notion.request(`v1/blocks/${router}/children`)),
          ),
        )
        const blocks = root.results as Array<Record<string, unknown>>
        expect(
          blocks.some(
            (block) =>
              block.type === "heading_1" && JSON.stringify(block.heading_1).includes(heading),
          ),
        ).toBe(true)
        expect(
          blocks.some(
            (block) =>
              block.type === "paragraph" && JSON.stringify(block.paragraph).includes("guide"),
          ),
        ).toBe(true)
        expect(blocks.some((block) => block.type === "code")).toBe(false)
        expect(f.children).toHaveLength(1)
        const guide = f.children[0]!
        const reference = property(
          await f.run(
            Effect.flatMap(Notion, (notion) => notion.request(`v1/blocks/${guide.id}/children`)),
          ),
        )
        expect(
          (reference.results as Array<Record<string, unknown>>).some(
            (block) =>
              block.type === "heading_1" && JSON.stringify(block.heading_1).includes(guideHeading),
          ),
        ).toBe(true)
        expect(property(f.properties.References).rich_text).not.toEqual([])
        const files = property(f.properties.Files).files as Array<{ name: string }>
        expect(files.map((file) => file.name)).toEqual([BUNDLE])
        expect(files.some((file) => /\.md$/i.test(file.name))).toBe(false)
        const snapshot = await f.run(openSkill(router, { refresh: true }))
        const main = await f.run(readSkill(snapshot.snapshot_id))
        const resource = await f.run(
          readSkill(snapshot.snapshot_id, { path: "references/guide.md" }),
        )
        expect("content" in main && main.content).toContain(`# ${heading}`)
        expect("content" in resource && resource.content).toContain(`# ${guideHeading}`)
        const exported = await f.run(snapshotAuthoredPortable(snapshot))
        expect(
          Array.from(exported.files.find((file) => file.path === "assets/data.bin")!.bytes),
        ).toEqual(index ? [9, 0, 255, 128] : [0, 255, 7, 128])
        const current = await f.run(
          Effect.flatMap(UpstreamPublisher, (publisher) => publisher.inspect(router)),
        )
        expect(current.content_hash).toBe(hash)
        expected = { page_id: router, version: current.version, hash }
      }
      expect(
        f.requests.filter(({ path, method }) => path === "v1/pages" && method === "POST"),
      ).toHaveLength(2)
    } finally {
      await f.close()
    }
  }, 30000)
  // Only the reviewed parent and binding are seeded through repositories; the live
  // publisher creates every publication child, frozen object, guard and remote intent.
  async function interruptedMode(
    f: RouterFixture,
    mode: "tracked" | "fork",
    applied: boolean | "preintent" = true,
  ) {
    const portable = readPortable(
      await Promise.all(
        [MANIFEST, "SKILL.md", "references/guide.md", "assets/data.bin"].map(async (path) => ({
          path,
          bytes: new Uint8Array(await readFile(join(f.input, path))),
        })),
      ),
    )!
    const initialHash = await f.run(portableIdentity(portable))
    await f.run(
      Effect.flatMap(UpstreamPublisher, (publisher) =>
        publisher.publish({
          operation_id: "mode-fixture-initial",
          portable,
          target_database_id: database,
          ownership: {
            subscription_id: subscription,
            member_key: "fixture/frozen",
            mode: mode === "tracked" ? "fork" : "tracked",
            published_hash: initialHash,
            revision: "accepted-v1",
          },
        }),
      ),
    )
    const seeded = await f.run(
      Effect.gen(function* () {
        const current = yield* (yield* UpstreamPublisher).inspect(router)
        const frozen = yield* freezePortable(current.portable)
        const scope = yield* authScope
        const binding = {
          subscription_id: subscription,
          member_key: "fixture/frozen",
          target_key: JSON.stringify([database, subscription, "fixture/frozen"]),
          page_id: router,
          generation: 1,
          mode: mode === "tracked" ? ("fork" as const) : ("tracked" as const),
          active: true,
          revision: "accepted-v1",
          published_hash: current.content_hash,
          accepted: frozen,
          materialized: frozen,
        }
        yield* (yield* UpstreamState).setMode(binding, 0)
        const operation = `um_${yield* sha256(
          JSON.stringify([
            scope,
            upstreamDatabase,
            subscription,
            binding.member_key,
            binding.generation,
            mode,
          ]),
        )}`
        return { operation, current, binding, scope }
      }),
    )
    const start = f.requests.length
    const writes = f.writes.length
    const child = await f.run(Effect.map(sha256(seeded.operation), (hash) => `p_${hash}`))
    let interruptedBeforeIntent = false
    if (applied === "preintent")
      f.beforeRequest(({ method }) => {
        if (interruptedBeforeIntent || method !== "GET") return
        // Observe the real persisted writer checkpoint; never seed or change its journal.
        const db = new DatabaseSync(join(dirname(f.input), "state", "state.sqlite"), {
          readOnly: true,
        })
        try {
          const row = db.prepare("SELECT payload FROM publications WHERE id=?").get(child)
          const bound = db
            .prepare("SELECT payload FROM integrity_operations WHERE operation_id=?")
            .get(child)
          if (typeof row?.payload !== "string" || typeof bound?.payload !== "string") return
          const receipt = JSON.parse(row.payload)
          const integrity = JSON.parse(bound.payload)
          if (
            receipt.intents.length !== 0 ||
            integrity.page_id !== router ||
            typeof integrity.marker.base_revision !== "string"
          )
            return
          interruptedBeforeIntent = true
          throw fail(
            "NOTION_REQUEST_FAILED",
            "Controlled read failed before the first mode intent.",
          )
        } finally {
          db.close()
        }
      })
    else if (applied) f.losePropertyResponse()
    else f.losePropertyResponseBeforeApply()
    if (mode === "fork") {
      const stopped = await f.run(
        forkUpstream(subscription, seeded.binding.member_key).pipe(Effect.result),
      )
      expect(stopped).toMatchObject({
        _tag: "Failure",
        failure: {
          code: applied === "preintent" ? "NOTION_REQUEST_FAILED" : "WRITE_OUTCOME_UNKNOWN",
        },
      })
    } else {
      const parent: Extract<UpstreamCommandOperation, { domain: "upstream_track" }> = {
        operation_id: seeded.operation,
        domain: "upstream_track",
        scope: seeded.scope,
        database_id: upstreamDatabase,
        subscription_id: subscription,
        member_key: seeded.binding.member_key,
        page_id: router,
        expected_version: seeded.current.version,
        recovery_generation: seeded.binding.generation,
        publication_required: true,
        baseline_operation_ids: [],
        content_hash: seeded.current.content_hash,
        revision: "frozen-v2",
        state: "unknown",
        error_code: "WRITE_OUTCOME_UNKNOWN",
      }
      await f.run(
        Effect.flatMap(UpstreamState, (state) => state.saveCommand(seeded.operation, parent)),
      )
      const stopped = await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) =>
          publisher.setMode({
            operation_id: seeded.operation,
            page_id: router,
            expected_version: seeded.current.version,
            mode,
            published_hash: parent.content_hash,
            revision: parent.revision,
          }),
        ).pipe(Effect.result),
      )
      expect(stopped).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
    }
    f.beforeRequest(() => {})
    const saved = await modeEvidence(f, seeded.operation, child)
    expect(saved.receipt).toMatchObject({
      operation_id: child,
      operation: "write",
      page_id: router,
      context: { ownership: { mode, published_hash: seeded.current.content_hash } },
    })
    expect(saved.integrity).toMatchObject({
      operation_id: child,
      page_id: router,
      marker: { state: "writing" },
    })
    if (applied === "preintent") {
      expect(interruptedBeforeIntent).toBe(true)
      expect(saved.receipt!.intents).toEqual([])
      expect(saved.receipt!.failure?.code).toBe("NOTION_REQUEST_FAILED")
      expect(publicationMarker({ properties: f.properties })).toMatchObject({ state: "committed" })
      expect(f.writes.slice(writes).filter(({ path }) => path === `v1/pages/${router}`)).toEqual([])
      return { ...seeded, child, saved }
    }
    expect(publicationMarker({ properties: f.properties })).toMatchObject({
      state: "writing",
      operation_id: child,
    })
    const rootWrites = f.writes.slice(writes).filter(({ path }) => path === `v1/pages/${router}`)
    expect(rootWrites).toHaveLength(2)
    const modePatch = property(property(rootWrites[1]!.body).properties)
    expect(modePatch["Sync Mode"]).toEqual({ select: { name: mode } })
    expect(modePatch["Published Hash"]).toEqual({
      rich_text: [{ type: "text", text: { content: seeded.current.content_hash } }],
    })
    expect(modePatch["Upstream Revision"]).toEqual({
      rich_text: [
        { type: "text", text: { content: mode === "tracked" ? "frozen-v2" : "accepted-v1" } },
      ],
    })
    expect(
      f.requests
        .slice(start)
        .filter(({ path, method }) => path === `v1/pages/${router}` && method === "PATCH"),
    ).toHaveLength(2)
    const intent = saved.receipt!.intents.find(
      (entry) =>
        entry.path === `v1/pages/${router}` &&
        property(property(entry.body).properties)["Sync Mode"] !== undefined,
    )
    expect(intent).toMatchObject({ method: "PATCH", status: "unknown", body: rootWrites[1]!.body })
    expect(f.sourceRequests).toEqual([])
    return { ...seeded, child, saved }
  }

  async function modeEvidence(f: RouterFixture, operation: string, child: string) {
    return f.run(
      Effect.gen(function* () {
        const store = yield* Store
        const state = yield* UpstreamState
        return {
          parent: yield* state.command(operation),
          bindings: yield* state.bindings(subscription),
          receipt: yield* store.readJson(`publications/${child}.json`, PublicationReceiptSchema),
          integrity: yield* store.integrity.inspect(child),
        }
      }),
    )
  }

  for (const change of ["none", "body", "organization"] as const) {
    test(`original unsent fork child ${change === "none" ? "resumes after a preflight read failure" : `rejects external ${change} changes`}`, async () => {
      const f = await fixture(true)
      try {
        const interrupted = await interruptedMode(f, "fork", "preintent")
        const writes = f.writes.length
        const body = f.body()
        const childBodies = f.children.map(({ body }) => body)
        const baselineIds = property(interrupted.saved.parent).baseline_operation_ids
        expect(Array.isArray(baselineIds)).toBe(true)
        if (change === "body") f.editBody()
        if (change === "organization")
          f.properties["Default Context"] = rich("External organization edit.")
        const observed = await f.run(reconcileOperation(interrupted.operation).pipe(Effect.result))
        expect(f.writes).toHaveLength(writes)
        if (change !== "none") {
          expect(observed._tag).toBe("Failure")
          expect((await modeEvidence(f, interrupted.operation, interrupted.child)).receipt).toEqual(
            interrupted.saved.receipt,
          )
          return
        }
        expect(observed).toMatchObject({
          _tag: "Success",
          success: {
            verified: false,
            outcome: "needs_safe_resume",
            resume_supported: true,
            next: { argv: ["ntn-skills", "operation", "resume", interrupted.operation] },
          },
        })
        const unchanged = await modeEvidence(f, interrupted.operation, interrupted.child)
        expect(unchanged.receipt).toEqual(interrupted.saved.receipt)
        expect(unchanged.integrity).toEqual(interrupted.saved.integrity)
        await rm(f.input, { recursive: true, force: true })
        const start = f.requests.length
        expect(await f.run(resumeOperation(interrupted.operation))).toMatchObject({
          verified: true,
        })
        const recovered = await modeEvidence(f, interrupted.operation, interrupted.child)
        expect(recovered.receipt).toMatchObject({ state: "completed", page_id: router })
        expect(recovered.receipt!.portable).toEqual(interrupted.saved.receipt!.portable)
        expect(recovered.receipt!.intents.every((intent) => intent.status === "completed")).toBe(
          true,
        )
        expect(recovered.parent).toMatchObject({ domain: "upstream_fork", state: "verified" })
        expect(property(recovered.parent).baseline_operation_ids).toEqual(baselineIds)
        expect(f.requests.slice(start).some(({ method }) => method === "POST")).toBe(false)
        expect(f.body()).toBe(body)
        expect(f.children.map(({ body }) => body)).toEqual(childBodies)
        expect(f.sourceRequests).toEqual([])
        const finishedWrites = f.writes.length
        expect(await f.run(resumeOperation(interrupted.operation))).toMatchObject({
          verified: true,
        })
        expect(f.writes).toHaveLength(finishedWrites)
      } finally {
        await f.close()
      }
    }, 30000)
  }

  for (const { mode, applied } of [
    { mode: "tracked", applied: true },
    { mode: "fork", applied: true },
    { mode: "tracked", applied: false },
  ] as const) {
    test(`original upstream ${mode} parent observes and resumes its ${applied ? "applied" : "unapplied"} mode PATCH after a fresh Store`, async () => {
      const f = await fixture(true)
      try {
        const interrupted = await interruptedMode(f, mode, applied)
        const start = f.requests.length
        const writes = f.writes.length
        const marker = structuredClone(f.properties.Publication)
        const body = f.body()
        const childBodies = f.children.map(({ body }) => body)
        const shown = await f.run(showOperation(interrupted.operation))
        expect(shown).toMatchObject({
          operation_id: interrupted.operation,
          domain: mode === "fork" ? "upstream_fork" : "upstream_track",
          verified: false,
          resume_supported: true,
          result: {
            page_id: router,
            mode,
            expected_version: interrupted.current.version,
            children: expect.arrayContaining([
              expect.objectContaining({
                domain: "publication",
                operation_id: interrupted.child,
                state: interrupted.saved.receipt!.state,
                refs: { page_id: router },
                intended_hash: interrupted.saved.integrity!.intended_hash,
              }),
            ]),
          },
        })
        if (mode === "tracked")
          expect(shown.result).toMatchObject({
            content_hash: interrupted.current.content_hash,
            revision: "frozen-v2",
          })
        expect(await f.run(reconcileOperation(interrupted.operation))).toMatchObject({
          operation_id: interrupted.operation,
          outcome: applied ? "needs_safe_resume" : "unknown",
          verified: false,
          resume_supported: true,
          next: { argv: ["ntn-skills", "operation", "resume", interrupted.operation] },
        })
        expect(f.writes).toHaveLength(writes)
        expect(f.requests.slice(start).every(({ method }) => method === "GET")).toBe(true)
        expect(f.properties.Publication).toEqual(marker)
        const observed = await modeEvidence(f, interrupted.operation, interrupted.child)
        expect(observed.parent).toEqual(interrupted.saved.parent)
        expect(observed.bindings).toEqual(interrupted.saved.bindings)
        expect(observed.integrity).toEqual(interrupted.saved.integrity)
        expect(observed.receipt!.portable).toEqual(interrupted.saved.receipt!.portable)
        expect(
          observed.receipt!.intents.map(({ path, method, body }) => ({ path, method, body })),
        ).toEqual(
          interrupted.saved.receipt!.intents.map(({ path, method, body }) => ({
            path,
            method,
            body,
          })),
        )
        // Recovery has only durable frozen objects; the registry endpoint always 404s.
        await rm(f.input, { recursive: true, force: true })
        const resumeStart = f.requests.length
        const diagnosticCounts = counts(f.requests.slice(start, resumeStart))
        expect(await f.run(resumeOperation(interrupted.operation))).toMatchObject({
          operation_id: interrupted.operation,
          verified: true,
        })
        const completed = await modeEvidence(f, interrupted.operation, interrupted.child)
        expect(completed.parent).toMatchObject({ state: "verified" })
        expect(completed.receipt).toMatchObject({
          operation_id: interrupted.child,
          state: "completed",
        })
        expect(completed.receipt!.portable).toEqual(interrupted.saved.receipt!.portable)
        expect(completed.integrity).toMatchObject({
          intended_hash: interrupted.saved.integrity!.intended_hash,
          marker: { state: "committed", operation_id: interrupted.child },
        })
        expect(completed.bindings).toHaveLength(1)
        expect(completed.bindings[0]).toMatchObject({
          mode,
          generation: interrupted.binding.generation + 1,
        })
        expect(f.requests.slice(resumeStart).filter(({ method }) => method !== "GET")).toEqual([
          ...(!applied ? [{ path: `v1/pages/${router}`, method: "PATCH" }] : []),
          { path: `v1/pages/${router}`, method: "PATCH" },
        ])
        expect(f.writes).toHaveLength(writes + (applied ? 1 : 2))
        expect(publicationMarker({ properties: f.properties })).toMatchObject({
          state: "committed",
          operation_id: interrupted.child,
        })
        expect(f.body()).toBe(body)
        expect(f.children.map(({ body }) => body)).toEqual(childBodies)
        const repeatStart = f.requests.length
        const resumeCounts = counts(f.requests.slice(resumeStart, repeatStart))
        expect(await f.run(resumeOperation(interrupted.operation))).toMatchObject({
          operation_id: interrupted.operation,
          verified: true,
        })
        expect(f.writes).toHaveLength(writes + (applied ? 1 : 2))
        expect(f.requests.slice(repeatStart).every(({ method }) => method === "GET")).toBe(true)
        expect((await modeEvidence(f, interrupted.operation, interrupted.child)).bindings).toEqual(
          completed.bindings,
        )
        expect(f.sourceRequests).toEqual([])
        console.info(
          JSON.stringify({
            case: `${mode}-${applied ? "applied" : "unapplied"}`,
            diagnostic: diagnosticCounts,
            resume: resumeCounts,
            repeat: counts(f.requests.slice(repeatStart)),
            intended_mode: mode,
            intended_hash: interrupted.current.content_hash,
            intended_revision: mode === "tracked" ? "frozen-v2" : "accepted-v1",
            body_unchanged: f.body() === body,
          }),
        )
      } finally {
        await f.close()
      }
    }, 30000)
  }

  for (const changedGuard of [
    "none",
    "root-metadata",
    "root-markdown",
    "reference-metadata",
    "reference-markdown",
    "references-property",
  ] as const) {
    test(`mode-only guard inventory recovery with ${changedGuard} changed`, async () => {
      const f = await fixture(true)
      try {
        const interrupted = await interruptedMode(f, "tracked", false)
        const rootPath = `v1/pages/${router}`
        const child = f.children[0]!
        const referencePath = `v1/pages/${child.id}`
        const propertyPath = `${rootPath}/properties/references?page_size=100`
        const receipt = structuredClone(interrupted.saved.receipt!)
        // Historical mode-only receipts retain the five content/property guards,
        // without the child inventories collected by today's fixture reads.
        delete receipt.guards[`v1/blocks/${router}/children?page_size=100`]
        delete receipt.guards[`v1/blocks/${child.id}/children?page_size=100`]
        await f.run(
          Effect.flatMap(Store, (store) =>
            store.writeJson(`publications/${interrupted.child}.json`, receipt),
          ),
        )
        expect(Object.keys(receipt.guards).sort()).toEqual(
          [
            rootPath,
            `${rootPath}/markdown`,
            referencePath,
            `${referencePath}/markdown`,
            propertyPath,
          ].sort(),
        )
        expect(receipt.intents).toHaveLength(2)
        expect(receipt.intents[0]).toMatchObject({
          path: rootPath,
          method: "PATCH",
          status: "completed",
          body: { properties: { Publication: expect.any(Object) } },
        })
        expect(receipt.intents[1]).toMatchObject({
          path: rootPath,
          method: "PATCH",
          status: "unknown",
          body: { properties: { "Sync Mode": { select: { name: "tracked" } } } },
        })
        if (changedGuard === "root-metadata")
          f.properties["Default Context"] = { id: "default", type: "checkbox", checkbox: true }
        if (changedGuard === "reference-metadata") child.revision++
        if (changedGuard === "reference-markdown") child.body += "\nExternal reference edit.\n"
        let changed = false
        f.beforeRequest(({ path, method }) => {
          if (changed || method !== "GET") return
          if (changedGuard === "root-markdown" && path === `${rootPath}/markdown`) {
            changed = true
            f.editBody()
          }
          if (changedGuard === "references-property" && path === propertyPath) {
            changed = true
            property(f.properties.References).rich_text = []
          }
        })
        const start = f.requests.length
        const writes = f.writes.length
        const resumed = await f.run(resumeOperation(interrupted.operation).pipe(Effect.result))
        const after = await modeEvidence(f, interrupted.operation, interrupted.child)
        if (changedGuard === "none") {
          expect(resumed).toMatchObject({ _tag: "Success", success: { verified: true } })
          const firstWrite = f.requests.slice(start).findIndex(({ method }) => method !== "GET")
          expect(firstWrite).toBeGreaterThanOrEqual(0)
          const reads = f.requests.slice(start, start + firstWrite).map(({ path }) => path)
          expect(reads).toEqual(expect.arrayContaining(Object.keys(receipt.guards)))
          expect(f.writes.slice(writes)).toEqual([
            { path: rootPath, body: receipt.intents[1]!.body },
            {
              path: rootPath,
              body: expect.objectContaining({
                properties: { Publication: expect.any(Object) },
              }),
            },
          ])
          expect(after.receipt!.intents[1]).toMatchObject({
            status: "failed",
            response: { prior_status: "unknown", recovery: "known_not_applied" },
          })
          expect(after.parent).toMatchObject({ state: "verified" })
          expect(after.bindings[0]).toMatchObject({
            mode: "tracked",
            generation: interrupted.binding.generation + 1,
          })
        } else {
          expect(resumed).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
          expect(f.writes).toHaveLength(writes)
          expect(f.requests.slice(start).every(({ method }) => method === "GET")).toBe(true)
          expect(after.parent).toEqual(interrupted.saved.parent)
          expect(after.bindings).toEqual(interrupted.saved.bindings)
          expect(after.integrity).toEqual(interrupted.saved.integrity)
          expect(after.receipt!.intents).toEqual(receipt.intents)
        }
        expect(f.sourceRequests).toEqual([])
      } finally {
        await f.close()
      }
    }, 30000)
  }

  for (const divergence of [
    "body",
    "provenance",
    "unrequested-property",
    "wrong-root",
    "foreign-marker",
  ] as const) {
    test(`original upstream parent fences ${divergence} without writes or binding advancement`, async () => {
      const f = await fixture(true)
      try {
        const interrupted = await interruptedMode(f, "tracked")
        if (divergence === "body") f.editBody()
        if (divergence === "provenance")
          f.properties["Upstream Key"] = { id: "Upstream Key", ...rich("foreign/member") }
        if (divergence === "unrequested-property")
          f.properties["Default Context"] = { id: "default", type: "checkbox", checkbox: true }
        if (divergence === "wrong-root")
          await f.run(
            Effect.flatMap(UpstreamState, (state) =>
              state.saveCommand(interrupted.operation, {
                ...property(interrupted.saved.parent),
                page_id: foreign,
              }),
            ),
          )
        if (divergence === "foreign-marker") {
          const marker = publicationMarker({ properties: f.properties })!
          f.properties.Publication = {
            id: "publication",
            ...rich(JSON.stringify({ ...marker, operation_id: "p_foreign" })),
          }
        }
        const start = f.requests.length
        const writes = f.writes.length
        const before = await modeEvidence(f, interrupted.operation, interrupted.child)
        const diagnostic = await f.run(
          reconcileOperation(interrupted.operation).pipe(Effect.result),
        )
        if (divergence === "wrong-root")
          expect(diagnostic).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
        else if (divergence === "foreign-marker" && diagnostic._tag === "Failure")
          expect(diagnostic.failure).toMatchObject({ code: "PUBLICATION_UNRESOLVED" })
        else
          expect(diagnostic).toMatchObject({
            _tag: "Success",
            success: { verified: false, outcome: "conflict" },
          })
        const resumed = await f.run(resumeOperation(interrupted.operation).pipe(Effect.result))
        expect(resumed).toMatchObject({
          _tag: "Failure",
          failure: {
            code:
              divergence === "foreign-marker"
                ? expect.stringMatching(/^(WRITE_CONFLICT|PUBLICATION_UNRESOLVED)$/)
                : "WRITE_CONFLICT",
          },
        })
        expect(f.writes).toHaveLength(writes)
        expect(f.requests.slice(start).every(({ method }) => method === "GET")).toBe(true)
        const after = await modeEvidence(f, interrupted.operation, interrupted.child)
        expect(after.parent).toEqual(before.parent)
        expect(after.bindings).toEqual(before.bindings)
        expect(after.integrity).toEqual(before.integrity)
        expect(after.receipt!.portable).toEqual(before.receipt!.portable)
        expect(f.sourceRequests).toEqual([])
      } finally {
        await f.close()
      }
    }, 30000)
  }

  test("native replacement does not accept an external child added after its body ACK", async () => {
    const f = await fixture(true)
    try {
      const portable = readPortable(
        await Promise.all(
          [MANIFEST, "SKILL.md", "references/guide.md", "assets/data.bin"].map(async (path) => ({
            path,
            bytes: new Uint8Array(await readFile(join(f.input, path))),
          })),
        ),
      )!
      const owner = {
        subscription_id: subscription,
        member_key: "fixture/child-inventory",
        mode: "tracked" as const,
        published_hash: await f.run(portableIdentity(portable)),
        revision: "inventory-v1",
      }
      await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) =>
          publisher.publish({
            operation_id: "child-inventory-initial",
            portable,
            target_database_id: database,
            ownership: owner,
          }),
        ),
      )
      const before = await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) => publisher.inspect(router)),
      )
      const description = structuredClone(f.properties.Description)
      const candidate = {
        ...portable,
        description: "Requested replacement metadata.",
        files: portable.files.map((file) =>
          file.path === portable.main
            ? {
                ...file,
                bytes: new TextEncoder().encode(
                  "# Intended replacement\n\nRead [guide](references/guide.md).\n",
                ),
              }
            : file,
        ),
      }
      let bodySent = false,
        injected = false
      f.beforeRequest(({ method, path }) => {
        if (method === "PATCH" && path === `v1/pages/${router}/markdown`) bodySent = true
        if (
          bodySent &&
          !injected &&
          method === "GET" &&
          path.startsWith(`v1/blocks/${router}/children`)
        ) {
          injected = true
          f.children.push({
            id: foreign,
            name: "external.md",
            body: "Independent child.\n",
            revision: 0,
          })
        }
      })
      const candidateHash = await f.run(portableIdentity(candidate))
      const result = await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) =>
          publisher.publish({
            operation_id: "child-inventory-replacement",
            portable: candidate,
            target_database_id: database,
            expected: { page_id: router, version: before.version, hash: before.content_hash },
            ownership: { ...owner, published_hash: candidateHash, revision: "inventory-v2" },
          }),
        ).pipe(Effect.result),
      )
      expect(injected).toBe(true)
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("Expected external child inventory conflict")
      expect(
        result.failure.code === "WRITE_PARTIAL"
          ? property(result.failure.details).cause_code
          : result.failure.code,
      ).toBe("WRITE_CONFLICT")
      expect(f.properties.Description).toEqual(description)
      expect(f.children.find((child) => child.id === foreign)?.body).toBe("Independent child.\n")
    } finally {
      await f.close()
    }
  }, 30000)

  for (const loss of ["property", "writing-marker"] as const) {
    test(`live upstream publisher resumes an original known-page replacement ${loss} PATCH lost before apply`, async () => {
      const f = await fixture(true)
      try {
        const portable = readPortable(
          await Promise.all(
            [MANIFEST, "SKILL.md", "references/guide.md", "assets/data.bin"].map(async (path) => ({
              path,
              bytes: new Uint8Array(await readFile(join(f.input, path))),
            })),
          ),
        )!
        const owner = {
          subscription_id: subscription,
          member_key: "fixture/frozen",
          mode: "tracked" as const,
          published_hash: await f.run(portableIdentity(portable)),
          revision: "accepted-v1",
        }
        await f.run(
          Effect.flatMap(UpstreamPublisher, (publisher) =>
            publisher.publish({
              operation_id: "known-page-initial",
              portable,
              target_database_id: database,
              ownership: owner,
            }),
          ),
        )
        const before = await f.run(
          Effect.flatMap(UpstreamPublisher, (publisher) => publisher.inspect(router)),
        )
        const originalBody = f.body()
        const candidate = {
          ...portable,
          description: "Use for the original frozen replacement.",
          files: portable.files.map((file) =>
            file.path === "SKILL.md"
              ? {
                  ...file,
                  bytes: new TextEncoder().encode(
                    "# Frozen replacement\n\nRead [guide](references/guide.md).\n",
                  ),
                }
              : file,
          ),
        }
        const operation = `known-page-frozen-replacement-${loss}`
        const child = await f.run(Effect.map(sha256(operation), (hash) => `p_${hash}`))
        const request = {
          operation_id: operation,
          portable: candidate,
          target_database_id: database,
          expected: { page_id: router, version: before.version, hash: before.content_hash },
          ownership: {
            ...owner,
            published_hash: await f.run(portableIdentity(candidate)),
            revision: "frozen-v2",
          },
        }
        const start = f.requests.length
        const writesStart = f.writes.length
        if (loss === "writing-marker") f.loseMarkerResponseBeforeApply()
        else f.loseChangedDescriptionResponseBeforeApply()
        const stopped = await f.run(
          Effect.flatMap(UpstreamPublisher, (publisher) => publisher.publish(request)).pipe(
            Effect.result,
          ),
        )
        expect(stopped).toMatchObject({
          _tag: "Failure",
          failure: {
            code: expect.stringMatching(/^(WRITE_OUTCOME_UNKNOWN|WRITE_PARTIAL)$/),
          },
        })
        const retained = await modeEvidence(f, operation, child)
        expect(retained.receipt).toMatchObject({
          operation: "replace",
          page_id: router,
          state: "unknown",
        })
        expect(
          retained.receipt!.guards[`v1/blocks/${router}/children?page_size=100`],
        ).toMatchObject({
          results: f.children.map((child) => ({
            id: child.id,
            type: "child_page",
            child_page: { title: child.name },
          })),
          has_more: false,
          next_cursor: null,
        })
        const pending = retained.receipt!.intents.find(
          (intent) => intent.path === `v1/pages/${router}` && intent.status === "unknown",
        )!
        expect(pending).toMatchObject({ method: "PATCH" })
        if (loss === "writing-marker") {
          expect(retained.receipt!.intents).toHaveLength(1)
          expect(publicationMarker({ properties: f.properties })).toMatchObject({
            state: "committed",
          })
          const markerProperty = property(property(property(pending.body).properties).Publication)
          if (!Array.isArray(markerProperty.rich_text))
            throw new Error("Expected frozen writing marker rich text")
          const marker = JSON.parse(
            String(property(property(markerProperty.rich_text[0]).text).content),
          )
          expect(marker).toMatchObject({
            state: "writing",
            operation_id: child,
            intended_hash: retained.integrity!.intended_hash,
          })
        } else {
          const changes = property(property(pending.body).properties)
          expect(changes.description).toEqual({
            rich_text: [{ text: { content: candidate.description } }],
          })
          expect(changes.Publication).toBeUndefined()
          expect(property(f.properties.Description).rich_text).not.toEqual(
            property(changes.description).rich_text,
          )
        }
        if (loss === "writing-marker") expect(f.body()).toBe(originalBody)
        else expect(f.body()).toContain("# Frozen replacement")
        const diagnosticStart = f.requests.length
        const diagnosticWrites = f.writes.length
        const marker = structuredClone(f.properties.Publication)
        expect(
          await f.run(
            Effect.flatMap(UpstreamPublisher, (publisher) => publisher.reconcile(operation)),
          ),
        ).toBeUndefined()
        expect(f.requests.slice(diagnosticStart).every(({ method }) => method === "GET")).toBe(true)
        expect(f.writes).toHaveLength(diagnosticWrites)
        expect(f.properties.Publication).toEqual(marker)
        const observed = await modeEvidence(f, operation, child)
        expect(observed.integrity).toEqual(retained.integrity)
        expect(observed.receipt!.portable).toEqual(retained.receipt!.portable)
        await rm(f.input, { recursive: true, force: true })
        const resumeStart = f.requests.length
        const diagnosticCounts = counts(f.requests.slice(diagnosticStart, resumeStart))
        const resumed = await f.run(
          Effect.flatMap(UpstreamPublisher, (publisher) =>
            publisher.publish({ ...request, resume_only: true }),
          ).pipe(Effect.result),
        )
        expect(
          resumed,
          JSON.stringify({
            ...(resumed._tag === "Failure" ? { failure: resumed.failure } : {}),
            guard_paths: Object.keys(observed.receipt!.guards),
            intents: observed.receipt!.intents.map(({ path, method, status }) => ({
              path,
              method,
              status,
            })),
          }),
        ).toMatchObject({ _tag: "Success" })
        if (resumed._tag !== "Success")
          throw new Error("Expected the original frozen publication to resume")
        expect(resumed.success).toMatchObject({
          page_id: router,
          publication_operation_id: child,
          content_hash: request.ownership.published_hash,
          verified: true,
        })
        const resumeCounts = counts(f.requests.slice(resumeStart))
        const completed = await modeEvidence(f, operation, child)
        expect(completed.receipt).toMatchObject({ state: "completed", page_id: router })
        expect(completed.receipt!.portable).toEqual(retained.receipt!.portable)
        expect(completed.integrity).toMatchObject({
          intended_hash: retained.integrity!.intended_hash,
          marker: { state: "committed", operation_id: child },
        })
        const matching = completed.receipt!.intents.filter(
          (intent) =>
            intent.path === pending.path &&
            JSON.stringify(intent.body) === JSON.stringify(pending.body),
        )
        expect(matching).toHaveLength(2)
        expect(matching[0]).toMatchObject({
          status: "failed",
          response: { recovery: "known_not_applied", prior_status: "unknown" },
        })
        expect(matching[1]).toMatchObject({ status: "completed", method: "PATCH" })
        expect(
          f.writes
            .slice(writesStart)
            .filter(
              ({ path, body }) =>
                path === pending.path && JSON.stringify(body) === JSON.stringify(pending.body),
            ),
        ).toHaveLength(2)
        expect(
          f.requests
            .slice(start)
            .filter(({ path, method }) => path === "v1/pages" && method === "POST"),
        ).toEqual([])
        expect(
          await f.run(Effect.flatMap(UpstreamPublisher, (publisher) => publisher.inspect(router))),
        ).toMatchObject({
          content_hash: request.ownership.published_hash,
          ownership: request.ownership,
        })
        const repeatWrites = f.writes.length
        const repeatStart = f.requests.length
        expect(
          await f.run(
            Effect.flatMap(UpstreamPublisher, (publisher) =>
              publisher.publish({ ...request, resume_only: true }),
            ),
          ),
        ).toMatchObject({ verified: true, page_id: router })
        expect(f.writes).toHaveLength(repeatWrites)
        expect(f.sourceRequests).toEqual([])
        console.info(
          JSON.stringify({
            case: `known-page-replacement-${loss}-unapplied`,
            diagnostic: diagnosticCounts,
            resume: resumeCounts,
            repeat: counts(f.requests.slice(repeatStart)),
            intended_mode: request.ownership.mode,
            intended_hash: request.ownership.published_hash,
            intended_revision: request.ownership.revision,
            body_unchanged: f.body() === originalBody,
          }),
        )
      } finally {
        await f.close()
      }
    }, 30000)
  }

  test("AH258 live upstream publisher rejects multiple owner relations before every mutation entrypoint", async () => {
    const f = await fixture(true)
    try {
      const portable = readPortable(
        await Promise.all(
          [MANIFEST, "SKILL.md", "references/guide.md", "assets/data.bin"].map(async (path) => ({
            path,
            bytes: new Uint8Array(await readFile(join(f.input, path))),
          })),
        ),
      )!
      const ownership = {
        subscription_id: subscription,
        member_key: "fixture/frozen",
        mode: "tracked" as const,
        published_hash: await f.run(portableIdentity(portable)),
        revision: "accepted-v1",
      }
      await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) =>
          publisher.publish({
            operation_id: "duplicate-owner-initial",
            portable,
            target_database_id: database,
            ownership,
          }),
        ),
      )
      const current = await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) => publisher.inspect(router)),
      )
      f.properties.Upstream = {
        id: "upstream",
        type: "relation",
        relation: [{ id: subscription }, { id: foreign }],
        has_more: false,
      }
      const writes = f.writes.length
      const start = f.requests.length
      const results = [
        await f.run(
          Effect.flatMap(UpstreamPublisher, (publisher) => publisher.inspect(router)).pipe(
            Effect.result,
          ),
        ),
        await f.run(
          Effect.flatMap(UpstreamPublisher, (publisher) =>
            publisher.setMode({
              operation_id: "duplicate-owner-mode",
              page_id: router,
              expected_version: current.version,
              mode: "tracked",
              published_hash: current.content_hash,
              revision: "frozen-v2",
            }),
          ).pipe(Effect.result),
        ),
        await f.run(
          Effect.flatMap(UpstreamPublisher, (publisher) =>
            publisher.publish({
              operation_id: "duplicate-owner-replace",
              portable,
              target_database_id: database,
              expected: { page_id: router, version: current.version, hash: current.content_hash },
              ownership,
            }),
          ).pipe(Effect.result),
        ),
      ]
      for (const result of results)
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            code: "INVALID_UPSTREAM",
            message: "Upstream must contain at most one complete relation.",
          },
        })
      const methods = counts(f.requests.slice(start))
      expect(methods.GET).toBeGreaterThan(0)
      expect(methods.POST).toBe(0)
      expect(methods.PATCH).toBe(0)
      expect(f.writes).toHaveLength(writes)
      expect(f.sourceRequests).toEqual([])
      console.info(JSON.stringify({ case: "AH258-multiple-owner-relations", methods }))
    } finally {
      await f.close()
    }
  }, 30000)
}
