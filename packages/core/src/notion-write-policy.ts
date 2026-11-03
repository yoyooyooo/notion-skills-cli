import { property } from "./model.ts"

// https://developers.notion.com/reference/request-limits, verified 2026-11-03.
// 429 and 529 reject the request before execution. Other 5xx responses may
// acknowledge a committed write and require observation of the original intent.
export const notionRejectionStatus: Readonly<Record<string, number>> = {
  invalid_json: 400,
  invalid_request_url: 400,
  invalid_request: 400,
  invalid_grant: 400,
  missing_version: 400,
  invalid_beta: 400,
  validation_error: 400,
  unauthorized: 401,
  restricted_resource: 403,
  object_not_found: 404,
  rate_limited: 429,
  service_overload: 529,
}

export function isDefinitiveNotionRejection(
  code: string,
  status: number,
  details: Readonly<Record<string, unknown>>,
): boolean {
  const additional = property(details.additional_data)
  const committed =
    typeof additional.committed_resource_id === "string" ||
    (Array.isArray(additional.committed_child_ids) && additional.committed_child_ids.length > 0) ||
    (Array.isArray(additional.retry_guidance) &&
      additional.retry_guidance.includes("Do not repeat the write."))
  return notionRejectionStatus[code] === status && !committed
}

/** Permission to repeat the frozen request, never to restart its operation. */
export function isRetryableNotionWriteRejection(
  details: Readonly<Record<string, unknown>>,
): boolean {
  return (
    details.phase === "definitive_rejection" &&
    details.rate_limit_reason !== "public_api_request_blocked" &&
    (details.notion_code === "rate_limited" || details.notion_code === "service_overload") &&
    typeof details.http_status === "number" &&
    isDefinitiveNotionRejection(details.notion_code, details.http_status, details)
  )
}
