# Maintain a shared Notion library

Use a shared library's **Skills database entry** with `--database` on ordinary content commands and `--entry` on `ctl library` commands. Obtain that entry from the library you intend to maintain. Names and aliases help discovery; keep the exact record, page ID and pinned refs returned by the CLI for writes.

This guide covers the shared Skills / Files / Records model. Existing libraries that still use the earlier publication or synchronization model retain their own recovery workflow until migration is complete.

## Contents

- [Connect and read](#connect-and-read)
- [Create a native Skill](#create-a-native-skill)
- [Change existing files and metadata](#change-existing-files-and-metadata)
- [Add, delete or move a file](#add-delete-or-move-a-file)
- [Select a fixed source and restore following](#select-a-fixed-source-and-restore-following)
- [Choose a Profile and View](#choose-a-profile-and-view)
- [Keep a version across machines](#keep-a-version-across-machines)
- [Handle an interrupted operation](#handle-an-interrupted-operation)
- [Current limits](#current-limits)

Replace uppercase placeholders with values returned by your own commands. Keep the original input files and command output until a write has been verified.

## Connect and read

Inspect an existing shared entry before using it:

```bash
ntn-skills ctl library inspect LIBRARY_ENTRY
ntn-skills list --database LIBRARY_ENTRY
ntn-skills read 'REF_FROM_LIST' --database LIBRARY_ENTRY
ntn-skills files SNAPSHOT_ID_FROM_READ
```

`list` reads discovery metadata. `read` returns the selected instructions and a complete fixed snapshot. Use its pinned refs for supporting files from the same version. A current read may reuse a validated cache; `read SKILL_PAGE_ID --database LIBRARY_ENTRY --refresh` requests complete fresh validation. A pinned ref stays fixed and does not accept `--refresh`.

Create a new library only when the task includes creating its tables under an owned parent:

```bash
ntn-skills ctl library init --parent PARENT_PAGE_ID
```

Use the returned `library.skills.database_id` as the entry. Initialization creates the shared tables and descriptor; it does not migrate another library or change machine defaults. `ctl library init --entry LIBRARY_ENTRY` validates an existing entry.

Direct edits to a bound Notion body are detected by normal current reads. After the complete edited body has been retained and verified, that whole file becomes customized. Other files retain their own ownership. Name, Description, Default Context and Router Members remain native Notion properties; a body edit does not change them.

## Create a native Skill

Prepare an ordinary folder with `SKILL.md` and any supporting UTF-8 Markdown or text files. For example:

```markdown
---
name: Release Review
description: Review a release and its operational checklist.
---

# Release review

Read [the checklist](references/checklist.md) before recommending a release.
```

Place the linked file at `references/checklist.md` in the same folder. Then preview and create:

```bash
ntn-skills create ./release-review --database LIBRARY_ENTRY --dry-run
ntn-skills create ./release-review --database LIBRARY_ENTRY
```

The CLI creates the stable Skill and File identities and shared records. Ordinary Skill folders do not need a hand-authored portable manifest. A single Markdown file is also accepted; supply `--description` if its frontmatter has no Description. `--name` and `--description` explicitly override input metadata.

In a shared library, creation uses native Skills and Files pages. The new Skill stays disabled until its complete file set has passed verification. Binary or unsupported input fails before page creation; it is never silently omitted. Keep binaries in a fixed source when consuming a mixed file tree. Omit `--storage` for this shared path; the older `--storage markdown_files` mode is rejected for a shared library.

Success returns the exact record, a verified snapshot and `create_operation_id`. A matching existing name is never permission to overwrite another Skill. If the result is unknown, preserve the exact input and original operation; see [interrupted operations](#handle-an-interrupted-operation).

Prompt and Router input still uses the existing portable v2 kind declaration. Consult `create --help` and the [portable input contract](protocol.md#portable-input-contract) for those explicit kinds. Filenames alone do not select kind.

## Change existing files and metadata

First read the current exact Skill and retain its pinned main ref:

```bash
ntn-skills read SKILL_PAGE_ID --database LIBRARY_ENTRY --refresh
```

### Apply one set of changes

Put changed **existing** files in a separate authoring directory, preserving their logical relative paths. For example, `./changes/SKILL.md` and `./changes/references/checklist.md` can update the main body and an existing resource together:

```bash
ntn-skills apply 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --input ./changes --description 'Review the release and its rollback checklist.' --dry-run

ntn-skills apply 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --input ./changes --description 'Review the release and its rollback checklist.'
```

Omitted files remain unchanged. The pinned version must still match a fresh current read. The CLI validates every requested input and the proposed complete tree before dispatch, then executes the frozen body and nominated metadata operations in order. This is a sequential batch: a later failure can leave earlier verified edits in place. The response or error retains the original batch and its child operations; it does not roll back a later user edit.

Success reports `status: "applied"`, `verified: true`, `apply_operation_id`, the changed paths and a new pinned snapshot. Identical input reports `status: "unchanged"`. Dry-run reports a plan and sends no Notion writes.

This batch supports existing bound native files and metadata. A single isolated add or delete is also supported, but mixed or multiple layout changes currently fail with `SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED` before any write. Use the explicit [file commands](#add-delete-or-move-a-file) for those individual changes. Replacing a complete Skill with `replace --target` uses the same shared authoring rules and limits.

### Write one complete file

```bash
ntn-skills write 'PINNED_FILE_REF' --database LIBRARY_ENTRY --input ./edited-file.md --dry-run
ntn-skills write 'PINNED_FILE_REF' --database LIBRARY_ENTRY --input ./edited-file.md
```

Submit the complete replacement file. A returned file ref already contains its logical path, so omit `--path`. If selecting a page or main ref without a resource path, use `--path references/checklist.md` for the supporting file.

Main frontmatter may restate the current Name and Description, or values explicitly supplied to the same `apply`. Changing those fields inside `write` alone is rejected; additional unsupported main frontmatter is also rejected rather than discarded. A supplied `notion_page_id` must identify the exact selected Skill. Router bodies retain their generated Members index; change membership through the native relation or `update --member`.

New native authoring plans freeze the original input, the request Markdown and the exact expected native readback separately. Projection version 2 preserves authored H1 headings by sending them as native heading tags during create and file add; body writes keep their ordinary heading syntax. It projects common inline code, bold, italic and strikethrough to the native readback form. Fenced code keeps its literal content; an omitted language is sent explicitly as plain text, whose native readback label is `txt`. CRLF becomes LF and terminal line feeds are removed before projection. Every complete response must still match the frozen candidate exactly. A mismatch keeps the original operation for review, and older version 1 plans retain their original policy and request bytes.

### Update native properties

```bash
ntn-skills update 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --name 'Release Readiness' --description 'Check the release and rollback procedure.' --dry-run

ntn-skills update 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --name 'Release Readiness' --description 'Check the release and rollback procedure.'
```

Only nominated fields change. Omitted properties and file bodies remain intact. `--default-context` controls the native checkbox. For a Router, repeat `--member SKILL_PAGE_ID` with exact accessible members in the same shared library, or use `--clear-members`; omit both to preserve the relation. Metadata writes use Notion's native last-writer behavior and do not provide compare-and-swap.

Keep generated snapshot directories as consumption output. Editing one does not silently submit it to Notion. Explicitly choose the intended files as `write` or `apply` input and read the verified result before distributing a new snapshot. Existing local sync bindings have a separate migration and recovery path; a generated directory is not an implicit replacement for them.

## Add, delete or move a file

These commands take an exact shared Skill page ID or Notion page URL, followed by the logical file path:

```bash
ntn-skills ctl library file add SKILL_PAGE_ID references/new-checklist.md \
  --entry LIBRARY_ENTRY --input ./new-checklist.md --dry-run
ntn-skills ctl library file add SKILL_PAGE_ID references/new-checklist.md \
  --entry LIBRARY_ENTRY --input ./new-checklist.md

ntn-skills ctl library file move SKILL_PAGE_ID references/old.md references/new.md \
  --entry LIBRARY_ENTRY --dry-run

ntn-skills ctl library file delete SKILL_PAGE_ID references/obsolete.md \
  --entry LIBRARY_ENTRY --dry-run
```

Review the dry-run, then omit `--dry-run` to execute the same intent. Each command checks the complete current tree and deterministic relative Markdown links and images. Move does not rewrite references. Remove or update obsolete references deliberately and take a new read before the next change.

Add creates one new File identity and native body page. Move preserves the File ID, page and body; a following file also preserves its original fixed-source path. Delete records an explicit tombstone while retaining the page and body. A later upstream reappearance does not revive the deleted path. The main entrypoint cannot be moved or deleted through these commands. Missing permissions or a failed read are never treated as deletion intent.

## Select a fixed source and restore following

Register the exact Git commit and repository-relative root chosen for this Skill:

```bash
ntn-skills ctl library source inspect https://github.com/OWNER/REPOSITORY \
  --commit FULL_40_CHARACTER_COMMIT --root skills/example

ntn-skills ctl library source register SKILL_PAGE_ID --entry LIBRARY_ENTRY \
  --url https://github.com/OWNER/REPOSITORY \
  --commit FULL_40_CHARACTER_COMMIT --root skills/example
```

Registration retains the immutable source identity; it does not change the current Source property or overwrite a customized file. Select the returned source ID through a generated plan:

```bash
ntn-skills ctl library source select prepare SKILL_PAGE_ID --entry LIBRARY_ENTRY \
  --source SOURCE_ID_FROM_REGISTER --output ./source-selection.json
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY
```

The CLI writes this plan; keep it unchanged for execution or reconciliation. Use `--native` instead of `--source` when intentionally clearing the Source selection. Source selection changes only the native property. Customized files keep their complete Notion content until explicitly restored to following:

```bash
ntn-skills ctl library file restore-follow SKILL_PAGE_ID references/checklist.md \
  --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library file restore-follow SKILL_PAGE_ID references/checklist.md \
  --entry LIBRARY_ENTRY
```

Restore uses the exact source currently selected in Notion, retains the old complete custom body, and verifies the new result before changing ownership. Moved files use their retained source path. An absent source file remains a failure with the custom content preserved; the CLI does not guess a same-named replacement or select a newer commit. The main entrypoint can also be explicitly restored.

Advanced HTTP and local mounts use `ctl library source composition inspect PLAN_JSON --verify` and `composition register SKILL_PAGE_ID --entry LIBRARY_ENTRY --manifest PLAN_JSON`. These commands consume an existing fixed composition plan; there is no interactive composition builder. Every file identity remains fixed by hash and size. Machine-only resource configuration uses `ctl library source resource --help`; local roots and signed HTTP retrieval addresses are not stored in shared Records. Local access requires an explicit machine/workspace binding. Restoring a local file into shared Notion records requires the additional `--allow-local-archive` flag.

## Choose a Profile and View

```bash
ntn-skills views --database LIBRARY_ENTRY
ntn-skills ctl library profile list --entry LIBRARY_ENTRY
ntn-skills ctl library profile show daily --entry LIBRARY_ENTRY
ntn-skills list --profile daily --database LIBRARY_ENTRY
ntn-skills list --view VIEW_ID --database LIBRARY_ENTRY
```

An explicit View takes precedence over Profile defaults. A Profile with no default View uses the library's first View in API order. Bare `list` retains complete explicit discovery; binding a Profile does not hide other content or grant access.

Create a Profile only when it does not already exist:

```bash
ntn-skills ctl library profile set daily --entry LIBRARY_ENTRY \
  --name Daily --enabled true --base new --default-view VIEW_ID
ntn-skills ctl library profile bind daily --entry LIBRARY_ENTRY
ntn-skills list --default-view
```

For an existing Profile, use the exact current revision returned by `profile show` as `--base`. `profile set` replaces the full rule: omitting `--default-view` removes the previous default. The machine binding stores only the library entry and Profile ID. `profile unbind` removes that machine selection without changing shared rules.

## Keep a version across machines

An ordinary `s_...` pin addresses local immutable snapshot bytes. To make an exact complete snapshot recoverable on another machine, archive and restore it explicitly:

```bash
ntn-skills ctl library snapshot save SNAPSHOT_ID_FROM_READ --entry LIBRARY_ENTRY
ntn-skills ctl library snapshot restore SHARED_PIN_ID_FROM_SAVE \
  --entry LIBRARY_ENTRY --target SKILL_PAGE_ID
ntn-skills export RESTORED_SNAPSHOT_ID --projection snapshot --format directory --output ./fixed-snapshot
```

The receiving machine uses its own Notion authentication. Restore validates access and reads the archived bytes; it does not substitute current bodies or fetch a newer provider version. A local resource binding grants read access on that machine and does not authorize shared archival. When the exact selected snapshot contains local-restricted bytes, a new archive requires `snapshot save SNAPSHOT_ID --entry LIBRARY_ENTRY --allow-local-archive`. That flag authorizes this one archive and does not remove durable local-content restrictions. The separate `restore-follow --allow-local-archive` flag applies only to its selected native body.

## Handle an interrupted operation

Keep the original input, exact target, operation ID and recovery details. A matching current body or property does not prove that an unknown original request completed. Do not change input or choose a new name to bypass a pending operation. A recovery result with `verified: true` confirms its reported outcome: `not_applied` or `partial` does not mean that the requested edit completed.

| Operation | Supported next step |
| --- | --- |
| Shared body write, apply or restore-follow | Read the exact current Skill. The reader checks retained original operations before adopting new bodies. If it reports `read_again`, read once more. Missing original facts remain unresolved. |
| Native create | Retain the complete original input and operation. Repeating the same create intent takes its original reconciliation path; it does not blindly repeat a page POST. A partially created Skill remains disabled until verified. |
| File add, delete or move | `ctl library file reconcile SKILL_PAGE_ID OPERATION_ID --entry LIBRARY_ENTRY` |
| Source registration | `ctl library source reconcile SKILL_PAGE_ID --entry LIBRARY_ENTRY --source ORIGINAL_SOURCE_ID` |
| Source selection | `ctl library source select reconcile ./source-selection.json --entry LIBRARY_ENTRY` |
| Profile revision | Repeat the original complete `profile set` arguments with `--reconcile`. |
| Shared snapshot archive | Repeat `ctl library snapshot save ORIGINAL_SNAPSHOT_ID --entry LIBRARY_ENTRY --reconcile`. |

These shared IDs are distinct from older Publication IDs. Do not pass them to the legacy `operation resume` workflow. An empty independent machine may be unable to distinguish an invisible first request from one never sent; preserve the original machine's pending operation instead of recreating it elsewhere.

## Current limits

Shared authoring currently requires existing editable bindings for changed files. Native binary creation, mixed or multiple layout changes in one `apply`, and arbitrary lossless Markdown rendering are not implemented. New plans reject Setext headings and YAML frontmatter in supporting files before any Notion write because native readback does not preserve their original structure. Main-file frontmatter is limited to the supported name and description fields; unknown fields are rejected. Excessive operation-envelope size fails before dispatch. HTTP/local composition still requires a reviewed fixed plan. These limits do not change old pins or authorize omission of input files.
