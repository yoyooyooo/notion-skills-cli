import { fail } from "./model.ts"

// The public Update Block schema accepts rich_text/color for numbered items.
// list_start_index appears only in the response schema (with minimum 1).
// Keep this separate from the strict historical before/after proof: identifying
// a desired correction does not establish an API capability to send it.
export function unsupportedOrderedListStart() {
  return fail(
    "UNSUPPORTED_MARKDOWN",
    "The Notion block API does not support setting an ordered list start to zero.",
    {
      reason: "unsupported_public_api_field",
      field: "numbered_list_item.list_start_index",
      requested_value: 0,
      notion_version: "2026-03-11",
      schema_url: "https://developers.notion.com/openapi.json",
    },
  )
}
