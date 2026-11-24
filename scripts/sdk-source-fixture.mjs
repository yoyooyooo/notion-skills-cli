import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import { createServer } from "node:http"
import { isAbsolute, join } from "node:path"

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const monotonic = () => process.hrtime.bigint().toString()
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// The installed service serves declared Notion facts. Writes are enabled only
// for the bounded CLI import gate; SDK consumption keeps the default read-only mode.
export async function startSdkSourceFixture(sample, ledgerPath, options = {}) {
  assert.ok(
    sample?.notion?.library?.skills && sample.notion.library.sources,
    "The controlled current service requires the complete four-table library",
  )
  assert.ok(
    Array.isArray(sample.notion.sources),
    "Declare the current Source rows explicitly, including an empty native-only table",
  )
  assert.ok(isAbsolute(ledgerPath), "The owned request ledger must be absolute")
  const port = options.port ?? 0
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "Invalid loopback fixture port")
  assert.ok(
    options.allowCurrentWrites === undefined || typeof options.allowCurrentWrites === "boolean",
  )
  assert.ok(
    options.emptyFirstRecordsPage === undefined ||
      typeof options.emptyFirstRecordsPage === "boolean",
  )
  const allowCurrentWrites = options.allowCurrentWrites === true
  const eventsPath = ledgerPath.endsWith(".jsonl")
    ? ledgerPath.slice(0, -6) + ".events.jsonl"
    : ledgerPath + ".events.jsonl"
  for (const path of [ledgerPath, eventsPath])
    fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 })

  const notion = structuredClone(sample.notion)
  assert.equal(notion.library.version, 2, "The controlled service requires the current Library descriptor")
  assert.equal(notion.root?.object, "page", "Declare the actual root page independently")
  assert.ok(Array.isArray(notion.root_children), "Declare the actual root children independently")
  assert.ok(Array.isArray(notion.databases), "Declare actual databases independently of the descriptor")
  assert.ok(Array.isArray(notion.data_sources), "Declare actual data sources independently of the descriptor")
  const skillsDataSource = () => notion.data_sources.find((source) => source.id === notion.library.skills.data_source_id)
  notion.blocks ??= {}
  let nextPage = 900000,
    edit = 0
  const nextId = () => "00000000-0000-4000-8000-" + (nextPage++).toString(16).padStart(12, "0")
  const currentPages = () => [...notion.skills, ...notion.files, ...notion.records]
  const rowsFor = (dataSource) => {
    const { library } = notion
    if (dataSource === library.skills.data_source_id) return notion.skills
    if (dataSource === library.files.data_source_id) return notion.files
    if (dataSource === library.records.data_source_id) return notion.records
    throw new Error("The current writer selected an undeclared table")
  }
  const touch = (row) => {
    row.last_edited_time = new Date(Date.now() + edit++).toISOString()
  }
  const normalizedProperties = (input) =>
    Object.fromEntries(
      Object.entries(input).map(([id, raw]) => {
        const type = ["title", "rich_text", "select", "relation", "files", "checkbox"].find((key) =>
          Object.hasOwn(raw, key),
        )
        assert.ok(type, "A current write has an unsupported property")
        if (type === "files")
          assert.deepEqual(raw.files, [], "This bounded import gate uses inline originals")
        return [
          id,
          {
            ...structuredClone(raw),
            id,
            type,
            ...(["rich_text", "relation", "files"].includes(type) ? { has_more: false } : {}),
          },
        ]
      }),
    )
  const mutateCurrent = (method, path, body, call) => {
    if (!allowCurrentWrites) return undefined
    if (method === "POST" && path === "/v1/pages") {
      assert.equal(body.parent.type, "data_source_id")
      const rows = rowsFor(body.parent.data_source_id)
      const table = [notion.library.skills, notion.library.files, notion.library.records].find(
        (item) => item.data_source_id === body.parent.data_source_id,
      )
      const defaults = {}
      if (rows === notion.skills && skillsDataSource() !== undefined)
        for (const field of Object.values(skillsDataSource().properties))
          if (field.type === "relation") {
            assert.equal(typeof field.id, "string")
            assert.ok(field.id.length > 0)
            defaults[field.id] = { relation: [] }
          }
      const row = {
        object: "page",
        id: nextId(),
        parent: { ...structuredClone(body.parent), database_id: table.database_id },
        properties: normalizedProperties({ ...defaults, ...body.properties }),
        in_trash: false,
        archived: false,
      }
      touch(row)
      rows.push(row)
      notion.blocks[row.id] = []
      notion.bodies[row.id] = ""
      if (rows === notion.skills && !notion.main) notion.main = row
      call.semantic_write = true
      return { status: 200, value: row }
    }
    const selected = /^\/v1\/pages\/([^/]+)(\/markdown)?$/u.exec(path)
    if (selected && method === "PATCH") {
      const row = currentPages().find((item) => item.id === selected[1])
      assert.ok(row, "A current write selected an undeclared page")
      if (selected[2]) {
        assert.equal(body.markdown_version, "v2")
        assert.equal(body.type, "replace_content")
        assert.equal(typeof body.replace_content.new_str, "string")
        notion.bodies[row.id] = body.replace_content.new_str
        notion.blocks[row.id] = []
      } else {
        if (body.properties)
          for (const [id, field] of Object.entries(normalizedProperties(body.properties))) {
            const key =
              Object.keys(row.properties).find(
                (name) => name === id || row.properties[name].id === id,
              ) ?? id
            row.properties[key] = field
          }
        if (Object.hasOwn(body, "in_trash")) {
          assert.equal(typeof body.in_trash, "boolean")
          row.in_trash = body.in_trash
        }
      }
      touch(row)
      if (notion.main?.id === row.id) notion.main = row
      call.semantic_write = true
      return {
        status: 200,
        value: selected[2]
          ? {
              object: "page_markdown",
              id: row.id,
              markdown: notion.bodies[row.id],
              truncated: false,
              unknown_block_ids: [],
            }
          : row,
      }
    }
    const children = /^\/v1\/blocks\/([^/]+)\/children$/u.exec(path)
    if (children && method === "PATCH") {
      const row = currentPages().find((item) => item.id === children[1])
      assert.ok(row, "A projection selected an undeclared page")
      assert.ok(
        Array.isArray(body.children) && body.children.length > 0 && body.children.length <= 100,
      )
      assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 500000)
      const added = body.children.map((block) => ({
        ...structuredClone(block),
        object: "block",
        id: nextId(),
        parent: { type: "page_id", page_id: row.id },
        has_children: false,
        in_trash: false,
        archived: false,
      }))
      notion.blocks[row.id].push(...added)
      notion.bodies[row.id] = notion.blocks[row.id]
        .map((block) => richText(block[block.type]?.rich_text))
        .join("\n")
      touch(row)
      call.semantic_write = true
      return {
        status: 200,
        value: { object: "list", results: added, has_more: false, next_cursor: null },
      }
    }
    return undefined
  }
  const requests = [],
    unexpected = [],
    active = new Set()
  let phase = "setup",
    denyCurrent = false,
    denyAuthentication = false
  let viewObservation,
    incompleteViewInventory = false
  let pendingControl, closing
  const event = (call, name, fields = {}) => {
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        phase: call.phase,
        sequence: call.sequence,
        method: call.method,
        path: call.path,
        event: name,
        monotonic_ns: monotonic(),
        ...fields,
      }) + "\n",
    )
  }

  const richText = (parts) =>
    (parts ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("")
  const matches = (row, filter) => {
    if (!filter) return true
    if (Array.isArray(filter.and)) return filter.and.every((item) => matches(row, item))
    if (Array.isArray(filter.or)) return filter.or.some((item) => matches(row, item))
    const field =
      row.properties[filter.property] ??
      Object.values(row.properties).find((value) => value.id === filter.property)
    if (!field) return false
    if (filter.relation?.is_empty === true) return field.relation?.length === 0
    if (filter.relation) {
      // Notion hides a relation to a trashed target even while this row remains live.
      const target = [...currentPages(), ...notion.sources].find(
        (item) => item.id === filter.relation.contains,
      )
      if (target?.in_trash === true || target?.archived === true || target?.is_archived === true)
        return false
      return field.relation?.some((item) => item.id === filter.relation.contains) ?? false
    }
    if (filter.select) return field.select?.name === filter.select.equals
    if (filter.rich_text) {
      const value = richText(field.rich_text)
      if (typeof filter.rich_text.contains === "string")
        return value.includes(filter.rich_text.contains)
      return value === filter.rich_text.equals
    }
    if (filter.checkbox) return field.checkbox === filter.checkbox.equals
    throw new Error("Unsupported controlled inventory filter")
  }
  const project = (rows, fields) =>
    rows.map((row) => ({
      ...row,
      properties:
        fields.length === 0
          ? row.properties
          : Object.fromEntries(
              Object.entries(row.properties).filter(([key, field]) =>
                fields.includes(field.id ?? key),
              ),
            ),
    }))
  const page = (rows, body) => {
    const cursor = body?.start_cursor
    assert.ok(cursor === undefined || /^offset-[0-9]+$/u.test(cursor))
    const offset = cursor === undefined ? 0 : Number(cursor.slice(7))
    const end = Math.min(rows.length, offset + Math.min(100, body?.page_size ?? 100))
    return {
      object: "list",
      results: rows.slice(offset, end),
      has_more: end < rows.length,
      next_cursor: end < rows.length ? `offset-${end}` : null,
    }
  }

  const packet = (request, url, body, call) => {
    const mutation = mutateCurrent(request.method, url.pathname, body, call)
    if (mutation !== undefined) return mutation
    let value,
      status = 200
    const fields = url.searchParams.getAll("filter_properties")
    const { library } = notion
    if (denyAuthentication && request.method === "GET" && url.pathname === "/v1/users/me") {
      status = 401
      value = {
        object: "error",
        status,
        code: "unauthorized",
        message: "Controlled credential rejection",
      }
    } else if (
      denyCurrent &&
      request.method === "GET" &&
      (url.pathname === `/v1/pages/${notion.main?.id}` ||
        url.pathname === `/v1/pages/${notion.main?.id}/markdown`)
    ) {
      status = 403
      value = {
        object: "error",
        status,
        code: "restricted_resource",
        message: "Controlled current permission denial",
      }
    } else if (request.method === "GET" && url.pathname === "/v1/users/me")
      value = { object: "user", id: "00000000-0000-4000-8000-000000000099" }
    else if (request.method === "GET" && url.pathname === "/v1/pages/" + notion.root.id)
      value = notion.root
    else if (request.method === "GET" && url.pathname === "/v1/blocks/" + notion.root.id + "/children")
      value = page(notion.root_children, {
        page_size: 100,
        ...(url.searchParams.has("start_cursor") ? { start_cursor: url.searchParams.get("start_cursor") } : {}),
      })
    else if (request.method === "GET" && notion.databases.some((row) => url.pathname === "/v1/databases/" + row.id))
      value = notion.databases.find((row) => url.pathname === "/v1/databases/" + row.id)
    else if (request.method === "GET" && notion.data_sources.some((row) => url.pathname === "/v1/data_sources/" + row.id))
      value = notion.data_sources.find((row) => url.pathname === "/v1/data_sources/" + row.id)
    else if (
      allowCurrentWrites &&
      request.method === "GET" &&
      /^\/v1\/blocks\/[^/]+\/children$/u.test(url.pathname)
    ) {
      const id = url.pathname.split("/")[3]
      assert.ok(currentPages().some((row) => row.id === id))
      value = page(notion.blocks[id] ?? [], {
        page_size: 100,
        ...(url.searchParams.has("start_cursor")
          ? { start_cursor: url.searchParams.get("start_cursor") }
          : {}),
      })
    } else if (
      allowCurrentWrites &&
      request.method === "GET" &&
      /^\/v1\/pages\/[^/]+$/u.test(url.pathname)
    ) {
      value = currentPages().find((row) => url.pathname === `/v1/pages/${row.id}`)
      assert.ok(value, "An undeclared current page was requested")
    } else if (viewObservation && request.method === "GET" && url.pathname === "/v1/views") {
      assert.equal(url.searchParams.get("database_id"), library.skills.database_id)
      value = {
        object: "list",
        results: [{ object: "view", id: sample.view_dynamics.view.id }],
        has_more: false,
        next_cursor: null,
      }
    } else if (
      viewObservation &&
      request.method === "GET" &&
      url.pathname === `/v1/views/${sample.view_dynamics.view.id}`
    )
      value = { ...sample.view_dynamics.view, filter: viewObservation.filter }
    else if (
      viewObservation &&
      request.method === "POST" &&
      url.pathname === `/v1/views/${sample.view_dynamics.view.id}/queries`
    ) {
      assert.deepEqual(body, { page_size: 100 })
      value = {
        object: "list",
        id: viewObservation.query_id,
        view_id: sample.view_dynamics.view.id,
        expires_at: new Date(Date.now() + 900000).toISOString(),
        total_count: viewObservation.member_page_ids.length,
        results: viewObservation.member_page_ids.map((id) => ({ object: "page", id })),
        has_more: false,
        next_cursor: null,
        request_status: { type: "complete", incomplete_reason: null },
      }
      Object.assign(call, {
        view_observation: viewObservation.id,
        view_filter: viewObservation.filter,
        view_member_page_ids: viewObservation.member_page_ids,
      })
    } else if (
      request.method === "GET" &&
      url.pathname !== `/v1/pages/${notion.main?.id}` &&
      notion.skills.some((row) => url.pathname === `/v1/pages/${row.id}`)
    )
      value = notion.skills.find((row) => url.pathname === `/v1/pages/${row.id}`)
    else if (request.method === "GET" && url.pathname === `/v1/pages/${notion.main?.id}`)
      value = notion.main
    else if (
      request.method === "GET" &&
      notion.files.some((file) => url.pathname === `/v1/pages/${file.id}`)
    )
      value = notion.files.find((file) => url.pathname === `/v1/pages/${file.id}`)
    else if (request.method === "GET" && /^\/v1\/pages\/[^/]+\/markdown$/u.test(url.pathname)) {
      const id = url.pathname.split("/")[3]
      assert.equal(typeof notion.bodies[id], "string", "An unselected target body was requested")
      value = { id, markdown: notion.bodies[id], truncated: false, unknown_block_ids: [] }
    } else if (request.method === "POST" && url.pathname.endsWith("/query")) {
      const rows =
        url.pathname === `/v1/data_sources/${library.skills.data_source_id}/query`
          ? notion.skills
          : url.pathname === `/v1/data_sources/${library.files.data_source_id}/query`
            ? notion.files
            : url.pathname === `/v1/data_sources/${library.records.data_source_id}/query`
              ? notion.records
              : url.pathname === `/v1/data_sources/${library.sources.data_source_id}/query`
                ? notion.sources
                : undefined
      assert.ok(rows, "An unexpected data source was queried")
      // A short query page may still carry a continuation. This opt-in boundary
      // requires the reader to finish enumeration before publishing unique bytes.
      value =
        options.emptyFirstRecordsPage === true &&
        url.pathname === `/v1/data_sources/${library.records.data_source_id}/query` &&
        body?.start_cursor === undefined
          ? { object: "list", results: [], has_more: true, next_cursor: "offset-0" }
          : page(
              project(
                rows.filter((row) => row.in_trash !== true && matches(row, body?.filter)),
                fields,
              ),
              body,
            )
      if (
        incompleteViewInventory &&
        url.pathname === `/v1/data_sources/${library.skills.data_source_id}/query`
      )
        value.request_status = {
          type: "incomplete",
          incomplete_reason: "query_result_limit_reached",
        }
      Object.assign(call, {
        page_ids: value.results.map((row) => row.id),
        returned_properties: [
          ...new Set(
            value.results.flatMap((row) => Object.values(row.properties).map((field) => field.id)),
          ),
        ].sort(),
        has_more: value.has_more,
        next_cursor: value.next_cursor,
      })
    } else throw new Error("Unexpected controlled inventory request")

    return { value, status }
  }
  const knownRoute = (method, path) => {
    const { library } = notion
    if (
      allowCurrentWrites &&
      ((method === "POST" && path === "/v1/pages") ||
        (method === "PATCH" &&
          /^\/v1\/(?:pages\/[^/]+(?:\/markdown)?|blocks\/[^/]+\/children)$/u.test(path)))
    )
      return true
    if (
      allowCurrentWrites &&
      method === "GET" &&
      currentPages().some(
        (row) => path === `/v1/pages/${row.id}` || path === `/v1/blocks/${row.id}/children`,
      )
    )
      return true
    if (method === "GET")
      return (
        path === "/v1/users/me" ||
        path === "/v1/pages/" + notion.root.id ||
        path === "/v1/blocks/" + notion.root.id + "/children" ||
        notion.databases.some((row) => path === "/v1/databases/" + row.id) ||
        notion.data_sources.some((row) => path === "/v1/data_sources/" + row.id) ||
        path === "/v1/pages/" + notion.main?.id ||
        notion.files.some((file) => path === "/v1/pages/" + file.id) ||
        notion.skills.some((row) => path === "/v1/pages/" + row.id) ||
        Object.keys(notion.bodies).some((id) => path === "/v1/pages/" + id + "/markdown") ||
        (viewObservation &&
          (path === "/v1/views" || path === "/v1/views/" + sample.view_dynamics.view.id))
      )
    return (
      method === "POST" &&
      ([library.skills, library.files, library.records, library.sources].some(
        (table) => path === "/v1/data_sources/" + table.data_source_id + "/query",
      ) ||
        (viewObservation && path === "/v1/views/" + sample.view_dynamics.view.id + "/queries"))
    )
  }
  const discardPending = () => {
    if (!pendingControl) return
    pendingControl.reached.resolve(null)
    pendingControl.closed.resolve(null)
    pendingControl.release.resolve()
    pendingControl = undefined
  }
  const applyView = () => {
    if (!viewObservation) return
    for (const [id, names] of viewObservation.tags) {
      const row = notion.skills.find((entry) => entry.id === id)
      assert.ok(row)
      const tags = {
        id: sample.view_dynamics.tags_property_id,
        type: "multi_select",
        multi_select: names.map((name) => ({ id: name, name, color: "default" })),
      }
      row.properties.tags = tags
      if (id === notion.main?.id) notion.main.properties.tags = structuredClone(tags)
    }
  }
  const setPhase = (label, options = {}) => {
    assert.ok(!closing && active.size === 0, "Set a phase only after all prior HTTP calls close")
    assert.ok(typeof label === "string" && label.length > 0)
    const keys = [
      "current",
      "viewObservationId",
      "denyAuthentication",
      "denyCurrent",
      "incompleteViewInventory",
    ]
    assert.ok(Object.keys(options).every((key) => keys.includes(key)))
    if (Object.hasOwn(options, "current")) {
      assert.ok(["initial", "refreshed"].includes(options.current))
      const prefix = options.current === "initial" ? "" : "refreshed_"
      assert.ok(sample.notion[prefix + "main"] && sample.notion[prefix + "skills"])
      notion.main = structuredClone(sample.notion[prefix + "main"])
      notion.skills = structuredClone(sample.notion[prefix + "skills"])
    }
    if (Object.hasOwn(options, "viewObservationId")) {
      assert.ok(options.viewObservationId === null || typeof options.viewObservationId === "string")
      viewObservation =
        options.viewObservationId === null
          ? undefined
          : sample.view_dynamics?.observations.find((item) => item.id === options.viewObservationId)
      assert.ok(
        options.viewObservationId === null || viewObservation,
        "Unknown fixture View observation",
      )
    }
    for (const key of ["denyAuthentication", "denyCurrent", "incompleteViewInventory"])
      if (Object.hasOwn(options, key)) assert.equal(typeof options[key], "boolean")
    if (Object.hasOwn(options, "denyAuthentication"))
      denyAuthentication = options.denyAuthentication
    if (Object.hasOwn(options, "denyCurrent")) denyCurrent = options.denyCurrent
    if (Object.hasOwn(options, "incompleteViewInventory"))
      incompleteViewInventory = options.incompleteViewInventory
    applyView()
    discardPending()
    phase = label
  }
  const control = (kind, options) => {
    assert.ok(!closing && !pendingControl, "Only one next HTTP control may be armed")
    const allowed =
      kind === "hold"
        ? ["method", "path", "afterHeaders"]
        : kind === "reject"
          ? ["method", "path", "status", "retryAfterSeconds"]
          : ["method", "path"]
    assert.ok(options && Object.keys(options).every((key) => allowed.includes(key)))
    assert.ok(knownRoute(options.method, options.path), "Controls require one exact declared route")
    if (kind === "hold" && Object.hasOwn(options, "afterHeaders"))
      assert.equal(typeof options.afterHeaders, "boolean")
    if (kind === "reject") {
      assert.equal(options.status ?? 429, 429)
      assert.ok(
        Number.isFinite(options.retryAfterSeconds ?? 0.1) &&
          (options.retryAfterSeconds ?? 0.1) >= 0,
      )
    }
    const next = {
      kind,
      ...options,
      reached: deferred(),
      closed: deferred(),
      release: deferred(),
    }
    pendingControl = next
    return {
      reached: next.reached.promise,
      closed: next.closed.promise,
      release: () => next.release.resolve(),
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    const call = {
      phase,
      sequence: requests.length + 1,
      method: request.method,
      path: url.pathname,
      filter_properties: url.searchParams.getAll("filter_properties"),
      started_monotonic_ns: monotonic(),
      ended_monotonic_ns: null,
      closed_monotonic_ns: null,
      terminal: "pending",
      request_bytes: null,
      request_bytes_complete: false,
      observed_request_bytes: 0,
      status: null,
      decoded_response_bytes: null,
      response_sha256: null,
      response_bytes_complete: false,
      observed_response_bytes: 0,
      response_boundary: "server uncompressed writes; client decoding/delivery is not observed",
    }
    requests.push(call)
    const complete = deferred(),
      record = { complete, next: undefined }
    active.add(record)
    event(call, "start")
    let handlerDone = false,
      finalized = false,
      next
    const responseChunks = []
    const finalize = () => {
      if (finalized || !handlerDone || call.closed_monotonic_ns === null) return
      finalized = true
      if (call.ended_monotonic_ns === null) {
        call.ended_monotonic_ns = call.closed_monotonic_ns
        call.terminal = "aborted"
        event(call, "end", { terminal: call.terminal })
      }
      fs.appendFileSync(ledgerPath, JSON.stringify(call) + "\n")
      active.delete(record)
      next?.closed.resolve(structuredClone(call))
      complete.resolve()
    }
    response.once("finish", () => {
      const bytes = Buffer.concat(responseChunks)
      call.terminal = "finished"
      call.ended_monotonic_ns = monotonic()
      call.decoded_response_bytes = bytes.length
      call.response_sha256 = hash(bytes)
      call.response_bytes_complete = true
      event(call, "end", {
        terminal: call.terminal,
        decoded_response_bytes: bytes.length,
        response_bytes_complete: true,
      })
    })
    response.once("close", () => {
      call.closed_monotonic_ns = monotonic()
      event(call, "close", { response_finished: response.writableFinished })
      next?.release.resolve()
      finalize()
    })
    response.once("error", (error) => {
      call.response_error = error.code ?? String(error)
    })
    const headers = (status, length, extra = {}) => {
      call.status = status
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(length),
        ...extra,
      })
      event(call, "headers", { status, content_length: length })
    }
    const write = (bytes, end = false) => {
      responseChunks.push(bytes)
      call.observed_response_bytes += bytes.length
      call.observed_response_sha256 = hash(Buffer.concat(responseChunks))
      if (end) response.end(bytes)
      else response.write(bytes)
    }
    try {
      const chunks = []
      for await (const chunk of request) {
        chunks.push(chunk)
        call.observed_request_bytes += chunk.length
      }
      const bytes = Buffer.concat(chunks)
      call.request_bytes = bytes.length
      call.request_bytes_complete = true
      call.request_sha256 = hash(bytes)
      const body = bytes.length === 0 ? undefined : JSON.parse(bytes.toString("utf8"))
      call.body = body ?? null
      if (pendingControl?.method === request.method && pendingControl.path === url.pathname) {
        next = pendingControl
        pendingControl = undefined
        record.next = next
        call.control =
          next.kind === "hold"
            ? next.afterHeaders
              ? "hold-after-headers"
              : "hold-before-headers"
            : next.kind
      }
      if (next?.kind === "hold" && !next.afterHeaders) {
        next.reached.resolve(structuredClone(call))
        await next.release.promise
        if (response.destroyed) return
      }
      const result =
        next?.kind === "reject"
          ? {
              status: 429,
              value: {
                object: "error",
                status: 429,
                code: "rate_limited",
                message: "Controlled one-attempt rate limit",
              },
            }
          : packet(request, url, body, call)
      const output = Buffer.from(JSON.stringify(result.value))
      headers(
        result.status,
        output.length,
        next?.kind === "reject" ? { "retry-after": String(next.retryAfterSeconds ?? 0.1) } : {},
      )
      if (next?.kind === "interrupt" || (next?.kind === "hold" && next.afterHeaders)) {
        const prefix = output.subarray(0, Math.min(32, output.length - 1))
        response.flushHeaders()
        write(prefix)
        next.reached.resolve(structuredClone(call))
        if (next.kind === "interrupt") {
          await new Promise((resolve) => setImmediate(resolve))
          response.destroy()
        } else {
          await next.release.promise
          if (!response.destroyed) write(output.subarray(prefix.length), true)
        }
      } else {
        next?.reached.resolve(structuredClone(call))
        write(output, true)
      }
    } catch (error) {
      if (request.aborted || response.destroyed) {
        call.request_error = error.code ?? String(error)
      } else {
        unexpected.push({ ...call, error: String(error) })
        const output = Buffer.from(
          JSON.stringify({
            object: "error",
            status: 400,
            code: "validation_error",
            message: "Unexpected controlled inventory request",
          }),
        )
        headers(400, output.length)
        write(output, true)
      }
    } finally {
      handlerDone = true
      finalize()
    }
  })
  server.listen(port, "127.0.0.1")
  await once(server, "listening")
  const origin = "http://127.0.0.1:" + server.address().port
  if (sample.view_dynamics?.observations[0])
    setPhase("setup", { viewObservationId: sample.view_dynamics.observations[0].id })
  return {
    origin,
    ledgerPath,
    eventsPath,
    requests,
    unexpected,
    // The controlled source owns these mutable current fixture facts.
    // They are not consumer state and are never copied into the consumer cache.
    notion,
    setPhase,
    holdNext: (options) => control("hold", options),
    rejectNext: (options) => control("reject", options),
    interruptNext: (options) => control("interrupt", options),
    close() {
      if (closing) return closing
      discardPending()
      closing = (async () => {
        const settled = [...active].map((record) => record.complete.promise)
        const stopped = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        server.closeAllConnections()
        await stopped
        await Promise.all(settled)
        assert.equal(active.size, 0, "Every started HTTP request must close")
      })()
      return closing
    },
  }
}
