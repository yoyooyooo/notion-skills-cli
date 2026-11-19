# Current Profiles and Source boundaries

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
its own Files identity and reading page.

Current acquisition records each file's exact Source or resource declaration.
Missing cached bytes require the current owner/descriptor to still match.
Ordinary reads do not follow the latest branch, publish discovered members,
repair projections or create records. A generated body edit does not transfer
authority; native ownership is an explicit management choice.

## A Source-management request

Read existing targets with `ctl library files`, then prepare one complete current
declaration. This example assumes the repository has exactly the selected alpha
and beta members; replace the repository and paths with the intended scope:

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
from a credential-free GitHub HTTPS URL, with manual or pinned policy. Unknown
providers, options, transformations, symlinks and retained-resource storage fail.

Every selected member needs explicit stable target assignments. One member can
target several Skills, but a member/Skill pair cannot repeat. Selection include
and exclude select member roots. Contribution mapping and exclude use exact
member-relative file paths. The effective path is mount_path plus the mapped
path. Keep exclusions when an upstream file disappears; they prevent resurrection.
Rename by mapping to retain the original Source-path File ID and Notion page.

For an existing native main, exclude the incoming SKILL.md and mount its supporting
files at a noncolliding path. The writer preserves current native bodies, resource
originals, other Sources and existing Skill metadata. Only new targets receive
the discovered metadata defaults. Collisions, missing canonical main and broken
current references are refused. Source binaries get usable current originals
without changing their Source authority. Generated text remains full text.

Provider reachability, registered source identity, complete membership,
verified file bytes and complete Notion reading projection are different
outcomes. A working Git URL does not prove any of the later outcomes. Missing
permissions and incomplete pagination are not an empty source.

Dry-run reads Notion and exact Git bytes without semantic writes; body verification
still happens during apply. Review additions, removals and target scope. A complete
equal invocation creates no operation and makes no semantic writes.

```sh
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --operation OPERATION_ID --resume
```

Keep the original declaration, local state and credential selection. Losing that
state does not provide safe automatic recovery of an unknown child CREATE.
Resume uses the original declaration and frozen Git commit, even after its branch
moves. Use original apply input if an unfinished configuration change differs from
the declaration visible in Notion. The one parent intent keeps a bounded target
cursor and each in-flight child uses the same current kernel. Already completed
children are verified without fresh mutations; untouched later targets continue.
Native body edits are neither frozen nor overwritten. Final verification makes
Source ready and clears parent/child intents. There is no multi-Skill atomicity
or distributed CAS. Unknown CREATE/append is observed, never replayed from absence.

One invocation shares 1000 HTTP attempts, 512 MiB payload bytes and 600000 ms by
default. --max-requests, --max-bytes and --timeout in ms choose positive limits.
Git subprocess acquisition shares the deadline and file limits but its HTTP count
and wire bytes are not measured; known Git object bytes are reported separately.

Explicit takeover/restore-follow, Source disable/removal, global census and
production conversion remain separate capabilities. The complete local import
refuses Source-owned targets; it cannot substitute for those operations.
