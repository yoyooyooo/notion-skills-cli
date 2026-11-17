/** A presentation-only projection for agent invocations.
 *
 * The core still executes and verifies the original operation and keeps its
 * full recovery contract. Normal CLI output remains unchanged. An explicit
 * --compact omits only the high-volume per-attempt transport trace, preserving
 * the measured aggregate costs, conflicts, page identity, fixed refs, status
 * and original-operation IDs.
 */
export function compactApplyOutput<A extends object>(result: A): A {
  const metrics = (result as { readonly request_metrics?: unknown }).request_metrics
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) return result
  const { trace, ...summary } = metrics as Record<string, unknown>
  if (!Array.isArray(trace)) return result
  return {
    ...result,
    request_metrics: {
      ...summary,
      trace_omitted_from_output: true,
      trace_entries: trace.length,
    },
  } as A
}
