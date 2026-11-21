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
`CURRENT_SOURCE_MANAGEMENT_REQUIRED`. Import selects resource or native authority,
so even an unchanged export would take over those Source files. Keep their current
identities, paths and bindings; use Source apply/refresh for their contributions.
Do not omit or reidentify them to force an import.

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

The CLI defaults every file to an exact Notion resource. To make selected text
editable in Notion, repeat `--native` with exact canonical input paths:

```bash
ntn-skills ctl library import ./my-skill --entry LIBRARY_ENTRY --skill-id my-skill --native SKILL.md --native references/guide.md
```

Native selection is explicit and enters the input fingerprint. Unknown, duplicate
or noncanonical paths are rejected before network access. Select `SKILL.md` after
the single-Markdown entrypoint rename. The body must be valid UTF-8 with LF line
endings; the stored frontmatter and regular executable mode remain exact. Invalid
text is rejected, never silently normalized. Native transport is checked by an
actual round trip; an unconfirmed write leaves the intent unfinished. Keep exact
resources for byte formats the native body cannot preserve.

Paths, original resource bytes, and executable modes remain part of file identity.
The writer verifies the complete current tree and authoritative bytes. Run the explicit projection command below for generated main-page and supporting-page reading bodies; those bodies do not block content readiness.
It cleans obsolete resources owned by an admitted replacement after the new bindings are established.

For a new Skill, Enabled defaults to true and Default Context defaults to false.
Replacing an existing Skill preserves those fields because the import CLI does not expose overrides.
Name and Description come from the input metadata or explicit overrides.

A successful result has `state: "ready"` and `status: "applied"` or `"unchanged"`.
It also returns the operation ID, page ID, input hash, current file/relationship
results and the exact library/database/data-source binding.

All remote work shares one invocation budget, including library lookup, retries,
relationship validation, uploads, native bodies and cleanup. Defaults are 1000 HTTP
attempts, 512 MiB payload bytes and 600000 ms. Override with positive integer
`--max-requests`, `--max-bytes`, and `--timeout` in ms. Inspect the reported usage.
An admitted response may exceed the byte limit; the next request is refused.
Exhaustion preserves any unfinished intent. Resume the same input explicitly
with a fresh invocation budget; do not create a replacement operation.

## Generate readable text in Notion

After import or Source apply/refresh, inspect and generate the current text:

```bash
ntn-skills ctl library projection SKILL_PAGE_ID --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library projection SKILL_PAGE_ID --entry LIBRARY_ENTRY
ntn-skills ctl library projection --daily --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library projection --daily --entry LIBRARY_ENTRY
```

Open the resulting Skill page and follow Supporting Files. The main body belongs
on Skills and each text supporting body on its existing Files page. The same
renderer writes complete Markdown or code text from verified current originals,
then reads the actual result back. An equal complete projection is a zero-write
no-op. A link, hash, truncated excerpt or local cache path is not a text body.
Non-text files, including images and fonts, are reported as skipped; their exact
original acquisition remains available without generating a Notion body.

`--daily` selects current members of Sources marked 日用, Skills marked 日用 and
Default Context. It validates the checkbox schema and complete pagination and
uses current contributions rather than Origin navigation. It reports Enabled
and 期望删除 without changing them. Daily text coverage includes disabled choices;
missing current metadata or unavailable bytes must be reported, not hidden.

Each Skill uses one finite projection intent through the existing operation
kernel. That intent changes generated bodies only. The real Skill remains ready
for ordinary consumption, including after projection failure. Native author
bodies are verified without replacement. The command does not change content
authority, source membership, file identities or human policies.

Resume an interrupted single-Skill intent with the returned exact operation:

```bash
ntn-skills ctl library projection SKILL_PAGE_ID --entry LIBRARY_ENTRY --operation PROJECTION_ID --resume
```

Keep its original state and credential scope. A daily run executes Skills in
order and stops on failure, reporting completed and remaining targets plus the
exact single-Skill recovery command. Resume that intent first, then rerun daily;
already-complete bodies require no semantic writes. `--daily` cannot combine
with `--operation` or `--resume`; projection has no supersede mode. Unknown
append outcomes are reconciled, not blindly replayed.

The whole invocation shares 1000 HTTP attempts, 512 MiB payload bytes and
600000 ms by default, including daily selection, original acquisition, generated
body writes and readback. `--max-requests`, `--max-bytes` and `--timeout` accept
positive explicit limits; nested Skills cannot reset them. Content sync and
projection are explicit separate commands. Ordinary consumption stays read-only.

The `Content` descriptor continues to determine where the authoritative bytes live.
Editing a generated resource or Source projection does not change those bytes or transfer authority.
For an existing native file, its Notion author body remains editable under the native descriptor.
An explicit `--native PATH` selects this editable representation. Reimporting a
local native file replaces its current body, including intervening human edits.
Export the current content first when those edits belong in the intended input.

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
Resume the exact input and original `--native` selections against the exact library and Skill:

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

## Apply or refresh a Git Source

Use one complete JSON declaration for a regular Git repository on GitHub or a credential-free HTTP(S) Git origin using local machine authentication. Every discovered selected member is included. Contributions preserve explicit stable identities; newly discovered members receive deterministic identities from the Source ID and member path. This example preserves two existing identities:

```json
{
  "version": 1,
  "definition": {
    "version": 1,
    "source_id": "team-skills",
    "name": "Team skills",
    "description": "Current team workflows",
    "enabled": true,
    "policy": "manual",
    "adapter": { "type": "git", "url": "https://github.com/OWNER/REPO", "ref": "main" },
    "selection": { "roots": ["skills"], "include": [], "exclude": [], "mapping": {} },
    "options": {}
  },
  "contributions": [
    { "member_key": "skills/alpha", "skill_id": "alpha", "mount_path": "", "mapping": {}, "exclude": [] },
    { "member_key": "skills/beta", "skill_id": "beta", "mount_path": "", "mapping": {}, "exclude": [] }
  ]
}
```

Replace the repository and member paths with the intended source. The input must
be one regular UTF-8 JSON file of at most 512 KiB. Unknown fields, providers,
transformations, symbolic links and retained-resource mode are rejected. Use
`manual`, or `pinned` with an exact commit; automatic refresh is not implemented.

```bash
ntn-skills ctl library source apply ./source.json --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library source apply ./source.json --entry LIBRARY_ENTRY --operation update-team
ntn-skills ctl library source refresh team-skills --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library source refresh team-skills --entry LIBRARY_ENTRY
```

Save the declaration outside Notion. Apply creates, rebuilds or replaces that Source's current configuration and contributions, including when the Source or its Skill pages were deleted.
Refresh reads the same declaration from Notion and uses the same writer. Dry run
acquires the selected Git files and inspects the complete affected directories;
it performs zero semantic Notion writes. It does not establish that projections
already match. Check the returned target actions and removals before applying.

`Selection.include/exclude` selects member roots. Contribution `mapping` and
`exclude` use exact member-relative file paths, not globs. The effective path is
`mount_path` plus the mapped path. An exclusion persists when that upstream file
is absent, so a later refresh cannot resurrect it. Mapping changes preserve the
existing File ID and page when the original Source path remains the same.
One member may contribute to several Skills; duplicate member/Skill assignments
and colliding effective paths are rejected.

An explicit desired Source path replaces matching native or resource content, retaining its stable File identity; dry-run reports this authority replacement. Excluded paths and unrelated native content remain current. Another Source cannot be overwritten. Existing Skill management metadata is preserved; new targets use discovered names and descriptions as create-only defaults. Exclude the incoming `SKILL.md` when the existing main should remain.

A pure Source member deleted upstream is retired with its Files. A complete empty upstream selection retires all pure Source members; provider failure or incomplete discovery never authorizes deletion. If removing a member would leave unrelated authored content without a main, the writer requires an explicit ownership decision. Paths, bytes and executable modes remain exact upstream values.

Every selected supporting file gets a Files identity. Generated reading projections do not block Source readiness or trigger ordinary consumption writes. The current manifest is inline or in one Source-owned resource; obsolete owned manifest resources are retired after verification.

Repository-relative links retain their upstream spelling and are checked against the complete fixed Git manifest. Links to another selected member resolve through the current contribution map. A reference outside all selected members reports its exact fixed repository path and, for GitHub, a commit-pinned URL; it does not create an extra Skill or File.

All affected targets share one finite parent Source intent. Its original
configuration, selected commit and affected IDs stay fixed across interruption.
The parent tracks only the next unfinished target and its in-flight state; each
child uses the same operation kernel as import. Completion checks every target,
publishes Source ready, and removes the finite parent and child records. This is
not an atomic multi-Skill transaction or a distributed lock.

```bash
ntn-skills ctl library source apply ./source.json --entry LIBRARY_ENTRY --operation update-team --resume
```

Retain the original declaration, local state and credential selection. Unknown
child CREATE recovery is not promised after that local state is lost. Resume
keeps the original commit even if the
branch moves. If an unfinished configuration update differs from the declaration
currently visible in Notion, resume `source apply` with the original file instead
of asking refresh to reconstruct it. A completed child is verified without new
writes; an untouched later child continues under the same parent intent. Native
body edits on excluded or unrelated paths are not frozen into that intent or overwritten during Source recovery.

Source uses the same invocation HTTP budgets as import, including lookup, child
writes and cleanup. Git subprocess acquisition shares the deadline and has file
bounds and known object-byte metrics; its internal HTTP count and wire bytes are
not covered by `--max-requests` and `--max-bytes`.

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
The CLI exposes complete resource/native imports, explicit Git Source apply/refresh
and current Profile changes.

Source removal/disable, explicit takeover/restore-follow, Pro-wide local Skill
census and batch migration, and cross-owner governance remain separate work.
The selected-owner file index is not a global orphan census.
The live Notion tables and Pro Pi runtime have not been certified as converted by these local checks.

Track those boundaries in the [current contract](current-contract.md).
Do not substitute an older publication or synchronization workflow for a missing current command.
