# Operations and recovery

## Operation choices

| Intent | Command | Result |
| --- | --- | --- |
| New item | `create INPUT --database LIBRARY` | A new page; an existing name is a conflict |
| One edit of existing body, resources and properties | `apply PINNED_MAIN_REF --input CHANGES --description TEXT` | Shared targets use a frozen sequential batch; earlier publication targets retain their own protocol |
| One selected file | `write PINNED_FILE_REF --input FILE` | Preserve every other file and page property |
| Properties only | `update PINNED_MAIN_REF --name NAME --description TEXT` | Change only the specified allowed properties |
| Deliberately replace the entire file set | `replace INPUT --target PINNED_MAIN_REF` | Preserve page identity and replace the included file set |
| Portable copy | `export PINNED_MAIN_REF --output NEW_DIRECTORY_OR_ZIP` | Export the chosen fixed version without changing Notion |

`apply` accepts a changes directory, ZIP or Markdown file. Paths are rooted at the Skill, including `references/` and other nested directories. A single Markdown file uses its basename. Preserve the original main path and kind when supplying a portable manifest. A path cannot be both changed and removed; the main file and reserved portability files cannot be deleted. Full replacement is a deliberate different operation: omitted supporting files leave the Skill's inclusion set.

Use exact page IDs/URLs or returned refs. Names and aliases can collide; incomplete discovery does not establish uniqueness. The creation database is explicit `--database`, the configured default, or the only discovered library. An existing target keeps its database.

## Shared file lifecycle

Use the exact Skill page ID and library entry for each individual operation:

```bash
ntn-skills ctl library file add SKILL_PAGE_ID references/new.md --entry LIBRARY_ENTRY --input ./new.md
ntn-skills ctl library file move SKILL_PAGE_ID references/old.md references/new.md --entry LIBRARY_ENTRY
ntn-skills ctl library file delete SKILL_PAGE_ID references/obsolete.md --entry LIBRARY_ENTRY
ntn-skills ctl library file restore-follow SKILL_PAGE_ID references/checklist.md --entry LIBRARY_ENTRY
```

Each supports `--dry-run`. Add creates a File identity; move keeps the File ID, native page and fixed-source path; delete retains a tombstone and the old page/body. Complete-tree relative references must remain valid, and move does not rewrite links. Main files cannot be moved or deleted. Restore-follow retains the complete custom body before restoring the exact currently selected source; a moved file uses its old source path. It never advances a commit. Local source bytes require an explicit machine/workspace binding plus `--allow-local-archive` to retain that selected body in shared records.

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
| Shared add/delete/move is unknown | `ctl library file reconcile SKILL_PAGE_ID OPERATION_ID --entry LIBRARY_ENTRY` |
| Partial or unknown legacy Publication | Follow its returned `operation show`/`reconcile`/`resume` action on the original Publication ID |
| Missing access, invalid paths or unsupported content | Fix the actual input/access issue before retrying |
| Output path conflict | Choose a new destination or review the owned previous output |

Shared operation IDs are not accepted by legacy `operation resume`. Do not replay a create, remove state, change frozen input or add acceptance/proof steps to routine edits. Historical migration/repair commands live in the separate operator tool and are for an explicitly diagnosed maintenance task.

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
