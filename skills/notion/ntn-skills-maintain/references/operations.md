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
| One non-document resource | `ctl library resource add/replace PAGE_ID PATH --entry LIBRARY --input FILE` | Exact bytes and executable mode; no resource execution |
| Complete reviewed local import | `ctl library inventory prepare-import/apply-import/reconcile-import` | One approved complete inventory entity and its original create operation |
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

In a shared library, ordinary Skill folders with `SKILL.md` need no hand-authored manifest. Native creation freezes every UTF-8 input and leaves the new Skill disabled until the complete body set verifies. Ordinary creation rejects unsupported input before page creation. Complete reviewed inventory imports and Source admissions additionally retain non-document resources through the same create journal. Use the inventory workflow for one approved full manifest, and `ctl library resource` for a later explicit resource edit. Omit `--storage` for the shared path. Shared main frontmatter must match current native Name/Description or values explicitly nominated in the same apply, and `notion_page_id` must match the selected Skill. Extra unsupported main fields are rejected. Native authoring normalizes CRLF to LF and terminal line feeds before exact candidate verification.

Router `--member` selects the complete Members relation using exact current Skill identities from the same database. `--clear-members` clears it; omission preserves it. Members and authored Router instructions remain distinct. Default Context is an ordinary checkbox available to Notion Views, not a second host-selection rule.

## Current reads and ownership

For shared content, a successful complete current observation retains a direct Notion body edit as a whole-file customization. Other files retain their own source behavior. Reverting the text, clearing caches or moving the file does not restore following. Use explicit restore-follow for that change; no manual adopt mark or whole-Skill fork is required. Notion still owns Name, Description, Default Context and Router Members.

Current `read --refresh` validates the selected Notion observation and complete manifest; non-document bytes may remain lazy. Authoring reads and full export verify the complete tree. Pinned resources keep their original identity: cached bytes work offline, while missing bytes require the frozen acquisition and its current read permission. Cross-member resolution uses exact current bindings and must not invent targets.

## Original-operation recovery

Commands emit one JSON result. Help/version/schema are offline; operational failures are structured. A completed mutation verifies the requested content and metadata readback. Require the applied/already-unchanged outcome as well as exit 0, `ok: true`, `verified: true` and no dry-run. A recovery result with `not_applied` or `partial` is not a completed edit even when `verified: true`. Keep the returned page/ref/operation result, and investigate further only for a discrepancy or an explicit audit.

| Result | Next action |
| --- | --- |
| `WRITE_CONFLICT` | Read the current exact item and merge the intended change into a fresh pinned edit |
| `UPSTREAM_CONTENT_READ_ONLY` | Edit the source or explicitly fork the selected member |
| Shared body/metadata write, apply or restore-follow is unknown | Read the exact current Skill; obey `read_again` after original facts settle, and retain missing original facts as unresolved |
| Shared create is unknown | Keep the same complete input and original intent; its retry reconciles original creation identities without blindly repeating POSTs |
| Known ordinary native body mismatch, with the same original main explicitly restored to its exact candidate | `ctl library create recovery review ORIGINAL_PLAN --entry LIBRARY --target ORIGINAL_MAIN --output REVIEW`; inspect the digest, then `recovery apply ORIGINAL_PLAN --entry LIBRARY --review REVIEW --review-id ID [--dry-run]` |
| Initial draft adoption is unknown | Preserve `adoption_operation_id` and use the returned `adopt PAGE_ID --database LIBRARY --reconcile`; no current equality or absent record authorizes a replay |
| Shared add/delete/move is unknown | `ctl library file reconcile SKILL_PAGE_ID OPERATION_ID --entry LIBRARY_ENTRY` |
| An original operation from another retained protocol | Follow its exact returned recovery action and original ID; do not translate it into a new create |
| Missing access, invalid paths or unsupported content | Fix the actual input/access issue before retrying |
| Output path conflict | Choose a new destination or review the owned previous output |

Shared operation IDs are not accepted by legacy `ctl operation resume`. Do not replay a create, remove state, change frozen input or add acceptance/proof steps to routine edits. Historical migration/repair commands live in the separate operator tool and are for an explicitly diagnosed maintenance task.

The exact-restoration route requires the original Store, one original main allocation, full original request/ACK set, unchanged metadata/relations and exact complete current Markdown. It never normalizes away an automatic link or patches an existing body. It retains a separate completion while preserving the original `needs_review` outcome. Independent `ctl library create recovery reconcile ORIGINAL_PLAN --entry LIBRARY --target ORIGINAL_MAIN` proves that historical chain; read current content afterward. Inventory and fixed-source plans keep their own recovery routes.

### Reserved creation markers on older pages

An older publication reference page may start with `ntn-skills-create:v1:…`. That reserved paragraph records the original creation identity, parent, logical path and input commitment so interrupted creation can identify the same page. A child page lacks the database property slots used by a publication root, so this older protocol carries its identity in the first physical block. Valid consumer reads exclude it from authored content, and that protocol's writers preserve it. Do not delete, relocate or re-encode it for appearance: current page visibility alone cannot replace its original recovery evidence. Current shared native Skills/Files use registered properties and immutable Records; adding a reference through `ctl library file add` does not require manually creating this marker.

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
