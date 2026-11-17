import { channel } from "node:diagnostics_channel"
import { createHash } from "node:crypto"
import type { RequestMetricsSnapshot } from "../../core/src/request-metrics.ts"

const observations = channel("ntn-skills.command-output")

/** The observable transport ledger is separate from the model-facing result.
 * Only a same-process subscriber receives it; no file, body, credentials,
 * command argv or alternate persistence is created by this function. An
 * external observer must match this exact output hash to the closed process's
 * actual stdout before treating the event as delivered evidence. */
export function renderCommandOutput(
  value: object,
  metrics?: RequestMetricsSnapshot,
  project?: (result: Record<string, unknown>) => object,
): string {
  const complete: Record<string, unknown> = {
    ...(Array.isArray(value) ? { ok: true, items: value } : { ok: true, ...value }),
    ...(metrics === undefined ? {} : { request_metrics: metrics }),
  }
  const output = JSON.stringify(project ? project(complete) : complete) + "\n"
  if (observations.hasSubscribers)
    observations.publish({
      version: 1,
      event: "result",
      operation: typeof complete.operation === "string" ? complete.operation : null,
      status: typeof complete.status === "string" ? complete.status : null,
      operation_id:
        typeof complete.apply_operation_id === "string" ? complete.apply_operation_id : null,
      projected: project !== undefined,
      output_sha256: createHash("sha256").update(output).digest("hex"),
      output_bytes: Buffer.byteLength(output),
      request_metrics: complete.request_metrics ?? null,
    })
  return output
}
