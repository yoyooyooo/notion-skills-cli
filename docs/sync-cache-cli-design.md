# Sync and cache CLI design

Status: implemented command/parameter design, 2026-10-14. [protocol.md](protocol.md) owns the current executable contract; this document records the accepted design and rationale. The [verification plan](../.cursor/skills/verify-ntn-skills/features/sync-cache-verification-plan.md) owns acceptance cases and evidence requirements. Runtime verification outcomes belong in the external case ledger, not this design.

The public additions are two command groups (`sync`, `cache`), common read-policy flags, explicit-target whole-Skill import, and cache-policy configuration. Keep JSON output, existing selector/naming rules, immutable snapshots and exit conventions. Avoid separate push/pull command families or a flag that bypasses conflict/version checks.

## Read policy on existing commands

Apply the following flags to `read`, `open`, `files` and `export`; apply the same policy vocabulary to `list` with its independent catalog default. Existing path/output/range/database flags retain their meanings.

| Flag | Designed behavior |
| --- | --- |
| omitted | Reuse a complete eligible recent snapshot/catalog within the configured maximum age; otherwise validate online and publish the successful observation |
| `--refresh` | Validate online regardless of cache age; reuse immutable content when its complete version is unchanged |
| `--offline` | Read local cached content/indexes only, allowing expired observations; fail explicitly if missing or identity/scope cannot be selected safely |
| `--max-age DURATION` | Override the age limit for this invocation; `0` requires online validation |

`--refresh`, `--offline` and `--max-age` are mutually exclusive. Defaults are five minutes for unpinned Skill content and 60 seconds for catalog metadata. Expired reads wait for validation; no automatic stale-on-error fallback or background refresh. A failed validation does not update the prior validation timestamp. An offline response describes a cached observation, never current access.

A fixed snapshot ID/pinned ref remains immutable and offline, including `read relative-path --from PINNED_REF`. `--offline` is permitted but redundant on a pinned target. `--refresh` and `--max-age` on a pinned target are invalid arguments, since refreshing cannot change the version selected by that ref. Keep `--raw` as text-only output; callers requiring freshness metadata use JSON.

All successful current-target reads keep existing snapshot/file-ref fields and add freshness metadata. Use `source=notion` for an online-validated result, `source=local_cache` for an unpinned cached result and `source=local_snapshot` for an explicitly pinned result. Examples of additional fields are:

```json
{
  "source": "local_cache",
  "freshness": {
    "policy": "default",
    "validated_at": "ISO-8601 timestamp",
    "age_ms": 12000,
    "max_age_ms": 300000,
    "stale": false
  }
}
```

The example is a schema illustration, not runtime output. `stale` is meaningful relative to the effective age limit. A cached hit does not move `validated_at`. For pinned snapshots freshness relative to the latest remote version is unknown: omit/null latest-validation fields and report pinned policy, rather than deriving freshness from snapshot creation time. `list` retains `fetched_at` and `coverage`; freshness metadata cannot upgrade discovery coverage.

Names/aliases are scoped by credential/workspace/endpoint and selected database. Offline/current-name selection uses only complete appropriate cached catalogs, never an arbitrary same-name latest-pointer entry. Ambiguity and incomplete discovery remain errors. No cross-credential fallback. Where official-login identity cannot be identified reliably from local information, ordinary reads still validate identity online; unpinned offline lookup fails if its scope cannot be determined safely. Pinned reads retain their existing explicit offline behavior.

Examples describe implemented syntax. Bind PAGE_ID, PINNED_REF and other identity placeholders to actual CLI results before execution.

```bash
ntn-skills read 'Release Review' --database personal
ntn-skills read 'Release Review' --database personal --refresh
ntn-skills read 'Release Review' --database personal --offline
ntn-skills read PAGE_ID --max-age 30s
ntn-skills files PAGE_ID --refresh
ntn-skills export PINNED_REF --output ./release-review.zip
ntn-skills list --database personal --offline
```

`export` keeps its no-overwrite output contract. Cache flags affect input selection, not permission to overwrite a directory. Writes, imports, sync plans/applies and `doctor` always use online validation; they do not accept these read-policy flags or inherit a TTL shortcut.

## Sync bindings

A binding identifies one existing Notion page and one local Skill directory. A binding label is local configuration, separate from the Skill invocation alias. Multiple distribution directories for the same page use distinct binding IDs/baselines.

| Command | Parameters | Effect |
| --- | --- | --- |
| `sync bind TARGET` | required `--path DIR`; optional `--as LABEL`, `--database SELECTOR`, `--dry-run` | Resolve an existing current remote page and the logical local path; save configuration. Initialize a baseline only when current contents are confirmed equal |
| `sync status [BINDING]` | optional `--refresh` | Default: inspect local content, stored baseline and the last observed remote state without network. Omitted binding lists all active bindings. Refresh validates the remote state online |
| `sync unbind BINDING` | optional `--dry-run` | Deactivate the binding in configuration; retain local/remote content, common baseline, plans and recovery receipts |

Bind TARGET accepts a current Name/alias, page ID/URL or unpinned pathless Skill ref; it rejects historical snapshot targets. Name resolution occurs only at registration. Store canonical page/database/data-source IDs, and use page ID for every later operation. An optional database selector constrains the page; no database default redirects an existing page. Bind never creates a remote page or copies content implicitly.

`--path` names a directory, including symlink directories. Normalize the logical path to an absolute path while preserving its logical spelling; do not store only `realpath`. Support a not-yet-created ordinary leaf under an existing resolvable parent for initial Notion-to-local materialization. A dangling symlink or cycle is an error, distinct from a missing ordinary leaf. For an established baseline, a missing local directory is an error and never automatic deletion intent.

The default label is the remote invocation alias. If that label is already bound elsewhere, require `--as` instead of rebinding it implicitly. Duplicate registration of the same edge is reusable; conflicting page-to-real-directory mappings stop before content writes. `--dry-run` reports the binding decision without saving configuration/baseline; read caches may still be populated.

An active duplicate edge retains its registered label; a differing explicit `--as` fails with `SYNC_BINDING_CONFLICT`. [Binding contract](protocol.md#synchronization).

If both sides differ, bind saves an explicitly uninitialized binding and reports `needs_initialization`; no baseline is invented. If only the local ordinary leaf is absent, report the same state. Initialize content through an explicit source-selection plan. Status without refresh reports remote observation time and stale/unknown state; it must not claim that the live remote is unchanged.

## Plan and apply

| Command | Parameters | Effect |
| --- | --- | --- |
| `sync plan BINDING` | optional `--from local\|notion`, `--output JSON_FILE` | Strongly read remote and local state, classify changes, persist a content-addressed plan, optionally write an identical reviewable copy |
| `sync plan --all` | optional `--output JSON_FILE` | Plan active bindings together, including shared-page and shared-real-target checks |
| `sync apply --plan PLAN_ID_OR_FILE` | required one plan ID or JSON file path | Revalidate and execute only the saved plan; read back effects before advancing each successful common baseline |
| `sync reconcile BINDING` | no content-write flags | Inspect an unfinished operation using fresh local/remote reads; classify its actual outcome without replaying writes |

Exactly one BINDING or `--all` is required for plan. `--from` is single-binding only, and selects a content source for initialization or an explicit conflict resolution. It does not bypass expected versions, baseline generation, scope or symlink checks. Without `--from`, one-sided changes select direction automatically; differing two-sided changes fail with `SYNC_CONFLICT`. There is no interactive decision based on TTY and no `--force`, apply-time direction override or automatic conflict preference.

A plan is a preview: it does not mutate Skill content or the common baseline. It can write read caches and its plan artifact. Persist plans in the state directory under `sync/plans/p_<sha256>.json`, not in disposable cache. The digest covers stable plan fields, including format version, binding IDs/configuration identity, common-base generation, selected source/direction, remote expected snapshot/version, local content/file hashes, logical/resolved targets, link proofs and proposed file actions. The CLI always returns the plan ID and effective plan path. `--output` produces a reviewable copy; differing existing output is rejected rather than overwritten. Copying a plan does not grant execution against another machine/binding.

`apply --plan` accepts an exact plan ID or a local JSON path, validates its schema/digest and matches it to current registered bindings. It does not implicitly discover/register targets. Changes to the binding, common baseline, local content, real destination/link chain, credential scope or remote version invalidate the plan. Check expected targets again at local commit boundaries. Plan age alone neither authorizes nor rejects execution; the actual preconditions decide validity. Plans with conflicts/missing prerequisites are retained as evidence but are not executable.

For batch planning, group by remote page and resolved local target. One page may have one accepted candidate result in a plan; distinct candidate contents conflict before writes. A push from one local copy can fan out to unchanged independent copies, with each local baseline checked separately. Apply checks all initial preconditions before its first write, performs a grouped remote write once, then verifies its own saved result before local fan-out. No global transaction is promised: a later runtime failure may leave earlier verified bindings complete. Preserve per-binding stages, common bases and affected page/group outcome in a partial receipt.

Reconcile never repeats a mutation. If reads prove the recorded intended content is present on both sides, it can close the receipt and publish the verified common baseline. Otherwise retain the old baseline and report the observed divergence so a new plan can be generated. An unresolved unknown operation fences new applies for the affected page/real target until reconciliation classifies it; conflicts are not resolved by deleting receipts.

Recovery checks the original binding revision and permits only one intervening unbind that leaves the binding inactive. Reconcile before reactivation or relabeling; later binding revisions retain the pending fence. [Recovery contract](protocol.md#synchronization).

## Everyday workflow

```bash
# Register an existing page against the logical distribution path.
ntn-skills sync bind PAGE_ID --path ~/.agents/skills/release-review --as release-review-global

# For a differing first bind, deliberately select the initialization source.
ntn-skills sync plan release-review-global --from notion
ntn-skills sync apply --plan PLAN_ID

# Subsequently choose direction from the stored common baseline.
ntn-skills sync status release-review-global
ntn-skills sync plan release-review-global --output ./release-review-plan.json
ntn-skills sync apply --plan ./release-review-plan.json

# Explicitly resolve a reported two-sided conflict through another checked plan.
ntn-skills sync plan release-review-global --from local
ntn-skills sync apply --plan RESOLUTION_PLAN_ID

# Inspect actual effects after an interrupted or unknown write.
ntn-skills sync reconcile release-review-global
```

Status does not require a separate binding-list command. Plan is already a dry run, so it has no redundant `--dry-run`. Apply is the explicit mutation entry; it has no `--all` or source override because its saved plan fixes both. Missing remote pages are not automatically recreated; use existing create/import deliberately, then establish a new binding.

## Explicit-target whole-Skill import

Extend the existing command with one optional parameter:

```bash
ntn-skills import INPUT --target TARGET [--database SELECTOR] [--dry-run]
```

Without `--target`, retain same-name create/reuse/update behavior. With `--target`, replace the complete portable Skill on the selected existing page while preserving page identity. Name/alias selection is resolved once; a changed imported name never redirects the write. The target can be a current existing selector or an immutable snapshot/pinned main-file ref used as its expected-version baseline. Reject non-main file refs; whole-Skill replacement must not look like writing a single reference file. Missing/inaccessible target fails with no create fallback.

A pinned target enforces its remote version, scope and database ownership before content mutation. An unpinned target captures a current baseline like existing single-file write; it is not sufficient as a saved sync plan's precondition. Sync passes the remote snapshot observed when the plan was generated, not an unrelated older common baseline. Reuse the existing whole-Skill save/References/source-bundle/verification logic; do not implement synchronization through a separate REST writer.

`--name`/`--description` keep their metadata-override roles, and naming constraints still apply; they never select a different page when `--target` exists. `--database` is a constraint on that target, not a creation default. Repeated singleton flags are invalid. Return the existing import `action=update|reuse`, verified snapshot/content identity and previous/expected version where relevant. Keep stale targets as `WRITE_CONFLICT` and partial/unknown outcomes under their existing recovery contract.

## Cache inspection, cleanup and configuration

| Command | Parameters | Effect |
| --- | --- | --- |
| `cache status [TARGET]` | optional `--database SELECTOR` | Offline report of effective config/state/cache directories, cached scopes/observations, snapshot pointers and freshness; no remote validation |
| `cache clear TARGET` | optional `--database SELECTOR`, `--dry-run` | Retire cached latest/selector/catalog observations associated with that target in the selected scope |
| `cache clear --all` | optional `--dry-run` | Retire only disposable application-cache observations in every recorded scope |
| `config set-cache-policy` | `--read-max-age DURATION`, `--catalog-max-age DURATION`; at least one | Save specified defaults offline, preserving authentication, sources and all other settings |
| `config clear-cache-policy` | none | Restore built-in defaults; no cache/state/content removal |

`cache clear` requires exactly one current target or `--all`. It never clears bindings, plans, pending receipts, common baselines, immutable snapshots or content objects. Retire catalog observations containing a selected target conservatively rather than pretending a partial catalog remains exhaustive. Cache clearing follows the verified system-trash/retention mechanism and reports a missing mechanism as a prerequisite failure; it does not silently perform permanent deletion. `--dry-run` previews selected entries without retiring them. Cache status can report multiple stored scopes without selecting any as the current account. If a targeted operation cannot disambiguate its local identity, require a page ID/scoped selection or return an error; never guess a same-name page.

There is no initial cache `gc`, state-reset command, automatic watch daemon, stale-on-error flag or baseline-adopt command. The explicit `--offline` policy already supplies an intentional local read; only checked convergence can promote a common baseline.

Accept finite nonnegative integer durations: `0`, `Ns`, `Nm`, `Nh`, `Nd`; bare nonzero numbers, fractions, negatives and overflow are invalid. Store milliseconds, render effective milliseconds in JSON and readable durations in help. `config show` retains sanitized configuration and additionally reports the effective cache policy; no token material enters keys/output.

Add `NTN_SKILLS_CACHE_HOME > $XDG_CACHE_HOME/ntn-skills > ~/.cache/ntn-skills`. Preserve existing `NTN_SKILLS_HOME`/XDG state and configuration precedence. Directory selection is global configuration/environment behavior, not repeated `--state-dir` flags on every command. The helper and installed-consumer smoke must isolate all three roots.

## Output and failures

Keep one JSON value on stdout, offline help/version text, exit 0 for success, exit 1 for operational failure and exit 2 for invalid arguments. Designed command outputs use these observable distinctions:

- Bind: binding identity/page/database, logical/resolved path, `baseline_initialized` and initialization status. A valid uninitialized registration is a successful configuration action, not successful content synchronization.
- Status: local/common-base identities, remote observation time/freshness, pending receipt and whether comparison is authoritative or provisional.
- Plan: plan ID/path, applicable status, per-binding direction (`push`, `pull`, `unchanged`, `advance_baseline`), expected versions, explicit source decision and file actions. No content baseline is changed.
- Apply: per-binding completed action, verified resulting snapshot/content, baseline generation before/after and receipt. Set `verified=true` only for readback-confirmed results.
- Reconcile: observed outcome and whether baseline was actually advanced. Divergence is explicit; an unresolved or unsafe outcome is a nonzero failure.

Reuse `WRITE_CONFLICT`, `WRITE_PARTIAL`, `WRITE_OUTCOME_UNKNOWN`, `OUTPUT_CONFLICT`, naming/access/state/path errors where their meanings already fit. Add narrowly scoped codes for missing/ambiguous binding, initialization required, differing sync candidates, stale plan/target drift, interrupted sync, missing cache or unselectable cached identity. Conflict errors include the retained plan/receipt path and safe before/after identities so callers can inspect the rejected action. They never include signed URLs or credentials. Exact additions must be documented with implemented schemas rather than inferred from this design.

## Compatibility and verification mapping

Changing unpinned reads from always-online to bounded cache reads is a behavior change for the next 0.x minor release. Upgrade guidance: use `--refresh` where callers require a current remote observation; follow returned pinned refs for one immutable activation; normal reads accept the explicit five-minute bound. Existing pinned references, mutation checks, import without target and no-overwrite exports retain their semantics.

Existing state-directory catalogs are historical observations, not proof of a fresh whole-Skill snapshot. On upgrade, keep immutable snapshots/objects, configuration and upload/recovery data in place; rebuild disposable latest/catalog indexes under the selected cache root. An absent new cache must cause normal online validation, not state deletion or implicit baseline initialization. Continue honoring the existing state/config overrides.

Help, protocol, usage, both READMEs, host integration, Bootstrap Skill guidance and affected verification recipes are updated with the implementation. A source update does not itself prove a runtime case; record observed outcomes separately.

The verification matrix covers singleton repetition, duration boundaries, policy mutual exclusion, pinned/ref-relative policies, required plan selection, bind dry-run versus real initialization, unbind retention, import target rename/missing/stale/ref rejection, conflict-source decisions, batch candidate conflicts, cache-clear scope/retention and zero provider calls from eligible warm reads. Exercise actual help, source CLI and installed Node.js consumer for affected entry points; keep fake-provider, live and offline-package proof distinct.
