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

// This is the original installed scalar-inventory service. It serves only its
// declared fixture facts; controls change HTTP delivery, never SDK results.
export async function startSdkSourceFixture(sample, ledgerPath, options = {}) {
  assert.ok(sample?.notion?.library?.skills)
  assert.ok(isAbsolute(ledgerPath), "The owned request ledger must be absolute")
  const port = options.port ?? 0
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "Invalid loopback fixture port")
  const eventsPath = ledgerPath.endsWith(".jsonl")
    ? ledgerPath.slice(0, -6) + ".events.jsonl"
    : ledgerPath + ".events.jsonl"
  for (const path of [ledgerPath, eventsPath])
    fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 })

  const notion = structuredClone(sample.notion)
  const requests = [],
    unexpected = [],
    active = new Set()
  let phase = "setup",
    denyCurrent = false,
    denyAuthentication = false
  let viewObservation,
    incompleteViewInventory = false,
    historyObservation = false
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
    const field = row.properties[filter.property]
    if (!field) return false
    if (filter.relation?.is_empty === true) return field.relation?.length === 0
    if (filter.relation)
      return field.relation?.some((item) => item.id === filter.relation.contains) ?? false
    if (filter.select) return field.select?.name === filter.select.equals
    if (filter.rich_text) return richText(field.rich_text) === filter.rich_text.equals
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
      (url.pathname === `/v1/pages/${notion.main.id}` ||
        url.pathname === `/v1/pages/${notion.main.id}/markdown`)
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
    else if (
      request.method === "GET" &&
      url.pathname === `/v1/databases/${library.skills.database_id}`
    )
      value = notion.database
    else if (viewObservation && request.method === "GET" && url.pathname === "/v1/views") {
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
      historyObservation &&
      request.method === "GET" &&
      notion.skills.some((row) => url.pathname === `/v1/pages/${row.id}`)
    )
      value = notion.skills.find((row) => url.pathname === `/v1/pages/${row.id}`)
    else if (request.method === "GET" && url.pathname === `/v1/pages/${notion.main.id}`)
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
              : undefined
      assert.ok(rows, "An unexpected data source was queried")
      value = page(
        project(
          rows.filter((row) => matches(row, body?.filter)),
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
        ...(historyObservation &&
        url.pathname === `/v1/data_sources/${library.records.data_source_id}/query`
          ? {
              records: value.results.map((row) => ({
                page_id: row.id,
                owner: row.properties.skill?.relation?.map((owner) => owner.id) ?? [],
                record_id: richText(row.properties.record?.rich_text),
                entity_id: richText(row.properties.entity?.rich_text),
                kind: row.properties.kind?.select?.name,
                hash: richText(row.properties.hash?.rich_text),
                payload_included: Object.hasOwn(row.properties, "payload"),
              })),
            }
          : {}),
      })
    } else throw new Error("Unexpected controlled inventory request")

    return { value, status }
  }
  const knownRoute = (method, path) => {
    const { library } = notion
    if (method === "GET")
      return (
        path === "/v1/users/me" ||
        path === "/v1/databases/" + library.skills.database_id ||
        path === "/v1/pages/" + notion.main.id ||
        notion.files.some((file) => path === "/v1/pages/" + file.id) ||
        (historyObservation && notion.skills.some((row) => path === "/v1/pages/" + row.id)) ||
        Object.keys(notion.bodies).some((id) => path === "/v1/pages/" + id + "/markdown") ||
        (viewObservation &&
          (path === "/v1/views" || path === "/v1/views/" + sample.view_dynamics.view.id))
      )
    return (
      method === "POST" &&
      ([library.skills, library.files, library.records].some(
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
      if (id === notion.main.id) notion.main.properties.tags = structuredClone(tags)
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
      "historyObservation",
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
    for (const key of [
      "denyAuthentication",
      "denyCurrent",
      "incompleteViewInventory",
      "historyObservation",
    ])
      if (Object.hasOwn(options, key)) assert.equal(typeof options[key], "boolean")
    if (Object.hasOwn(options, "denyAuthentication"))
      denyAuthentication = options.denyAuthentication
    if (Object.hasOwn(options, "denyCurrent")) denyCurrent = options.denyCurrent
    if (Object.hasOwn(options, "incompleteViewInventory"))
      incompleteViewInventory = options.incompleteViewInventory
    if (Object.hasOwn(options, "historyObservation"))
      historyObservation = options.historyObservation
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
    // The existing scalar/history smoke owns these same mutable fixture facts.
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

/** Reuse the original source fixture for built and independently installed SDK callers. */
export async function verifyCatalogDirectorySdk({ sdk, sample, env, root }) {
  assert.ok(isAbsolute(root))
  fs.mkdirSync(root, { mode: 0o700 })
  const input = sample.view_dynamics
  assert.equal(sdk.CATALOG_DIRECTORY_CONTRACT_VERSION, 1)
  assert.equal(input.inventory_pages, Math.ceil(sample.row_count / 100))
  const source = await startSdkSourceFixture(sample, join(root, "requests.jsonl"))
  const evidence = { version: 1, status: "running", transport: "owned loopback Notion", phases: [] }
  try {
    for (const mode of ["separate", "combined"]) {
      const cwd = join(root, mode)
      fs.cpSync(sample.seed, cwd, { recursive: true, errorOnExist: true, force: false })
      source.setPhase(mode, { current: "initial", viewObservationId: input.observations[0].id })
      const reports = []
      const options = {
        cwd,
        env: {
          ...env,
          NOTION_API_BASE_URL: source.origin,
          NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
        },
        database: sample.notion.library.skills.database_id,
        metrics: true,
        onRequestMetrics: (value) => reports.push(value),
      }
      const started = performance.now()
      const result =
        mode === "combined"
          ? await sdk.listCatalog({ ...options, directory: {} })
          : {
              version: 1,
              catalog: { ok: true, value: await sdk.listCatalog(options) },
              directory: {
                ok: true,
                value: await sdk.listCatalog({ ...options, defaultView: true }),
              },
            }
      const calls = source.requests.filter((call) => call.phase === mode)
      const inventory = calls.filter(
        (call) =>
          call.path ===
          "/v1/data_sources/" + sample.notion.library.skills.data_source_id + "/query",
      )
      const observed = {
        mode,
        elapsed_ms: performance.now() - started,
        result,
        request_metrics: [...reports],
        requests: calls,
        inventory_requests: inventory.length,
        inventory_response_bytes: inventory.reduce(
          (sum, call) => sum + call.decoded_response_bytes,
          0,
        ),
      }
      evidence.phases.push(observed)
      assert.equal(result.version, 1)
      assert.equal(result.catalog.ok, true)
      assert.equal(result.directory.ok, true)
      assert.deepEqual(
        result.catalog.value.records.map((record) => record.id).sort(),
        [...input.ordinary_record_ids].sort(),
      )
      assert.deepEqual(
        result.directory.value.records.map((record) => record.id),
        input.observations[0].member_record_ids,
      )
      assert.equal(result.directory.value.view.id, input.view.id)
      assert.equal(result.directory.value.capability_directory, true)
      assert.equal(result.catalog.value.scope, result.directory.value.scope)
      assert.equal(result.catalog.value.coverage.exhaustive, true)
      assert.equal(result.directory.value.coverage.exhaustive, true)
      assert.equal(inventory.length, input.inventory_pages * (mode === "combined" ? 1 : 2))
      assert.equal(reports.length, mode === "combined" ? 1 : 2)
      assert.equal(
        reports.reduce((sum, report) => sum + report.total_requests, 0),
        calls.length,
      )
      assert.equal(
        reports.reduce((sum, report) => sum + report.response_bytes, 0),
        calls.reduce((sum, call) => sum + call.decoded_response_bytes, 0),
      )
      for (const report of reports) {
        assert.equal(report.trace_dropped, 0)
        assert.equal(report.in_flight, 0)
        assert.equal(report.unknown_response_bytes, 0)
        assert.equal(report.requests.notion_body, 0)
        assert.equal(report.requests.notion_write, 0)
        assert.equal(report.requests.provider, 0)
      }
      for (const call of inventory) {
        assert.deepEqual([...call.filter_properties].sort(), [...sample.projection].sort())
        assert.deepEqual(call.returned_properties, [...sample.projection].sort())
      }
      assert.deepEqual(source.unexpected, [])
      if (mode === "combined") {
        source.setPhase("warm")
        const warm = await sdk.listCatalog({ ...options, directory: {} })
        assert.deepEqual(warm.catalog.value.records, result.catalog.value.records)
        assert.deepEqual(warm.directory.value.records, result.directory.value.records)
        assert.equal(source.requests.filter((call) => call.phase === "warm").length, 0)
        assert.equal(reports.at(-1).total_requests, 0)
        evidence.warm = { result: warm, request_metrics: reports.at(-1) }
      }
    }
    assert.deepEqual(
      evidence.phases[1].result.catalog.value.records,
      evidence.phases[0].result.catalog.value.records,
    )
    assert.deepEqual(
      evidence.phases[1].result.directory.value.records,
      evidence.phases[0].result.directory.value.records,
    )
    evidence.status = "passed"
    return evidence
  } catch (error) {
    evidence.status = "failed"
    evidence.error = String(error)
    throw error
  } finally {
    await source.close()
    fs.writeFileSync(join(root, "report.json"), JSON.stringify(evidence, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    })
  }
}
