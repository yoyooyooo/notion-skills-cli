# Current commands

Use the executable and scope supplied by the host. Command names and exact
flags come from `ntn-skills schema COMMAND...` or that command's help.
The public root is `list/read/use/files/export/schema/ctl`.

## Discovery and selection

```sh
ntn-skills list --library LIBRARY_ID --query TERMS --json
ntn-skills list --library LIBRARY_ID --cursor RETURNED_CURSOR --json
ntn-skills read EXACT_REF --library LIBRARY_ID --json
ntn-skills use EXACT_REF --library LIBRARY_ID
```

Keep the same query and selection when following a cursor. Names and aliases
may collide; use an exact returned ref or page ID with its known library.
Coverage failures cannot establish absence or uniqueness.

`read` inspects. `use` selects instructions and the complete Requires closure;
unselected Members remain lazy. Do not activate a workflow while merely
summarizing or editing its text.

## Files and export

```sh
ntn-skills files SNAPSHOT_ID
ntn-skills read RELATIVE_PATH --from 'CONTAINING_FILE_REF'
ntn-skills read SNAPSHOT_ID --path assets/image.png --output NEW_IMAGE
ntn-skills export SNAPSHOT_ID --output NEW_DIRECTORY_OR_ZIP
```

A selected ref preserves a complete local manifest. Keep it for subsequent
files instead of selecting by name again. Relative paths resolve from the
containing file, not always the root. Cross-Skill relative links need that file's
reliable current Source route and one exact contribution mapping. Otherwise use
an explicit stable Skill ref. Do not reconstruct repository siblings in the cache.
Pi exposes the same route through `read({path:RELATIVE_PATH, from:FIXED_FILE_REF})`;
use the actual containing `sr:S`, `sr:R` or fixed canonical File ref. An unfixed
candidate is not a valid base. This remains inspection, without Requires activation.

The inventory may include lazy Source/resource bytes. Acquire only the requested
file unless the task needs the complete export. Exact binary bytes and modes
are preserved; native files combine their stored frontmatter with normalized
current body text. Existing identical output is reused; differing output is
rejected. Reading/exporting scripts never executes them.

No arbitrary multiple-path export option is registered. Use single-file output
or a full export as appropriate. A local selection is not a remote historical
restore handle. If exact missing bytes cannot use an unchanged current declared
location, select current content again.

## Freshness and Views

`--refresh`, `--offline` and `--max-age` are mutually exclusive. Refresh
validates current native bodies; offline requires local selected bytes. A
fixed selection rejects refresh/max-age because those choose current content.
A valid current cache hit can use zero HTTP; metadata revalidation and actual
body reads have their own observable costs.

```sh
ntn-skills ctl views --library LIBRARY_ID
ntn-skills list --view VIEW_ID --library LIBRARY_ID
ntn-skills list --profile PROFILE_ID --library LIBRARY_ID
ntn-skills list --default-view
```

Views retain native API ordering and filters. Explicit View selection wins over
Profile rules. Profiles and Views do not grant access. For their management,
default to the same executable's `ctl builtin read notion/ntn-skills-sync`.
If the user explicitly selected a Notion workflow, inspect its exact source/ref
and apply it with `use REF --library LIBRARY_ID --json` or Pi `notion_use(ref)` to load
Requires unless already prepared. Inspect the edited target without activating it.

## Library inspection

```sh
ntn-skills ctl library inspect --library LIBRARY_ID
ntn-skills ctl library files PAGE_ID --library LIBRARY_ID
```

Inspect reads the descriptor; files reads complete current file metadata, state
and authority. Neither reads every body nor repairs the library. A missing
current descriptor or pending current operation remains an explicit error.

The current library family also provides `init`, `skill`, `import`, `members-plan`, `projection`,
`source` and singular `profile`. Use `ntn-skills-maintain` for daily
`skill create|update|register|remove`: native Markdown by default, partial updates,
body-preserving page registration and managed deletion cleanup. The CLI supplies
internal fields; repeated same-intent commands continue their own unfinished work.
That Skill also explains complete import and its explicit resume procedure.
Portable Members/Requires round-trip through
export and complete import; omitted fields preserve existing sets, [] clears, and
lists replace the complete relation. First import may discover omitted Members
from confirmed exact references. It never infers Requires. For a local sibling
link, use `members-plan` with explicit identity bindings; names and similar files
are not enough. Read the maintenance workflow's import procedure before preparing
a converted portable copy. Repeat --native PATH to select editable text during import.
Use `ntn-skills-sync` for explicit Git Source apply/refresh, contribution
mappings/exclusions and exact file takeover/restore-follow. Use
`ntn-skills-maintain` to generate missing daily Notion text through
`ctl library projection`; ordinary consumption never writes those bodies.

## Local builtins

```sh
ntn-skills ctl builtin list
ntn-skills ctl builtin read notion/ntn-skills
ntn-skills ctl builtin read notion/ntn-skills --path references/integration.md
ntn-skills ctl builtin read notion/ntn-skills-maintain
ntn-skills ctl builtin read notion/ntn-skills-sync
ntn-skills ctl builtin status
```

Use the task's executable and its bundled maintenance/sync guidance by default,
including with a connected library. These reads need no Notion request or copy.
Package guidance does not select a write target or authorize a write. Ordinary
business discovery still uses the selected Notion library.

An explicitly chosen Notion/team workflow keeps its exact source/ref and uses
the ordinary `read/use` routes, including `read --from` for its references.
Failed or partial discovery, pending content and denied access remain errors;
never silently substitute the package. Same names do not establish identity.
Optional native copies are user-owned editable Skills, not automatically
upgraded package installations or Source reading projections.

In a supporting Broker, an exact `@builtin` identity selects package content.
Local install/update is a separate requested action. Read its current help and
preserve unrelated host roots. Installing or upgrading a package does not refresh
its Notion Source, project reading pages, overwrite native copies or replace an
active task's selected content.

## Errors

Keep the exact error and scope. `CURRENT_SCHEMA_REQUIRED` means current
descriptors must be supplied by an explicit management action.
`CURRENT_OPERATION_PENDING` means current content is not ready. Missing
permission, bytes, complete pagination or identity must not fall back to a
same-name local workflow or a newer source revision.

Use [diagnosis](integration.md#diagnose-discovery-and-loading) for a real loading
problem. Do not clear caches, change identity or execute a content operation
just to make a read succeed.
