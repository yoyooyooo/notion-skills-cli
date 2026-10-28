# Discovery, configuration, authentication and doctor

Users discover available databases and Skill metadata, register a precise local database alias, choose creation preferences and check existing authentication without starting a login flow.

This recipe covers catalog policy, cache inspection/retirement and cache-policy configuration. [Command coverage](README.md#accepted-design-coverage) and [cache/parameter cases](sync-cache-verification-plan.md#cache-time-and-identity-matrix) own the wider matrix; [protocol](../../../../docs/protocol.md) owns exact result semantics. Product Doctor remains an online probe; helper Doctor defaults to offline readiness and requires `--live` for that probe. Recipes are unrun until the main verifier records evidence.

## Sub-features

- `discover-help`: offline command and version discovery.
- `discover-sources`: broad database discovery, explicit selection and local registration.
- `discover-catalog`: paginated metadata, query filtering, refresh and coverage.
- `discover-default-context`: optional Notion checkbox decoding; missing/unchecked values emit false, checked values emit true, and a wrongly typed property fails explicitly. Complete discovery and explicit reads retain every record.
- `config-preferences`: sanitized configuration and creation-default changes.
- `builtin-preference`: independently validated `builtin_database` for first publication, exact-target updates unaffected by that preference, sanitized set/clear preserving ordinary defaults and registrations.
- `auth-token`: stdin token storage, configuration precedence and fallback restoration.
- `doctor-access`: official `ntn` availability, authentication, coverage and one available Skill read.
- `cache-policy`: effective content/catalog defaults and persisted policy overrides.
- `cache-retention`: offline scoped status and system-Trash retirement without state loss.
- `database-init`: official two-table create/attach, durable operation recovery, exact property IDs and native relation validation; subscription database remains outside ordinary content discovery.

## How to get to it (user POV)

Each entry point below needs its own proof:

- Root `--help`, a command's `--help`, and `--version`.
- `ctl database list`, then explicit `ctl database list --database` with the selected ID/URL or registered alias.
- `ctl database register`, offline registrations via `ctl config show`, and `ctl database unregister`.
- `ctl database init --parent EXACT_RUN_PARENT`, or `ctl database init --content-database EXACT_CONTENT_ID --upstream-database EXACT_UPSTREAM_ID`; repeat the same operation and then consume from an independent empty local state.
- **Additive source schema upgrade.** Retain an already-published attach and repeat its identical `ctl database init --content-database EXACT_CONTENT_ID --upstream-database EXACT_UPSTREAM_ID` inputs, optionally pinning `--operation OPERATION_ID`. If the original operation used `--parent`, repeat that original input instead. Changed inputs under the same operation ID must fail. Capture raw Notion schema before/after. Source Type select has exactly builtin/upstream/manual and Builtin ID is rich_text. Preserve native title labels and property IDs. Repeat again and prove no duplicate fields/rows/tables. Legacy rows stay unset and incompatible existing fields fail safely. Ordinary create on missing-field tables remains usable and upgraded tables read back manual. Ordinary replace/write preserve preset and unset values. Public ContentRecord JSON and CLI source flags remain unchanged. Record actual observations only.
- `list`, `list --database`, `list --query`, `list --refresh`, `list --offline` and `list --max-age`.
- `ctl config show`, `ctl config set KEY VALUE` and `ctl config unset KEY` for each supported preference key.
- `ctl config set-token --stdin`, `ctl config clear-token`, and `ctl doctor` with the selected credential source.
- `ctl cache status [TARGET]`, `ctl cache clear TARGET --database`, and `ctl cache clear --all`, with dry-run and real retention proof.

The AH258 fixture receipt is held by the orchestrator at `ah258/notion-init-receipt.json`. Use only its run parent and exact created table IDs. Verify Kind select skill/router/prompt; missing Kind on historical content decodes skill. Verify Members is a self relation with `single_property` (no reverse field, multiple members allowed), and Upstream/Skills is a dual relation targeting the exact opposite data source. Upstream allows at most one subscription in the product decoder. Validate Publication and provenance rich_text fields without rewriting existing page content. A wrong field type, wrong relation target or wrong direction must fail before schema changes. Repeating a completed init must retain both exact database IDs. Unknown creation outcomes must reconcile the operation marker and never replay creation by name. Check `upstream_database` independently of `default_database`, and confirm the subscription table is excluded from catalog discovery. Mark these cases unverified until actual installed CLI and isolated state evidence is recorded.

## Driving it with control-ntn-skills

Preconditions:

- Follow the [index](./README.md) isolation and variable conventions. Set `DATABASE_ALIAS=verification-selected` for this scratch registration. Set `QUERY` to a name, invocation alias or description fragment actually present in a selected catalog result.
- Inherited `NOTION_API_TOKEN` is non-empty. The helper intentionally ignores stdin and rejects `ctl config set-token`; it uses inherited authentication and never relays token input. Keep sanitized responses in `$RUN/evidence`.

- **Help/version.** Run each command below. Help/version are text, exit 0, and help does not trigger online work. Repeat command help for each command under acceptance; root help alone does not cover it.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- --help
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read --help
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- --version
  ```

- **Database discovery and registration.** Drive broad discovery, explicit validation, registration, local listing and alias selection separately. Responses identify databases and data sources; explicit selection must identify the selected database, and `ctl config show` must retain its canonical ID and registered alias. After alias-selection proof, unregister the owned alias and inspect configuration again; unrelated registrations and canonical preferences must survive.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl database list
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl database list --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl database register "$DATABASE_ALIAS" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl database list --database "$DATABASE_ALIAS"
  ```

- **Catalog.** Record scope, database map, count, fetched_at, coverage, source and freshness. Metadata excludes bodies/manifests. Catalog default is 60s; fresh acceptance uses --refresh, while ordinary cached/offline reads remain separate evidence and cannot upgrade coverage. Record request counts only when observable; fast wall time alone is not zero-network proof.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE_ALIAS"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --query "$QUERY"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --refresh
  ```

  After warming the selected complete catalog, drive ordinary, offline and max-age reads separately and retain source/validation timestamps. Repeat invalid combinations/durations through the actual CLI (P1); failures must be exit 2 before online work. Official-login mode may require online identity checks; unsafe unpinned offline scope fails rather than guessing an account.

  For `discover-default-context`, use only an authorized owned fixture to compare `Default Context` absent, unchecked and checked states with fresh `list --database` results. Retain boolean `default_context`, full catalog membership and explicit reads for unchecked records. A wrong-type controlled fixture must fail with `INVALID_RESPONSE`; legacy cached metadata must decode missing values as false. Host catalog filtering and session-neutral background preparation require the separate [broker consumption map](broker-consumption.md); CLI output alone does not prove those behaviors.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --offline
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --max-age 30s
  ```

- **Creation preference.** Capture configuration before, after setting and after clearing. The default stores a canonical database ID; clearing it preserves registrations and token presence. None of these changes mutate Notion.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config set default_database "$DATABASE_ALIAS"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config unset default_database
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config show
  ```

- **Official publication preference.** In scratch, capture `ctl config show`, set `ctl config set builtin_database "$DATABASE_ALIAS"`, inspect again, clear with `ctl config unset builtin_database`, then compare. Set validates online and saves the canonical ID; unset works offline. Prove ordinary default, source registrations, token presence, policy and bindings survive, and unknown/inaccessible selectors fail without changing the preference. Capture any live preflight via `ctl builtin publish notion/ntn-skills-maintain --dry-run`; keep create/update behavior in the [publication recipe](import-create-recovery-dry-run.md). The priority is explicit database → built-in publication default → ordinary creation default → sole discovery. Updates retain their exact target and ignore both defaults.

- **Cache policy and retention.** Capture effective config/state/cache/data roots and pinned versions through public `ctl cache status`, `ctl config show`, `sync local status` and `operation show` results; use `ctl backup --output` when retaining the database and referenced immutable files. Mutable bindings, bases, plans, receipts and observations are SQL state, not loose JSON files. All four roots and XDG bases must point inside scratch; builtin commands also require an owned HOME. Keep launcher transpiler cache separately owned as the index prescribes. Save policy, launch a new process, inspect effective milliseconds, unset policy keys and compare unrelated settings/token presence. Defaults are 300000/60000 ms. Never record tokens.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config set cache_policy.read_max_age_ms 300000
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config set cache_policy.catalog_max_age_ms 60000
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config unset cache_policy.read_max_age_ms
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config unset cache_policy.catalog_max_age_ms
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl cache status
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl cache status "$PAGE_ID" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl cache clear "$PAGE_ID" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl cache clear "$PAGE_ID" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl cache clear --all --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl cache clear --all
  ```

  Bind PAGE_ID from a real catalog result. Status makes no network request; targeted clear retires the selected scoped latest/selector/catalog observations conservatively. --all retires every recorded cache scope, never immutable state. Capture system Trash retention paths/receipts and prove pinned reads, baselines, plans and unfinished receipts survive a second process. Missing retention mechanism must fail with no permanent deletion. C18 covers other targets/ambiguous catalogs; do not infer it from a single target.

- **Environment authentication and clearing config.** Use inherited `NOTION_API_TOKEN` for live access. Capture `ctl config show`, clear any scratch configured token and confirm `token_configured=false`; doctor must still prove remote access through the environment fallback. The baseline does not copy personal configuration.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config clear-token
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$RUN" --live
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl doctor
  ```

  Doctor reports `ntn_version`, `authentication`, counts, `coverage` and `skill_read`; require accessibility, then explicitly scope subsequent list operations to the selected plan database. When a Skill exists, require `checked=true`, `available=true` and the expected storage mode. Record `checked=false` as an unavailable read probe, not successful Skill-read proof.

- **Separate token-storage entry.** `ctl config set-token --stdin` is direct CLI proof outside the helper. Main verifier may cite config tests only after running them. Live precedence needs isolated config/state/cache and trusted piped input without token arguments/interpolation/recorded stdin; preserve sanitized transitions and doctor/current `read PAGE_ID --refresh` results. Baseline helper does not prove token storage/login fallback.

## Gotchas

- Search is eventually consistent and not exhaustive. Inspect `coverage.failed_sources` and `search_index_limited`; a missing row is not proof of workspace absence.
- Database aliases are case-sensitive; titles are display labels. Skill invocation aliases are a different namespace. A default affects create only, not read discovery or exact-target replacement.
- Authentication priority is non-empty config token, non-empty environment token, then existing official `ntn` login. The helper's baseline uses inherited environment credentials; proving existing-login fallback separately requires an authorized environment with neither token source.
- Doctor has no database selector, reads broadly and may cache one available Skill. It never starts login. Local isolation does not isolate the shared remote database.
- Fresh content readbacks use --refresh on a current page/ref; pinned refs remain unchanged. Cache/config operations preserve authentication/sources/bindings and cannot advance a sync baseline.
- Tokens must never appear in arguments, evidence or reports. Scratch config stores its configured token in plaintext with private permissions; cleanup removes scratch and preserves evidence and retained Notion skills.

## View acceptance

Run `bun test packages/core/test/views.test.ts` for ordered first selection, native-query continuation, exact URL identity, checkbox independence, empty/failure distinction and scoped caching. Run Node Vitest `packages/core/test/sqlite-state.node.test.ts` for real process generation/retirement fences. With existing read authorization, run built/installed CLI `views --database ID`, `list --default-view --database ID`, and an explicit View with more than 100 members to verify the actual pagination contract. Save complete JSON envelopes; report member failures without claiming full coverage. Host prompt injection requires the Broker's separate real Pi/OMP route.

Run Node Vitest `packages/core/test/upstream-rebuild.node.test.ts` to verify selected-member Tags survive native rebuild and deleted-page restore using real local Git/SQLite and a controlled Notion boundary. The route includes an applied-but-lost Tags response, a conflicting user edit, same-operation readback without a second Tags PATCH, preserved member Default Context and unchanged sibling binding. It performs no production rebuild.
