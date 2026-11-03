---
name: ntn-skills-maintain
description: Create and edit Notion Skills, Prompts and Routers through ntn-skills. Use for native shared content, a pinned body/resources/metadata change, a supporting-file add/delete/move, explicit restore-follow, exact replacement or portable transfer. Preserve the original operation after interruption and use its matching recovery path. Route fixed-source selection, Profiles and existing synchronization bindings to ntn-skills-sync.
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

## Edit an exact current item

Read the current page and keep its pinned main ref:

```bash
ntn-skills read SKILL_PAGE_ID --database LIBRARY_ENTRY --refresh
ntn-skills read guide.md --from PINNED_CONTAINING_FILE_REF
```

Use that snapshot for related files. Refresh applies to a current target; old pins keep their exact bytes. Prepare a separate changes directory with only the existing files being changed, preserving their relative paths:

```bash
ntn-skills apply PINNED_MAIN_REF --database LIBRARY_ENTRY \
  --input ./changes --description 'Updated workflow description'
```

Omitted files and properties remain unchanged. Explicit `--name`, `--description`, `--default-context`, and Router `--member`/`--clear-members` nominate native properties. Shared main frontmatter must match current metadata or those explicit changes; unsupported extra main fields fail before writes. Use `write PINNED_FILE_REF --input FILE` for one complete file, or `update PINNED_MAIN_REF` for metadata only.

A shared `apply` validates the complete proposed tree, then runs its frozen body and metadata operations sequentially. It is not atomic. A later failure preserves earlier verified changes and the remaining original intent. Mixed or multiple layout changes currently fail before writing; one isolated add/delete is supported. Use `--dry-run` when a preview will resolve a remaining decision. A stale baseline requires a fresh read and deliberate reconciliation of the requested edit.

## Maintain file identity and ownership

For a shared Skill, inspect `ctl library file --help` and use the exact page ID, entry and logical path:

```bash
ntn-skills ctl library file add SKILL_PAGE_ID references/new.md --entry LIBRARY_ENTRY --input ./new.md
ntn-skills ctl library file move SKILL_PAGE_ID references/old.md references/new.md --entry LIBRARY_ENTRY
ntn-skills ctl library file delete SKILL_PAGE_ID references/obsolete.md --entry LIBRARY_ENTRY
ntn-skills ctl library file restore-follow SKILL_PAGE_ID references/checklist.md --entry LIBRARY_ENTRY
```

Add creates a new File identity. Move preserves its ID, native page and original source path. Delete records a tombstone and retains the page/body. Relative references are validated without rewriting them; prepare those changes explicitly. Main files cannot be moved or deleted. Failed or inaccessible reads are not deletion intent.

Editing any bound Notion body makes that whole file customized through the next successful current read. Other files retain their own source behavior. Shared metadata remains authoritative in Notion; no tracked/fork conversion or manual adopt marker is required. `restore-follow` explicitly retains the custom body and restores the exact source selected in Notion. It does not select a newer revision. Sharing a selected local source body requires `--allow-local-archive`.

Existing legacy tracked members still require their explicit fork/conversion workflow for personal authoring. Existing local sync bindings retain their own baselines and recovery. Keep generated snapshot directories as consumption output; modifying one never authorizes a silent reverse sync. Route those existing bindings or source/Profile changes to `ntn-skills-sync`.

## Finish from the verified result

Require exit 0, `ok: true`, `verified: true`, no `dry_run: true`, and an applied/already-unchanged result for a completed mutation. A verified recovery with `not_applied` or `partial` confirms that outcome; it is not a completed edit. Report the exact record, changed paths/properties and returned pin. The CLI owns saved-content verification; routine success needs no additional export/hash checklist.

Preserve `create_operation_id`, `body_write_operation_id`, `metadata_operation_id`, `apply_operation_id`, or the original error's recovery plan. For shared writes/apply/restore-follow, read the exact current Skill to reconcile retained operations; repeat the read only when it reports `read_again`. For an interrupted native create, retain the same input and intent. Use `ctl library file reconcile SKILL_PAGE_ID OPERATION_ID --entry LIBRARY_ENTRY` for add/delete/move. Missing original facts remain unresolved; current equality never proves an unknown request succeeded.

Use `operation resume OPERATION_ID --progress` only when the result identifies the earlier Publication workflow and returns that recovery action. Shared IDs do not use legacy resume. Do not create a replacement, change a name, clear pending state or discard unrelated files to bypass an unresolved result. Consult [operations and recovery](references/operations.md) for the matching path.
