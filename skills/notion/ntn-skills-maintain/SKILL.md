---
name: ntn-skills-maintain
description: Create, adopt and edit Notion Skills through ntn-skills. Use for native content, pinned body/resource/metadata changes, linked reference pages, library audits, exact inventory reconciliation and complete reviewed imports. Preserve original operations and whole custom files. Route source policy, fixed-source selection, Profiles and existing synchronization bindings to ntn-skills-sync.
compatibility: Requires ntn-skills, Node.js 22.22.3+ within 22.x or 24.20.0+, and an existing Notion token with Read, Insert and Update content access. Notion requests use the project's direct HTTP engine.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain content in Notion

Use the installed CLI within the user's requested scope. Resolve the exact page and library from the task, configuration or discovery. Keep returned record IDs and refs unchanged; a shared stable ID is not a page UUID. Use `ntn-skills schema COMMAND` or `COMMAND --help` for the installed interface.

## Create a new item

Prepare ordinary `SKILL.md` and supporting files, then create the authorized Skill:

```bash
ntn-skills create ./release-review --database LIBRARY_ENTRY
```

Ordinary Skill folders need no hand-authored manifest. `--name` and `--description` explicitly override input metadata. A name collision does not permit replacing another page. Prompt/Router kind declarations still use the portable contract in [content formats](references/operations.md#content-formats).

A shared library creates native Skills/Files pages, preserves the original input, and enables the Skill only after its complete file set verifies. Omit `--storage` for that path. Ordinary `create` keeps its existing UTF-8 native input contract. Use the reviewed complete inventory workflow below when the Skill includes binary, JSON or script resources; it uses the same original creation journal. Unsupported input must fail before partial creation. An unknown result retains its exact input and original operation.

## Audit and import a complete local Skill

Freeze the authorized roots and target library first. Do not expand a private project, external symlink target or package-owned tree merely because a Skill refers to it.

```bash
ntn-skills ctl audit run --entry LIBRARY_ENTRY --all --depth content
ntn-skills ctl audit resume AUDIT_RUN_ID
ntn-skills ctl library inventory remote --audit-run AUDIT_RUN_ID
ntn-skills ctl library inventory local --root /absolute/approved/skills --allow-target /absolute/approved/targets
ntn-skills ctl library inventory reconcile --remote REMOTE_INVENTORY_ID --local LOCAL_INVENTORY_ID
ntn-skills ctl library inventory review RECONCILIATION_ID
```

Use `audit report RUN_ID` or `audit list` offline to inspect original observations. Audit depth, execution, coverage and severity are separate: exit 75 is resumable budget exhaustion, 4 is incomplete coverage, and 3 is a completed full audit with error findings. Partial scope cannot prove absence. Inventory records complete paths, hashes, byte sizes, modes, real identities, logical aliases, restricted dependencies and provenance without executing scripts or changing the source tree. Add only the exact relevant `--provenance` files; an AK installation needs its assets mode configuration alongside install/upstream registries.

Review one entity and its complete manifest, then choose exactly one input kind:

```bash
ntn-skills ctl library inventory prepare-import --entry LIBRARY_ENTRY \
  --review RECONCILIATION_ID --entity ENTITY_ID --approve-manifest MANIFEST_SHA256 \
  --native --output ./import-plan.json
ntn-skills ctl library inventory apply-import ./import-plan.json --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library inventory apply-import ./import-plan.json --entry LIBRARY_ENTRY
ntn-skills ctl library inventory reconcile-import ./import-plan.json --entry LIBRARY_ENTRY
```

For upstream content, replace `--native` with `--source SOURCE_ID --member EXACT_MEMBER`. Local modifications require a proven original fixed commit; the current upstream revision cannot serve as an invented old baseline. Exact existing equal content uses `--verify-existing`; differences and ambiguous identities need a separate reviewed author/source plan. Names and hashes alone never authorize replacement.

New entries default to disabled. Add `--enable` only when preparing a plan that explicitly includes making the fully verified new Skill available. Markdown, references, scripts, JSON, images, binary, modes and required relative paths all participate in completeness. Same-library portable relations retain their explicit ownership; upstream relationship suggestions do not modify user selections. Revalidate the complete source tree and provenance before applying. Never drop unsupported files to obtain a successful main-only import.

Use the same original plan for partial recovery and repeated execution. `reconcile-import` reads the original outcome without source-tree reads, provider rediscovery or remote writes. Only original durable receipts can justify continuation; current equality does not confirm a lost response. A copied or rehashed JSON is not new upload authority. For an actual inventory migration, independently audit and consume each reviewed batch from its frozen pre-import manifest, retaining all conflicts, pending authorization and failures in the denominator. Do not delete or redirect local originals as part of import.

## Adopt a draft created in Notion

When the intended Skill already exists as a disabled Notion page, use its original page. Ensure its native Name and Description are complete and Kind is `skill`, then run:

```bash
ntn-skills adopt SKILL_PAGE_ID --database LIBRARY_ENTRY
ntn-skills read SKILL_PAGE_ID --database LIBRARY_ENTRY --authoring
```

Adopt establishes stable Skill and main File identities and retains the complete existing body in Records. It preserves the original page, body, metadata and `Enabled=false`; it creates no replacement Skills/Files page. Initial adoption requires empty Skill ID, Main File ID, Source, Projection, References and managed relations, with no existing Files or Records lifecycle. An unfinished disabled page is a valid unregistered state outside consumer discovery, not permission to overwrite a previous lifecycle. Correct incomplete native metadata before adoption; preserve a conflicting binding for its existing workflow.

Keep `adoption_operation_id`. An interrupted adoption uses its returned `adopt ... --reconcile` action, which verifies only the original outcome without repeating writes. Reconciliation still requires a fresh authoring read for current content. Do not assign identities by hand or use create to duplicate an existing draft.

Metadata audit recognizes a disabled unregistered draft without demanding registered identities. Managed fields, related Files or Records still produce a lifecycle finding; an audit never grants adoption authority. Content/history checks of an unregistered draft remain partial. Old v1 audit reports stay available offline with their original findings, but current v3 rules require a new run rather than resuming or reusing the old classification.

## Repair an existing identity

For a page with a legal Skill ID and blank Main File ID, use `ntn-skills ctl repair plan PAGE --entry historical-missing-main --database LIBRARY_ENTRY --dry-run`. Inspect the exact target and preservation facts, then copy its returned `next.argv`. The apply command reuses that original operation; do not hand-write identity fields or copy a page. A hand-created Files row uses the explicit `managed-file` entry with `--owner` and `--path`. An ordinary child page without safe same-page placement returns a diagnosed refusal. Duplicate or foreign identities require an explicit owner decision. Disabled state, a matching body and a Status label are not repair authority.

## Edit an exact current item

Read the current page and keep its pinned main ref:

```bash
ntn-skills read SKILL_PAGE_ID --database LIBRARY_ENTRY --authoring
ntn-skills read guide.md --from PINNED_CONTAINING_FILE_REF
```

Authoring reads verify the exact current page and its complete tree online, including a disabled draft. They return a fixed author pin without enabling consumption or publishing a disabled current-cache entry. Use that snapshot for related files; old pins keep their exact bytes. Ordinary `read` and `use` still reject disabled current content. Existing write/update/apply/replace and file add/move/delete commands already express author intent and need no extra flag. Prepare a separate changes directory with only the existing files being changed, preserving their relative paths:

```bash
ntn-skills apply PINNED_MAIN_REF --database LIBRARY_ENTRY \
  --input ./changes --description 'Updated workflow description'
```

Omitted files and properties remain unchanged. Explicit `--name`, `--description`, `--default-context`, and Router `--member`/`--clear-members` nominate native properties. Shared main frontmatter must match current metadata or those explicit changes; unsupported extra main fields fail before writes. Use `write PINNED_FILE_REF --input FILE` for one complete file, or `update PINNED_MAIN_REF` for metadata only.

A shared `apply` validates the complete proposed tree, including added native files and omitted existing files, then executes one original parent and its ordered children. Submit a main rewrite and new references in the same input directory. Explicit `--changes FILE` can nominate moves, removals and revivals; do not infer them from absent input. A later failure preserves verified changes and original recovery evidence. Unknown writes stop the suffix. Use `--dry-run` to resolve a remaining decision; a stale baseline requires a fresh authoring read.

When the requested result includes making the reviewed Skill available, finish with `ntn-skills update SKILL_PAGE_ID --database LIBRARY_ENTRY --enabled true`. This verifies the complete current tree before changing only the nominated property. `--enabled false` disables it. Editing a disabled draft otherwise preserves its disabled state; disabled is an availability state, not an access-control boundary.

## Maintain file identity and ownership

For a shared Skill, inspect `ctl file --help` and use the exact page ID, entry and logical path:

```bash
ntn-skills ctl file add SKILL_PAGE_ID references/new.md --entry LIBRARY_ENTRY --input ./new.md
ntn-skills ctl file move SKILL_PAGE_ID references/old.md references/new.md --entry LIBRARY_ENTRY
ntn-skills ctl file delete SKILL_PAGE_ID references/obsolete.md --entry LIBRARY_ENTRY
ntn-skills ctl file restore-follow SKILL_PAGE_ID references/checklist.md --entry LIBRARY_ENTRY
```

Prefer one `apply` containing the revised main and new references for a normal split. Standalone add is useful when the file should be staged before a later edit: it creates a new File identity and returns its native `page_id`. For that standalone workflow, complete both steps: add the file, then take a fresh `read SKILL_PAGE_ID --authoring`, append a descriptive Markdown link such as `[New reference](references/new.md)`, and submit the complete main file through `write PINNED_MAIN_REF --input FILE`. Preserve all existing main content and metadata. Write restores exact same-owner relative paths to their native Notion pages, so both existing and new references stay clickable in Notion and readable from the same fixed snapshot. Explicit native Notion URLs remain accepted. The reference is a flat Files-table page related to the Skill; no physical child-page traversal or duplicate page is needed.

Move preserves its ID, native page and original source path. Delete records a tombstone and retains the page/body. `ctl file undelete PAGE PATH --entry LIBRARY_ENTRY` revives the same retained Markdown identity; it does not follow a newer source or recreate a page. Relative references are validated without rewriting them; prepare those changes explicitly. Main files cannot be moved or deleted. Failed or inaccessible reads are not deletion intent.

Editing any bound Notion body makes that whole file customized through the next successful current read. Other files retain their own source behavior. Shared metadata remains authoritative in Notion; no tracked/fork conversion or manual adopt marker is required. `restore-follow` explicitly retains the custom body and restores the exact source selected in Notion. It does not select a newer revision. Sharing a selected local source body requires `--allow-local-archive`.

For non-document resources, use `ctl resource` with one exact path and input file:

```bash
ntn-skills ctl resource add SKILL_PAGE_ID assets/icon.png --entry LIBRARY_ENTRY --input ./icon.png
ntn-skills ctl resource replace SKILL_PAGE_ID scripts/run.js --entry LIBRARY_ENTRY --input ./run.js
ntn-skills ctl resource reconcile SKILL_PAGE_ID OPERATION_ID --entry LIBRARY_ENTRY
```

The resource command preserves raw bytes and known executable mode in retained objects, with a stable Files management page; the page's notes are not the binary payload. `move` preserves identity and source path, `delete` records a tombstone, `undelete` restores the retained custom resource, and `restore` explicitly follows the selected source again. Paths and references must remain valid. Old pins keep original bytes; a later source update cannot revive a tombstone. These commands never run the resource. Use their `--dry-run` and original operation ID for review and reconciliation; changing inputs does not clear an unknown operation.

Keep generated snapshot directories as consumption output; modifying one never authorizes a silent reverse sync. Preserve another operation family's original baselines and returned recovery actions. Route current Source policy and Profile changes to `ntn-skills-sync`.

## Finish from the verified result

Require exit 0, `ok: true`, `verified: true`, no `dry_run: true`, and an applied/already-unchanged result for a completed mutation. A verified recovery with `not_applied` or `partial` confirms that outcome; it is not a completed edit. Report the exact record, changed paths/properties and returned pin. The CLI owns saved-content verification; routine success needs no additional export/hash checklist.

Preserve the original operation ID. `ctl operation show ID --target PAGE --entry LIBRARY_ENTRY` and `reconcile` route shared creation, adoption, body/metadata/file/resource/apply and repair families to their existing owners. Show distinguishes intent from an outcome; reconcile never dispatches the missing write. Only an explicitly selected original apply can use `ctl operation resume` to continue its proved-unsent suffix. Missing original facts stay unresolved. Follow `read_again` with a fresh current read; use `--authoring` for a disabled target. Current equality never manufactures an original ACK.

Use the exact recovery action returned for the original operation; different operation families are not interchangeable. A known ordinary native body mismatch whose same original main was explicitly restored to the exact frozen candidate has `ctl library create recovery review/apply/reconcile`; preserve its complete original plan and durable receipts. This route keeps the old failure and resumes only the original file suffix. Do not create a replacement, change a name, clear pending state or discard unrelated files to bypass an unresolved result. Consult [operations and recovery](references/operations.md) for the matching path and the reserved marker on older publication pages.
