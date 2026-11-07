# Operations and recovery

## Operation choices

| Intent | Command | Result |
| --- | --- | --- |
| New item | `create INPUT --database LIBRARY` | A new page; an existing name is a conflict |
| Existing unregistered disabled draft | `adopt PAGE_ID --database LIBRARY` | Retain the original page/body/disabled state and establish its complete initial identity and retained-body lifecycle |
| Inspect an exact draft for editing | `read PAGE_ID --database LIBRARY --authoring` | Validate the complete tree online and return a fixed author pin without enabling current consumption |
| One edit of existing body, resources and properties | `apply PINNED_MAIN_REF --input CHANGES --description TEXT` | Shared targets use a frozen sequential batch; earlier publication targets retain their own protocol |
| One selected file | `write PINNED_FILE_REF --input FILE` | Preserve every other file and page property |
| Properties only | `update PINNED_MAIN_REF --name NAME --description TEXT` | Change only the specified allowed properties |
| Enable or disable a reviewed native Skill | `update PAGE_ID --database LIBRARY --enabled true` or `--enabled false` | Verify the complete current tree and change only nominated properties |
| Deliberately replace the entire file set | `replace INPUT --target PINNED_MAIN_REF` | Preserve page identity and replace the included file set |
| Portable copy | `export PINNED_MAIN_REF --output NEW_DIRECTORY_OR_ZIP` | Export the chosen fixed version without changing Notion |

`apply` accepts a changes directory, ZIP or Markdown file. Paths are rooted at the Skill, including `references/` and other nested directories. A single Markdown file uses its basename. Preserve the original main path and kind when supplying a portable manifest. A path cannot be both changed and removed; the main file and reserved portability files cannot be deleted. Full replacement is a deliberate different operation: omitted supporting files leave the Skill's inclusion set.

Use exact page IDs/URLs or returned refs. Names and aliases can collide; incomplete discovery does not establish uniqueness. The creation database is explicit `--database`, the configured default, or the only discovered library. An existing target keeps its database.

## Initial native draft adoption

Adopt requires an exact original page with complete valid Name/Description, Kind=skill and Enabled=false. Skill ID/Main File ID/Source/Projection/References and managed relations must be empty, and no Files or Records lifecycle may already belong to it. It anchors deterministic Skill and main File identities to the library and original page, retains the complete main body and initial adopted event, and changes only the two identity properties. It sends no body PATCH and creates no Skills/Files page. `--dry-run` makes no remote writes.

An unregistered disabled page can remain under human construction without blocking the consumer catalog. It is not an active Skill or proof of a history-free draft. Existing bindings or Records require their original workflow, not a replacement identity. Repeat adoption only reconciles its original retained outcome; `verification=original_adoption_outcome` and `enabled_at_adoption` are historical facts. Use the returned fresh authoring read before further edits or activation.

## Shared file lifecycle

Use the exact Skill page ID and library entry for each individual operation:

```bash
ntn-skills ctl library file add SKILL_PAGE_ID references/new.md --entry LIBRARY_ENTRY --input ./new.md
ntn-skills ctl library file move SKILL_PAGE_ID references/old.md references/new.md --entry LIBRARY_ENTRY
ntn-skills ctl library file delete SKILL_PAGE_ID references/obsolete.md --entry LIBRARY_ENTRY
ntn-skills ctl library file restore-follow SKILL_PAGE_ID references/checklist.md --entry LIBRARY_ENTRY
```

Each supports `--dry-run`. Add creates a File identity; move keeps the File ID, native page and fixed-source path; delete retains a tombstone and the old page/body. Complete-tree relative references must remain valid, and move does not rewrite links. Main files cannot be moved or deleted. Restore-follow retains the complete custom body before restoring the exact currently selected source; a moved file uses its old source path. It never advances a commit. Local source bytes require an explicit machine/workspace binding plus `--allow-local-archive` to retain that selected body in shared records.

For a reference visible from the original Notion Skill, obtain a fresh `read PAGE_ID --authoring` after add, then write the complete main file with a descriptive link to the new logical path, for example `[Checklist](references/new.md)`. Do not reuse the pre-add pin: the file inventory changed. Write restores relative destinations using only the fresh selected owner's exact native File bindings, so existing and new links stay clickable in Notion; a subsequent read renders the same fixed resource paths. The returned `page_id` also supports an explicit native URL. The file lives in the related flat Files table; this workflow does not create or enumerate physical child pages. Add alone does not edit the main body. Submitting the unchanged complete read result performs no body PATCH or new Records publication merely to normalize URL spelling.

Shared `apply` supports existing bound native UTF-8 files plus explicitly nominated metadata in one non-atomic batch. Every input and the complete proposed tree are checked before dispatch. One isolated add/delete is supported; mixed or multiple layout changes fail with `SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED` before writes. A later execution failure can preserve earlier verified edits; retain the original remaining intent. `replace` uses these same shared limits and cannot change the original kind.

## Content formats

Skill, Router and Prompt use `SKILL.md`, `ROUTER.md` and `PROMPT.md` for reading. To create a Prompt/Router, keep the exported portable manifest or use the installed `schema create` contract. A root `.ntn-skills.json` declares kind and main; a lone file named `ROUTER.md` does not change the import kind.

For example, a Prompt directory contains `.ntn-skills.json` and `PROMPT.md`:

```json
{
  "format": "ntn-skills",
  "version": 2,
  "kind": "prompt",
  "name": "Release Review",
  "description": "Review a proposed release",
  "main": "PROMPT.md"
}
```

In a shared library, ordinary Skill folders with `SKILL.md` need no hand-authored manifest. Native creation freezes every UTF-8 input and leaves the new Skill disabled until the complete body set verifies. Binary or unsupported input fails before page creation. Omit `--storage`; consume binary resources through fixed sources. Shared main frontmatter must match current native Name/Description or values explicitly nominated in the same apply, and `notion_page_id` must match the selected Skill. Extra unsupported main fields are rejected. Native authoring normalizes CRLF to LF and terminal line feeds before exact candidate verification.

In an existing legacy publication library, supporting Markdown is included through References with relative paths; optional Files preserves source bytes and non-Markdown resources. Page-only storage supports Markdown and its documented normalization. Preserve scripts, binary assets, link destinations, code and authored structure; do not discard them to make verification pass. Reading an included script does not execute it.

`markdown_files` is an explicit text-only storage choice through create/replace in those legacy libraries; shared targets reject it. Existing editable-file items keep that choice during apply. Binary assets require native Files storage. Editable code files require LF line endings. A storage error calls for a compatible target or a deliberate content decision, not silent conversion to another representation.

Router `--member` selects the complete Members relation using exact current Skill identities from the same database. `--clear-members` clears it; omission preserves it. Members and authored Router instructions remain distinct. Default Context is an ordinary checkbox available to Notion Views, not a second host-selection rule.

## Current reads and ownership

For shared content, a successful complete current observation retains a direct Notion body edit as a whole-file customization. Other files retain their own source behavior. Reverting the text, clearing caches or moving the file does not restore following. Use explicit restore-follow for that change; no manual adopt mark or whole-Skill fork is required. Notion still owns Name, Description, Default Context and Router Members.

Current `read --refresh` verifies a complete stable Notion graph. It can read human edits independently of the previous publication's intended bytes. A writing/incomplete publication remains blocked; pinned reads stay fixed and offline. Source-link projection is optional: an unavailable or incompatible upstream map cannot make current member files unreadable. Cross-member resolution requires a valid map and must not invent targets.

Existing legacy tracked content is owned by its upstream source. Ordinary body/resource/Name/Description edits require a personal fork first. Current readability, a title match or a committed marker does not transfer ownership. Organization-only changes preserve the authored content; later synchronization still detects a divergent tracked edit.

For those legacy records, Source Type and Builtin ID record origin separately from Sync Mode. Ordinary edits preserve origin. Use package publication to create/update a package copy; use upstream synchronization for source-managed content. Do not infer origin from a display name or an empty relation.

## Original-operation recovery

Commands emit one JSON result. Help/version/schema are offline; operational failures are structured. A completed mutation verifies the requested content and metadata readback. Require the applied/already-unchanged outcome as well as exit 0, `ok: true`, `verified: true` and no dry-run. A recovery result with `not_applied` or `partial` is not a completed edit even when `verified: true`. Keep the returned page/ref/operation result, and investigate further only for a discrepancy or an explicit audit.

| Result | Next action |
| --- | --- |
| `WRITE_CONFLICT` | Read the current exact item and merge the intended change into a fresh pinned edit |
| `UPSTREAM_CONTENT_READ_ONLY` | Edit the source or explicitly fork the selected member |
| Shared body/metadata write, apply or restore-follow is unknown | Read the exact current Skill; obey `read_again` after original facts settle, and retain missing original facts as unresolved |
| Shared create is unknown | Keep the same complete input and original intent; its retry reconciles original creation identities without blindly repeating POSTs |
| Initial draft adoption is unknown | Preserve `adoption_operation_id` and use the returned `adopt PAGE_ID --database LIBRARY --reconcile`; no current equality or absent record authorizes a replay |
| Shared add/delete/move is unknown | `ctl library file reconcile SKILL_PAGE_ID OPERATION_ID --entry LIBRARY_ENTRY` |
| Partial or unknown legacy Publication | Follow its returned `ctl operation show`/`reconcile`/`resume` action on the original Publication ID |
| Missing access, invalid paths or unsupported content | Fix the actual input/access issue before retrying |
| Output path conflict | Choose a new destination or review the owned previous output |

Shared operation IDs are not accepted by legacy `ctl operation resume`. Do not replay a create, remove state, change frozen input or add acceptance/proof steps to routine edits. Historical migration/repair commands live in the separate operator tool and are for an explicitly diagnosed maintenance task.

## Builtin management

Use installed package Skills to direct the Agent's work. Package installation, remote publication and ordinary content edits are separate operations:

```bash
ntn-skills ctl builtin list
ntn-skills ctl builtin install notion/ntn-skills-maintain
ntn-skills ctl builtin status notion/ntn-skills-maintain
ntn-skills ctl builtin update notion/ntn-skills-maintain
ntn-skills ctl builtin publish notion/ntn-skills-maintain --database library
```

Local install/update distributes one managed central copy. Preserve modified or foreign targets if the CLI reports a conflict. Package publication creates a remote copy; updating an existing copy requires an exact pinned target. Builtin origin describes the installed package ID, not editable publisher text. After changing local distribution, use the consuming host's documented reload path.

## Review a legacy migration

Keep the complete frozen input, retained managed files, exact native response JSON and selected fixed Source bytes. Use `ctl library migration plan --input FROZEN_JSON` for the offline inventory, then prepare the concrete target without changing approvals:

```bash
ntn-skills ctl library migration review --input FROZEN_JSON \
  --legacy-id LEGACY_ID --entry LIBRARY_ENTRY --files RETAINED_FILES \
  --preimages RAW_RESPONSES
```

Add `--source-files EXACT_SOURCE_DIR_OR_ZIP` when the frozen target selects a Source. Save the complete JSON and inspect its `review_id`, content, ownership, Source, target and member bindings. Review can read target metadata; it performs no Notion writes and does not approve migration. For absent `Enabled`, use complete original row/schema evidence with `legacy_catalog_active_page_v1`, or explicitly select `legacy_catalog_active_page_v2` and API `2026-03-11`. V1 requires `archived:false` and `in_trash:false`; v2 requires `in_trash:false` and rejects contradictory archive flags when present. Retain `original_enabled: absent`; never invent an `Enabled` or missing `archived` value or reclassify ownership from activity. Consult each subcommand's `--help` for its exact retained-input contract.

New reviews bind `origin.candidate.execution_policy` into the digest. Ordinary targets use `copy_to_new_native_v1`, which requires the target's exact bytes, ownership, same-page aliases, Router members, Source and relevant operation evidence. A validated versioned retained-publication descriptor selects `copy_to_new_native_v2` for a copy of one exact retained observation. V2 rechecks the original committed publication, fixed member, authored export and native response bytes; the derived native files are its `--files` input. It retains `retained_operations` and `retained_catalog_coverage` in the review digest, including unresolved history and incomplete enumeration. Both policies create new native pages without source cutover or legacy retirement. A policy name, approval or receipt boolean cannot replace the selected target's actual evidence.

After explicit approval, keep a separate frozen input with the reviewed identity in `approved_legacy_ids`. Preserve all other review-bound facts and the independent approved digest. Run `ctl library migration apply --input APPROVED_JSON --review REVIEW_JSON --review-id MIGRATION_REVIEW_ID --dry-run`; execute the same command without `--dry-run` only for that approved result. Require `status: created`, `verified: true` and a verified current pin before reporting migration success.

For either explicit copy policy, apply/dry-run and direct create execution require the approved target and complete dependency evidence; independent unapproved entries may remain blocked. Empty approval permits no creation. Saved unmarked and v1 candidates keep their original gates and cannot inherit v2 by relabelling. Unresolved dependencies return `SHARED_MIGRATION_CREATE_BLOCKED`; unmarked/v1 reliance on unread impact/isolation receipts returns `SHARED_MIGRATION_RECEIPT_UNVERIFIED`. V2 verifies the retained publication instead, without settling old operations or completing enumeration. Preserve the full input and exact review-bound history through apply.

Keep an unknown operation unchanged and use `ctl library migration reconcile --entry LIBRARY_ENTRY --operation ORIGINAL_SKILL_CREATE_OPERATION_ID`; add the exact new `--target PAGE_ID` from a receipt when the original journal is unavailable on another machine. Reconciliation verifies only the original create outcome and does not replay writes or prove a current pin. `WRITE_VERIFICATION_FAILED` with `native_create_completed: true` also needs this distinction: native creation finished, but the final current-snapshot check failed without adopting user edits. Preserve the error and original operation; never switch to generic `ctl operation resume` or issue a replacement intent. Ordinary later current reads have their own adoption behavior.

For a known disabled partial migration with `SHARED_CREATE_BODY_MISMATCH`, inspect `ctl library migration recovery review --help`. Its bounded v4-to-v5 decision keeps original input/wire bytes, page identities and failure evidence. Save and inspect the separate review before `recovery apply` with the original approved input; existing page bodies remain untouched. A current observation is labeled `post_failure_current_read`. Recovery interruption uses `recovery reconcile` with the original operation and existing target, without replay. See the authoring guide's partial migration recovery workflow; this path cannot recover an unknown original create or silently accept changed current content.

If that recovery itself reports an unknown page create, inspect `ctl library migration recovery continuation review --help`. A separate continuation requires the terminal retained by the actual serial dispatch, exact successful responses and matching current allocations. Save and inspect its digest before `continuation apply` with the complete original approved input. It skips accepted pages and creates only the proven unattempted suffix; the original POST stays unknown. Missing terminal or input, an invisible or changed page, and a second interruption remain blocked. Current GETs and retrospective summaries cannot replace execution evidence. Completion v2 is checked independently through `recovery reconcile`; do not fabricate an old terminal or downgrade the completion.
