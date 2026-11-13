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
| One non-document resource | `ctl resource add/replace PAGE_ID PATH --entry LIBRARY --input FILE` | Exact bytes and executable mode; no resource execution |
| Complete reviewed local import | `ctl library inventory prepare-import/apply-import/reconcile-import` | One approved complete inventory entity and its original create operation |
| Fixed shared snapshot copy | `export PINNED_MAIN_REF --projection snapshot --output NEW_DIRECTORY_OR_ZIP` | Export the chosen complete read view without changing Notion |

`apply` accepts a changes directory, ZIP or Markdown file. Paths are rooted at the Skill, including `references/` and other nested directories. A single Markdown file uses its basename. Preserve the original main path and kind when supplying a portable manifest. A path cannot be both changed and removed; the main file and reserved portability files cannot be deleted. Full replacement is a deliberate different operation: omitted supporting files leave the Skill's inclusion set.

Use exact page IDs/URLs or returned refs. Names and aliases can collide; incomplete discovery does not establish uniqueness. The creation database is explicit `--database`, the configured default, or the only discovered library. An existing target keeps its database.

For a shared Skill, select `export --projection snapshot` explicitly. The default source projection belongs to the earlier authored-publication format and rejects shared Skills. Exported snapshot files are consumption output; editing them does not submit a change. Select the intended complete files as explicit `write` or sparse `apply` input against a fresh author pin.

## Initial native draft adoption

Adopt requires an exact original page with complete valid Name/Description, Kind=skill and Enabled=false. Skill ID/Main File ID/Source/Projection/References and managed relations must be empty, and no Files or Records lifecycle may already belong to it. It anchors deterministic Skill and main File identities to the library and original page, retains the complete main body and initial adopted event, and changes only the two identity properties. It sends no body PATCH and creates no Skills/Files page. `--dry-run` makes no remote writes.

An unregistered disabled page can remain under human construction without blocking the consumer catalog. It is not an active Skill or proof of a history-free draft. Existing bindings or Records require their original workflow, not a replacement identity. Repeat adoption only reconciles its original retained outcome; `verification=original_adoption_outcome` and `enabled_at_adoption` are historical facts. Use the returned fresh authoring read before further edits or activation.

## Shared file lifecycle

Use the exact Skill page ID and library entry for each individual operation:

```bash
ntn-skills ctl file add SKILL_PAGE_ID references/new.md --entry LIBRARY_ENTRY --input ./new.md
ntn-skills ctl file move SKILL_PAGE_ID references/old.md references/new.md --entry LIBRARY_ENTRY
ntn-skills ctl file delete SKILL_PAGE_ID references/obsolete.md --entry LIBRARY_ENTRY
ntn-skills ctl file restore-follow SKILL_PAGE_ID references/checklist.md --entry LIBRARY_ENTRY
```

Each supports `--dry-run`. Add creates a File identity; move keeps the File ID, native page and fixed-source path; delete retains a tombstone and the old page/body. Complete-tree relative references must remain valid, and move does not rewrite links. Main files cannot be moved or deleted. Restore-follow retains the complete custom body before restoring the exact currently selected source; a moved file uses its old source path. It never advances a commit. Local source bytes require an explicit machine/workspace binding plus `--allow-local-archive` to retain that selected body in shared records.

For a reference visible from the original Notion Skill, obtain a fresh `read PAGE_ID --authoring` after add, then write the complete main file with a descriptive link to the new logical path, for example `[Checklist](references/new.md)`. Do not reuse the pre-add pin: the file inventory changed. Write restores relative destinations using only the fresh selected owner's exact native File bindings, so existing and new links stay clickable in Notion; a subsequent read renders the same fixed resource paths. The returned `page_id` also supports an explicit native URL. The file lives in the related flat Files table; this workflow does not create or enumerate physical child pages. Add alone does not edit the main body. Submitting the unchanged complete read result performs no body PATCH or new Records publication merely to normalize URL spelling.

Shared `apply` can submit added or edited native UTF-8 files, explicit moves/removals/revivals and nominated metadata in one frozen, non-atomic parent operation. Use `--input` for added or edited files, repeatable `--remove` for deletions, and `--changes` for the version 1 manifest. Omitted files and properties remain unchanged. The complete proposed tree is checked before dispatch. A later failure can leave earlier verified children applied; preserve the original operation and follow its returned recovery action. Unknown children are not replayed. `replace` preserves the original kind, but still rejects mixed or multiple deletions inferred from omitted files with `SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED`; express those changes through explicit `apply` input and layout instructions.

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

In a shared library, ordinary Skill folders with `SKILL.md` need no hand-authored manifest. Native creation freezes every UTF-8 input and leaves the new Skill disabled until the complete body set verifies. Ordinary creation rejects unsupported input before page creation. Complete reviewed inventory imports and Source admissions additionally retain non-document resources through the same create journal. Use the inventory workflow for one approved full manifest, and `ctl resource` for a later explicit resource edit. Omit `--storage` for the shared path. Shared main frontmatter must match current native Name/Description or values explicitly nominated in the same apply, and `notion_page_id` must match the selected Skill. Extra unsupported main fields are rejected. Native authoring normalizes CRLF to LF and terminal line feeds before exact candidate verification.

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
| Shared body/metadata write or restore-follow is unknown | Read the exact current Skill; obey `read_again` after original facts settle, and retain missing original facts as unresolved |
| Shared apply is incomplete | Inspect its original ID with `ctl operation show ORIGINAL --target PAGE --entry ENTRY`; use `reconcile` for read-only outcome verification. Explicit `resume` is limited to a verified prefix and proved-unsent suffix under the original local journal; unknown children stop it |
| Restore request stopped before final feedback | `ctl file request TARGET PATH --entry ENTRY --reconcile`; for an older processing receipt missing its ID, add `--operation ORIGINAL` after inspecting the exact original through `ctl library state`. Preview with `--dry-run`; no body write is repeated. A verified `ORIGINAL_NOT_APPLIED` requires explicit new `--submit` before processing |
| Shared create is unknown | Keep the same complete input and original intent; its retry reconciles original creation identities without blindly repeating POSTs |
| Known ordinary native body mismatch, with the same original main explicitly restored to its exact candidate | `ctl library create recovery review ORIGINAL_PLAN --entry LIBRARY --target ORIGINAL_MAIN --output REVIEW`; inspect the digest, then `recovery apply ORIGINAL_PLAN --entry LIBRARY --review REVIEW --review-id ID [--dry-run]` |
| Initial draft adoption is unknown | Preserve `adoption_operation_id` and use the returned `adopt PAGE_ID --database LIBRARY --reconcile`; no current equality or absent record authorizes a replay |
| Shared add/delete/move is unknown | `ctl file reconcile SKILL_PAGE_ID OPERATION_ID --entry LIBRARY_ENTRY` |
| An original operation from another retained protocol | Follow its exact returned recovery action and original ID; do not translate it into a new create |
| Missing access, invalid paths or unsupported content | Fix the actual input/access issue before retrying |
| Output path conflict | Choose a new destination or review the owned previous output |

Shared operation IDs have one `ctl operation show/reconcile` entry. Only an original apply supports explicit `resume` of its proved-unsent suffix; other families return their own guarded recovery action. Do not replay a create, remove state, change frozen input or add acceptance/proof steps to routine edits. Historical migration/repair commands live in the separate operator tool and are for an explicitly diagnosed maintenance task.

If an original body write remains unresolved, keep its original plan, response and current complete-body observation. A later matching body or visible file event does not supply a missing original completion. When the returned recovery action permits an explicit current-body decision, inspect the exact full observation and use `ctl file accept-current SKILL_PAGE_ID ORIGINAL_OPERATION --entry LIBRARY_ENTRY --accept-observed-sha256 EXACT_HASH --dry-run` before submitting that same decision. This retains an independent acceptance; it does not repeat the body PATCH or change the original unknown outcome into applied. Follow a returned `read_again` with a new current read before authoring again.

The exact-restoration route requires the original Store, one original main allocation, full original request/ACK set, unchanged metadata/relations and exact complete current Markdown. It never normalizes away an automatic link or patches an existing body. It retains a separate completion while preserving the original `needs_review` outcome. Independent `ctl library create recovery reconcile ORIGINAL_PLAN --entry LIBRARY --target ORIGINAL_MAIN` proves that historical chain; read current content afterward. Inventory and fixed-source plans keep their own recovery routes.

For an ordinary native file add with the exact retained `SHARED_FILE_MANAGEMENT_BODY_MISMATCH` outcome, a separate current-file acceptance is available after the author explicitly repairs that same bound page to its frozen candidate. Preserve the original plan, Store and failure. This narrow path requires the complete unchanged native tree, exact owner/File/page bindings and event frontier; unknown or invalid page responses are ineligible. Inspect the complete current Markdown and select its SHA-256, then save and inspect the review:

```sh
ntn-skills ctl file accept-add review SKILL_PAGE_ID ORIGINAL_OPERATION --entry LIBRARY_ENTRY --accept-observed-sha256 EXACT_HASH --output REVIEW
ntn-skills ctl file accept-add apply REVIEW --entry LIBRARY_ENTRY --review-id REVIEW_ID --dry-run
ntn-skills ctl file accept-add apply REVIEW --entry LIBRARY_ENTRY --review-id REVIEW_ID
ntn-skills ctl file accept-add reconcile SKILL_PAGE_ID ORIGINAL_OPERATION --entry LIBRARY_ENTRY
```

The default review still requires the exact frozen candidate. When intentionally retaining the actual complete observation instead, add `--accept-current` to `review` together with its exact `--accept-observed-sha256`. The separate review, retained observed body, adopted event and completion do not change the original failure. This permits a subsequent ordinary `write` to correct a known wrong link without recreating the page. The operator must inspect the actual content; the flag is not automatic approval or an unknown-create retry.

These commands emit JSON and request metrics without extra output flags. Acceptance writes only its complete review, a new adopted event and its own completion. It never creates or patches a native page, emits the old add event, or supplies a missing original request/ACK. The old add remains `needs_review` with unproven completion. Repeated completed acceptance and reconciliation are read-only; unknown new Record dispatches cannot be replayed. Obtain a fresh current read afterward; it may first report `read_again` while retiring a derived local barrier. Source-backed files and changed trees keep their existing author workflows. A relative link changed into an HTTPS link is a real content change and must not be normalized into equality.

### Reserved creation markers on older pages

An older publication reference page may start with `ntn-skills-create:v1:…`. That reserved paragraph records the original creation identity, parent, logical path and input commitment so interrupted creation can identify the same page. A child page lacks the database property slots used by a publication root, so this older protocol carries its identity in the first physical block. Valid consumer reads exclude it from authored content, and that protocol's writers preserve it. Do not delete, relocate or re-encode it for appearance: current page visibility alone cannot replace its original recovery evidence. Current shared native Skills/Files use registered properties and immutable Records; adding a reference through `ctl file add` does not require manually creating this marker.

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
