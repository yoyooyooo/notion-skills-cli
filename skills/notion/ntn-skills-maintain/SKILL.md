---
name: ntn-skills-maintain
description: Create, adopt and edit Notion Skills through ntn-skills. Use for a manually created disabled draft, native shared content, pinned body/resources/metadata changes, adding a linked reference page, enabling a reviewed Skill, explicit restore-follow, exact replacement or portable transfer. Preserve interrupted original operations. Route source selection and Profile/View settings to ntn-skills-sync.
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

A shared library creates native Skills/Files pages, preserves the original input, and enables the Skill only after its complete file set verifies. Omit `--storage` for that path. Unsupported binary or input projection fails before creation without dropping files; consume binary resources through a fixed source. A create result that is unknown must retain its exact input and original operation.

## Adopt a draft created in Notion

When the intended Skill already exists as a disabled Notion page, use its original page. Ensure its native Name and Description are complete and Kind is `skill`, then run:

```bash
ntn-skills adopt SKILL_PAGE_ID --database LIBRARY_ENTRY
ntn-skills read SKILL_PAGE_ID --database LIBRARY_ENTRY --authoring
```

Adopt establishes stable Skill and main File identities and retains the complete existing body in Records. It preserves the original page, body, metadata and `Enabled=false`; it creates no replacement Skills/Files page. Initial adoption requires empty Skill ID, Main File ID, Source, Projection, References and managed relations, with no existing Files or Records lifecycle. An unfinished disabled page is a valid unregistered state outside consumer discovery, not permission to overwrite a previous lifecycle. Correct incomplete native metadata before adoption; preserve a conflicting binding for its existing workflow.

Keep `adoption_operation_id`. An interrupted adoption uses its returned `adopt ... --reconcile` action, which verifies only the original outcome without repeating writes. Reconciliation still requires a fresh authoring read for current content. Do not assign identities by hand or use create to duplicate an existing draft.

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

A shared `apply` validates the complete proposed tree, then runs its frozen body and metadata operations sequentially. It is not atomic. A later failure preserves earlier verified changes and the remaining original intent. Mixed or multiple layout changes currently fail before writing; one isolated add/delete is supported. Use `--dry-run` when a preview will resolve a remaining decision. A stale baseline requires a fresh read and deliberate reconciliation of the requested edit.

When the requested result includes making the reviewed Skill available, finish with `ntn-skills update SKILL_PAGE_ID --database LIBRARY_ENTRY --enabled true`. This verifies the complete current tree before changing only the nominated property. `--enabled false` disables it. Editing a disabled draft otherwise preserves its disabled state; disabled is an availability state, not an access-control boundary.

## Maintain file identity and ownership

For a shared Skill, inspect `ctl library file --help` and use the exact page ID, entry and logical path:

```bash
ntn-skills ctl library file add SKILL_PAGE_ID references/new.md --entry LIBRARY_ENTRY --input ./new.md
ntn-skills ctl library file move SKILL_PAGE_ID references/old.md references/new.md --entry LIBRARY_ENTRY
ntn-skills ctl library file delete SKILL_PAGE_ID references/obsolete.md --entry LIBRARY_ENTRY
ntn-skills ctl library file restore-follow SKILL_PAGE_ID references/checklist.md --entry LIBRARY_ENTRY
```

Add creates a new File identity and returns its native `page_id`. To deliver a reference page discoverable from the original Skill, complete both steps: add the file, then take a fresh `read SKILL_PAGE_ID --authoring`, append a descriptive Markdown link such as `[New reference](references/new.md)`, and submit the complete main file through `write PINNED_MAIN_REF --input FILE`. Preserve all existing main content and metadata. Write restores exact same-owner relative paths to their native Notion pages, so both existing and new references stay clickable in Notion and readable from the same fixed snapshot. Explicit native Notion URLs remain accepted. The reference is a flat Files-table page related to the Skill; no physical child-page traversal or duplicate page is needed.

Move preserves its ID, native page and original source path. Delete records a tombstone and retains the page/body. Relative references are validated without rewriting them; prepare those changes explicitly. Main files cannot be moved or deleted. Failed or inaccessible reads are not deletion intent.

Editing any bound Notion body makes that whole file customized through the next successful current read. Other files retain their own source behavior. Shared metadata remains authoritative in Notion. `restore-follow` explicitly retains the custom body and restores the exact source selected in Notion. It does not select a newer revision. Sharing a selected local source body requires `--allow-local-archive`.

## Finish from the verified result

Require exit 0, `ok: true`, `verified: true`, no `dry_run: true`, and an applied/already-unchanged result for a completed mutation. A verified recovery with `not_applied` or `partial` confirms that outcome; it is not a completed edit. Report the exact record, changed paths/properties and returned pin. The CLI owns saved-content verification; routine success needs no additional export/hash checklist.

Preserve `create_operation_id`, `adoption_operation_id`, `body_write_operation_id`, `metadata_operation_id`, `apply_operation_id`, or the original error's recovery plan. For shared writes/apply/restore-follow, read the exact current Skill to reconcile retained operations; use `--authoring` for a disabled draft and repeat only when it reports `read_again`. For an interrupted native create, retain the same input and intent. Use the returned `adopt ... --reconcile` for initial draft adoption, and `ctl library file reconcile SKILL_PAGE_ID OPERATION_ID --entry LIBRARY_ENTRY` for add/delete/move. Missing original facts remain unresolved; current equality never proves an unknown request succeeded.

Use only the recovery action returned for that operation. Do not create a replacement, change a name, clear pending state or discard unrelated files to bypass an unresolved result. Consult [operations and recovery](references/operations.md) for the matching path.
