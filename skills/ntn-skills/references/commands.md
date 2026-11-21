# Current commands

Use the executable and scope supplied by the host. Command names and exact
flags come from `ntn-skills schema COMMAND...` or that command's help.
The public root is `list/read/use/files/export/schema/ctl`.

## Discovery and selection

```sh
ntn-skills list --database ENTRY --query TERMS --json
ntn-skills list --database ENTRY --cursor RETURNED_CURSOR --json
ntn-skills read EXACT_REF --database ENTRY --json
ntn-skills use EXACT_REF --database ENTRY
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
containing file, not always the root. A cross-root link needs an explicit
current Skill ref.

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
ntn-skills ctl views --database ENTRY
ntn-skills list --view VIEW_ID --database ENTRY
ntn-skills list --profile PROFILE_ID --database ENTRY
ntn-skills list --default-view
```

Views retain native API ordering and filters. Explicit View selection wins over
Profile rules. Profiles and Views do not grant access. Discover `ntn-skills-sync`
in the connected library to change shared rules, then read its exact returned ref.

## Library inspection

```sh
ntn-skills ctl library inspect ENTRY
ntn-skills ctl library files PAGE_ID --entry ENTRY
```

Inspect reads the descriptor; files reads complete current file metadata, state
and authority. Neither reads every body nor repairs the library. A missing
current descriptor or pending current operation remains an explicit error.

The current library family also provides `init`, `skill`, `import`, `projection`,
`source` and singular `profile`. Use `ntn-skills-maintain` for daily
`skill create|update|register|remove`: native Markdown by default, partial updates,
body-preserving page registration and managed deletion cleanup. The CLI supplies
internal fields; repeated same-intent commands continue their own unfinished work.
That Skill also explains complete import and its explicit resume procedure.
Portable Members/Requires round-trip through
export and complete import; omitted fields preserve, [] clears, and lists replace
the complete relation. Repeat --native PATH to select editable text during import.
Use `ntn-skills-sync` for explicit Git Source apply/refresh, contribution
mappings/exclusions and exact file takeover/restore-follow. Use
`ntn-skills-maintain` to generate missing daily Notion text through
`ctl library projection`; ordinary consumption never writes those bodies.

## Local builtins

```sh
ntn-skills ctl builtin list
ntn-skills ctl builtin read notion/ntn-skills
ntn-skills ctl builtin read notion/ntn-skills --path references/integration.md
ntn-skills ctl builtin status
```

Use these commands without a connected library or for explicit offline/package
inspection. A connected library's projected copies use the ordinary scoped
`list/read` commands above, including `read --from` for references. Keep failed or
partial discovery visible; it does not prove that a projected workflow is absent.

In a supporting Broker, an exact `@builtin` identity selects package content.
Local install/update is a separate requested action. Read its current help and
preserve unrelated host roots. Installing or upgrading a package does not refresh
its Notion Source, project reading pages or replace an active selection.

## Errors

Keep the exact error and scope. `CURRENT_SCHEMA_REQUIRED` means current
descriptors must be supplied by an explicit management action.
`CURRENT_OPERATION_PENDING` means current content is not ready. Missing
permission, bytes, complete pagination or identity must not fall back to a
same-name local workflow or a newer source revision.

Use [diagnosis](integration.md#diagnose-discovery-and-loading) for a real loading
problem. Do not clear caches, change identity or execute a content operation
just to make a read succeed.
