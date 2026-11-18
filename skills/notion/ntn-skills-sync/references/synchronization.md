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

Sources.Content contains `{version: 1, plan: ...}` for one normalized current
plan. Sources.Last Revision is the SHA-256 fingerprint of that plan. Any fixed
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

The current public CLI has no Source create, onboard, bind, refresh or remove
command. Read the selected Skill's `ctl library files` index, identify intended
Source/member/path scope, and prepare complete input for the current writer.

Provider reachability, registered source identity, complete membership,
verified file bytes and complete Notion reading projection are different
outcomes. A working Git URL does not prove any of the later outcomes. Missing
permissions and incomplete pagination are not an empty source.

When the current writer is available, one explicit refresh must preserve
native authority and unrelated Source contributions, apply current exclusions
and reconcile its unfinished effects. This reference does not invent that
future command's arguments or expose an alternate writer.
