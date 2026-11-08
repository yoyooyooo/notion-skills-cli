# Synchronization decisions

## Daily paths

| Relationship | Start once | Continue |
| --- | --- | --- |
| Active shared Source | `ctl library sources put` and exact `bind` | `sources prepare --target` or `--all-bound`, reviewed `apply`, original `reconcile` |
| Finite source policy | Explicit pinned/manual/auto definition | `sources run`, then offline `run-status` |
| New exact provider member | `sources admit` | Original `admit-apply` / `admit-reconcile` |
| Complete reviewed local Skill | `ctl library inventory local/reconcile/prepare-import` | Original `apply-import` / `reconcile-import` |
| One-time import/export/edit | Use `ntn-skills-maintain` | No recurring binding is established |

Use installed help/schema for flags and actual output fields. Do not manufacture internal subscription, plan, proof or receipt JSON as part of a normal connection. Existing low-level add/update and plan/apply commands remain useful for explicit advanced configuration or saved-plan review.

## Active Sources definitions

The current four-table model separates mutable Sources from immutable selected content in Records. Use `ctl library sources providers` for offline capabilities and `list/show/members --entry ENTRY` for complete current identities and associations. The Sources reverse relation may be truncated by Notion; `members` queries the forward Skills Origin relation and follows all cursors. A Source with no current bound members is valid; a retained former published-members manifest is not permission to recreate deleted content or guess by name.

`put` takes a complete version-1 definition with `source_id`, name, description, enabled, policy, adapter, selection and options. Read the installed `sources put --help` and the [Source management guide](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/sources-management.md) for exact Git and Linear JSON examples. Copy the last observed fingerprint into `--expect`; edits do not change current Skill pins. `bind` requires exact target/member and expected current Origin. Old multi-publisher settings remain provenance; a single-origin refresh deliberately rejects shared_target_set.

`check` resolves a complete provider candidate. `fetch` exports one exact member. `ctl library sources prepare SOURCE --entry ENTRY --target PAGE --output PLAN` freezes complete provider bytes, current custom/following/tombstone ownership and the effective tree without remote writes. Replace `--target` with `--all-bound` for one complete Source batch. `apply` verifies the frozen expectations and uses the common original selection journal. Fixed public Git uses exact commit/tree/blob/SHA-256/mode identities where supported; retained inputs preserve complete objects. Native editable-page replacement still requires a proven content precondition and can remain blocked.

Linear uses a machine-only `LINEAR_API_KEY` and the fixed official GraphQL endpoint. Select explicit issue/document IDs and file paths including SKILL.md. An observation hash binds the returned bytes and updatedAt, not an invented historical API commit. Git uses host authentication and exact resolved commits. Shared definitions never contain credentials, arbitrary headers or executable commands. Do not copy credentials to test another machine.

After interrupted refresh, `sources reconcile PLAN --entry ENTRY` observes the exact retained original selection. A visible new pin alone does not prove the original outcome. Acknowledged resource steps are immutable; an unknown original write is not resent. A candidate removing a bound following file or yielding broken final references needs an explicit content decision, not dropped files or looser validation.

## Shared fixed sources

A shared library selects immutable source identities while native Notion properties and whole-file customizations remain authoritative. Use the exact page and Skills database entry:

```bash
ntn-skills ctl library source inspect https://github.com/OWNER/REPOSITORY --commit FULL_40_HEX_COMMIT --root skills/example
ntn-skills ctl library source register SKILL_PAGE_ID --entry LIBRARY_ENTRY --url https://github.com/OWNER/REPOSITORY --commit FULL_40_HEX_COMMIT --root skills/example
ntn-skills ctl library source select prepare SKILL_PAGE_ID --entry LIBRARY_ENTRY --source SOURCE_ID --output ./source-selection.json
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY
```

Register freezes the candidate; select changes only the native Source property. The CLI generates the plan. Keep its exact content and IDs for application or reconciliation. Use `--native` instead of `--source` to clear Source intentionally. Register can also consume the complete `source inspect` JSON or its bare manifest with `--manifest FILE`, mutually exclusive with URL/commit/root; this form makes no provider request. A source change never selects a newer revision implicitly or discards customized Notion bodies. Content maintenance owns an explicit `ctl library file restore-follow`.

### HTTP/local composition and resource bindings

`ctl library source composition inspect PLAN_JSON --verify` and `composition register SKILL_PAGE_ID --entry LIBRARY_ENTRY --manifest PLAN_JSON` accept an existing fixed composition plan. There is no ordinary interactive builder. Files must have complete fixed identities; unresolved paths, collisions or access failures remain errors. `source resource show` reports redacted machine configuration. Use `source resource --help` for local workspace bindings, exact HTTP origin policy and machine-only retrieval locations. These bindings grant reads, not a two-way sync relationship or authorization to publish local bytes. Machine paths, credentials and signed retrieval URLs never belong in shared records or portable manifests. Native restore-follow requires separate `--allow-local-archive` authorization for selected local bytes.

Archiving an exact complete local snapshot uses `ctl library snapshot save SNAPSHOT_ID --entry LIBRARY_ENTRY`. A new archive containing local-restricted bytes requires its own `--allow-local-archive`; that flag authorizes only this archive and preserves durable content restrictions. Use the original snapshot with `--reconcile` after interruption. It does not authorize a different snapshot or replay an unknown write. Restore-follow's same-named flag covers only its selected native body.

### Shared Profile defaults

```bash
ntn-skills ctl library profile list --entry LIBRARY_ENTRY
ntn-skills ctl library profile show PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --profile PROFILE_ID --database LIBRARY_ENTRY
ntn-skills ctl library profile bind PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --default-view
```

Create or replace a complete rule with `profile set PROFILE_ID --entry LIBRARY_ENTRY --name NAME --enabled true|false --base REVISION [--default-view VIEW_ID]`. Use `--base new` only for a new Profile; otherwise copy the exact current revision from show. Omitting the optional View removes an old default. `profile unbind` removes only the machine binding. Explicit `list --view VIEW_ID --database LIBRARY_ENTRY` takes precedence; absent a configured default, use the first View in API order. Bare list discovers the accessible source scope; follow every returned cursor for the complete observation. Rules do not grant access or activate bodies.

### Shared recovery

| Original operation | Read-only reconciliation |
| --- | --- |
| Git source registration | `ctl library source reconcile SKILL_PAGE_ID --entry LIBRARY_ENTRY --source ORIGINAL_SOURCE_ID` |
| Composition registration | Repeat its exact `composition register` input with `--reconcile` |
| Source selection | `ctl library source select reconcile ORIGINAL_PLAN --entry LIBRARY_ENTRY` |
| Profile revision | Repeat the exact complete `profile set` intent with `--reconcile` |

Preserve original input and IDs. Equal current properties or absent remote results do not prove an unknown original request succeeded or was never sent. Missing facts remain unresolved, especially on an independent machine with no local receipt. Do not send these shared IDs to legacy `ctl operation resume`. A verified recovery proves its reported status, not necessarily completion of the intended change.

## Unresolved original results

A verified recovery proves its reported outcome, not necessarily completion of the intended change. Keep successful participants, blocked items and unknown requests separate. Resolve stale unused plans by preparing again; retain a dispatched original plan for reconciliation. Missing access is not deletion. Source failure does not authorize another provider, local copy or latest-branch fallback.

An operation from another retained protocol uses its own returned recovery action and exact original IDs. Its current page, original history and local receipts remain relevant; this Sources workflow does not convert, retire or replace them.
