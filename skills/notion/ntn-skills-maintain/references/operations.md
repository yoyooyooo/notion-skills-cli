# Operations and recovery

## Operation choices

| Intent | Command | Result |
| --- | --- | --- |
| New item | `create INPUT --database LIBRARY` | A new page; an existing name is a conflict |
| One edit of body, resources and properties | `apply PINNED_MAIN_REF --input CHANGES --remove PATH` | Merge specified files/properties and explicit deletions in one publication |
| One selected file | `write PINNED_FILE_REF --input FILE` | Preserve every other file and page property |
| Properties only | `apply PINNED_MAIN_REF --name NAME --description TEXT --default-context true` | Change only the specified allowed properties |
| Deliberately replace the entire file set | `replace INPUT --target PINNED_MAIN_REF` | Preserve page identity and replace the included file set |
| Portable copy | `export PINNED_MAIN_REF --output NEW_DIRECTORY_OR_ZIP` | Export the chosen fixed version without changing Notion |

`apply` accepts a changes directory, ZIP or Markdown file. Paths are rooted at the Skill, including `references/` and other nested directories. A single Markdown file uses its basename. Preserve the original main path and kind when supplying a portable manifest. A path cannot be both changed and removed; the main file and reserved portability files cannot be deleted. Full replacement is a deliberate different operation: omitted supporting files leave the Skill's inclusion set.

Use exact page IDs/URLs or returned refs. Names and aliases can collide; incomplete discovery does not establish uniqueness. The creation database is explicit `--database`, the configured default, or the only discovered library. An existing target keeps its database.

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

Native rendered storage is the ordinary path. Supporting Markdown is included through References with relative paths; optional Files preserves source bytes and non-Markdown resources. Page-only storage supports Markdown and its documented normalization. Preserve scripts, binary assets, link destinations, code and authored structure; do not discard them to make verification pass. Reading an included script does not execute it.

`markdown_files` is an explicit text-only storage choice through create/replace. Existing editable-file items keep that choice during apply. Binary assets require native Files storage. Editable code files require LF line endings. A storage error calls for a compatible target or a deliberate content decision, not silent conversion to another representation.

Router `--member` selects the complete Members relation using exact current Skill identities from the same database. `--clear-members` clears it; omission preserves it. Members and authored Router instructions remain distinct. Default Context is an ordinary checkbox available to Notion Views, not a second host-selection rule.

## Current reads and ownership

Current `read --refresh` verifies a complete stable Notion graph. It can read human edits independently of the previous publication's intended bytes. A writing/incomplete publication remains blocked; pinned reads stay fixed and offline. Source-link projection is optional: an unavailable or incompatible upstream map cannot make current member files unreadable. Cross-member resolution requires a valid map and must not invent targets.

Tracked content is owned by its upstream source. Ordinary body/resource/Name/Description edits require a personal fork first. Current readability, a title match or a committed marker does not transfer ownership. Organization-only changes preserve the authored content; later synchronization still detects a divergent tracked edit.

Source Type and Builtin ID record origin separately from Sync Mode. Ordinary edits preserve origin. Use package publication to create/update a package copy; use upstream synchronization for source-managed content. Do not infer origin from a display name or an empty relation.

## Original-operation recovery

Commands emit one JSON result. Help/version/schema are offline; operational failures are structured. A successful mutation already verifies content and metadata readback. Keep its returned page/ref/operation result, and investigate further only for a discrepancy or an explicit audit.

| Result | Next action |
| --- | --- |
| `WRITE_CONFLICT` | Read the current exact item and merge the intended change into a fresh pinned edit |
| `UPSTREAM_CONTENT_READ_ONLY` | Edit the source or explicitly fork the selected member |
| Partial or unknown publication | `operation resume OPERATION_ID` continues the frozen input and original page identities |
| Unresolved original write | `operation show` or `operation reconcile` identifies what is still unknown; preserve it and report the blocker |
| Missing access, invalid paths or unsupported content | Fix the actual input/access issue before retrying |
| Output path conflict | Choose a new destination or review the owned previous output |

Do not replay a create, remove state, change frozen input or add acceptance/proof steps to routine edits. Historical migration/repair commands live in the separate operator tool and are for an explicitly diagnosed maintenance task.

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
