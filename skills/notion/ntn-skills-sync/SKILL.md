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
executing it. Complete local imports belong to notion/ntn-skills-maintain.

## Source declarations

Use the complete {version:1,definition,contributions} input in
[Source input](references/synchronization.md#a-source-management-request):

```sh
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --dry-run
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --operation OPERATION_ID
ntn-skills ctl library source refresh SOURCE_ID --entry ENTRY
```

Supported input is regular Git content from GitHub HTTPS, manual or pinned.
There is no auto policy, scheduling interval or Source storage option. Assign
every selected member to stable Skill IDs. Contribution mapping/exclude uses
exact member-relative file paths; Selection excludes member roots. Mappings
preserve retained File identity. Collisions and a missing canonical main fail.

A Skill can combine Sources with native/resource content. Preserve other
contributions and existing Skill metadata. Every supporting file needs a Files
row and a full readable projection or usable opaque original. Generated body
edits do not transfer authority. Source binaries keep Source authority.

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
Resource is the default. --as native explicitly requests an editable body and
fails without an exact round-trip; it never falls back. Repeating a completed
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
