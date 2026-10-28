import { createHash } from "node:crypto"
import { fail } from "./model.ts"
import { importDocument } from "./import.ts"
import { rewritePageLinks } from "./references.ts"
import { canonical } from "./publication-effect-proof.ts"
import { compileSourceRootBody } from "./source-root-completion-physical.ts"
import { sourceRootCompletionInventory } from "./source-root-completion-guards.ts"
import type { PortableSkill } from "./portable.ts"
import type { SourceRootCompletionObservation } from "./upstream-source-root-completion-model.ts"

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const refused = (message: string) => fail("SOURCE_ROOT_COMPLETION_REFUSED", message)

/** A hypothetical complete root is a reviewed request, never observed content.
 * All IDs, source bytes and retained tag bytes come from the original inputs. */
export function deriveSourceRootCompletion(
  page: string,
  portable: PortableSkill,
  before: SourceRootCompletionObservation,
) {
  const inventory = sourceRootCompletionInventory(page, before)
  if (
    inventory.ordinary_nodes.length ||
    inventory.root_nodes.length !== inventory.references.length ||
    !/^[\t\r\n ]*$/.test(inventory.markdown.replace(/<page url="[^"]+">[^<>]*<\/page>/g, ""))
  )
    throw refused(
      "Only a physically empty authored root with its complete retained reference tags may be completed.",
    )
  const main = portable.files.find((file) => file.path === portable.main)
  const paths = portable.files
    .filter((file) => file.path !== portable.main && /^references\/.+\.md$/i.test(file.path))
    .map((file) => file.path)
    .sort()
  if (
    portable.kind !== "skill" ||
    !main ||
    !paths.length ||
    canonical(paths) !== canonical(inventory.references.map((reference) => reference.path).sort())
  )
    throw refused("The exact frozen main and complete reference source paths are required.")
  const sourceBody = importDocument(main, portable).body
  // Match the exact resource tag name. A source placeholder such as
  // `<page-name>.md` is a different name and remains ordinary authored text.
  if (/<\/?page(?=[\s/>]|$)/i.test(sourceBody))
    throw refused("Authored source cannot introduce or imitate a child-page resource.")
  const pages = [
    { id: page, path: portable.main, markdown: inventory.markdown },
    ...inventory.references.map((reference) => ({
      id: reference.page_id,
      path: reference.path,
      markdown: "",
    })),
  ]
  const body = rewritePageLinks(sourceBody, portable.main, pages, "notion")
  const compiled = compileSourceRootBody(body)
  if (!compiled)
    throw refused("The complete authored root has an unsupported or empty physical source model.")
  // Preserve the original authored prefix and retained suffix byte for byte.
  // The separator belongs to this request boundary; neither input is trimmed.
  const next = `${body}${body.endsWith("\n") ? "" : "\n"}${inventory.markdown}`
  return {
    kind: "empty_authored_root" as const,
    before_shape: "only_retained_reference_child_pages" as const,
    source_path: portable.main,
    source_sha256: digest(main.bytes),
    source_body_sha256: digest(sourceBody),
    authored_body: body,
    body_model_sha256: digest(canonical(compiled)),
    references: inventory.references,
    retained_markdown: inventory.markdown,
    request: {
      path: `v1/pages/${page}/markdown`,
      method: "PATCH" as const,
      body: {
        markdown_version: "v2" as const,
        type: "replace_content" as const,
        replace_content: { new_str: next },
      },
    },
    proposed_only: true as const,
  }
}
