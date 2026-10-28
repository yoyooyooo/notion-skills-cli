import { property } from "./model.ts"
import type { Receipt } from "./publication-model.ts"

/** Select fresh edit authority for this mutation; this is never an observation cache. */
export function publicationMutationGuards(
  receipt: Receipt,
  path: string,
  body: unknown,
  owned: ReadonlySet<string>,
  blockOwner?: string,
  blockAncestors: readonly string[] = [],
): Set<string> {
  // Allocation/send only create an artifact. Attaching it still checks the page target.
  if (path === "v1/file_uploads" || /^v1\/file_uploads\/[^/]+\/send$/.test(path)) return new Set()
  const parent = property(property(body).parent).page_id
  const target =
    blockOwner ??
    /^v1\/pages\/[^/]+/.exec(path)?.[0] ??
    (path === "v1/pages" && typeof parent === "string" ? `v1/pages/${parent}` : undefined)
  if (!target) return new Set(Object.keys(receipt.guards))
  const pages = new Set([target])
  const root = receipt.page_id && `v1/pages/${receipt.page_id}`
  if (root && target !== root) pages.add(root)
  // A child target also depends on the retained parent chain and ownership inventories.
  for (const page of pages) {
    const parentId = property(property(receipt.guards[page]).parent).page_id
    if (typeof parentId === "string" && owned.has(`v1/pages/${parentId}`))
      pages.add(`v1/pages/${parentId}`)
    const id = page.slice("v1/pages/".length)
    for (const [inventoryPath, raw] of Object.entries(receipt.guards)) {
      const owner = /^v1\/blocks\/([^/]+)\/children\?/.exec(inventoryPath)?.[1]
      if (!owner || !owned.has(`v1/pages/${owner}`)) continue
      const children = property(raw).results
      if (Array.isArray(children) && children.some((child) => property(child).id === id))
        pages.add(`v1/pages/${owner}`)
    }
  }
  const selected = new Set(blockAncestors)
  if (blockOwner && /^v1\/blocks\/[^/]+$/.test(path)) selected.add(path)
  for (const page of pages) {
    selected.add(page)
    selected.add(`${page}/markdown`)
    const inventoryPrefix = `v1/blocks/${page.slice("v1/pages/".length)}/children?`
    for (const guard of Object.keys(receipt.guards))
      if (guard.startsWith(`${page}/properties/`) || guard.startsWith(inventoryPrefix))
        selected.add(guard)
    const replacesPageMarkdown =
      /^v1\/pages\/[^/]+\/markdown$/.test(path) && property(body).type === "replace_content"
    if (!replacesPageMarkdown) continue
    // A whole-page replacement rechecks nested inventories. Child allocation
    // and property writes retain page, Markdown, root inventory and property
    // guards; direct block repairs retain their concrete ancestors.
    // Nested inventories have a concrete block parent chain when repairs observed it.
    for (const guard of Object.keys(receipt.guards)) {
      const block = /^v1\/blocks\/([^/]+)\/children\?/.exec(guard)?.[1]
      if (!block) continue
      let current: string | undefined = block
      const seen = new Set<string>()
      while (current && !seen.has(current)) {
        seen.add(current)
        if (`v1/pages/${current}` === page) {
          selected.add(guard)
          break
        }
        const parent = property(property(receipt.guards[`v1/blocks/${current}`]).parent)
        current =
          typeof parent.page_id === "string"
            ? parent.page_id
            : typeof parent.block_id === "string"
              ? parent.block_id
              : undefined
      }
    }
  }
  return selected
}
