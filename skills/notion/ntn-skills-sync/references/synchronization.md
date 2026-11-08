# Source and supply decisions

## Daily paths

| Relationship | Start once | Continue |
| --- | --- | --- |
| Active shared Source | `ctl library sources put` and exact `bind` | `sources prepare`, reviewed `apply`; `reconcile` original plan |
| One-time import/export/edit | Use `ntn-skills-maintain` | No recurring binding is established |

Use installed help/schema for flags and actual output fields. Use CLI-generated plans; do not manufacture operation records or verification receipts.

## Active Sources definitions

The current four-table model separates mutable Sources from immutable selected content in Records. Use `ctl library sources providers` for offline capabilities and `list/show/members --entry ENTRY` for complete current identities and associations. The Sources reverse relation may be truncated by Notion; `members` queries the forward Skills Origin relation and follows all cursors. A Source with no current bound members is valid; a retained former published-members manifest is not permission to recreate deleted content or guess by name.

`put` takes a complete version-1 definition with `source_id`, name, description, enabled, policy, adapter, selection and options. Read the installed `sources put --help` and the [Source management guide](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/sources-management.md) for exact Git and Linear JSON examples. Copy the last observed fingerprint into `--expect`; edits do not change current Skill pins. `bind` requires exact target/member and expected current Origin. A single-origin refresh rejects `shared_target_set`; combined contributors require an explicitly composed source.

`check` resolves a complete provider candidate. `fetch` writes one exact member's portable files to a new/identical directory. `ctl library sources prepare SOURCE --entry ENTRY --target PAGE --output PLAN` combines exact provider bytes with the current native custom/following/tombstone state and verifies the effective file tree without remote writes. `apply PLAN --entry ENTRY` checks the original configuration, target, resources and current expectations, stores content chunks and the bundle, then uses the common guarded selection journal. It verifies the result and records the last successful revision; no automatic cron, whole-library sync or native-body overwrite is implied.

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

Preserve original input and IDs. Equal current properties or absent remote results do not prove an unknown original request succeeded or was never sent. Missing facts remain unresolved, especially on an independent machine with no local receipt. Use the recovery action returned for the exact source operation. A verified recovery proves its reported status, not necessarily completion of the intended change.
