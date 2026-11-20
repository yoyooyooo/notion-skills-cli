# Current Profiles and Source boundaries

- [Profile rules](#profile-rules)
- [Current Source](#current-source-boundaries)
- [Declaration input](#a-source-management-request)
- [File authority and lifecycle](#file-authority-and-lifecycle)
- [Unfinished Source work](#unfinished-source-work)

A current Profile controls discovery and freshness. A current Source describes
where selected file bytes come from. Neither is a content-version history or a
permission boundary.

## Profile rules

```sh
ntn-skills ctl library profile list --entry ENTRY
ntn-skills ctl library profile show PROFILE_ID --entry ENTRY
ntn-skills ctl library profile set PROFILE_ID --entry ENTRY --name NAME --enabled true --expect CURRENT_FINGERPRINT --default-view VIEW_ID
```

Use `--expect new` only when no current record exists for that stable Profile ID.
The set command supplies the complete rule. Required fields are name, enabled
and expected fingerprint. Omitted default-view and freshness-json remove their
prior values. A no-change intent makes no write.

`--freshness-json` accepts:

```json
{
  "default": {
    "read_max_age_ms": 300000,
    "source_check_max_age_ms": 300000
  },
  "skills": [
    {
      "skill_id": "STABLE_SKILL_ID",
      "read_max_age_ms": 60000
    }
  ]
}
```

Durations are optional nonnegative integer milliseconds. Skill IDs must be
unique; use stable IDs from the current result, not display names. Explicit read
policy wins, followed by the Skill rule, Profile default and product default.
A long TTL delays visibility of current edits and does not extend independent
native-body or eligibility deadlines.

```sh
ntn-skills ctl library profile freshness PROFILE_ID --entry ENTRY --skill STABLE_SKILL_ID
ntn-skills list --profile PROFILE_ID --database ENTRY
ntn-skills ctl library profile bind PROFILE_ID --entry ENTRY
ntn-skills list --default-view
ntn-skills ctl library profile unbind
```

Binding changes only local selection. Shared rules remain in Notion. An explicit
View wins; bare list remains explicit discovery. Profiles and Views do not grant
access.

After an interrupted set, repeat that same complete intent with `--reconcile`.
It only observes current rules and never repeats POST/PATCH. Preserve unresolved
results. A fingerprint detects an observed conflict; Notion properties do not
provide distributed CAS.

## Current Source boundaries

Sources.Content contains `{version: 1, plan: ...}`, or a current Source-owned
resource for a larger complete plan. Sources.Last Revision is the SHA-256 fingerprint of that plan. Any fixed
Git commit or provider revision lives inside the plan. Stable Source ID is
independent of its display title and current plan.

Each source-backed main or supporting file declares:

```json
{
  "kind": "source",
  "source_id": "STABLE_SOURCE_ID",
  "revision": "CURRENT_PLAN_SHA256",
  "source_path": "references/example.md",
  "sha256": "FILE_SHA256",
  "bytes": 123,
  "mode": "100644"
}
```

The displayed hash placeholders must be replaced by actual lowercase 64-digit
SHA-256 values. This file location is exact. A Skill can combine multiple
Sources with native and resource files, and every supporting file still needs
its own Files identity. Generated reading pages are verified separately.

Current acquisition records each file's exact Source or resource declaration.
Missing cached bytes require the current owner/descriptor to still match.
Ordinary reads do not follow the latest branch, publish discovered members,
repair projections or create records. A generated body edit does not transfer
authority; native ownership is an explicit management choice.

## A Source-management request

Read existing targets with `ctl library files`, then prepare one complete current
declaration. This example preserves explicit identities for alpha and beta;
other discovered members receive deterministic identities. Use an empty
contributions array when no identity overrides are needed:

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

```sh
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --dry-run
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --operation OPERATION_ID
ntn-skills ctl library source refresh SOURCE_ID --entry ENTRY --dry-run
ntn-skills ctl library source refresh SOURCE_ID --entry ENTRY
```

Apply replaces that Source's complete configuration and contributions. Refresh
reads the declaration from Notion and uses the same coordinator. The JSON file
must be regular UTF-8 and at most 512 KiB. This writer accepts regular Git files
from GitHub and credential-free private HTTP(S) Git origins, with manual or pinned
policy. GitHub SSH repository spellings normalize to the same shared identity.
Authentication stays on the machine. Unknown providers, options, transformations
and symlinks fail. Source options.storage are rejected, as are auto policy and
check_interval_ms. The only current option is accepted_ref for an explicitly fixed discovery
commit. Do not retain that option for a declaration intended to follow a branch.
Selection.mapping supplies new Skill names; it is not a file mapping.

Discovery reconciles all selected members. Existing contributions retain stable
target assignments; unassigned members receive identities derived from Source ID
and member key. Missing members leave the effective declaration. An empty selected
set is valid only after complete successful discovery. Selection include/exclude
selects member roots. Contribution mapping/exclude uses exact member-relative file
paths; the effective path is mount_path plus the mapped path. Keep file exclusions
to prevent a deliberately taken-over file from returning when upstream reintroduces it.

A desired upstream path replaces matching native/resource authority and preserves
its File ID. Dry-run reports that overwrite before applying. Exclude the incoming
SKILL.md when an existing native main should stay authoritative. Unrelated files,
other Sources and existing Skill metadata remain preserved; another Source at the
same desired path is a conflict. When a member disappears, archive its Files and
Skill only if the complete target is owned by this Source. Retaining unrelated
author content must not silently erase it. Source bytes and modes remain upstream
exact. Generated page bodies and binary attachments are optional projections, not
consumption prerequisites.

Save the declaration outside Notion for `source apply` after a Source deletion.
A recreated page has a new physical page ID but the declared stable Skill identity.
Human checkboxes and relations need their own explicit recovery input; do not
claim that Git content restores those choices.

Provider reachability, registered source identity, complete membership,
verified file bytes and complete Notion reading projection are different
outcomes. A working Git URL does not prove any of the later outcomes. Missing
permissions and incomplete pagination are not an empty source.

Dry-run reads Notion and exact Git bytes without semantic writes; body verification
still happens during apply. Review additions, removals and target scope. A complete
equal invocation creates no operation and makes no semantic writes.

## File authority and lifecycle

Inspect the current directory and obtain the stable Skill ID, File ID, source path
and target path. Source paths include the original member root; contribution
exclusions remain member-relative. Use exactly one current file:

```sh
ntn-skills ctl library source takeover SOURCE_ID SOURCE_PATH --entry ENTRY --skill-id SKILL_ID --file-id FILE_ID --as resource --dry-run
ntn-skills ctl library source takeover SOURCE_ID SOURCE_PATH --entry ENTRY --skill-id SKILL_ID --file-id FILE_ID --as native --operation OPERATION_ID
ntn-skills ctl library source restore-follow SOURCE_ID SOURCE_PATH --entry ENTRY --skill-id SKILL_ID --file-id FILE_ID --operation OPERATION_ID
```

Takeover reads the selected Source original, keeps File ID, page, target path and
mode, and adds the exact file exclusion in the same Source intent. Resource is
the default and preserves opaque originals too. Native requires supported text
and an exact author-body round-trip; failure leaves the intent unfinished without
fallback. Repeating a completed takeover must preserve later Notion edits.

Restore-follow names the intended current Source and path explicitly. It requires
an enabled Source and overwrites current customization with that Source's selected
original. It removes the exclusion and aligns mapping to the retained target path.
It does not restore a historical revision or require a permanent old Origin pointer.
Other files and Sources remain preserved. A concurrent change of authority or a
new resource reference blocks overwrite or cleanup until explicitly resolved.

```sh
ntn-skills ctl library source disable SOURCE_ID --entry ENTRY --operation OPERATION_ID
ntn-skills ctl library source enable SOURCE_ID --entry ENTRY --operation OPERATION_ID
ntn-skills ctl library source remove SOURCE_ID --entry ENTRY --dry-run
ntn-skills ctl library source remove SOURCE_ID --entry ENTRY --operation OPERATION_ID
```

Disable changes consumption eligibility only. It keeps selected content, files and
contributions; it is not an automatic-refresh pause. Enable changes eligibility
without acquiring a newer provider revision. Do not force ready over another
unfinished action. Takeover of a disabled Source uses explicit management of its
exact current original; ordinary readers remain blocked.

Remove scans complete Skills and Files metadata in this one library, including
Main and bindings absent from Origin. Any current Source Content or Origin
reference blocks removal with exact affected identities. Take over those files
first; a Source main is never implicitly deleted, and another Source is never
chosen as replacement. Correct stale Origin explicitly. The action retires only
unreferenced Source-owned resources and its exact Source page. Skill-owned binary
reading copies follow each child's complete resource-reference checks.

Skills and their authored Members/Requires, Profile selections and Views are not
silently deleted or rewritten. A surviving Skill identity keeps its relationships.
Arbitrary cross-Skill body links, View filters and whole-library orphan repair need
their own explicit governance; this command does not claim those outcomes.
Incomplete pagination, permission failure or exhausted limits cannot prove absence.

## Unfinished Source work

Inspect the exact parent before changing an unfinished action:

```sh
ntn-skills ctl library operation SOURCE_ID --kind source --entry ENTRY
```

This reads the finite Record, owner state, local lifecycle, in-flight action,
child cursor and predecessor without semantic writes or repair. A not_found result
with operation:null does not establish ready, absence of the owner or retirement.
Keep the actual result and its original credential/state scope.

```sh
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --operation OPERATION_ID --resume
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --supersede OLD_OPERATION_ID --operation NEW_OPERATION_ID
ntn-skills ctl library source remove SOURCE_ID --entry ENTRY --operation OPERATION_ID --resume
```

Keep the original input, local state and credential scope. Empty state or another
machine cannot safely recover an unknown child CREATE. Resume the same action and
selected targets. Declaration resume freezes the original Git commit even after
its branch moves; use original apply input when the visible Notion declaration
differs. Its one parent cursor verifies completed targets before continuing later
ones. Native author edits remain current. Completion clears parent/child intents.

Supersede explicitly names the predecessor and a distinct new operation. The
kernel reconciles before handoff; it does not discard an unresolved CREATE/append.
Source actions remain in the same family. A file action keeps its exact selected
Source/path/Skill/File; a failed native takeover can explicitly select resource in
its successor. A metadata toggle cannot clear an unfinished multi-target refresh.
Resume and supersede are mutually exclusive, and neither accepts dry-run.

After an unknown Source retirement, resume reads the exact physical owner even
when Trash removed it from active queries. It verifies removed state and retires
the finite intent without publishing ready or recreating the Source. Unknown
outcomes stay explicit. No permanent tombstone, rollback history, distributed CAS
or multi-Skill atomicity is promised.

One invocation shares 1000 HTTP attempts, 512 MiB payload bytes and 600000 ms by
default. --max-requests, --max-bytes and --timeout in ms select positive limits.
Git subprocess acquisition shares the deadline and file bounds, but HTTP count
and wire bytes are unmetered; known Git object bytes are reported separately.
Live Notion conversion, broad reverse repair and all-Pro migration remain distinct
acceptance work. A controlled test or source command does not prove them complete.
