import { Effect } from "effect"
import { fail, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { sharedSkillProperty } from "./shared-content.ts"
import { assertGitOnlyAdmissionOwner } from "./shared-git-only-marker.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { readSharedFileSourceContext } from "./shared-file-source-context.ts"
import { resolveSelectedSharedSourceReference } from "./shared-selected-source.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import type { SharedBodyWritePlan } from "./shared-body-write-model.ts"
export {
  gitMainChecked,
  gitMainInput,
  type SharedGitMainInitialization,
} from "./shared-git-main-initialization-model.ts"

/** Fresh exact original Source ownership and immutable selected main. This
 * reads metadata only and does not infer any native file event from emptiness. */
export function readGitMainInitializationContext(library: SharedLibrary, skillPageId: string) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/pages/${skillPageId}`)
    const index = yield* querySharedSkillIndex(library, skillPageId, raw)
    const sourceContext = yield* readSharedFileSourceContext(library, skillPageId, raw)
    const definition = sourceContext.definition
    const projection = text(sharedSkillProperty(raw, library, "Projection").rich_text)
    if (
      index.kind !== "skill" ||
      definition === null ||
      index.main.baseline !== undefined ||
      sourceContext.selected_version !== index.source_reference
    )
      return yield* Effect.fail(
        fail(
          "SHARED_GIT_MAIN_SCOPE",
          "Select an initially Git-only Skill with its exact original Source and main identity.",
        ),
      )
    yield* assertGitOnlyAdmissionOwner({
      projection,
      library_id: library.library_id,
      skill_id: index.skill_id,
      origin_page_id: definition.page_id,
      member: definition.member,
    })
    const selected = yield* resolveSelectedSharedSourceReference(library, {
      skillPageId,
      sourceId: index.source_reference,
    })
    if (selected.kind !== "git" || selected.binding.root !== definition.member)
      return yield* Effect.fail(
        fail(
          "SHARED_GIT_MAIN_SCOPE",
          "The selected main must belong to the exact fixed Git member.",
        ),
      )
    const sourceFile = selected.binding.files.find((file) => file.path === index.main.path)
    if (!sourceFile || sourceFile.sha256 === undefined || sourceFile.mode === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_GIT_MAIN_SCOPE",
          "The fixed Git main must retain its complete hash, size and executable mode.",
        ),
      )
    const binding = (file: {
      readonly file_id: string
      readonly page_id: string
      readonly path: string
    }) => ({ file_id: file.file_id, page_id: file.page_id, path: file.path })
    const relations = ["Members", "Requires"]
      .filter((name) => library.skills.property_ids[name] !== undefined)
      .map((name) => [name, sharedSkillProperty(raw, library, name)])
    const ownerMetadata = {
      skill_id: index.skill_id,
      page_id: index.page_id,
      kind: index.kind,
      name: index.name,
      description: index.description,
      enabled: index.enabled,
      default_context: index.default_context,
      source_reference: index.source_reference,
      file_links: index.file_links,
      projection,
      relations,
      main: binding(index.main),
      files: index.files.map(binding),
    }
    return {
      index,
      sourceContext,
      sourceFile: { ...sourceFile, sha256: sourceFile.sha256, mode: sourceFile.mode },
      revision: selected.revision,
      ownerMetadataSha256: yield* sha256(canonicalSharedJson(ownerMetadata)),
    }
  })
}

/** Reuse the same frozen Git/owner proof before insertion and before an
 * explicit review of that insertion. Native body and event gates stay at the caller. */
export function verifyGitMainInitializationContext(
  library: SharedLibrary,
  plan: SharedBodyWritePlan,
) {
  return Effect.gen(function* () {
    const initial = plan.git_main_initialization
    if (initial === undefined)
      return yield* Effect.fail(
        fail("SHARED_GIT_MAIN_SCOPE", "The original plan is not an initial Git main insertion."),
      )
    const selected = yield* readGitMainInitializationContext(library, plan.skill_page_id)
    if (
      selected.index.main.file_id !== plan.file_id ||
      selected.index.main.page_id !== plan.page_id ||
      selected.index.main.path !== plan.path ||
      selected.index.source_reference !== plan.source_id ||
      selected.ownerMetadataSha256 !== initial.owner_metadata_sha256 ||
      selected.revision !== initial.source_revision ||
      canonicalSharedJson(selected.sourceContext) !== canonicalSharedJson(plan.source_context) ||
      canonicalSharedJson(selected.sourceFile) !== canonicalSharedJson(initial.source_file) ||
      canonicalSharedJson(
        [selected.index.main, ...selected.index.files].map((file) => ({
          page_id: file.page_id,
          path: file.path,
        })),
      ) !== canonicalSharedJson(initial.bindings)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_STALE",
          "The initial Git main, exact source, metadata or native frontier changed; no first insertion or review is authorized.",
        ),
      )
    return selected
  })
}
