---
name: ntn-skills-sync
description: Manage current Git Source contributions, take over or restore one exact file, enable, disable or remove a Source, and manage Profiles, View defaults and freshness. Use for Source onboarding, refresh, authority changes and current discovery policy.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-sync
---

# Manage current Sources and Profiles

Requires ntn-skills, Node.js 22.22.3+ within 22.x or 24.20.0+, and exact library access. Source management needs Notion Insert and Update; Profiles need Records access.

Use the task's executable, exact library and stable identities. Ordinary
consumption never updates Source content. Reading a script does not authorize
executing it. Complete local imports belong to ntn-skills-maintain.

In a connected library, discover that workflow within the same library and read
its exact returned ref for inspection. To apply a Notion-selected workflow, use
that source's exact ref via Pi `notion_use(ref)` or CLI `ntn-skills use REF
--database ENTRY --json` to load its Requires, unless already prepared for this
task. Use only an available route; otherwise report unavailable adoption. Inspect
the edited target without activating it. Local and package workflows keep their
host's native route. Read this Skill's references with `ntn-skills read
RELATIVE_PATH --from CONTAINING_FILE_REF`. Keep package-selected references in the
same package with `ctl builtin read notion/ntn-skills-sync --path RELATIVE_PATH`.
An npm update does not refresh a Notion Source. Refresh its selected Git ref and
generate reading pages explicitly when that update is requested; preserve active
task selections and human discovery metadata.

## Source declarations

Use the complete {version:1,definition,contributions} input in
[Source input](references/synchronization.md#a-source-management-request):

```sh
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --dry-run
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --operation OPERATION_ID
ntn-skills ctl library source refresh SOURCE_ID --entry ENTRY
ntn-skills ctl library projection --daily --entry ENTRY
```

Use regular Git content from GitHub or a credential-free private HTTP(S) Git
origin with existing machine authentication. Manual policy follows the configured
ref; pinned policy retains its exact commit. Do not invent a provider or scheduler.
Discovery supplies the complete selected member set. Existing contributions keep
stable Skill identities; new members receive deterministic identities. Missing
members are removed, including a completely empty selected set. A provider or
pagination failure must never be interpreted as deletion.

Use contribution mapping/exclude for exact member-relative files and Selection
include/exclude for member roots. A desired upstream path replaces matching
native/resource content; inspect the authority change in dry-run. Exclude a path
explicitly to retain its Notion authority. Other Source content cannot be replaced.
A removed pure Source member is archived with its Files; unrelated author content
prevents silent deletion. Retained paths preserve File identities and human metadata.
The complete Source manifest and Contributions own every Git consumption file;
Source Files rows are selected reading documents. After sync, projection keeps
the main and defaults to Markdown outside test/fixture/generated/dependency
directories. It creates missing selected pages and retires excluded Source rows
without removing consumption files. Notion-owned native/resource Files remain
authoritative. Native bodies are verified without writes; non-text is skipped.
Projection failure preserves consumption. See
[daily text](references/synchronization.md#daily-notion-text) for preview and recovery.

Keep the declaration outside Notion. Reapply it to rebuild a missing Source or
Skill; upstream content does not reconstruct human checkbox or relation choices.
For an existing completed Skill moved to Trash, prefer the original exact page:
`ctl library projection PAGE_ID --restore --entry ENTRY`. It restores the same
owner and current reading projection, preserving identity and human choices.
Use [Trash recovery](references/synchronization.md#restore-a-trashed-skill) for its
limits and repeat the same command after its own interrupted stages.
For daily batches, combine Source 日用 (all real members), Skill 日用 and Default
Context without changing Default Context to match the daily set. Installed/App
Skills use repeatable complete imports through ntn-skills-maintain; genuine
Notion originals retain native authority and use complete exports as recovery input.

## File authority and lifecycle

Inspect `ctl library files PAGE_ID --entry ENTRY` to obtain exact Skill/File IDs.
Name the original Source path, including its member root:

```sh
ntn-skills ctl library source takeover SOURCE_ID SOURCE_PATH --entry ENTRY --skill-id SKILL_ID --file-id FILE_ID --as resource
ntn-skills ctl library source restore-follow SOURCE_ID SOURCE_PATH --entry ENTRY --skill-id SKILL_ID --file-id FILE_ID
ntn-skills ctl library source disable SOURCE_ID --entry ENTRY
ntn-skills ctl library source enable SOURCE_ID --entry ENTRY
ntn-skills ctl library source remove SOURCE_ID --entry ENTRY --dry-run
```

Takeover preserves File/page/path/mode and adds its exact contribution exclusion.
Resource is the default. --as native requests an editable body under the shared
native semantic check. Supported formatting normalization is reported; content
loss leaves pending without fallback. The selected Source input stays exact.
Repeating a completed
takeover preserves later author edits. Restore-follow explicitly overwrites
customization with the enabled Source's selected original, removes the exclusion
and aligns mapping. No permanent former-Origin pointer is required.

Disable blocks ordinary Source consumption and preserves files/configuration;
enable restores eligibility without discovering a new revision. Remove requires
a complete same-library metadata scan proving no current Content or Origin
references. Take over referenced files first, including a Source main. Remove
does not delete Skills or repair arbitrary inbound links. See
[authority and lifecycle](references/synchronization.md#file-authority-and-lifecycle).

## Unfinished Source work

Resume the original action with --operation OPERATION_ID --resume. Declaration
resume freezes its commit and uses the original INPUT_JSON when Notion differs.
Keep original input, local state and credential scope; an unknown child CREATE
cannot safely resume from empty state on another machine.

To replace an unfinished intent, use --supersede OLD --operation NEW. The action
family stays the same; a file transfer retains its exact target. Reconcile the
predecessor first, without replaying unknown CREATE/append or clearing pending
by hand. Supersede is incompatible with resume and dry-run. See
[recovery](references/synchronization.md#unfinished-source-work).

All actions share HTTP/deadline limits. Git subprocess HTTP/wire bytes remain
unmetered; known object bytes and the deadline are reported separately.
Complete equal input makes zero semantic writes. No multi-Skill atomicity or
distributed CAS is promised. Live data conversion and full governance remain
separate from these commands.

## Profiles and discovery

A Profile is one current Records rule; a local binding stores its selection.

```sh
ntn-skills ctl library profile show PROFILE_ID --entry ENTRY
ntn-skills ctl library profile set PROFILE_ID --entry ENTRY --name NAME --enabled true --expect new
ntn-skills ctl views --database ENTRY
```

For replacement, use show's fingerprint as --expect and supply the complete desired rule.
Name/enabled/expect are required; omitted View/freshness removes their prior value.
Unchanged rules make no write. After a lost response, repeat that intent with
--reconcile to inspect without another POST or PATCH. This is observed conflict
detection, not distributed CAS.

Profiles and Views do not grant access or activate bodies. Explicit View/read
policy wins over Profile defaults; a longer TTL delays current-edit visibility
without extending native-body eligibility. Read
[Profile rules](references/synchronization.md#profile-rules) for bind/unbind,
per-invocation selection and complete freshness input.
