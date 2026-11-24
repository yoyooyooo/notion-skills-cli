#!/usr/bin/env node
/** Explicit one-time operator tool. No import from this file belongs in the SDK. */
import { execFileSync } from "node:child_process"
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  appendFileSync,
  fsyncSync,
  readdirSync,
} from "node:fs"
import { resolve, join, isAbsolute, dirname } from "node:path"
import { pathToFileURL } from "node:url"
import {
  ROLES,
  OLD_MARKER,
  NEW_MARKER,
  digest,
  richText,
  writableRich,
  requireValue,
  decodeLegacy,
  valueText,
  preparePlan,
  migrateConfig,
  migratePortableManifest,
  rewriteReference,
  applyPlan,
} from "./library-root-migration.mjs"

const HELP =
  "Usage: node scripts/library-root-migrate.mjs inspect --entry OLD_SKILLS_DB --root ROOT_PAGE --output NEW_INVENTORY [--store EXISTING_STATE_ROOT ...] [--objects-root DIRECTORY ...]\n" +
  "       node scripts/library-root-migrate.mjs plan --inventory FILE --output NEW_PLAN\n" +
  "       node scripts/library-root-migrate.mjs apply --inventory FILE --plan FILE --journal PRIVATE_DIRECTORY --ack-plan SHA256 --writers-quiesced\n" +
  "       node scripts/library-root-migrate.mjs config --input FILE --plan FILE --output NEW_PRIVATE_CANDIDATE\n" +
  "       node scripts/library-root-migrate.mjs portable --input MANIFEST --tree PACKAGE_DIRECTORY --plan FILE --output NEW_PRIVATE_CANDIDATE\n" +
  "Notion access uses existing ntn and NOTION_API_TOKEN from the process environment. inspect/plan/config/portable never write Notion. apply only PATCHes existing pages/blocks/one descriptor; descriptor commits last. Historical Records, snapshots and external bytes are never rewritten. All outputs are new files, not overwrites."

function regularBytes(path) {
  requireValue(isAbsolute(path) && realpathSync(path) === path, "CANONICAL_FILE_REQUIRED")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    requireValue(stat.isFile(), "REGULAR_FILE_REQUIRED")
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}
function readJson(path) {
  return JSON.parse(regularBytes(resolve(path)).toString("utf8"))
}
function saveNew(path, value) {
  const target = resolve(path)
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return target
}
function api(endpoint, { method = "GET", body, fields = [] } = {}) {
  requireValue(Boolean(process.env.NOTION_API_TOKEN), "TOKEN_ENV_REQUIRED")
  const args = ["api", endpoint, "--notion-version", "2025-09-03", "--method", method]
  if (body !== undefined) args.push("--data", "@-")
  for (const id of fields) args.push("filter_properties==" + id)
  let text
  try {
    text = execFileSync("ntn", args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch {
    throw Object.assign(new Error("NOTION_REQUEST_FAILED"), {
      code: "NOTION_REQUEST_FAILED",
      details: { method, endpoint },
    })
  }
  const value = JSON.parse(text)
  const result = value.data ?? value
  requireValue(result.object !== "error" && !result.error, "NOTION_REQUEST_FAILED", {
    method,
    endpoint,
  })
  return result
}
function enumerate(endpoint, options = {}) {
  const rows = [],
    cursors = new Set(),
    ids = new Set()
  let cursor
  for (;;) {
    const query = options.method === "POST"
    const request = query
      ? endpoint
      : endpoint + "?page_size=100" + (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : "")
    const response = api(request, {
      ...options,
      ...(query
        ? { body: { ...options.body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } }
        : {}),
    })
    requireValue(
      response.object === "list" &&
        Array.isArray(response.results) &&
        (response.request_status === undefined || response.request_status.type === "complete"),
      "ENUMERATION_INCOMPLETE",
    )
    for (const row of response.results) {
      requireValue(typeof row.id === "string" && !ids.has(row.id), "ENUMERATION_REPEATED_ID")
      ids.add(row.id)
      rows.push(row)
    }
    if (!response.has_more) {
      requireValue(response.next_cursor === null, "ENUMERATION_CURSOR_INVALID")
      return rows
    }
    requireValue(
      typeof response.next_cursor === "string" && !cursors.has(response.next_cursor),
      "ENUMERATION_CURSOR_INVALID",
    )
    cursor = response.next_cursor
    cursors.add(cursor)
  }
}
function queryTable(binding, filter) {
  return enumerate("/v1/data_sources/" + binding.data_source_id + "/query", {
    method: "POST",
    fields: Object.values(binding.property_ids),
    body: filter ? { filter } : {},
  })
}
const currentRecordFilter = (binding) => ({
  or: [
    {
      and: [
        { property: binding.property_ids.Kind, select: { equals: "operation" } },
        {
          property: binding.property_ids["Record ID"],
          rich_text: { starts_with: "operation-current-" },
        },
      ],
    },
    { property: binding.property_ids.Kind, select: { equals: "profile" } },
  ],
})
export function inspectStore(path) {
  const selected = resolve(path),
    database = join(selected, "state.sqlite")
  requireValue(
    realpathSync(selected) === selected && existsSync(database),
    "ORIGINAL_STORE_REQUIRED",
  )
  const code =
    'import sqlite3,json,sys,hashlib,pathlib\np=pathlib.Path(sys.argv[1]);c=sqlite3.connect(p.as_uri()+"?mode=ro",uri=True);c.execute("pragma query_only=on")\nrows=c.execute("select key,payload from shared_local_records where category=\'dispatch\' and retired=0 order by key").fetchall()\nprint(json.dumps({"dispatch":[{"key":k,"payload_sha256":hashlib.sha256(v.encode()).hexdigest()} for k,v in rows],"snapshots":c.execute("select count(*) from snapshots").fetchone()[0]}))'
  let result
  try {
    result = JSON.parse(
      execFileSync("python3", ["-c", code, database], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )
  } catch {
    throw Object.assign(new Error("STORE_INSPECTION_FAILED"), { code: "STORE_INSPECTION_FAILED" })
  }
  return { path: selected, ...result }
}
function referenceTokens(text) {
  // This collector does not edit external bytes. False positives remain a
  // review blocker, never an automatic source/hash rewrite.
  return [...new Set(text.match(/skill:\/\/[^\s<>"'`\])}]+/gu) ?? [])]
}
export function auditPortableTree(directory, manifestPath, mapping) {
  const root = resolve(directory),
    manifest = resolve(manifestPath)
  requireValue(realpathSync(root) === root && dirname(manifest) === root, "PORTABLE_TREE_REQUIRED")
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const selected = join(path, entry.name)
      requireValue(!entry.isSymbolicLink(), "PORTABLE_TREE_SYMLINK")
      if (entry.isDirectory()) {
        visit(selected)
        continue
      }
      requireValue(entry.isFile(), "PORTABLE_TREE_SPECIAL_FILE")
      if (selected === manifest) continue
      const bytes = regularBytes(selected)
      let text
      try {
        text = new TextDecoder("utf8", { fatal: true }).decode(bytes)
      } catch {
        continue
      }
      for (const reference of referenceTokens(text))
        requireValue(
          rewriteReference(reference, mapping, mapping.old_library_id) === reference,
          "PORTABLE_DOCUMENT_REBIND_REQUIRED",
          { path: selected },
        )
    }
  }
  visit(root)
}
export function collectInventory({ entry, root, stores = [], objects = [] }) {
  const database = api("/v1/databases/" + entry)
  const legacy = decodeLegacy(database.description)
  requireValue(legacy.skills.database_id === entry, "ENTRY_DESCRIPTOR_MISMATCH")
  const rootPage = api("/v1/pages/" + root)
  const children = enumerate("/v1/blocks/" + root + "/children")
  const childIds = children
    .filter((block) => block.type === "child_database")
    .map((block) => block.id)
  const otherDescriptors = []
  const databases = new Map([[database.id, database]])
  for (const id of childIds) {
    const current = databases.get(id) ?? api("/v1/databases/" + id)
    databases.set(id, current)
    if (
      id !== entry &&
      [OLD_MARKER, NEW_MARKER].some((marker) => richText(current.description).startsWith(marker))
    )
      otherDescriptors.push(id)
  }
  const tables = {}
  for (const role of ROLES) {
    const binding = legacy[role]
    const selected =
      databases.get(binding.database_id) ?? api("/v1/databases/" + binding.database_id)
    const dataSource = api("/v1/data_sources/" + binding.data_source_id)
    const rows = queryTable(binding, role === "records" ? currentRecordFilter(binding) : undefined)
    tables[role] = { database: selected, data_source: dataSource, rows, complete: true }
  }
  const nativeBlocks = [],
    nativePages = new Set(),
    required = [],
    bodyFailures = []
  for (const role of ["skills", "files"])
    for (const row of tables[role].rows) {
      const encoded = valueText(legacy, role, row, "Content")
      if (!encoded) continue
      const content = JSON.parse(encoded)
      if (content.kind === "native") nativePages.add(row.id)
      else if (["resource", "source"].includes(content.kind)) {
        requireValue(
          /^[a-f0-9]{64}$/u.test(content.sha256) &&
            Number.isSafeInteger(content.bytes) &&
            content.bytes >= 0,
          "CONTENT_IDENTITY_INVALID",
        )
        required.push({
          page_id: row.id,
          sha256: content.sha256,
          bytes: content.bytes,
          authority: content.kind,
        })
      } else requireValue(false, "CONTENT_AUTHORITY_UNKNOWN")
    }
  const walk = (id) => {
    for (const block of enumerate("/v1/blocks/" + id + "/children")) {
      if (block.type === "synced_block" && block.synced_block?.synced_from !== null) {
        bodyFailures.push({ block_id: block.id, code: "EXTERNAL_SYNCED_BLOCK" })
        continue
      }
      nativeBlocks.push(block)
      if (block.has_children) walk(block.id)
    }
  }
  for (const page of nativePages) walk(page)
  const roots = [
    ...new Set([
      ...objects.map(resolve),
      ...stores.map((store) => join(resolve(store), "objects")),
    ]),
  ]
  const audited = new Map()
  for (const item of required) {
    if (audited.has(item.sha256)) continue
    for (const directory of roots) {
      const path = join(directory, item.sha256)
      if (!existsSync(path)) continue
      const bytes = regularBytes(path)
      requireValue(
        bytes.length === item.bytes && digest(bytes) === item.sha256,
        "CONTENT_BYTES_CHANGED",
      )
      let text
      try {
        text = new TextDecoder("utf8", { fatal: true }).decode(bytes)
      } catch {
        text = ""
      }
      audited.set(item.sha256, {
        sha256: item.sha256,
        bytes: bytes.length,
        references: referenceTokens(text),
        location: path,
      })
      break
    }
  }
  return {
    version: 1,
    kind: "library-root-migration-inventory",
    observed_at: new Date().toISOString(),
    root: rootPage,
    root_children_complete: true,
    root_database_ids: childIds,
    other_descriptors: otherDescriptors,
    tables,
    stores: stores.map(inspectStore),
    native_bodies_complete: bodyFailures.length === 0,
    native_body_failures: bodyFailures,
    native_page_ids: [...nativePages],
    native_blocks: nativeBlocks,
    required_content: required,
    content_audit: [...audited.values()],
  }
}
function patchEndpoint(patch) {
  return (
    "/v1/" + { page: "pages", block: "blocks", database: "databases" }[patch.kind] + "/" + patch.id
  )
}
function selectPatchValue(patch, raw) {
  if (patch.kind === "database") return { description: writableRich(raw.description) }
  if (patch.kind === "page") {
    const properties = {}
    for (const [id, wanted] of Object.entries(patch.before.properties)) {
      const values = Object.values(raw.properties).filter((value) => value.id === id)
      requireValue(values.length === 1 && !values[0].has_more, "PATCH_PROPERTY_INCOMPLETE")
      const type = Object.keys(wanted)[0]
      requireValue(values[0].type === type, "PATCH_PROPERTY_TYPE_CHANGED")
      properties[id] = { [type]: writableRich(values[0][type]) }
    }
    return { properties }
  }
  const type = Object.keys(patch.before)[0]
  requireValue(raw.type === type, "BLOCK_TYPE_CHANGED")
  return {
    [type]: Object.fromEntries(
      Object.keys(patch.before[type]).map((key) => [key, writableRich(raw[type][key])]),
    ),
  }
}
function freshPreflight(plan) {
  for (const path of plan.stores)
    requireValue(inspectStore(path).dispatch.length === 0, "LOCAL_OPERATION_PENDING", {
      store: path,
    })
  requireValue(plan.stores.length > 0, "ORIGINAL_STORE_REQUIRED")
  const root = api("/v1/pages/" + plan.mapping.root_id)
  requireValue(root.object === "page" && !root.in_trash && !root.archived, "ROOT_UNAVAILABLE")
  const children = enumerate("/v1/blocks/" + root.id + "/children")
    .filter((block) => block.type === "child_database")
    .map((block) => block.id)
  for (const role of ROLES) {
    const binding = plan.descriptor[role],
      database = api("/v1/databases/" + binding.database_id),
      source = api("/v1/data_sources/" + binding.data_source_id)
    requireValue(
      !database.in_trash &&
        !database.archived &&
        database.parent?.page_id === root.id &&
        children.includes(database.id) &&
        !source.in_trash &&
        !source.archived &&
        source.parent?.database_id === database.id,
      "BINDING_DRIFT",
    )
    requireValue(
      database.data_sources.some((item) => item.id === binding.data_source_id) &&
        Object.values(binding.property_ids).every(
          (id) =>
            Object.values(source.properties).filter((property) => property.id === id).length === 1,
        ),
      "BINDING_DRIFT",
    )
    if (role === "skills") {
      const patch = plan.patches.at(-1),
        current = { description: writableRich(database.description) }
      requireValue(
        [patch.before_sha256, patch.after_sha256].includes(digest(current)),
        "DESCRIPTOR_DRIFT",
      )
    }
  }
  for (const id of children)
    if (id !== plan.descriptor.skills.database_id)
      requireValue(
        ![OLD_MARKER, NEW_MARKER].some((marker) =>
          richText(api("/v1/databases/" + id).description).startsWith(marker),
        ),
        "SHARED_PARENT_REQUIRES_SEPARATE_ROOT",
      )
  const operations = queryTable(plan.descriptor.records, {
    and: [
      { property: plan.descriptor.records.property_ids.Kind, select: { equals: "operation" } },
      {
        property: plan.descriptor.records.property_ids["Record ID"],
        rich_text: { starts_with: "operation-current-" },
      },
    ],
  })
  requireValue(operations.length === 0, "REMOTE_OPERATION_PENDING")
  for (const role of ["skills", "sources"])
    requireValue(
      queryTable(plan.descriptor[role], {
        property: plan.descriptor[role].property_ids.Operation,
        rich_text: { is_not_empty: true },
      }).length === 0,
      "OWNER_OPERATION_PENDING",
    )
}
function journalIO(plan, path) {
  const directory = resolve(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  requireValue(realpathSync(directory) === directory, "CANONICAL_JOURNAL_REQUIRED")
  const manifest = join(directory, "plan.json")
  if (existsSync(manifest))
    requireValue(readJson(manifest).plan_sha256 === plan.plan_sha256, "JOURNAL_PLAN_MISMATCH")
  else saveNew(manifest, plan)
  const events = join(directory, "events.jsonl")
  return {
    preflight: async (selected) => freshPreflight(selected),
    read: async (patch) => selectPatchValue(patch, api(patchEndpoint(patch))),
    patch: async (patch) => {
      api(patchEndpoint(patch), { method: "PATCH", body: patch.after })
    },
    record: async (event) => {
      const fd = openSync(
        events,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        const stat = fstatSync(fd)
        requireValue(
          stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
          "PRIVATE_JOURNAL_REQUIRED",
        )
        appendFileSync(
          fd,
          JSON.stringify({
            at: new Date().toISOString(),
            plan_sha256: plan.plan_sha256,
            ...event,
          }) + "\n",
        )
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    },
  }
}
export async function main(argv) {
  if (argv.length === 0 || argv[0] === "--help") {
    console.log(HELP)
    return
  }
  const [command, ...rest] = argv,
    options = {},
    repeat = { "--store": [], "--objects-root": [] }
  const allowed = {
    inspect: ["--entry", "--root", "--output", "--store", "--objects-root"],
    plan: ["--inventory", "--output"],
    apply: ["--inventory", "--plan", "--journal", "--ack-plan", "--writers-quiesced"],
    config: ["--input", "--plan", "--output"],
    portable: ["--input", "--tree", "--plan", "--output"],
  }
  requireValue(allowed[command], "USAGE")
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]
    requireValue(allowed[command].includes(key), "USAGE")
    if (key === "--writers-quiesced") {
      requireValue(!options[key], "USAGE")
      options[key] = true
      continue
    }
    requireValue(key.startsWith("--") && rest[i + 1] && !rest[i + 1].startsWith("--"), "USAGE")
    const value = rest[++i]
    if (repeat[key]) repeat[key].push(value)
    else {
      requireValue(options[key] === undefined, "USAGE")
      options[key] = value
    }
  }
  const required = (key) => {
    requireValue(typeof options[key] === "string", "USAGE", { key })
    return options[key]
  }
  let result
  if (command === "inspect") {
    for (const key of ["--entry", "--root"])
      requireValue(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(required(key)),
        "CANONICAL_NOTION_ID_REQUIRED",
      )
    result = collectInventory({
      entry: required("--entry"),
      root: required("--root"),
      stores: repeat["--store"],
      objects: repeat["--objects-root"],
    })
  } else if (command === "plan") result = preparePlan(readJson(required("--inventory")))
  else if (command === "config" || command === "portable") {
    const plan = readJson(required("--plan"))
    const { plan_sha256, ...body } = plan
    requireValue(digest(body) === plan_sha256, "PLAN_CHANGED")
    const original = readJson(required("--input"))
    if (command === "portable")
      auditPortableTree(required("--tree"), required("--input"), plan.mapping)
    result =
      command === "config"
        ? migrateConfig(original, plan.mapping, plan.descriptor)
        : migratePortableManifest(original, plan.mapping)
  } else if (command === "apply") {
    const plan = readJson(required("--plan"))
    requireValue(
      options["--writers-quiesced"] === true && required("--ack-plan") === plan.plan_sha256,
      "EXACT_PLAN_AND_QUIESCENCE_REQUIRED",
    )
    requireValue(
      preparePlan(readJson(required("--inventory"))).plan_sha256 === plan.plan_sha256,
      "INVENTORY_PLAN_MISMATCH",
    )
    result = await applyPlan(plan, journalIO(plan, required("--journal")))
    console.log(JSON.stringify(result))
    return
  } else requireValue(false, "USAGE")
  const output = saveNew(required("--output"), result)
  console.log(
    JSON.stringify({
      output,
      sha256: digest(result),
      ...(command === "plan"
        ? { status: result.status, counts: result.counts, blockers: result.blockers }
        : {}),
    }),
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        error: {
          code: error.code ?? "MIGRATION_FAILED",
          ...(error.details ? { details: error.details } : {}),
        },
      }),
    )
    process.exitCode = 1
  })
