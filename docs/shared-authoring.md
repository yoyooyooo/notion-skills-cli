# Maintain current Notion Skills

This guide uses the current Skills, Files, Sources, and Records contract.
The main file lives on its Skill page. Every supporting path has its own Files row.
The [current library contract](current-contract.md) owns the field definitions and authority rules.

## Inspect or initialize a library

Inspect the exact Skills database entry:

```bash
ntn-skills ctl library inspect LIBRARY_ENTRY
```

To create a new library under an owned parent:

```bash
ntn-skills ctl library init --parent PARENT_PAGE_ID
```

Use the returned `library.skills.database_id` as the entry.
Initialization creates the current tables and descriptor. It does not convert an existing library.
For an existing current entry, `ctl library init --entry LIBRARY_ENTRY` validates that entry.

Keep registered database, data-source, and property identities intact.
A similar table name does not make another table part of the library.
Live table cleanup remains a separate cutover task.

## Prepare the entire replacement tree

Use one directory or ZIP containing root `SKILL.md`.
Every path in that input becomes part of the desired current tree, including hidden authored files.
Use `--name` and `--description` only when you intend to override Notion discovery metadata.
Those overrides do not rewrite the original file bytes.

The import boundary also accepts one explicitly selected Markdown file, which becomes `SKILL.md`.
The result reports `renamed_entrypoint_from` when that changes its filename.
A multi-file input must already use the canonical entrypoint.

Current portable manifest version 2 can select a Skill, Router, or Prompt.
The canonical entrypoints are `SKILL.md`, `ROUTER.md`, and `PROMPT.md`.
Portable Members/Requires accept unpinned `shared_skill` refs from the same library.
An omitted field preserves its current set, `[]` clears it, and a list replaces it.
Export includes both complete sets, so editing and reimporting that manifest keeps
the intended relations. Prompt inputs reject relations. Projection/materialization
and unknown manifest fields are refused rather than discarded.

Every target must resolve to one enabled ready Skill in the registered Skills data
source. The relation properties must be single_property. A changed set can contain
at most 100 targets; larger unchanged sets are verified and retained. Changed
Requires must have an acyclic reachable dependency closure. Names, page URLs,
foreign libraries, pins, duplicates and self-references are not accepted.

Keep the full input within 128 MiB and 10,000 entries.
The compressed ZIP input limit is 138 MiB.
Symbolic links, symbolic-link ancestors, unsafe paths, and a tree that changes during loading are refused.
Use the resolved physical path when a platform directory is itself a symbolic link.
All local Markdown links must resolve inside the complete input. Update inbound links when
deleting or moving their targets; an unresolved target is rejected before Notion access.

## Review the current replacement

Select the exact stable Skill ID within the intended library:

```bash
ntn-skills ctl library import ./my-skill --entry LIBRARY_ENTRY --skill-id my-skill --dry-run
```

Review `input_sha256`, `metadata`, `files`, `relations`, `remove`, and `budget`.
The dry run reports `replaces_complete_tree: true` and `remote_writes: 0`.
It allocates no operation ID.

Existing Notion-owned supporting files omitted from the input are removed.
Import does not interpret a small directory as a partial patch.
Use a complete export or your complete local Skill directory as the starting input.

Check the returned authority before preparing a replacement. If the current main
or any supporting file has Source authority, this CLI's dry-run and apply return
`CURRENT_SOURCE_MANAGEMENT_REQUIRED`. The CLI makes every input file a resource,
so even an unchanged export would take over those Source files. Keep their current
identities, paths and bindings; coordinated Source contribution management is not
available through this import. Do not omit or reidentify them to force the write.

Dry run inspects the admitted input and current index.
Its `body_verification: "required_during_apply"` means that body checks still occur during apply.
A matching metadata summary does not prove an unchanged complete tree.

## Apply the import

Use a stable operation ID that you can retain with the input:

```bash
ntn-skills ctl library import ./my-skill --entry LIBRARY_ENTRY --skill-id my-skill --operation import-my-skill
```

Without `--operation`, the CLI generates an ID for apply.
Import creates the selected Skill if it is absent or replaces that Skill's complete file tree.
It preserves the existing content kind. A different kind requires a different target.

The CLI currently imports every file as an exact Notion resource.
Paths, original bytes, and executable modes remain part of the file identity.
The writer creates the main-page and supporting-page reading projections, then verifies the current tree.
It cleans obsolete resources owned by an admitted replacement after the new bindings are established.

For a new Skill, Enabled defaults to true and Default Context defaults to false.
Replacing an existing Skill preserves those fields because the import CLI does not expose overrides.
Name and Description come from the input metadata or explicit overrides.

A successful result has `state: "ready"` and `status: "applied"` or `"unchanged"`.
It also returns the operation ID, page ID, input hash, current file/relationship
results and the exact library/database/data-source binding.

All remote work shares one invocation budget, including library lookup, retries,
relationship validation, uploads, projection and cleanup. Defaults are 1000 HTTP
attempts, 512 MiB payload bytes and 600000 ms. Override with positive integer
`--max-requests`, `--max-bytes`, and `--timeout` in ms. Inspect the reported usage.
An admitted response may exceed the byte limit; the next request is refused.
Exhaustion preserves any unfinished intent. Resume the same input explicitly
with a fresh invocation budget; do not create a replacement operation.

## Read the projection and exact original

Open the resulting Skill page and follow its Supporting Files relation.
Readable UTF-8 files receive complete text projections.
Markdown uses supported Notion blocks; constructs outside that rendering subset remain visible as code.
Opaque files have an original usable attachment.
Formats that need a ZIP carrier use one ZIP containing that single original file.

The `Content` descriptor determines where the authoritative bytes live.
Editing a generated resource or Source projection does not change those bytes or transfer authority.
For an existing native file, its Notion author body remains editable under the native descriptor.
The import CLI does not expose a native-authority switch.

Check the current index and selected bytes:

```bash
ntn-skills ctl library files SKILL_PAGE_ID --entry LIBRARY_ENTRY
ntn-skills read SKILL_PAGE_ID --database LIBRARY_ENTRY --refresh
ntn-skills files SKILL_PAGE_ID --database LIBRARY_ENTRY
ntn-skills export SKILL_PAGE_ID --database LIBRARY_ENTRY --output ./verified-skill.zip
```

If the Skill is disabled, inspect its management index first.
Ordinary reads continue to enforce Enabled.
A successful export verifies the selected file tree's bytes, not the completeness of unrelated library cleanup.

## Resume the same operation

After interruption, retain the input directory, local state, credential selection, and operation ID.
Resume the exact input against the exact library and Skill:

```bash
ntn-skills ctl library import ./my-skill --entry LIBRARY_ENTRY --skill-id my-skill --operation import-my-skill --resume
```

`--resume` requires `--operation` and cannot combine with `--dry-run`.
Resume reconciles the original intent before continuing.
A request whose remote effect remains unknown is not replayed automatically.
An empty query result does not prove that a timed-out create never happened.

The Skill remains `applying` or `attention` while its operation is unfinished.
Ordinary readers stop before acquiring its content.
Do not change the operation ID or erase local pending state to bypass that condition.
There is no separate acknowledgement, repair, or finalize command for import.

## Replace current Profile rules

Read the current fingerprint:

```bash
ntn-skills ctl library profile show daily --entry LIBRARY_ENTRY
```

For a new Profile:

```bash
ntn-skills ctl library profile set daily --entry LIBRARY_ENTRY --name Daily --enabled true --expect new
```

For an existing Profile, replace `new` with the exact fingerprint returned by `show`.
Supply the complete intended rules. Omitting `--default-view` or `--freshness-json` removes that prior rule.

A freshness rule can set Profile defaults and overrides keyed by stable Skill ID:

```bash
ntn-skills ctl library profile set daily --entry LIBRARY_ENTRY --name Daily --enabled true --expect CURRENT_FINGERPRINT --freshness-json '{"default":{"read_max_age_ms":300000},"skills":[{"skill_id":"my-skill","read_max_age_ms":60000}]}'
ntn-skills ctl library profile freshness daily --entry LIBRARY_ENTRY --skill my-skill
```

Explicit read age takes precedence over a Skill override, then the Profile default, then the product default.
Longer cache age delays the visibility of changes. It does not extend independent eligibility or full-body checks.

Unchanged Profile rules cause no write.
After an uncertain Profile write, repeat the same full intent with `--reconcile` to inspect the result.
Profile reconciliation does not repeat POST or PATCH.
The fingerprint detects observed conflicts; it is not a distributed compare-and-swap.

Bind or remove the machine's selection:

```bash
ntn-skills ctl library profile bind daily --entry LIBRARY_ENTRY
ntn-skills ctl library profile unbind
```

Binding stores only the library entry and Profile ID locally.
Unbinding leaves the shared Profile unchanged.

## Remaining management work

The current reader supports native, resource, and selected Source descriptors.
The CLI exposes complete resource imports and current Profile changes.

Source refresh and contribution updates, Pro-wide local Skill census and batch migration,
and governance across related objects still need their current management entrypoints.
The selected-owner file index is not a global orphan census.
The live Notion tables and Pro Pi runtime have not been certified as converted by these local checks.

Track those boundaries in the [current contract](current-contract.md).
Do not substitute an older publication or synchronization workflow for a missing current command.
