/** An observed HTTP boundary for proving validation/help/offline commands send no requests. */
export function createHttpProbe() {
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls += 1
      return Response.json(
        { object: "error", code: "restricted_resource", message: "Controlled probe" },
        { status: 403 },
      )
    },
  })
  return { origin: server.url.origin, calls: () => calls, close: () => server.stop(true) }
}
