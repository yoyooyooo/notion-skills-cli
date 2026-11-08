import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { Notion } from "../../packages/core/src/notion.ts"
import { property, text } from "../../packages/core/src/model.ts"
import {
  createLibrary,
  sharedCreateFixture,
} from "../../packages/core/test/shared-create-fixture.ts"
import { id, rich } from "../../packages/core/test/shared-snapshot-fixture.ts"
import type { SmokeContext } from "./context.ts"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
type HttpObservation = {
  method: string
  path: string
  request_bytes: number
  response_bytes: number | null
  status: number | null
  response_lost?: boolean
}

/** The fixture owns only the loopback service; every consumer action uses the installed Node bin. */
export async function checkAuthoring(context: SmokeContext) {
  const root = join(context.scratch, "controlled-authoring")
  await mkdir(root)
  const state = join(root, "state")
  const calls: HttpObservation[] = []
  const commands: unknown[] = []
  const errors: unknown[] = []
  const retainedPlans = new Map<string, string>()
  const retainedResourcePlans = new Map<string, string>()
  const resourcePages = new Set<string>()
  const resourceBlocks = new Map<string, Record<string, unknown>>()
  const resourceChildren = new Map<string, string[]>()
  let nextResourceId = 95_000
  const original = sharedCreateFixture()
  const ownedPages = new Set<string>()
  original.onCreate((row) => ownedPages.add(String(row.id)))
  // Model a page authored directly in Notion, not a CLI-created identity or
  // a seeded consumer snapshot. Adoption must preserve this native page/body.
  const draftPage = id(90_002)
  const draft = structuredClone(original.base.main)
  draft.id = draftPage
  const draftFields = property(draft.properties)
  draftFields.title = { id: "title", type: "title", title: [{ plain_text: "Installed draft" }] }
  draftFields.description = rich("description", "Created directly in the native fixture")
  draftFields.skill_id = rich("skill_id", "")
  draftFields.main_file_id = rich("main_file_id", "")
  draftFields.members = { id: "members", type: "relation", relation: [], has_more: false }
  property(draftFields.enabled).checkbox = false
  original.skills.set(draftPage, draft)
  const originalDraftBody = "# Native draft\n\nKeep the original native page."
  original.base.bodies.set(draftPage, originalDraftBody)
  ownedPages.add(draftPage)
  let editedAt = Date.now()
  let loseOutcome = false
  let lostOperation: string | undefined
  let loseResourceOutcome = false
  let lostResourceOperation: string | undefined
  const token = "controlled-installed-author-token"
  const view = id(90_001)
  const writes = (values: readonly HttpObservation[]) =>
    values.filter(
      (call) => call.method === "PATCH" || (call.method === "POST" && call.path === "v1/pages"),
    )

  // Preserve the original fixture's durable-before-create oracle. The observer
  // copies only a real retained dispatch from the owned consumer SQLite store;
  // it never seeds or edits consumer state, snapshots, receipts or credentials.
  function observeOriginalCreatePlan() {
    const database = new Database(join(state, "state.sqlite"), { readonly: true })
    try {
      const rows = database
        .query(
          "SELECT key,payload FROM shared_local_records WHERE category='dispatch' AND retired=0 AND key LIKE 'operations/shared-native-create/%'",
        )
        .all()
      assert.equal(rows.length, 1, "One real original native-create dispatch must precede POST")
      for (const raw of rows) {
        const row = property(raw)
        assert.equal(typeof row.key, "string")
        assert.equal(typeof row.payload, "string")
        const key = String(row.key),
          payload = String(row.payload)
        const prior = retainedPlans.get(key)
        if (prior !== undefined) assert.equal(payload, prior, "The original create plan changed")
        retainedPlans.set(key, payload)
        original.base.json.set(key, JSON.parse(payload))
      }
    } finally {
      database.close()
    }
  }

  function observeOriginalResourcePlan() {
    const database = new Database(join(state, "state.sqlite"), { readonly: true })
    try {
      const rows = database
        .query(
          "SELECT key,payload FROM shared_local_records WHERE category='dispatch' AND retired=0 AND key LIKE 'operations/shared-observation-pending/%'",
        )
        .all()
        .map(property)
        .filter(
          (row) =>
            property(property(JSON.parse(String(row.payload))).plan).kind === "resource_authoring",
        )
      assert.equal(
        rows.length,
        1,
        "One durable original resource plan must precede a display mutation",
      )
      const row = rows[0]!,
        key = String(row.key),
        payload = String(row.payload)
      if (retainedResourcePlans.has(key)) assert.equal(payload, retainedResourcePlans.get(key))
      retainedResourcePlans.set(key, payload)
      const plan = property(property(JSON.parse(payload)).plan)
      const facts = [...original.base.records.values()].map((record) => ({
        record_id: text(property(property(record.properties).record).rich_text),
        operation_id: property(
          JSON.parse(text(property(property(record.properties).payload).rich_text)),
        ).operation_id,
      }))
      assert.ok(
        facts.some((fact) => fact.operation_id === plan.operation_id),
        "Original shared resource intent precedes display",
      )
      assert.ok(
        facts.some((fact) => fact.record_id === plan.prior_pin),
        "Exact prior complete pin precedes display",
      )
      for (const content of [plan.content, plan.before].filter((value) => value !== null))
        assert.ok(
          facts.some((fact) => fact.record_id === property(content).object_id),
          "Exact before/after resource manifests precede display",
        )
      return plan
    } finally {
      database.close()
    }
  }

  function addResourceBlock(page: string, value: unknown) {
    const blockId = id(nextResourceId++)
    const block = {
      ...property(structuredClone(value)),
      object: "block",
      id: blockId,
      parent: { type: "page_id", page_id: page },
      archived: false,
      in_trash: false,
    }
    resourceBlocks.set(blockId, block)
    resourceChildren.set(page, [...(resourceChildren.get(page) ?? []), blockId])
    return block
  }

  const request = async (path: string, body: unknown, method: "GET" | "POST" | "PATCH") => {
    const url = new URL(path, "http://127.0.0.1")
    if (url.pathname === "/v1/users/me") {
      assert.equal(method, "GET")
      return { object: "user", id: id(90_000) }
    }
    if (url.pathname === "/v1/views") {
      assert.equal(method, "GET")
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        database_id: createLibrary.skills.database_id,
        page_size: "100",
      })
      return {
        object: "list",
        results: [{ object: "view", id: view }],
        has_more: false,
        next_cursor: null,
      }
    }
    if (url.pathname === `/v1/views/${view}`) {
      assert.equal(method, "GET")
      assert.equal(url.searchParams.size, 0)
      return {
        id: view,
        name: "Controlled author directory",
        type: "table",
        data_source_id: createLibrary.skills.data_source_id,
        parent: { type: "database_id", database_id: createLibrary.skills.database_id },
        url: `https://notion.so/${createLibrary.skills.database_id}?v=${view}`,
      }
    }
    const parent = property(property(body).parent).data_source_id
    const raw = property(body)
    if (
      path === "v1/pages" &&
      method === "POST" &&
      parent === createLibrary.files.data_source_id &&
      Array.isArray(raw.children)
    ) {
      observeOriginalResourcePlan()
      assert.equal(raw.markdown, undefined)
      assert.equal(raw.children.length, 1)
      const page = id(nextResourceId++)
      const row = {
        object: "page",
        id: page,
        last_edited_time: new Date(++editedAt).toISOString(),
        parent: {
          type: "data_source_id",
          data_source_id: createLibrary.files.data_source_id,
          database_id: createLibrary.files.database_id,
        },
        properties: Object.fromEntries(
          Object.entries(property(raw.properties)).map(([key, value]) => {
            const field = property(value),
              type = Array.isArray(field.rich_text)
                ? "rich_text"
                : Array.isArray(field.title)
                  ? "title"
                  : Array.isArray(field.relation)
                    ? "relation"
                    : "select"
            return [
              key,
              {
                ...field,
                id: key,
                type,
                ...(type === "rich_text" || type === "relation" ? { has_more: false } : {}),
              },
            ]
          }),
        ),
      }
      original.files.set(page, row)
      original.base.bodies.set(page, "RESOURCE MANAGEMENT NOTES; NEVER CONSUME AS RESOURCE BYTES")
      resourcePages.add(page)
      addResourceBlock(page, raw.children[0])
      return structuredClone(row)
    }
    const resourceChild = /^v1\/blocks\/([^/]+)\/children(?:\?.*)?$/u.exec(path)
    if (resourceChild !== null && resourcePages.has(resourceChild[1]!)) {
      const page = resourceChild[1]!
      if (method === "GET")
        return {
          object: "list",
          results: (resourceChildren.get(page) ?? []).map((block) =>
            structuredClone(resourceBlocks.get(block)),
          ),
          has_more: false,
          next_cursor: null,
        }
      assert.equal(method, "PATCH")
      observeOriginalResourcePlan()
      assert.ok(Array.isArray(raw.children) && raw.children.length === 1)
      const block = addResourceBlock(page, raw.children[0])
      original.files.get(page)!.last_edited_time = new Date(++editedAt).toISOString()
      return { object: "list", results: [block], has_more: false, next_cursor: null }
    }
    const resourceBlock = /^v1\/blocks\/([^/]+)$/u.exec(path)
    if (resourceBlock !== null && resourceBlocks.has(resourceBlock[1]!)) {
      assert.equal(method, "GET")
      return structuredClone(resourceBlocks.get(resourceBlock[1]!))
    }
    if (
      path === "v1/pages" &&
      method === "POST" &&
      [createLibrary.skills.data_source_id, createLibrary.files.data_source_id].includes(
        String(parent),
      )
    )
      observeOriginalCreatePlan()
    const matched = /^v1\/pages\/([^/]+)(\/markdown)?$/u.exec(url.pathname.slice(1))
    const page = matched?.[1]
    const selected =
      page === undefined ? undefined : (original.skills.get(page) ?? original.files.get(page))
    if (page !== undefined && resourcePages.has(page)) {
      assert.equal(
        matched?.[2],
        undefined,
        "Raw resource management prose must never enter Markdown consumption",
      )
      assert.ok(selected)
      if (method === "PATCH") {
        observeOriginalResourcePlan()
        const changes = property(raw.properties)
        assert.deepEqual(Object.keys(raw), ["properties"])
        assert.deepEqual(Object.keys(changes), ["path"])
        property(selected.properties).path = {
          ...property(property(selected.properties).path),
          ...property(changes.path),
        }
        selected.last_edited_time = new Date(++editedAt).toISOString()
      } else assert.equal(method, "GET")
      return structuredClone(selected)
    }
    // This is the same strict whole-body/property fixture boundary used by
    // shared-skill-apply.test.ts. Unknown pages, paths and properties fail.
    if (
      method === "PATCH" &&
      page !== undefined &&
      ownedPages.has(page) &&
      selected !== undefined
    ) {
      if (matched?.[2] === "/markdown") {
        const current = original.base.bodies.get(page)
        const updates = property(property(body).update_content).content_updates
        assert.equal(typeof current, "string")
        assert.ok(Array.isArray(updates) && updates.length === 1)
        const update = property(updates[0])
        assert.equal(typeof update.old_str, "string")
        assert.equal(typeof update.new_str, "string")
        assert.ok(
          String(update.old_str).length > 0 && String(current).includes(String(update.old_str)),
        )
        const markdown = String(current).replace(String(update.old_str), String(update.new_str))
        original.base.bodies.set(page, markdown)
        selected.last_edited_time = new Date(++editedAt).toISOString()
        return { id: page, markdown, truncated: false, unknown_block_ids: [] }
      }
      const changes = property(property(body).properties)
      assert.deepEqual(Object.keys(property(body)), ["properties"])
      assert.ok(Object.keys(changes).length > 0)
      const enabling =
        Object.keys(changes).length === 1 && property(changes.enabled).checkbox === true
      if (!enabling) {
        const properties = property(selected.properties)
        for (const [key, value] of Object.entries(changes)) {
          assert.ok(Object.hasOwn(properties, key), `Unknown controlled property: ${key}`)
          properties[key] = { ...property(properties[key]), ...property(value) }
        }
        selected.last_edited_time = new Date(++editedAt).toISOString()
        return structuredClone(selected)
      }
    }
    return original.run(Effect.flatMap(Notion, (api) => api.request(path, body, { method })))
  }

  const server = createServer(async (incoming, response) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    const path = String(incoming.url).replace(/^\//u, "")
    const method = incoming.method
    const observed: HttpObservation = {
      path,
      method: String(method),
      request_bytes: bytes.length,
      response_bytes: null,
      status: null,
    }
    calls.push(observed)
    try {
      assert.equal(incoming.headers.authorization, `Bearer ${token}`)
      assert.ok(method === "GET" || method === "POST" || method === "PATCH")
      const body: unknown = bytes.length === 0 ? undefined : JSON.parse(bytes.toString("utf8"))
      const result = await request(path, body, method)
      const record = text(property(property(property(body).properties).record).rich_text)
      if (
        loseOutcome &&
        method === "POST" &&
        path === "v1/pages" &&
        record.startsWith("outcome-body-write-")
      ) {
        loseOutcome = false
        lostOperation = record.slice("outcome-".length)
        observed.response_lost = true
        incoming.socket.destroy()
        return
      }
      if (
        loseResourceOutcome &&
        method === "POST" &&
        path === "v1/pages" &&
        record.startsWith("outcome-resource-authoring-")
      ) {
        loseResourceOutcome = false
        lostResourceOperation = record.slice("outcome-".length)
        observed.response_lost = true
        incoming.socket.destroy()
        return
      }
      const serialized = JSON.stringify(result)
      observed.response_bytes = Buffer.byteLength(serialized)
      observed.status = 200
      response.writeHead(200, { "content-type": "application/json" })
      response.end(serialized)
    } catch (error) {
      errors.push({ path, method, error: String(error) })
      const serialized = JSON.stringify({
        object: "error",
        code: "validation_error",
        message: "Controlled fixture rejected an unexpected request",
      })
      observed.response_bytes = Buffer.byteLength(serialized)
      observed.status = 400
      response.writeHead(400, { "content-type": "application/json" })
      response.end(serialized)
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address !== null && typeof address !== "string")
  const env = {
    HOME: join(root, "home"),
    NTN_SKILLS_HOME: state,
    NTN_SKILLS_CONFIG_HOME: join(root, "config"),
    NTN_SKILLS_CACHE_HOME: join(root, "cache"),
    NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
    NOTION_API_TOKEN: token,
    NOTION_WORKSPACE_ID: "",
    NOTION_API_BASE_URL: `http://127.0.0.1:${address.port}`,
  }
  const invoke = async (label: string, args: string[], expectedExit = 0) => {
    const start = calls.length
    const metricsSupported = args[0] === "read" || args[0] === "files"
    const argv = metricsSupported ? [...args, "--metrics"] : args
    try {
      const result = await context.cli(argv, expectedExit, env)
      const observed = calls.slice(start)
      const metricsObserved = result.request_metrics !== undefined
      if (metricsSupported || metricsObserved) {
        const metrics = property(result.request_metrics)
        assert.equal(metrics.total_requests, observed.length, `${label}: actual HTTP count`)
        assert.equal(metrics.in_flight, 0)
        assert.equal(metrics.trace_enabled, true)
        assert.equal(metrics.trace_dropped, 0)
        assert.equal(
          metrics.requests && property(metrics.requests).notion_write,
          writes(observed).length,
        )
      }
      commands.push({
        label,
        argv: [context.runtime, context.executable, ...argv],
        exit: expectedExit,
        result,
        http_start: start,
        http_count: observed.length,
        observation: metricsObserved
          ? "transport_metrics_and_loopback_service"
          : "loopback_service",
      })
      await writeFile(join(root, `${label}.json`), JSON.stringify(result, null, 2) + "\n")
      assert.equal(errors.length, 0, "The strict controlled service rejected a request")
      return result
    } catch (error) {
      commands.push({
        label,
        argv: [context.runtime, context.executable, ...argv],
        error: String(error),
        http_start: start,
        http_count: calls.length - start,
      })
      throw error
    }
  }
  const noWrites = async (label: string, args: string[], expectedExit = 0) => {
    const before = writes(calls).length
    const result = await invoke(label, args, expectedExit)
    assert.equal(writes(calls).length, before, `${label}: zero source mutations`)
    return result
  }
  const directory = async (name: string, files: Record<string, string>) => {
    const location = join(root, name)
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split("/")
      await mkdir(join(location, ...parts.slice(0, -1)), { recursive: true })
      await writeFile(join(location, path), content)
    }
    return location
  }
  let completed = false
  try {
    const initial = {
      "SKILL.md":
        "---\nname: Installed author\ndescription: Independent installed author fixture\n---\n\n# Installed author\n\nInitial main.\n",
      "references/a.md": "# A\n\nOriginal A.\n",
      "references/b.md": "# B\n\nOriginal B.\n",
    }
    // Native Markdown has a canonical read view; keep this explicit fixture
    // expectation separate from both submitted source bytes and later pins.
    const expectedInitial: Record<string, string> = {
      "SKILL.md":
        '---\n"description": "Independent installed author fixture"\n"name": "Installed author"\n---\n\n# Installed author\n\nInitial main.\n',
      "references/a.md": "# A\n\nOriginal A.",
      "references/b.md": "# B\n\nOriginal B.",
    }
    const input = await directory("create-input", initial)
    const db = createLibrary.skills.database_id
    const dry = await noWrites("create-dry", ["create", input, "--database", db, "--dry-run"])
    assert.equal(dry.dry_run, true)
    const created = await invoke("create", ["create", input, "--database", db])
    assert.equal(created.operation, "create")
    assert.equal(created.verified, true)
    assert.equal(original.nativeCreates().length, 3)
    assert.equal(original.enablePatches().length, 1)
    const owner = String(created.record.id)
    const originalRef = String(created.ref)
    const originalSnapshot = String(created.snapshot_id)
    const current = async (label: string) =>
      invoke(label, ["read", owner, "--database", db, "--refresh", "--json"])
    const read = await current("created-current")
    assert.equal(read.record.name, "Installed author")
    const originalFiles = await noWrites("created-files", ["files", originalSnapshot, "--offline"])
    assert.deepEqual(
      originalFiles.files.map((file: { path: string }) => file.path).sort(),
      Object.keys(initial).sort(),
    )
    const pinned = new Map<string, string>()
    for (const [index, file] of originalFiles.files.entries()) {
      const output = await noWrites(`old-file-${index}`, ["read", file.ref, "--offline", "--json"])
      assert.equal(output.content, expectedInitial[file.path])
      pinned.set(file.path, output.content)
    }
    const reusedCreate = await noWrites("create-original-reuse", [
      "create",
      input,
      "--database",
      db,
    ])
    assert.equal(reusedCreate.reused, true)
    assert.equal(reusedCreate.create_operation_id, created.create_operation_id)
    assert.equal(reusedCreate.ref, originalRef)
    const conflicting = await directory("create-conflict-input", {
      ...initial,
      "SKILL.md": initial["SKILL.md"].replace("Initial main.", "Different creation intent."),
    })
    const conflict = await noWrites("create-conflict", ["create", conflicting, "--database", db], 1)
    assert.equal(conflict.error.code, "NAME_CONFLICT")
    const writeInput = join(root, "write.md")
    await writeFile(
      writeInput,
      "---\nname: Not a metadata edit\ndescription: Not an implicit update\n---\n\n# Written main\n\nChanged through write.\n",
    )
    const mismatchedMetadata = await noWrites(
      "write-metadata-conflict",
      ["write", read.ref, "--input", writeInput],
      1,
    )
    assert.equal(mismatchedMetadata.error.code, "SHARED_METADATA_CONFLICT")
    await writeFile(
      writeInput,
      "---\nname: Installed author\ndescription: Independent installed author fixture\n---\n\n# Written main\n\nChanged through write.\n",
    )
    await noWrites("write-dry", ["write", read.ref, "--input", writeInput, "--dry-run"])
    const written = await invoke("write", ["write", read.ref, "--input", writeInput])
    assert.equal(written.record.name, "Installed author")
    assert.equal(written.record.description, "Independent installed author fixture")
    const afterWrite = await current("written-current")
    assert.ok(afterWrite.content.includes("Changed through write."))
    const bodyBeforeUpdate = original.base.bodies.get(String(written.record.locator.page_id))
    await noWrites("update-dry", [
      "update",
      afterWrite.ref,
      "--description",
      "Explicit metadata update",
      "--dry-run",
    ])
    const updated = await invoke("update", [
      "update",
      afterWrite.ref,
      "--description",
      "Explicit metadata update",
    ])
    assert.equal(updated.record.name, "Installed author")
    assert.equal(updated.record.description, "Explicit metadata update")
    assert.equal(original.base.bodies.get(String(written.record.locator.page_id)), bodyBeforeUpdate)
    const afterUpdate = await current("updated-current")
    const patch = await directory("apply-input", { "references/a.md": "# A\n\nApplied A.\n" })
    await noWrites("apply-dry", ["apply", afterUpdate.ref, "--input", patch, "--dry-run"])
    const applied = await invoke("apply", ["apply", afterUpdate.ref, "--input", patch])
    assert.deepEqual(applied.changes, { files: ["references/a.md"], removed: [] })
    const afterApply = await current("applied-current")
    assert.equal(afterApply.content, afterUpdate.content)
    const a = await noWrites("applied-a", [
      "read",
      "references/a.md",
      "--from",
      afterApply.ref,
      "--offline",
      "--json",
    ])
    const b = await noWrites("preserved-b", [
      "read",
      "references/b.md",
      "--from",
      afterApply.ref,
      "--offline",
      "--json",
    ])
    assert.equal(a.content, "# A\n\nApplied A.")
    assert.equal(b.content, pinned.get("references/b.md"))
    await noWrites("apply-reuse", ["apply", afterApply.ref, "--input", patch])
    const replacement = await directory("replace-input", {
      "SKILL.md": afterApply.content,
      "references/a.md": a.content,
    })
    await noWrites("replace-dry", [
      "replace",
      replacement,
      "--target",
      afterApply.ref,
      "--database",
      db,
      "--dry-run",
    ])
    const replaced = await invoke("replace", [
      "replace",
      replacement,
      "--target",
      afterApply.ref,
      "--database",
      db,
    ])
    assert.equal(replaced.operation, "replace")
    const afterReplace = await current("replaced-current")
    assert.equal(afterReplace.content, afterApply.content)
    const currentFiles = await noWrites("replaced-files", [
      "files",
      afterReplace.snapshot_id,
      "--offline",
    ])
    assert.deepEqual(currentFiles.files.map((file: { path: string }) => file.path).sort(), [
      "SKILL.md",
      "references/a.md",
    ])
    const stale = await noWrites("stale-write", ["write", originalRef, "--input", writeInput], 1)
    assert.equal(stale.error.code, "WRITE_CONFLICT")
    for (const [index, file] of originalFiles.files.entries()) {
      const restored = await noWrites(`preserved-old-file-${index}`, [
        "read",
        file.ref,
        "--offline",
        "--json",
      ])
      assert.equal(restored.content, pinned.get(file.path))
    }
    const unknownInput = join(root, "unknown.md")
    await writeFile(unknownInput, "# Verified original outcome\n\nKeep the original operation.\n")
    loseOutcome = true
    const unknown = await invoke(
      "lost-original-outcome",
      ["write", afterReplace.ref, "--input", unknownInput],
      1,
    )
    assert.equal(unknown.error.code, "WRITE_OUTCOME_UNKNOWN")
    assert.ok(lostOperation?.startsWith("body-write-"))
    assert.equal(loseOutcome, false)
    const sentBodies = calls.filter(
      (call) => call.method === "PATCH" && call.path.endsWith("/markdown"),
    ).length
    const reconciliation = await noWrites(
      "reconcile-original",
      ["read", owner, "--database", db, "--refresh", "--json"],
      1,
    )
    assert.equal(reconciliation.error.code, "SHARED_BODY_WRITE_RECONCILED")
    assert.equal(reconciliation.error.details.body_write_operation_id, lostOperation)
    assert.equal(reconciliation.error.details.status, "applied")
    assert.equal(reconciliation.error.details.read_again, true)
    const recovered = await current("reconciled-current")
    const expectedRecovered = afterReplace.content.replace(
      "# Written main\n\nChanged through write.",
      "# Verified original outcome\n\nKeep the original operation.",
    )
    assert.notEqual(expectedRecovered, afterReplace.content)
    assert.equal(recovered.content, expectedRecovered)
    assert.equal(
      calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")).length,
      sentBodies,
    )
    const outcomes = [...original.base.records.values()].filter(
      (row) =>
        text(property(property(row.properties).record).rich_text) === `outcome-${lostOperation}`,
    )
    assert.equal(outcomes.length, 1, "Recovery must retain one exact original outcome")
    const resourceTarget = String(created.record.locator.page_id)
    const resource = (action: string, path: string, extra: string[] = []) => [
      "ctl",
      "library",
      "resource",
      action,
      resourceTarget,
      path,
      ...extra,
      "--entry",
      db,
    ]
    const scriptBytes = Buffer.from(
      "#!/bin/sh\r\nprintf 'this file is evidence, never an execution step'\r\n",
      "utf8",
    )
    const binaryBytes = Buffer.from(
      Uint8Array.from({ length: 70_003 }, (_, index) =>
        index < 2 ? [255, 0][index]! : (index * 73) % 251,
      ),
    )
    const scriptInput = join(root, "resource-script.sh"),
      binaryInput = join(root, "resource-binary.bin")
    await writeFile(scriptInput, scriptBytes)
    await chmod(scriptInput, 0o700)
    await writeFile(binaryInput, binaryBytes)
    await chmod(binaryInput, 0o600)
    await noWrites(
      "resource-add-dry",
      resource("add", "scripts/check.sh", ["--input", scriptInput, "--dry-run"]),
    )
    const addedScript = await invoke(
      "resource-add-script",
      resource("add", "scripts/check.sh", ["--input", scriptInput]),
    )
    const addedBinary = await invoke(
      "resource-add-binary",
      resource("add", "assets/payload.bin", ["--input", binaryInput]),
    )
    assert.equal(addedScript.status, "applied")
    assert.equal(addedScript.content.sha256, hash(scriptBytes))
    assert.equal(addedScript.content.mode, "100755")
    assert.equal(addedBinary.content.sha256, hash(binaryBytes))
    const rawDirectory = await noWrites("resource-complete-directory", [
      "files",
      owner,
      "--database",
      db,
      "--refresh",
    ])
    const initialRaw = rawDirectory.files.filter(
      (file: { path: string }) =>
        file.path === "scripts/check.sh" || file.path === "assets/payload.bin",
    )
    assert.equal(initialRaw.length, 2)
    for (const file of initialRaw) {
      assert.equal(file.sha256, hash(file.path === "scripts/check.sh" ? scriptBytes : binaryBytes))
      assert.equal(file.mode, file.path === "scripts/check.sh" ? "100755" : "100644")
    }
    const sdkRoot = join(root, "cold-sdk")
    const sdkEnv = {
      ...env,
      HOME: join(sdkRoot, "home"),
      NTN_SKILLS_HOME: join(sdkRoot, "state"),
      NTN_SKILLS_CONFIG_HOME: join(sdkRoot, "config"),
      NTN_SKILLS_CACHE_HOME: join(sdkRoot, "cache"),
      NTN_SKILLS_SCHEDULER_ROOT: join(sdkRoot, "scheduler"),
    }
    const sdkPath = join(context.installed, "dist", "sdk.js")
    const runSdk = async (label: string, code: string) => {
      const start = calls.length,
        before = writes(calls).length
      const program = `import * as sdk from ${JSON.stringify(sdkPath)};import {access} from 'node:fs/promises';import {join} from 'node:path';const metrics=[];const options={metrics:true,onRequestMetrics:value=>metrics.push(value)};${code}`
      const output = JSON.parse(
        await context.run([context.runtime, "--input-type=module", "-e", program], 0, sdkEnv),
      )
      assert.equal(writes(calls).length, before, `${label}: SDK acquisition is read-only`)
      assert.equal(
        output.metrics.reduce(
          (total: number, metric: { total_requests: number }) => total + metric.total_requests,
          0,
        ),
        calls.length - start,
        `${label}: SDK transport totals include all loopback requests`,
      )
      commands.push({
        label,
        sdk: sdkPath,
        runtime: context.runtime,
        result: output,
        http_start: start,
        http_count: calls.length - start,
      })
      await writeFile(join(root, `${label}.json`), JSON.stringify(output, null, 2) + "\n")
      assert.equal(errors.length, 0)
      return output
    }
    const cold = await runSdk(
      "resource-sdk-cold-selected",
      `
const input={version:1,targets:[${JSON.stringify(String(created.record.ref))}],purpose:'use',freshness:{policy:'refresh'}};
const consumed=await sdk.consume(input,options);await sdk.decodeConsumeResult(consumed,input);
const directory=await sdk.listSkill(${JSON.stringify(owner)},options);
const refs=Object.fromEntries(directory.files.map(file=>[file.path,file.ref]));
const present=async sha=>access(join(process.env.NTN_SKILLS_HOME,'objects',sha)).then(()=>true,()=>false);
const cold={script:await present(${JSON.stringify(hash(scriptBytes))}),binary:await present(${JSON.stringify(hash(binaryBytes))})};
const selected=await sdk.readResources({version:1,refs:[refs['scripts/check.sh']]},options);
const after={script:await present(${JSON.stringify(hash(scriptBytes))}),binary:await present(${JSON.stringify(hash(binaryBytes))})};
const missing=await sdk.readResources({version:1,refs:[refs['assets/payload.bin']]},{...options,offline:true});
console.log(JSON.stringify({consumed,directory,selected,missing,cold,after,metrics}));`,
    )
    assert.equal(cold.consumed.status, "ready")
    assert.equal(cold.consumed.entries[0].manifest.snapshot_id, rawDirectory.snapshot_id)
    assert.equal(cold.consumed.entries[0].materialization.status, "entry_ready")
    assert.deepEqual(cold.consumed.entries[0].materialization.paths, ["SKILL.md"])
    assert.deepEqual(cold.consumed.delivery, { status: "not_observed" })
    assert.deepEqual(cold.consumed.activation, { status: "not_evaluated" })
    assert.deepEqual(cold.directory.files, rawDirectory.files)
    assert.deepEqual(cold.cold, { script: false, binary: false })
    assert.deepEqual(cold.after, { script: true, binary: false })
    assert.equal(cold.selected.status, "ready")
    assert.equal(cold.selected.files[0].sha256, hash(scriptBytes))
    assert.equal(cold.selected.files[0].content, scriptBytes.toString("utf8"))
    assert.equal(cold.missing.status, "failed")

    const changedBinary = Buffer.from(
      binaryBytes.map((value, index) => (index < 2 ? value : value ^ 0x55)),
    )
    await writeFile(binaryInput, changedBinary)
    loseResourceOutcome = true
    const uncertainResource = await invoke(
      "resource-lost-original-outcome",
      resource("replace", "assets/payload.bin", ["--input", binaryInput]),
      1,
    )
    assert.equal(uncertainResource.error.code, "WRITE_OUTCOME_UNKNOWN")
    assert.equal(loseResourceOutcome, false)
    assert.ok(lostResourceOperation?.startsWith("resource-authoring-replace-"))
    const reconciledResource = await noWrites("resource-reconcile-original", [
      "ctl",
      "library",
      "resource",
      "reconcile",
      resourceTarget,
      lostResourceOperation!,
      "--entry",
      db,
    ])
    assert.equal(reconciledResource.status, "applied")
    assert.equal(reconciledResource.operation_id, lostResourceOperation)
    const changedDirectory = await noWrites("resource-changed-directory", [
      "files",
      owner,
      "--database",
      db,
      "--refresh",
    ])
    assert.notEqual(changedDirectory.snapshot_id, rawDirectory.snapshot_id)
    assert.equal(
      changedDirectory.files.find((file: { path: string }) => file.path === "assets/payload.bin")
        .sha256,
      hash(changedBinary),
    )
    const historicalStart = calls.length
    const oldBinaryRef = rawDirectory.files.find(
      (file: { path: string }) => file.path === "assets/payload.bin",
    ).ref
    const historical = await runSdk(
      "resource-sdk-original-pin-after-replace",
      `const result=await sdk.readResources({version:1,refs:[${JSON.stringify(oldBinaryRef)}]},options);console.log(JSON.stringify({result,metrics}));`,
    )
    assert.equal(historical.result.status, "ready")
    assert.equal(historical.result.selection.snapshot_id, rawDirectory.snapshot_id)
    assert.equal(historical.result.files[0].encoding, "base64")
    assert.deepEqual(Buffer.from(historical.result.files[0].content, "base64"), binaryBytes)
    assert.equal(
      calls.slice(historicalStart).some((call) => call.path.includes("/markdown")),
      false,
    )

    const changedScript = Buffer.from("# retained as an ordinary non-executable file\n", "utf8")
    await writeFile(scriptInput, changedScript)
    await chmod(scriptInput, 0o600)
    const replacedResource = await invoke(
      "resource-replace-script",
      resource("replace", "scripts/check.sh", ["--input", scriptInput]),
    )
    assert.equal(replacedResource.file_id, addedScript.file_id)
    assert.equal(replacedResource.content.mode, "100644")
    const movedResource = await invoke(
      "resource-move",
      resource("move", "scripts/check.sh", ["scripts/renamed.sh"]),
    )
    assert.equal(movedResource.file_id, addedScript.file_id)
    await invoke("resource-delete", resource("delete", "scripts/renamed.sh"))
    const deletedDirectory = await noWrites("resource-deleted-directory", [
      "files",
      owner,
      "--database",
      db,
      "--refresh",
    ])
    assert.equal(
      deletedDirectory.files.some((file: { path: string }) => file.path === "scripts/renamed.sh"),
      false,
    )
    const undeletedResource = await invoke(
      "resource-undelete",
      resource("undelete", "scripts/renamed.sh"),
    )
    assert.equal(undeletedResource.file_id, addedScript.file_id)
    assert.equal(undeletedResource.content.sha256, hash(changedScript))
    const originalResource = await noWrites("resource-reconcile-first-add-after-move", [
      "ctl",
      "library",
      "resource",
      "reconcile",
      resourceTarget,
      addedScript.operation_id,
      "--entry",
      db,
    ])
    assert.equal(originalResource.operation_id, addedScript.operation_id)
    const finalResources = await noWrites("resource-final-directory", [
      "files",
      owner,
      "--database",
      db,
      "--refresh",
    ])
    const exportedResources = join(root, "complete-resource-export")
    await noWrites("resource-full-export", [
      "export",
      finalResources.snapshot_id,
      "--output",
      exportedResources,
      "--format",
      "directory",
      "--projection",
      "snapshot",
      "--offline",
    ])
    assert.deepEqual(await readFile(join(exportedResources, "scripts/renamed.sh")), changedScript)
    assert.deepEqual(await readFile(join(exportedResources, "assets/payload.bin")), changedBinary)
    assert.equal((await stat(join(exportedResources, "scripts/renamed.sh"))).mode & 0o111, 0)
    assert.equal(
      original.base.bodies.get(addedScript.page_id),
      "RESOURCE MANAGEMENT NOTES; NEVER CONSUME AS RESOURCE BYTES",
    )
    const resourceEvidence = {
      first_snapshot: rawDirectory.snapshot_id,
      final_snapshot: finalResources.snapshot_id,
      stable_file_id: addedScript.file_id,
      original_operation: addedScript.operation_id,
      lost_original_operation: lostResourceOperation,
      binary: {
        bytes: binaryBytes.length,
        old_sha256: hash(binaryBytes),
        new_sha256: hash(changedBinary),
      },
      script: {
        old_sha256: hash(scriptBytes),
        old_mode: "100755",
        new_sha256: hash(changedScript),
        new_mode: "100644",
      },
      cold_sdk_roots: sdkRoot,
      sdk_sha256: hash(await readFile(sdkPath)),
      complete_manifest_verified: true,
      cold_raw_downloads_before_selection: 0,
      old_pin_recovered_after_current_replacement: true,
      management_body_preserved: true,
      complete_export: exportedResources,
    }
    const listedViews = await noWrites("ctl-views", ["ctl", "views", "--database", db, "--refresh"])
    const historicalViews = await noWrites("historical-views", [
      "views",
      "--database",
      db,
      "--offline",
    ])
    assert.deepEqual(
      listedViews.views.map((item: { id: string }) => item.id),
      [view],
    )
    assert.deepEqual(
      historicalViews.views.map((item: { id: string }) => item.id),
      [view],
    )
    await noWrites("ctl-status", ["ctl", "status"])
    const draftBefore = structuredClone(draft)
    const draftNativeCreatesBefore = original.nativeCreates().length
    await noWrites("adopt-dry", ["adopt", draftPage, "--database", db, "--dry-run"])
    assert.deepEqual(draft, draftBefore)
    const adoptionStart = calls.length
    const adopted = await invoke("adopt-native-draft", ["adopt", draftPage, "--database", db])
    assert.equal(adopted.status, "adopted")
    assert.equal(adopted.verified, true)
    assert.equal(adopted.skill_page_id, draftPage)
    assert.equal(adopted.enabled, false)
    assert.equal(original.nativeCreates().length, draftNativeCreatesBefore)
    assert.equal(original.base.bodies.get(draftPage), originalDraftBody)
    assert.equal(
      calls.slice(adoptionStart).filter((call) => call.method === "PATCH").length,
      1,
      "Adoption sends one identity PATCH and no body PATCH",
    )
    const deniedDraft = await noWrites(
      "draft-consumer-denied",
      ["read", draftPage, "--database", db, "--refresh", "--json"],
      1,
    )
    assert.equal(deniedDraft.error.code, "CONTENT_DISABLED")
    const draftRead = await noWrites("draft-author-read", [
      "read",
      draftPage,
      "--database",
      db,
      "--authoring",
      "--json",
    ])
    assert.equal(draftRead.record.enabled, false)
    assert.ok(draftRead.content.includes(originalDraftBody))
    const draftInput = join(root, "native-draft.md")
    await writeFile(draftInput, "# Native draft\n\nEdited while disabled.\n")
    const draftWritten = await invoke("draft-author-write", [
      "write",
      draftRead.ref,
      "--input",
      draftInput,
    ])
    assert.equal(draftWritten.verified, true)
    assert.equal(property(draftFields.enabled).checkbox, false)
    const draftEdited = await noWrites("draft-edited-author-read", [
      "read",
      draftPage,
      "--database",
      db,
      "--authoring",
      "--json",
    ])
    assert.ok(draftEdited.content.includes("Edited while disabled."))
    const draftUpdated = await invoke("draft-author-update", [
      "update",
      draftEdited.ref,
      "--description",
      "Reviewed native draft",
    ])
    assert.equal(draftUpdated.verified, true)
    assert.equal(draftUpdated.record.enabled, false)
    const enabledDraft = await invoke("draft-enable", [
      "update",
      draftPage,
      "--database",
      db,
      "--enabled",
      "true",
    ])
    assert.equal(enabledDraft.verified, true)
    assert.equal(enabledDraft.record.enabled, true)
    const consumedDraft = await noWrites("enabled-draft-consumer-read", [
      "read",
      draftPage,
      "--database",
      db,
      "--refresh",
      "--json",
    ])
    assert.ok(consumedDraft.content.includes("Edited while disabled."))
    const recoveryStart = calls.length
    const adoptedAgain = await noWrites("adopt-original-after-edits", [
      "adopt",
      draftPage,
      "--database",
      db,
      "--reconcile",
    ])
    assert.equal(adoptedAgain.status, "reconciled")
    assert.equal(adoptedAgain.verification, "original_adoption_outcome")
    assert.equal(adoptedAgain.adoption_operation_id, adopted.adoption_operation_id)
    assert.equal(adoptedAgain.enabled_at_adoption, false)
    assert.equal(adoptedAgain.enabled, undefined)
    assert.equal(
      calls.slice(recoveryStart).some((call) => call.path.endsWith("/markdown")),
      false,
      "Original adoption recovery does not substitute current body equality",
    )
    await invoke("draft-disable", ["update", draftPage, "--database", db, "--enabled", "false"])
    const disabledAgain = await noWrites(
      "disabled-draft-consumer-denied",
      ["read", draftPage, "--database", db, "--refresh", "--json"],
      1,
    )
    assert.equal(disabledAgain.error.code, "CONTENT_DISABLED")
    const preservedDraft = await noWrites("draft-original-pin-preserved", [
      "read",
      draftRead.ref,
      "--offline",
      "--json",
    ])
    assert.equal(preservedDraft.content, draftRead.content)
    completed = true
    const result = {
      proof: "independent_installed_node_with_controlled_notion",
      runtime: context.runtime,
      executable: context.executable,
      cli_sha256: hash(await readFile(context.executable)),
      source: {
        library_id: createLibrary.library_id,
        database_id: db,
        origin: env.NOTION_API_BASE_URL,
      },
      original_snapshot: originalSnapshot,
      original_files: Object.fromEntries(
        [...pinned].map(([path, value]) => [
          path,
          { bytes: Buffer.byteLength(value), sha256: hash(value) },
        ]),
      ),
      lost_original_operation: lostOperation,
      native_draft: {
        page_id: draftPage,
        adoption_operation_id: adopted.adoption_operation_id,
        original_snapshot: draftRead.snapshot_id,
        original_pin_preserved: true,
        disabled_authoring_verified: true,
        enable_disable_verified: true,
      },
      original_outcome_count: outcomes.length,
      raw_resource_lifecycle: resourceEvidence,
      command_count: commands.length,
      server_received_requests: calls.length,
      request_observation: "loopback_service; transport totals reconciled when returned by the CLI",
      writes: writes(calls).length,
      receipt: join(root, "evidence.json"),
    }
    context.evidence.controlled_installed_authoring = result
    return result
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify(
        {
          completed,
          commands,
          calls,
          errors,
          retained_create_plans: [...retainedPlans].map(([key, value]) => ({
            key,
            sha256: hash(value),
            payload: JSON.parse(value),
          })),
          retained_resource_plans: [...retainedResourcePlans].map(([key, value]) => ({
            key,
            sha256: hash(value),
            payload: JSON.parse(value),
          })),
          source_closed: true,
        },
        null,
        2,
      ) + "\n",
    )
  }
}
