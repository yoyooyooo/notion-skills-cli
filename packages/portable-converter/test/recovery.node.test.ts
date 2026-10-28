import { expect, test, vi } from "vitest"
import { zipSync } from "fflate"
import { Crypto, Effect } from "effect"
import { access, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fixture, page, database, guide } from "../../core/test/sync-fixture.ts"
import { decode, fail, property, SnapshotSchema } from "../../core/src/model.ts"
import type { SkillsError, Snapshot } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { openSkill } from "../../core/src/snapshot.ts"
import { sha256, Store } from "../../core/src/store.ts"
import { BUNDLE } from "../../core/src/portable.ts"
import { snapshotAuthoredPortable } from "../../core/src/export.ts"
import * as exportModule from "../../core/src/export.ts"
import * as referencesModule from "../../core/src/references.ts"
import type { Receipt } from "../../core/src/publication-model.ts"
import {
  applyRemote,
  planRemote,
  planRecoveryRemote,
  reconcileRemote,
  replanRemote,
  resumeRemote,
} from "../src/remote.ts"

const encoder = new TextEncoder()
const binary = new Uint8Array([0, 255, 128, 42, 0, 254])
const liveGuide = "# Guide\n\nCurrent authored guide, ahead of the retained archive.\n"
const liveName = "Recovery Skill"

async function readLedger(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8"))
}

async function stoppedAttempt(
  stopAt: Parameters<typeof stoppedAttemptWithRenderer>[0] = "prepare",
  historicalBaseline = false,
) {
  if (!historicalBaseline) return stoppedAttemptWithRenderer(stopAt)
  const readReferences = referencesModule.readReferences
  const renderer = vi
    .spyOn(referencesModule, "readReferences")
    .mockImplementation((...args) =>
      readReferences(...args).pipe(
        Effect.flatMap((graph) =>
          sha256(JSON.stringify([graph.version_id, "previous-materialization"])).pipe(
            Effect.map((version_id) => ({ ...graph, version_id })),
          ),
        ),
      ),
    )
  try {
    // Snapshot IDs, ledger and receipt are produced by the original public apply path.
    // Only the historical renderer's version derivation changes; authored input stays exact.
    return await stoppedAttemptWithRenderer(stopAt)
  } finally {
    renderer.mockRestore()
  }
}

async function stoppedAttemptWithRenderer(
  stopAt: "prepare" | "mutation" | "allocation" | "after-allocation" = "prepare",
) {
  const host = await fixture(true)
  // This suite owns the archive; live metadata, main and reference are newer.
  const old = zipSync({
    ".ntn-skills.json": encoder.encode(
      JSON.stringify({
        format: "ntn-skills",
        version: 1,
        name: "Archived Skill",
        description: "Archived description.",
        main: "workflow.md",
        projection: {
          name: "Archived Skill",
          description: "Archived description.",
          body: "# Archived instructions",
          references: { "references/guide.md": "# Archived guide" },
        },
      }),
    ),
    "workflow.md": encoder.encode("# Archived instructions\n"),
    "references/guide.md": encoder.encode("# Archived guide\n"),
    "assets/raw.bin": binary,
  })
  host.seedAttachment(BUNDLE, old)
  host.remoteEdit(liveGuide)
  host.renameRemote(liveName)
  const sourceRequest: Notion["Service"]["request"] = (path, body, options) =>
    host.provider
      .request(path, body, options)
      .pipe(
        Effect.map((response) =>
          stopAt === "after-allocation" && path === `v1/pages/${page}`
            ? { ...property(response), last_edited_time: "2026-10-18T00:00:00.000Z" }
            : response,
        ),
      )
  const strict = await host.run(
    openSkill(page, { refresh: true }).pipe(
      Effect.provideService(Notion, { ...host.provider, request: sourceRequest }),
      Effect.result,
    ),
  )
  expect(strict).toMatchObject({
    _tag: "Failure",
    failure: { code: "PORTABLE_UPGRADE_REQUIRED" },
  })

  const plan = await host.run(
    planRemote(page, database, "skill").pipe(
      Effect.provideService(Notion, { ...host.provider, request: sourceRequest }),
    ),
  )
  expect(host.mutations()).toBe(0)
  expect(plan.source_inventory.find((file) => file.path === BUNDLE)?.sha256).toBe(
    await host.run(sha256(old)),
  )
  const plannedFile = (path: string) => {
    const file = plan.output.find((file) => file.path === path)
    if (!file) throw new Error(`Missing planned file: ${path}`)
    return Buffer.from(file.base64, "base64")
  }
  expect(plannedFile("workflow.md").toString()).toContain("# Sample")
  expect(plannedFile("workflow.md").toString()).not.toContain("Archived instructions")
  expect(plannedFile("references/guide.md").toString()).toBe(liveGuide)
  expect(new Uint8Array(plannedFile("assets/raw.bin"))).toEqual(binary)

  const bytes = JSON.stringify(plan)
  const hash = await host.run(sha256(bytes))
  const ledger = join(host.scratch, "recovery-attempt.json")
  let dropped = false
  let ledgerAtLoss: Record<string, unknown> | undefined
  let receiptAtLoss: Receipt | undefined
  const request: Notion["Service"]["request"] = (path, body, options) =>
    Effect.gen(function* () {
      const method = options?.method ?? (body === undefined ? "GET" : "POST")
      const receipt = [...host.json.entries()].find(
        ([key, value]) =>
          key.startsWith("publications/") &&
          property(value).operation === "replace" &&
          property(value).page_id === page,
      )?.[1] as Receipt | undefined
      const afterAllocation =
        stopAt === "after-allocation" &&
        !dropped &&
        method === "GET" &&
        path === `v1/pages/${page}` &&
        receipt?.intents.some(
          (intent) => intent.path === "v1/file_uploads" && intent.status === "completed",
        ) &&
        !receipt.intents.some((intent) => intent.path.endsWith("/send"))
      if (method === "GET" && /^v1\/file_uploads\/[^/]+$/.test(path)) {
        host.calls.push({ path, method })
        const uploaded = receipt?.intents.some(
          (intent) => intent.path === `${path}/send` && intent.status === "completed",
        )
        return { id: path.split("/")[2], status: uploaded ? "uploaded" : "pending" }
      }
      const response = afterAllocation ? undefined : yield* sourceRequest(path, body, options)
      const prepareRead =
        stopAt === "prepare" &&
        method === "GET" &&
        path === `v1/pages/${page}` &&
        receipt?.intents.length === 0
      const acceptedMutation =
        receipt &&
        ((stopAt === "mutation" && method !== "GET") ||
          (stopAt === "allocation" && path === "v1/file_uploads" && method === "POST"))
      if (!dropped && (prepareRead || acceptedMutation || afterAllocation)) {
        dropped = true
        ledgerAtLoss = yield* Effect.tryPromise({
          try: () => readLedger(ledger),
          catch: () => fail("STORAGE_ERROR", "Cannot read durable converter ledger."),
        })
        receiptAtLoss = structuredClone(receipt)
        return yield* Effect.fail(
          fail(
            stopAt === "prepare" || stopAt === "after-allocation"
              ? "HTTP_ERROR"
              : "WRITE_OUTCOME_UNKNOWN",
            stopAt === "prepare" || stopAt === "after-allocation"
              ? "Preparation GET response lost"
              : "Accepted mutation response lost",
          ),
        )
      }
      return response
    })
  const store = await host.run(Store)
  const interruptedStore: Store["Service"] = {
    ...store,
    writeJson: (key, value) =>
      Effect.gen(function* () {
        yield* store.writeJson(key, value)
        if (stopAt !== "after-allocation" || dropped || !key.startsWith("publications/")) return
        const receipt = value as Receipt
        if (
          receipt.intents.some(
            (intent) => intent.path === "v1/file_uploads" && intent.status === "completed",
          ) &&
          !receipt.intents.some((intent) => intent.path.endsWith("/send"))
        ) {
          // Fault after the allocation is durable, independently of guard read counts.
          yield* request(`v1/pages/${page}`)
        }
      }),
  }
  const stopped = await host.run(
    applyRemote(bytes, hash, ledger).pipe(
      Effect.provideService(Notion, { ...host.provider, request }),
      Effect.provideService(Store, interruptedStore),
      Effect.result,
    ),
  )
  expect(dropped, JSON.stringify(stopped)).toBe(true)
  expect(stopped).toMatchObject({
    _tag: "Failure",
    failure: {
      code:
        stopAt === "prepare"
          ? "HTTP_ERROR"
          : stopAt === "after-allocation"
            ? "WRITE_PARTIAL"
            : "WRITE_OUTCOME_UNKNOWN",
    },
  })
  const savedLedger = await readLedger(ledger)
  const operation = savedLedger.operation_id
  expect(operation).toMatch(/^p_[a-zA-Z0-9-]+$/)
  if (typeof operation !== "string") throw new Error("Missing durable operation identity")
  expect(ledgerAtLoss).toMatchObject({ plan_hash: hash, page_id: page, operation_id: operation })
  expect(receiptAtLoss).toMatchObject({ operation_id: operation, page_id: page })
  const receipt = () => host.json.get(`publications/${operation}.json`) as Receipt
  expect(receipt().operation_id).toBe(operation)
  if (stopAt === "prepare") {
    expect(host.mutations()).toBe(0)
    expect(receiptAtLoss?.intents).toEqual([])
    expect(receipt()).toMatchObject({ state: "failed", intents: [] })
    expect(property(receipt().failure?.details).stage).toBe("prepare")
  } else if (stopAt === "after-allocation") {
    expect(receipt()).toMatchObject({ state: "failed" })
    expect(receipt().intents.length).toBeGreaterThan(0)
    expect(receipt().intents.every((intent) => intent.status === "completed")).toBe(true)
    expect(receipt().intents.some((intent) => intent.path.endsWith("/send"))).toBe(false)
  } else {
    expect(host.mutations()).toBeGreaterThan(0)
    expect(receipt().state).toBe("unknown")
    expect(receipt().intents.some((intent) => intent.status === "unknown")).toBe(true)
  }
  expect(
    property(stopped._tag === "Failure" ? property(stopped.failure).details : undefined)
      .operation_id,
  ).toBe(operation)
  return { host, bytes, hash, ledger, operation, receipt, plannedFile, request }
}

function observeStore(
  store: Store["Service"],
  transform: (snapshot: Snapshot) => Effect.Effect<Snapshot, SkillsError>,
): Store["Service"] {
  return {
    ...store,
    readJson: (key, schema) =>
      store
        .readJson(key, schema)
        .pipe(
          Effect.flatMap((value) =>
            value === undefined || !key.startsWith("snapshots/")
              ? Effect.succeed(value)
              : transform(decode(SnapshotSchema, value)).pipe(
                  Effect.map((snapshot) => decode(schema, snapshot)),
                ),
          ),
        ),
  }
}

async function generatedEntryAttempt() {
  const host = await fixture(true)
  const archive = zipSync({
    ".ntn-skills.json": encoder.encode(
      JSON.stringify({
        format: "ntn-skills",
        version: 1,
        name: "Archived Skill",
        description: "Archived description.",
        main: "SKILL.md",
        projection: {
          name: "Archived Skill",
          description: "Archived description.",
          body: "# Archived instructions",
          references: { "references/guide.md": "# Archived guide" },
        },
      }),
    ),
    "SKILL.md": encoder.encode("# Archived instructions\n"),
    "references/guide.md": encoder.encode("# Archived guide\n"),
    "assets/raw.bin": binary,
  })
  host.seedAttachment(BUNDLE, archive)
  host.remoteEdit(liveGuide)
  host.renameRemote(liveName)
  const store = await host.run(Store)
  const crypto = await host.run(Crypto.Crypto)
  let aliasReads = 0
  const oldRenderer = observeStore(store, (snapshot) =>
    Effect.gen(function* () {
      const entry = snapshot.files.find((file) => file.path === snapshot.entrypoint)!
      const current = new TextDecoder().decode(yield* store.readBytes(`objects/${entry.sha256}`))
      const display = `"name": ${JSON.stringify(snapshot.record.name)}`
      const alias = `"name": ${JSON.stringify(snapshot.record.alias)}`
      expect(current).toContain(display)
      const bytes = encoder.encode(current.replace(display, alias))
      const hash = yield* sha256(bytes)
      yield* store.writeBytes(`objects/${hash}`, bytes)
      aliasReads++
      return {
        ...snapshot,
        files: snapshot.files.map((file) =>
          file.path === snapshot.entrypoint ? { ...file, bytes: bytes.length, sha256: hash } : file,
        ),
      }
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
  )
  const plan = await host.run(
    planRemote(page, database, "skill").pipe(Effect.provideService(Store, oldRenderer)),
  )
  expect(aliasReads).toBeGreaterThan(0)
  expect(plan.baseline.entrypoint).toBe("SKILL.md")
  expect(plan.baseline.references?.map(({ id, path }) => ({ id, path }))).toEqual([
    { id: page, path: "SKILL.md" },
    { id: guide, path: "references/guide.md" },
  ])
  // Historical planning copied the generated entry's cached bytes directly.
  // Today's exporter re-renders its name, so freeze that old output before review.
  const entry = plan.baseline.files.find((file) => file.path === plan.baseline.entrypoint)!
  const originalEntry = await host.run(store.readBytes(`objects/${entry.sha256}`))
  plan.output = plan.output.map((file) =>
    file.path === plan.baseline.entrypoint
      ? { ...file, base64: Buffer.from(originalEntry).toString("base64") }
      : file,
  )
  expect(host.mutations()).toBe(0)
  const bytes = JSON.stringify(plan)
  const hash = await host.run(sha256(bytes))
  const ledger = join(host.scratch, "generated-entry-attempt.json")
  return { host, store, plan, bytes, hash, ledger, archive }
}

async function reviewedReplanAttempt() {
  const attempt = await generatedEntryAttempt()
  const previousVersion = await attempt.host.run(
    sha256(JSON.stringify([attempt.plan.baseline.version_id, "previous-materialization"])),
  )
  const baseline = {
    ...attempt.plan.baseline,
    version_id: previousVersion,
    snapshot_id: `s_${await attempt.host.run(
      sha256(
        JSON.stringify([
          attempt.plan.baseline.scope,
          attempt.plan.baseline.historical_snapshot_id ? page : attempt.plan.baseline.record.id,
          previousVersion,
        ]),
      ),
    )}`,
  }
  const plan = { ...attempt.plan, baseline }
  const bytes = JSON.stringify(plan)
  const hash = await attempt.host.run(sha256(bytes))
  const currentStore = attempt.store
  const currentPlan = await attempt.host.run(planRemote(page, database, "skill"))
  const currentVersion = currentPlan.baseline.version_id
  return { ...attempt, plan, bytes, hash, currentVersion, currentStore, currentPlan }
}

test("reviewed replan preserves frozen output across a materialization version change and applies it", async () => {
  const { host, plan, bytes, hash, ledger, currentVersion, currentStore, currentPlan } =
    await reviewedReplanAttempt()
  expect(currentVersion).not.toBe(plan.baseline.version_id)
  expect(currentPlan.baseline.record).toEqual(plan.baseline.record)
  expect(currentPlan.baseline.references).toEqual(plan.baseline.references)
  expect(currentPlan.baseline.source_files).toEqual(plan.baseline.source_files)
  expect(currentPlan.baseline.source_projection).toEqual(plan.baseline.source_projection)
  expect(currentPlan.guard).toBe(plan.guard)
  expect(currentPlan.output).not.toEqual(plan.output)
  const originalEntry = plan.output.find((file) => file.path === "SKILL.md")!
  const currentEntry = currentPlan.output.find((file) => file.path === "SKILL.md")!
  expect(Buffer.from(originalEntry.base64, "base64").toString()).toContain(
    '"name": "recovery-skill"',
  )
  expect(Buffer.from(currentEntry.base64, "base64").toString()).toBe(
    Buffer.from(originalEntry.base64, "base64")
      .toString()
      .replace('"name": "recovery-skill"', '"name": "Recovery Skill"'),
  )
  // An old plan remains version-bound even when its authored authority is unchanged.
  expect(
    await host.run(
      applyRemote(bytes, hash, ledger).pipe(
        Effect.provideService(Store, currentStore),
        Effect.result,
      ),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
  const successor = await host.run(
    replanRemote(bytes, hash, ledger).pipe(Effect.provideService(Store, currentStore)),
  )
  expect(successor).toMatchObject({
    format: "portable-remote-reviewed-upgrade",
    baseline: { version_id: currentVersion },
    lineage: {
      plan_sha256: hash,
      plan_base64: Buffer.from(bytes).toString("base64"),
      attempt_ledger: ledger,
    },
  })
  expect(successor.baseline).toEqual(currentPlan.baseline)
  expect(successor.source_inventory).toEqual(currentPlan.source_inventory)
  expect(successor.output).toEqual(plan.output)
  expect(JSON.stringify(plan)).toBe(bytes)
  expect(host.mutations()).toBe(0)
  expect([...host.json.keys()].filter((key) => key.startsWith("publications/"))).toEqual([])
  await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })

  const successorBytes = JSON.stringify(successor)
  const successorHash = await host.run(sha256(successorBytes))
  const successorLedger = join(host.scratch, "reviewed-successor-attempt.json")
  expect(
    await host.run(
      applyRemote(successorBytes, successorHash, successorLedger).pipe(
        Effect.provideService(Store, currentStore),
      ),
    ),
  ).toMatchObject({ verified: true })
  expect(await readLedger(successorLedger)).toMatchObject({
    plan_hash: successorHash,
    baseline: JSON.parse(JSON.stringify(successor.baseline)),
  })
  await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })
  expect(host.mutations()).toBeGreaterThan(0)
  const current = await host.run(openSkill(page, { refresh: true }))
  const saved = await host.run(snapshotAuthoredPortable(current))
  expect(
    saved.files.map((file) => ({
      path: file.path,
      base64: Buffer.from(file.bytes).toString("base64"),
    })),
  ).toEqual(plan.output)
  expect(current.record.id).toBe(plan.baseline.record.id)
  expect(host.remoteGuide()).toBe(liveGuide)
  expect(host.calls.filter((call) => call.path === "v1/pages" && call.method === "POST")).toEqual(
    [],
  )
})

for (const change of ["main markdown", "reference markdown", "metadata", "resources"] as const) {
  test(`reviewed replan rejects changed raw ${change} before ledger or mutation`, async () => {
    const { host, bytes, hash, ledger, currentStore } = await reviewedReplanAttempt()
    let mainReads = 0
    const request: Notion["Service"]["request"] = (path, body, options) =>
      host.provider.request(path, body, options).pipe(
        Effect.map((response) => {
          if (
            change !== "main markdown" ||
            path !== `v1/pages/${page}/markdown` ||
            body !== undefined
          )
            return response
          const raw = property(response)
          mainReads++
          return { ...raw, markdown: String(raw.markdown).replace("# Sample", "# Samplf") }
        }),
      )
    if (change === "reference markdown") host.remoteEdit(liveGuide.replace("Current", "Durrent"))
    if (change === "metadata") host.renameRemote("Recovery Skilm")
    if (change === "resources") host.seedAttachment("assets/new.bin", binary)
    expect(
      await host.run(
        replanRemote(bytes, hash, ledger).pipe(
          Effect.provideService(Store, currentStore),
          Effect.provideService(Notion, { ...host.provider, request }),
          Effect.result,
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
    if (change === "main markdown") expect(mainReads).toBeGreaterThan(0)
    expect(host.mutations()).toBe(0)
    expect([...host.json.keys()].filter((key) => key.startsWith("publications/"))).toEqual([])
    await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })
  })
}

test("reviewed replan rejects an unchanged materialization version", async () => {
  const { host, bytes, hash, ledger } = await generatedEntryAttempt()
  expect(await host.run(replanRemote(bytes, hash, ledger).pipe(Effect.result))).toMatchObject({
    _tag: "Failure",
    failure: { code: "CONVERSION_BLOCKED" },
  })
  expect(host.mutations()).toBe(0)
  await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })
})

test("reviewed replan rejects a different original plan hash before observing or mutating", async () => {
  const { host, bytes, ledger, currentStore } = await reviewedReplanAttempt()
  const wrongHash = await host.run(sha256(`${bytes}\n`))
  const calls = host.calls.length
  expect(
    await host.run(
      replanRemote(bytes, wrongHash, ledger).pipe(
        Effect.provideService(Store, currentStore),
        Effect.result,
      ),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
  expect(host.calls.length).toBe(calls)
  expect(host.mutations()).toBe(0)
  await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })
})

test("reviewed replan rejects an existing attempt ledger without replacing it", async () => {
  const { host, bytes, hash, ledger, currentStore } = await reviewedReplanAttempt()
  const attempted = JSON.stringify({ plan_hash: hash, page_id: page, state: "attempted" })
  await writeFile(ledger, attempted)
  const calls = host.calls.length
  expect(
    await host.run(
      replanRemote(bytes, hash, ledger).pipe(
        Effect.provideService(Store, currentStore),
        Effect.result,
      ),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
  expect(await readFile(ledger, "utf8")).toBe(attempted)
  expect(host.calls.length).toBe(calls)
  expect(host.mutations()).toBe(0)
  expect([...host.json.keys()].filter((key) => key.startsWith("publications/"))).toEqual([])
})

test("reviewed replan resolves original ledger identity and rejects a relative alias at apply", async () => {
  const { host, bytes, hash, ledger } = await reviewedReplanAttempt()
  const successor = await host.run(replanRemote(bytes, hash, relative(process.cwd(), ledger)))
  expect(successor.lineage.attempt_ledger).toBe(ledger)
  const successorBytes = JSON.stringify(successor)
  const successorHash = await host.run(sha256(successorBytes))
  const alias = `${ledger.slice(0, ledger.lastIndexOf("/"))}/./${ledger.slice(ledger.lastIndexOf("/") + 1)}`
  expect(
    await host.run(applyRemote(successorBytes, successorHash, alias).pipe(Effect.result)),
  ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
  expect(host.mutations()).toBe(0)
  await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })
})

for (const tamper of [
  "lineage bytes",
  "lineage hash",
  "lineage target",
  "SKILL.md",
  "references/guide.md",
  "assets/raw.bin",
] as const) {
  test(`reviewed replan rejects tampered ${tamper} with a recomputed successor hash before mutation`, async () => {
    const { host, plan, bytes, hash, ledger, currentStore } = await reviewedReplanAttempt()
    const successor = await host.run(
      replanRemote(bytes, hash, ledger).pipe(Effect.provideService(Store, currentStore)),
    )
    let changed = successor
    if (tamper === "lineage bytes")
      changed = {
        ...successor,
        lineage: {
          ...successor.lineage,
          plan_base64: Buffer.from(`${bytes}\n`).toString("base64"),
        },
      }
    else if (tamper === "lineage hash")
      changed = { ...successor, lineage: { ...successor.lineage, plan_sha256: "0".repeat(64) } }
    else if (tamper === "lineage target") {
      const originalBytes = JSON.stringify({ ...plan, page_id: guide })
      changed = {
        ...successor,
        lineage: {
          ...successor.lineage,
          plan_base64: Buffer.from(originalBytes).toString("base64"),
          plan_sha256: await host.run(sha256(originalBytes)),
        },
      }
    } else
      changed = {
        ...successor,
        output: successor.output.map((file) =>
          file.path === tamper
            ? {
                ...file,
                base64: Buffer.concat([
                  Buffer.from(file.base64, "base64"),
                  Buffer.from("x"),
                ]).toString("base64"),
              }
            : file,
        ),
      }
    const changedBytes = JSON.stringify(changed)
    const changedHash = await host.run(sha256(changedBytes))
    const successorLedger = join(host.scratch, "reviewed-successor-attempt.json")
    expect(
      await host.run(
        applyRemote(changedBytes, changedHash, successorLedger).pipe(
          Effect.provideService(Store, currentStore),
          Effect.result,
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
    expect(host.mutations()).toBe(0)
    expect([...host.json.keys()].filter((key) => key.startsWith("publications/"))).toEqual([])
    await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(successorLedger)).rejects.toMatchObject({ code: "ENOENT" })
  })
}

test("reviewed output preserves the original generated alias bytes on the same page", async () => {
  const { host, store, plan, bytes, hash, ledger, archive } = await generatedEntryAttempt()
  const currentPlan = await host.run(planRemote(page, database, "skill"))
  const oldEntry = plan.source_inventory.find((file) => file.path === "SKILL.md")!
  const newEntry = currentPlan.source_inventory.find((file) => file.path === "SKILL.md")!
  expect(oldEntry.sha256).not.toBe(newEntry.sha256)
  const oldText = new TextDecoder().decode(
    await host.run(store.readBytes(`objects/${oldEntry.sha256}`)),
  )
  const newText = new TextDecoder().decode(
    await host.run(store.readBytes(`objects/${newEntry.sha256}`)),
  )
  expect(oldText).toContain('"name": "recovery-skill"')
  expect(newText).toBe(oldText.replace('"name": "recovery-skill"', '"name": "Recovery Skill"'))
  expect(
    Buffer.from(plan.output.find((file) => file.path === "SKILL.md")!.base64, "base64").toString(),
  ).toBe(oldText)
  const currentOutput = Buffer.from(
    currentPlan.output.find((file) => file.path === "SKILL.md")!.base64,
    "base64",
  ).toString()
  expect(currentOutput).toBe(newText)
  expect(currentOutput).not.toBe(oldText)
  expect(currentPlan.baseline.record).toEqual(plan.baseline.record)
  expect(currentPlan.baseline.references).toEqual(plan.baseline.references)
  expect(currentPlan.baseline.router_members).toEqual(plan.baseline.router_members)
  expect(currentPlan.baseline.version_id).toBe(plan.baseline.version_id)
  expect(currentPlan.baseline.scope).toBe(plan.baseline.scope)
  expect(currentPlan.guard).toBe(plan.guard)
  expect(currentPlan.source_inventory.filter((file) => file.path !== "SKILL.md")).toEqual(
    plan.source_inventory.filter((file) => file.path !== "SKILL.md"),
  )
  expect(plan.source_inventory.find((file) => file.path === BUNDLE)?.sha256).toBe(
    await host.run(sha256(archive)),
  )
  expect(currentPlan.output.filter((file) => file.path !== "SKILL.md")).toEqual(
    plan.output.filter((file) => file.path !== "SKILL.md"),
  )
  expect(host.mutations()).toBe(0)

  const applied = await host.run(applyRemote(bytes, hash, ledger))
  expect(applied).toMatchObject({ verified: true })
  expect((await readLedger(ledger)).plan_hash).toBe(hash)
  expect((await readLedger(ledger)).baseline).toEqual(plan.baseline)
  expect(await host.run(sha256(bytes))).toBe(hash)
  expect(JSON.stringify(plan)).toBe(bytes)
  expect(host.calls.filter((call) => call.path === "v1/pages" && call.method === "POST")).toEqual(
    [],
  )
  const current = await host.run(openSkill(page, { refresh: true }))
  expect(current.record.id).toBe(plan.baseline.record.id)
  expect(current.record.name).toBe(liveName)
  expect(host.remoteGuide()).toBe(liveGuide)
  const saved = await host.run(snapshotAuthoredPortable(current))
  expect(
    saved.files.map((file) => ({
      path: file.path,
      base64: Buffer.from(file.bytes).toString("base64"),
    })),
  ).toEqual(plan.output)
})

for (const path of ["SKILL.md", "references/guide.md", "assets/raw.bin"] as const) {
  test(`reviewed output rejects changed ${path} bytes with a recomputed plan hash before ledger or mutation`, async () => {
    const { host, plan, ledger } = await generatedEntryAttempt()
    const changed = {
      ...plan,
      output: plan.output.map((file) =>
        file.path === path
          ? {
              ...file,
              base64: Buffer.concat([
                Buffer.from(file.base64, "base64"),
                Buffer.from("x"),
              ]).toString("base64"),
            }
          : file,
      ),
    }
    expect(changed.output).not.toEqual(plan.output)
    const bytes = JSON.stringify(changed)
    const hash = await host.run(sha256(bytes))
    expect(await host.run(applyRemote(bytes, hash, ledger).pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { code: "CONVERSION_BLOCKED" },
    })
    expect(host.mutations()).toBe(0)
    expect([...host.json.keys()].filter((key) => key.startsWith("publications/"))).toEqual([])
    await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })
  })
}

for (const change of ["main markdown", "reference markdown", "metadata"] as const) {
  test(`generated entry drift rejects one-character authored ${change} changes before ledger or mutation`, async () => {
    const { host, bytes, hash, ledger } = await generatedEntryAttempt()
    let mainReads = 0
    const request: Notion["Service"]["request"] = (path, body, options) =>
      host.provider.request(path, body, options).pipe(
        Effect.map((response) => {
          if (
            change !== "main markdown" ||
            path !== `v1/pages/${page}/markdown` ||
            body !== undefined
          )
            return response
          const raw = property(response)
          const markdown = String(raw.markdown)
          expect(markdown).toContain("# Sample")
          mainReads++
          return { ...raw, markdown: markdown.replace("# Sample", "# Samplf") }
        }),
      )
    if (change === "reference markdown") host.remoteEdit(liveGuide.replace("Current", "Durrent"))
    if (change === "metadata") host.renameRemote("Recovery Skilm")
    const result = await host.run(
      applyRemote(bytes, hash, ledger).pipe(
        Effect.provideService(Notion, { ...host.provider, request }),
        Effect.result,
      ),
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
    if (change === "main markdown") expect(mainReads).toBeGreaterThan(0)
    expect(host.mutations()).toBe(0)
    expect(host.calls.every((call) => call.method === "GET" || call.path.endsWith("/query"))).toBe(
      true,
    )
    await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })
  })
}

for (const side of ["original", "current", "both"] as const) {
  for (const graph of ["missing", "empty", "root only"] as const) {
    test(`generated entry drift rejects ${graph} references in ${side} source authority before ledger or mutation`, async () => {
      const { host, store, plan, bytes, hash, ledger } = await generatedEntryAttempt()
      const incomplete = (snapshot: Snapshot): Snapshot => {
        if (graph === "missing") {
          const { references: _references, ...rest } = snapshot
          return rest
        }
        return {
          ...snapshot,
          references:
            graph === "empty"
              ? []
              : snapshot.references?.filter((reference) => reference.id === page),
        }
      }
      const approved = side === "current" ? plan : { ...plan, baseline: incomplete(plan.baseline) }
      const approvedBytes = side === "current" ? bytes : JSON.stringify(approved)
      const approvedHash = side === "current" ? hash : await host.run(sha256(approvedBytes))
      const currentStore =
        side === "original"
          ? store
          : observeStore(store, (snapshot) => Effect.succeed(incomplete(snapshot)))
      expect(
        await host.run(
          applyRemote(approvedBytes, approvedHash, ledger).pipe(
            Effect.provideService(Store, currentStore),
            Effect.result,
          ),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
      expect(host.mutations()).toBe(0)
      await expect(access(ledger)).rejects.toMatchObject({ code: "ENOENT" })
    })
  }
}

async function reviewedRecoveryAttempt() {
  const attempt = await stoppedAttempt("prepare", true)
  const plan = JSON.parse(attempt.bytes) as {
    baseline: Snapshot
    guard: string
    output: Array<{ path: string; base64: string }>
  }
  const current = await attempt.host.run(planRemote(page, database, "skill"))
  expect(current.baseline.version_id).not.toBe(plan.baseline.version_id)
  expect(current.baseline.snapshot_id).not.toBe(plan.baseline.snapshot_id)
  expect(current.baseline.record).toEqual(plan.baseline.record)
  expect(current.baseline.references).toEqual(plan.baseline.references)
  expect(current.baseline.files).toEqual(plan.baseline.files)
  expect(current.baseline.source_files).toEqual(plan.baseline.source_files)
  expect(current.baseline.source_projection).toEqual(plan.baseline.source_projection)
  expect(current.guard).toBe(plan.guard)
  return { ...attempt, plan, current }
}

test("explicit recovery review binds historical no-intent operation and resumes its frozen output", async () => {
  const { host, bytes, hash, ledger, operation, receipt, plan, current } =
    await reviewedRecoveryAttempt()
  const ledgerBytes = await readFile(ledger, "utf8")
  const originalReceipt = structuredClone(receipt())
  expect(originalReceipt).toMatchObject({ state: "failed", intents: [] })
  for (const recover of [reconcileRemote, resumeRemote]) {
    expect(await host.run(recover(bytes, hash, ledger, page).pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { code: "CONVERSION_BLOCKED" },
    })
  }
  const offset = host.calls.length
  const review = await host.run(
    planRecoveryRemote(bytes, hash, relative(process.cwd(), ledger), page, operation),
  )
  expect(review).toMatchObject({
    format: "portable-remote-recovery-review",
    original_plan_sha256: hash,
    original_plan_base64: Buffer.from(bytes).toString("base64"),
    original_ledger_sha256: await host.run(sha256(ledgerBytes)),
    original_ledger_path: ledger,
    operation_id: operation,
    page_id: page,
    baseline: current.baseline,
    guard: plan.guard,
    output: plan.output,
  })
  expect(review.baseline).toEqual(current.baseline)
  expect(review.output).toEqual(plan.output)
  expect(host.mutations()).toBe(0)
  expect(receipt()).toEqual(originalReceipt)
  expect(await readFile(ledger, "utf8")).toBe(ledgerBytes)
  expect(
    host.calls
      .slice(offset)
      .every(
        (call) =>
          call.method === "GET" || call.path === "v1/search" || call.path.endsWith("/query"),
      ),
  ).toBe(true)
  expect([...host.json.keys()].filter((key) => key.startsWith("publications/"))).toEqual([
    `publications/${operation}.json`,
  ])

  const reviewBytes = JSON.stringify(review)
  const reviewHash = await host.run(sha256(reviewBytes))
  expect(
    await host.run(resumeRemote(bytes, hash, ledger, page, operation, reviewBytes, reviewHash)),
  ).toMatchObject({ verified: true, operation_id: operation })
  expect(receipt()).toMatchObject({ state: "completed", operation_id: operation })
  expect(await readFile(ledger, "utf8")).toBe(ledgerBytes)
  expect(await readLedger(ledger)).toMatchObject({
    plan_hash: hash,
    operation_id: operation,
    baseline: plan.baseline,
  })
  expect([...host.json.keys()].filter((key) => key.startsWith("publications/"))).toEqual([
    `publications/${operation}.json`,
  ])
  const saved = await host.run(
    openSkill(page, { refresh: true }).pipe(Effect.flatMap(snapshotAuthoredPortable)),
  )
  expect(
    saved.files.map((file) => ({
      path: file.path,
      base64: Buffer.from(file.bytes).toString("base64"),
    })),
  ).toEqual(plan.output)
  expect(host.remoteGuide()).toBe(liveGuide)
  expect(host.calls.filter((call) => call.path === "v1/pages" && call.method === "POST")).toEqual(
    [],
  )
})

for (const mismatch of ["plan hash", "operation", "expected page"] as const) {
  test(`explicit recovery review rejects wrong original ${mismatch} without changing its attempt`, async () => {
    const { host, bytes, hash, ledger, operation, receipt } = await reviewedRecoveryAttempt()
    const originalLedger = await readFile(ledger, "utf8")
    const originalReceipt = structuredClone(receipt())
    expect(
      await host.run(
        planRecoveryRemote(
          bytes,
          mismatch === "plan hash" ? "0".repeat(64) : hash,
          ledger,
          mismatch === "expected page" ? database : page,
          mismatch === "operation" ? "p_unrelated-receipt" : operation,
        ).pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
    expect(host.mutations()).toBe(0)
    expect(receipt()).toEqual(originalReceipt)
    expect(await readFile(ledger, "utf8")).toBe(originalLedger)
  })
}

for (const tamper of [
  "review hash",
  "original plan hash",
  "operation",
  "ledger hash",
  "ledger path",
  "baseline",
  "guard",
  "output",
  "ledger bytes",
  "missing review bytes",
  "missing review hash",
] as const) {
  test(`explicit recovery resume rejects changed ${tamper} without mutating the original operation`, async () => {
    const { host, bytes, hash, ledger, operation, receipt, plan } = await reviewedRecoveryAttempt()
    const review = { ...(await host.run(planRecoveryRemote(bytes, hash, ledger, page))) }
    if (tamper === "original plan hash") review.original_plan_sha256 = "0".repeat(64)
    if (tamper === "operation") review.operation_id = "p_unrelated-receipt"
    if (tamper === "ledger hash") review.original_ledger_sha256 = "0".repeat(64)
    if (tamper === "ledger path") review.original_ledger_path = join(host.scratch, "other.json")
    if (tamper === "baseline") review.baseline = plan.baseline
    if (tamper === "guard") review.guard += " "
    if (tamper === "output")
      review.output = review.output.map((file) =>
        file.path === "workflow.md"
          ? { ...file, base64: Buffer.from("Changed approved output\n").toString("base64") }
          : file,
      )
    if (tamper === "ledger bytes") await writeFile(ledger, (await readFile(ledger, "utf8")) + "\n")
    const originalLedger = await readFile(ledger, "utf8")
    const originalReceipt = structuredClone(receipt())
    const reviewBytes = JSON.stringify(review)
    const reviewHash = await host.run(sha256(reviewBytes))
    expect(
      await host.run(
        resumeRemote(
          bytes,
          hash,
          ledger,
          page,
          operation,
          tamper === "missing review bytes" ? undefined : reviewBytes,
          tamper === "missing review hash"
            ? undefined
            : tamper === "review hash"
              ? "0".repeat(64)
              : reviewHash,
        ).pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
    expect(host.mutations()).toBe(0)
    expect(receipt()).toEqual(originalReceipt)
    expect(await readFile(ledger, "utf8")).toBe(originalLedger)
  })
}

for (const stage of ["review", "resume"] as const) {
  for (const change of ["main markdown", "reference markdown", "metadata", "resources"] as const) {
    test(`explicit recovery ${stage} rejects changed raw ${change}`, async () => {
      const { host, bytes, hash, ledger, operation, receipt } = await reviewedRecoveryAttempt()
      const review =
        stage === "resume"
          ? await host.run(planRecoveryRemote(bytes, hash, ledger, page))
          : undefined
      const originalLedger = await readFile(ledger, "utf8")
      const originalReceipt = structuredClone(receipt())
      let mainReads = 0
      const request: Notion["Service"]["request"] = (path, body, options) =>
        host.provider.request(path, body, options).pipe(
          Effect.map((response) => {
            if (
              change !== "main markdown" ||
              path !== `v1/pages/${page}/markdown` ||
              body !== undefined
            )
              return response
            const raw = property(response)
            mainReads++
            return { ...raw, markdown: String(raw.markdown).replace("# Sample", "# Samplf") }
          }),
        )
      if (change === "reference markdown") host.remoteEdit(liveGuide.replace("Current", "Durrent"))
      if (change === "metadata") host.renameRemote("Recovery Skilm")
      if (change === "resources") host.seedAttachment("assets/new.bin", binary)
      const reviewBytes = review ? JSON.stringify(review) : ""
      const result = review
        ? resumeRemote(
            bytes,
            hash,
            ledger,
            page,
            operation,
            reviewBytes,
            await host.run(sha256(reviewBytes)),
          )
        : planRecoveryRemote(bytes, hash, ledger, page, operation)
      expect(
        await host.run(
          result.pipe(Effect.provideService(Notion, { ...host.provider, request }), Effect.result),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
      if (change === "main markdown") expect(mainReads).toBeGreaterThan(0)
      expect(host.mutations()).toBe(0)
      expect(receipt()).toEqual(originalReceipt)
      expect(await readFile(ledger, "utf8")).toBe(originalLedger)
    })
  }
}

for (const stopAt of ["mutation", "allocation", "after-allocation"] as const) {
  test(`explicit recovery review rejects any existing ${stopAt} intent`, async () => {
    const { host, bytes, hash, ledger, operation, receipt } = await stoppedAttempt(stopAt, true)
    const originalLedger = await readFile(ledger, "utf8")
    const originalReceipt = structuredClone(receipt())
    const before = host.mutations()
    expect(originalReceipt.intents.length).toBeGreaterThan(0)
    expect(
      await host.run(planRecoveryRemote(bytes, hash, ledger, page, operation).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "NO_REPLAY" } })
    expect(host.mutations()).toBe(before)
    expect(receipt()).toEqual(originalReceipt)
    expect(await readFile(ledger, "utf8")).toBe(originalLedger)
  })
}

test("an existing recovery review cannot override a subsequently unknown mutation", async () => {
  const { host, bytes, hash, ledger, operation, receipt } = await reviewedRecoveryAttempt()
  const review = await host.run(planRecoveryRemote(bytes, hash, ledger, page))
  const reviewBytes = JSON.stringify(review)
  const reviewHash = await host.run(sha256(reviewBytes))
  const originalLedger = await readFile(ledger, "utf8")
  let lost = false
  const request: Notion["Service"]["request"] = (path, body, options) =>
    host.provider.request(path, body, options).pipe(
      Effect.flatMap((response) => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        if (lost || method === "GET" || path === "v1/search" || path.endsWith("/query"))
          return Effect.succeed(response)
        lost = true
        return Effect.fail(
          fail("WRITE_OUTCOME_UNKNOWN", "Accepted recovery mutation response lost"),
        )
      }),
    )
  expect(
    await host.run(
      resumeRemote(bytes, hash, ledger, page, operation, reviewBytes, reviewHash).pipe(
        Effect.provideService(Notion, { ...host.provider, request }),
        Effect.result,
      ),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
  expect(lost).toBe(true)
  expect(receipt().intents.some((intent) => intent.status === "unknown")).toBe(true)
  const failedReceipt = structuredClone(receipt())
  const before = host.mutations()
  expect(
    await host.run(
      resumeRemote(bytes, hash, ledger, page, operation, reviewBytes, reviewHash).pipe(
        Effect.result,
      ),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "NO_REPLAY" } })
  expect(host.mutations()).toBe(before)
  expect(receipt()).toEqual(failedReceipt)
  expect(await readFile(ledger, "utf8")).toBe(originalLedger)
})

test("prepare GET loss reconciles without writes and resumes the same known root exactly once", async () => {
  const { host, bytes, hash, ledger, operation, receipt, plannedFile } = await stoppedAttempt()
  const beforeReconcile = host.calls.length
  const savedReceipt = structuredClone(receipt())
  expect(await host.run(reconcileRemote(bytes, hash, ledger, page))).toMatchObject({
    operation_id: operation,
    page_id: page,
    state: "needs_prepare_revalidation",
    remote_writes: 0,
  })
  expect(host.calls.length).toBeGreaterThan(beforeReconcile)
  expect(host.calls.slice(beforeReconcile).every((call) => call.method === "GET")).toBe(true)
  expect(host.mutations()).toBe(0)
  expect(receipt()).toEqual(savedReceipt)

  const recovered = await host.run(resumeRemote(bytes, hash, ledger, page))
  expect(recovered).toMatchObject({ verified: true, operation_id: operation })
  expect(receipt()).toMatchObject({ state: "completed", operation_id: operation })
  expect([...host.json.keys()].filter((key) => key.startsWith("publications/"))).toEqual([
    `publications/${operation}.json`,
  ])
  expect(host.calls.filter((call) => call.path === "v1/pages" && call.method === "POST")).toEqual(
    [],
  )
  const current = await host.run(openSkill(page, { refresh: true }))
  expect(current.record.name).toBe(liveName)
  expect(host.remoteGuide()).toBe(liveGuide)
  const portable = await host.run(snapshotAuthoredPortable(current))
  expect(portable.files.find((file) => file.path === "workflow.md")?.bytes).toEqual(
    new Uint8Array(plannedFile("workflow.md")),
  )
  expect(portable.files.find((file) => file.path === "assets/raw.bin")?.bytes).toEqual(binary)
  const writes = host.mutations()
  expect(writes).toBeGreaterThan(0)
  const requestOffset = host.calls.length
  expect(await host.run(resumeRemote(bytes, hash, ledger, page))).toEqual(recovered)
  expect(host.mutations()).toBe(writes)
  expect(host.calls.slice(requestOffset).every((call) => call.method === "GET")).toBe(true)
  expect((await readLedger(ledger)).operation_id).toBe(operation)
})

test("recovery preserves frozen output when current materialization renders the same source differently", async () => {
  const { host, bytes, hash, ledger, operation, receipt, plannedFile } = await stoppedAttempt()
  const originalMaterialize = exportModule.snapshotAuthoredPortable
  let changedRenders = 0
  const rendering = vi
    .spyOn(exportModule, "snapshotAuthoredPortable")
    .mockImplementation((snapshot) =>
      originalMaterialize(snapshot).pipe(
        Effect.map((portable) => {
          if (receipt().intents.length !== 0) return portable
          changedRenders++
          return {
            ...portable,
            files: portable.files.map((file) =>
              file.path === portable.main
                ? {
                    ...file,
                    bytes: encoder.encode(new TextDecoder().decode(file.bytes) + "\n"),
                  }
                : file,
            ),
          }
        }),
      ),
    )
  try {
    expect(await host.run(reconcileRemote(bytes, hash, ledger, page))).toMatchObject({
      operation_id: operation,
      state: "needs_prepare_revalidation",
    })
    expect(host.mutations()).toBe(0)
    expect(await host.run(resumeRemote(bytes, hash, ledger, page))).toMatchObject({
      operation_id: operation,
      verified: true,
    })
    expect(changedRenders).toBeGreaterThan(0)
  } finally {
    rendering.mockRestore()
  }
  expect(receipt()).toMatchObject({ operation_id: operation, state: "completed" })
  expect((await readLedger(ledger)).operation_id).toBe(operation)
  const current = await host.run(openSkill(page, { refresh: true }))
  const saved = await host.run(snapshotAuthoredPortable(current))
  expect(saved.files.find((file) => file.path === "workflow.md")?.bytes).toEqual(
    new Uint8Array(plannedFile("workflow.md")),
  )
  expect(host.remoteGuide()).toBe(liveGuide)
})

test("a GET failure after acknowledged allocation resumes the existing pending upload", async () => {
  const { host, bytes, hash, ledger, operation, receipt, request } =
    await stoppedAttempt("after-allocation")
  const allocation = receipt().intents.find((intent) => intent.path === "v1/file_uploads")!
  const uploadId = property(allocation.response).id
  expect(uploadId).toEqual(expect.any(String))
  expect(allocation).toMatchObject({ status: "completed", artifact: { filename: BUNDLE } })
  const before = host.mutations()
  const offset = host.calls.length
  const observed = await host.run(
    reconcileRemote(bytes, hash, ledger, page).pipe(
      Effect.provideService(Notion, { ...host.provider, request }),
    ),
  )
  expect(observed).toMatchObject({ verified: false })
  expect(host.mutations()).toBe(before)
  expect(host.calls.slice(offset).every((call) => call.method === "GET")).toBe(true)
  const recovered = await host.run(
    resumeRemote(bytes, hash, ledger, page).pipe(
      Effect.provideService(Notion, { ...host.provider, request }),
    ),
  )
  expect(recovered).toMatchObject({ operation_id: operation, verified: true })
  expect(receipt()).toMatchObject({ state: "completed", operation_id: operation })
  expect(
    host.calls.filter((call) => call.path === "v1/file_uploads" && call.method === "POST"),
  ).toHaveLength(1)
  expect(
    host.calls.filter(
      (call) => call.path === `v1/file_uploads/${uploadId}/send` && call.method === "POST",
    ),
  ).toHaveLength(1)
  expect((await readLedger(ledger)).operation_id).toBe(operation)
  const current = await host.run(openSkill(page, { refresh: true }))
  const portable = await host.run(snapshotAuthoredPortable(current))
  expect(portable.files.find((file) => file.path === "assets/raw.bin")?.bytes).toEqual(binary)
  const completedWrites = host.mutations()
  expect(
    await host.run(
      resumeRemote(bytes, hash, ledger, page).pipe(
        Effect.provideService(Notion, { ...host.provider, request }),
      ),
    ),
  ).toEqual(recovered)
  expect(host.mutations()).toBe(completedWrites)
})

for (const change of ["plan hash", "body", "metadata", "expected page"] as const) {
  test(`prepare recovery rejects changed ${change} without an additional mutation`, async () => {
    const { host, bytes, hash, ledger, operation, receipt } = await stoppedAttempt()
    if (change === "body") host.remoteEdit("# Guide\n\nExternal edit after failed preparation.\n")
    if (change === "metadata") host.renameRemote("External rename after failed preparation")
    const approvedHash = change === "plan hash" ? "0".repeat(64) : hash
    const expectedPage = change === "expected page" ? database : page
    const before = host.mutations()
    const savedReceipt = structuredClone(receipt())
    for (const recover of [reconcileRemote, resumeRemote]) {
      const result = await host.run(
        recover(bytes, approvedHash, ledger, expectedPage).pipe(Effect.result),
      )
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
      expect(host.mutations()).toBe(before)
      expect(receipt()).toEqual(savedReceipt)
      expect((await readLedger(ledger)).operation_id).toBe(operation)
    }
    expect(before).toBe(0)
  })
}

test("rehashing altered plan output and ledger cannot replace the receipt's frozen bytes", async () => {
  const { host, bytes, ledger, operation, receipt } = await stoppedAttempt()
  const altered = JSON.parse(bytes) as {
    output: Array<{ path: string; base64: string }>
  }
  const main = altered.output.find((file) => file.path === "workflow.md")!
  main.base64 = Buffer.from(
    Buffer.from(main.base64, "base64").toString("utf8") + "\nChanged rendering after approval.\n",
  ).toString("base64")
  const changedBytes = JSON.stringify(altered)
  const changedHash = await host.run(sha256(changedBytes))
  const originalLedger = await readLedger(ledger)
  await writeFile(ledger, JSON.stringify({ ...originalLedger, plan_hash: changedHash }))
  const savedReceipt = structuredClone(receipt())
  const requestOffset = host.calls.length
  for (const recover of [reconcileRemote, resumeRemote]) {
    expect(
      await host.run(recover(changedBytes, changedHash, ledger, page).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
    expect(host.mutations()).toBe(0)
    expect(receipt()).toEqual(savedReceipt)
    expect(await readLedger(ledger)).toEqual({ ...originalLedger, plan_hash: changedHash })
  }
  expect(host.calls.slice(requestOffset).every((call) => call.method === "GET")).toBe(true)
  expect(receipt().operation_id).toBe(operation)
})

for (const fault of ["mutation", "allocation"] as const) {
  test(`an accepted ${fault} with a lost response cannot enter prepare recovery`, async () => {
    const { host, bytes, hash, ledger, receipt } = await stoppedAttempt(fault)
    const before = host.mutations()
    const savedReceipt = structuredClone(receipt())
    if (fault === "allocation") {
      expect(
        receipt().intents.some(
          (intent) =>
            intent.path === "v1/file_uploads" &&
            intent.method === "POST" &&
            intent.status === "unknown",
        ),
      ).toBe(true)
      expect(
        host.calls.filter((call) => call.path === "v1/file_uploads" && call.method === "POST"),
      ).toHaveLength(1)
    }
    const offset = host.calls.length
    for (const recover of [reconcileRemote, resumeRemote]) {
      expect(await host.run(recover(bytes, hash, ledger, page).pipe(Effect.result))).toMatchObject({
        _tag: "Failure",
        failure: { code: "NO_REPLAY" },
      })
      expect(host.mutations()).toBe(before)
      expect(receipt()).toEqual(savedReceipt)
    }
    expect(host.calls.slice(offset).every((call) => call.method === "GET")).toBe(true)
  })
}

test("legacy ledger requires an explicit matching operation before durable binding and resume", async () => {
  const { host, bytes, hash, ledger, operation, receipt } = await stoppedAttempt()
  const { operation_id: _operation, ...legacy } = await readLedger(ledger)
  await writeFile(ledger, JSON.stringify(legacy))
  const savedReceipt = structuredClone(receipt())
  for (const recover of [reconcileRemote, resumeRemote]) {
    for (const explicit of [undefined, "p_unrelated-receipt"]) {
      expect(
        await host.run(recover(bytes, hash, ledger, page, explicit).pipe(Effect.result)),
      ).toMatchObject({ _tag: "Failure", failure: { code: "CONVERSION_BLOCKED" } })
      expect((await readLedger(ledger)).operation_id).toBeUndefined()
      expect(receipt()).toEqual(savedReceipt)
      expect(host.mutations()).toBe(0)
    }
  }
  expect(await host.run(reconcileRemote(bytes, hash, ledger, page, operation))).toMatchObject({
    operation_id: operation,
    state: "needs_prepare_revalidation",
  })
  expect((await readLedger(ledger)).operation_id).toBe(operation)
  expect(receipt()).toEqual(savedReceipt)
  expect(host.mutations()).toBe(0)
  expect(await host.run(resumeRemote(bytes, hash, ledger, page))).toMatchObject({
    operation_id: operation,
    verified: true,
  })
})
