# Discovery, configuration, authentication and doctor

Users discover available databases and Skill metadata, register a precise local database alias, choose creation preferences and check existing authentication without starting a login flow.

This recipe covers catalog policy, cache inspection/retirement and cache-policy configuration. [Command coverage](README.md#accepted-design-coverage) and [cache/parameter cases](sync-cache-verification-plan.md#cache-time-and-identity-matrix) own the wider matrix; [protocol](../../../../docs/protocol.md) owns exact result semantics. Doctor remains a strong online probe. Recipes are unrun until the main verifier records evidence.

## Sub-features

- `discover-help`: offline command and version discovery.
- `discover-sources`: broad database discovery, explicit selection and local registration.
- `discover-catalog`: paginated metadata, query filtering, refresh and coverage.
- `config-preferences`: sanitized configuration and creation-default changes.
- `auth-token`: stdin token storage, configuration precedence and fallback restoration.
- `doctor-access`: official `ntn` availability, authentication, coverage and one available Skill read.
- `cache-policy`: effective content/catalog defaults and persisted policy overrides.
- `cache-retention`: offline scoped status and system-Trash retirement without state loss.

## How to get to it (user POV)

Each entry point below needs its own proof:

- Root `--help`, a command's `--help`, and `--version`.
- `database list`, then explicit `database list --database` with the selected ID/URL or registered alias.
- `source add` and offline `source list`.
- `list`, `list --database`, `list --query`, `list --refresh`, `list --offline` and `list --max-age`.
- `config show`, `config set-default`, `config clear-default`, `config set-cache-policy` and `config clear-cache-policy`.
- `config set-token --stdin`, `config clear-token`, and `doctor` with the selected credential source.
- `cache status [TARGET]`, `cache clear TARGET --database`, and `cache clear --all`, with dry-run and real retention proof.

## Driving it with control-ntn-skills

Preconditions:

- Follow the [index](./README.md) isolation and variable conventions. Set `DATABASE_ALIAS=verification-selected` for this scratch registration. Set `QUERY` to a name, invocation alias or description fragment actually present in a selected catalog result.
- Inherited `NOTION_API_TOKEN` is non-empty. The helper intentionally ignores stdin and rejects `config set-token`; it uses inherited authentication and never relays token input. Keep sanitized responses in `$RUN/evidence`.

- **Help/version.** Run each command below. Help/version are text, exit 0, and help does not trigger online work. Repeat command help for each command under acceptance; root help alone does not cover it.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- --help
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read --help
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- --version
  ```

- **Database discovery and registration.** Drive broad discovery, explicit validation, registration, local listing and alias selection separately. Responses identify databases and data sources; explicit selection must identify the selected database, and `source list` must retain its canonical ID and registered alias.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- database list
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- database list --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- source add "$DATABASE_ALIAS" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- source list
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- database list --database "$DATABASE_ALIAS"
  ```

- **Catalog.** Record scope, database map, count, fetched_at, coverage, source and freshness. Metadata excludes bodies/manifests. Catalog default is 60s; fresh acceptance uses --refresh, while ordinary cached/offline reads remain separate evidence and cannot upgrade coverage. Record request counts only when observable; fast wall time alone is not zero-network proof.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE_ALIAS"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --query "$QUERY"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --refresh
  ```

  After warming the selected complete catalog, drive ordinary, offline and max-age reads separately and retain source/validation timestamps. Repeat invalid combinations/durations through the actual CLI (P1); failures must be exit 2 before online work. Official-login mode may require online identity checks; unsafe unpinned offline scope fails rather than guessing an account.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --offline
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --max-age 30s
  ```

- **Creation preference.** Capture configuration before, after setting and after clearing. The default stores a canonical database ID; clearing it preserves registrations and token presence. None of these changes mutate Notion.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config set-default "$DATABASE_ALIAS"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config clear-default
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config show
  ```

- **Cache policy and retention.** Snapshot effective config/state/cache roots and existing pinned versions, binding/baseline/plan/receipt bytes. All three roots and XDG bases must point inside scratch; keep launcher transpiler cache separately owned as the index prescribes. Save policy, launch a new process, inspect effective milliseconds, clear policy and compare unrelated settings/token presence. Defaults are 300000/60000 ms. Never record tokens.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config set-cache-policy --read-max-age 5m --catalog-max-age 60s
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config clear-cache-policy
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- cache status
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- cache status "$PAGE_ID" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- cache clear "$PAGE_ID" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- cache clear "$PAGE_ID" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- cache clear --all --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- cache clear --all
  ```

  Bind PAGE_ID from a real catalog result. Status makes no network request; targeted clear retires the selected scoped latest/selector/catalog observations conservatively. --all retires every recorded cache scope, never immutable state. Capture system Trash retention paths/receipts and prove pinned reads, baselines, plans and unfinished receipts survive a second process. Missing retention mechanism must fail with no permanent deletion. C18 covers other targets/ambiguous catalogs; do not infer it from a single target.

- **Environment authentication and clearing config.** Use inherited `NOTION_API_TOKEN` for live access. Capture `config show`, clear any scratch configured token and confirm `token_configured=false`; doctor must still prove remote access through the environment fallback. The baseline does not copy personal configuration.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config clear-token
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config show
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$RUN"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- doctor
  ```

  Doctor reports `ntn_version`, `authentication`, counts, `coverage` and `skill_read`; require accessibility, then explicitly scope subsequent list operations to the selected plan database. When a Skill exists, require `checked=true`, `available=true` and the expected storage mode. Record `checked=false` as an unavailable read probe, not successful Skill-read proof.

- **Separate token-storage entry.** `config set-token --stdin` is direct CLI proof outside the helper. Main verifier may cite config tests only after running them. Live precedence needs isolated config/state/cache and trusted piped input without token arguments/interpolation/recorded stdin; preserve sanitized transitions and doctor/current `read PAGE_ID --refresh` results. Baseline helper does not prove token storage/login fallback.

## Gotchas

- Search is eventually consistent and not exhaustive. Inspect `coverage.failed_sources` and `search_index_limited`; a missing row is not proof of workspace absence.
- Database aliases are case-sensitive; titles are display labels. Skill invocation aliases are a different namespace. A default affects create/import only, not read discovery.
- Authentication priority is non-empty config token, non-empty environment token, then existing official `ntn` login. The helper's baseline uses inherited environment credentials; proving existing-login fallback separately requires an authorized environment with neither token source.
- Doctor has no database selector, reads broadly and may cache one available Skill. It never starts login. Local isolation does not isolate the shared remote database.
- Fresh content readbacks use --refresh on a current page/ref; pinned refs remain unchanged. Cache/config operations preserve authentication/sources/bindings and cannot advance a sync baseline.
- Tokens must never appear in arguments, evidence or reports. Scratch config stores its configured token in plaintext with private permissions; cleanup removes scratch and preserves evidence and retained Notion skills.
