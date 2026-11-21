# CLI and SDK reference

This reference describes the current `next` CLI and SDK 2.
The [current library contract](current-contract.md) defines table ownership, current descriptors,
operation states, and the remaining cutover work.
Use [the usage guide](usage.md) for commands and [the authoring guide](shared-authoring.md) for complete imports.

## Commands and output

The package and executable are `ntn-skills`.
Normal CLI results contain one JSON value on stdout.
Success includes `ok: true`. Typed failures include `ok: false`, `error.code`, and `error.message`.
A failure may also include `error.details`, request metrics, and a suggested `next.argv`.

Help and version return text. `read --raw` returns successful UTF-8 content as text.
`use` has its own instruction-text output; use `--json` for its structured result.
Stderr can contain runtime warnings. It is not a second stable result channel.

Exit status is 0 for success, 1 for an operation failure, 2 for invalid arguments, and 130 for interruption.
A suggested next command does not authorize another mutation.

The installed parser is the command reference:

```bash
ntn-skills schema
ntn-skills schema ctl library import
ntn-skills schema ctl library projection
ntn-skills schema ctl library profile set
```

`schema` and `--help` work offline.
Schema output includes parameter types, occurrence bounds, defaults, and constraints.
The root schema is shallow; query an exact command path for its full definition.

| Command | Current responsibility |
| --- | --- |
| `list` | Paginated discovery metadata with explicit coverage |
| `read` | One selected file or text range |
| `use` | Instructions and Requires expansion |
| `files` | Complete selected file directory and returned refs |
| `export` | Complete selected bytes in a local ZIP or directory |
| `ctl library init/inspect/files` | Current descriptor, initialization, or selected-owner directory |
| `ctl library import` | Complete current Skill replacement, dry run, or same-operation resume |
| `ctl library source apply/refresh` | Explicit Git contribution changes and same-parent finite recovery |
| `ctl library projection` | Complete Notion text for one current Skill or the daily set, with read-only preview and single-Skill resume |
| `ctl library profile` | Current shared Profile rules and machine selection |
| `ctl config/cache/builtin/doctor` | Local configuration, cache, packaged Skills, or scoped diagnostics |
| `ctl views/prepare/resolve` | View discovery, graph preparation, or relative-reference resolution |
| `ctl api` | A scoped read-only Notion API request |

## Identity and selected reads

Current shared identity is `shared_skill:<library_id>:<skill_id>`.
Names are discovery labels. The stable Skill ID identifies a Skill within its library.
The main file has a stable File ID on the Skills page. Every supporting path has a Files row.

A returned `skill://` ref can contain the selected file identity and local snapshot.
Preserve returned refs rather than constructing them from a title.
`read RELATIVE --from CONTAINING_REF` resolves within the containing file's selection.

A local snapshot fixes the manifest for one selection.
A complete manifest does not imply that every file's bytes are cached.
Missing bytes can be fetched only through that selection's unchanged current acquisition route.
An unavailable selection returns an explicit failure and requires current reselection.
It does not trigger remote history recovery.

Current targets accept one of `--refresh`, `--offline`, or `--max-age`.
Fixed refs and snapshot IDs reject refresh and max-age.
Offline content is evidence of a local selection, not proof of current remote access.
Ordinary reads check Enabled and reject an observed unfinished current operation.

## Current management commands

`ctl library skill create INPUT --entry ENTRY --skill-id ID` selects native
Markdown and exact resources for other files. `skill update TARGET` changes only
explicit content, metadata or relations; unmentioned files stay current.
`skill register PAGE_ID` preserves an authored page in the exact Skills table and
fills missing registration. `skill remove TARGET` owns supporting/resource
retirement and incoming same-library Members/Requires cleanup. Every action uses
exact identities, dry-run and shared request budgets. See [daily authoring](shared-authoring.md#manage-native-skills).

`ctl library import INPUT --entry ENTRY --skill-id ID` admits the complete local input before Notion access.
The accepted input is a directory, ZIP, or explicitly selected Markdown file.
The input limit is 128 MiB expanded and 10,000 entries. The ZIP wire limit is 138 MiB.

The default representation is exact Notion resource content. Generated reading projections are separate and do not block readiness.
An existing Notion-owned supporting file omitted from the input is removed.
Repeat `--native PATH` for editable supported Markdown with exact frontmatter and
mode. All native writers accept normal LF/CRLF and terminal newlines, verify full
Notion readback for structural equivalence and report formatting normalization.
Original input fingerprints remain fixed; native read/export uses the current
Notion body. Lost content or changed meaning cannot complete an intent.
Unknown or noncanonical native paths are rejected locally; the selection is part
of the input fingerprint and must match on resume. A target containing any Source
main or supporting file returns `CURRENT_SOURCE_MANAGEMENT_REQUIRED` in both dry-run
and apply, even when the exported bytes are unchanged. Source removal, takeover,
renaming and rebinding need coordinated contribution management; use Source
apply/refresh for its supported mapping and exclusion changes. Takeover and
Source removal remain separate work. Reading or exporting the target remains available.
Portable version 2 supports the canonical main path for its content kind.
Portable relations carry same-library unpinned `shared_skill` refs. Omitted Members
or Requires preserves that field, `[]` clears it, and an array replaces the full set.
Prompt inputs reject relations. Both fields require registered single-property
relations to the same Skills data source. Names, page URLs, foreign libraries,
duplicate/self targets, projection metadata and unknown fields fail admission.
Changed sets are limited to 100 targets; larger unchanged sets are retained after
complete pagination. Changed Requires checks its reachable dependency closure for
cycles and rechecks the observed closure before ready. Export includes both sets.

`--dry-run` reads current metadata without remote mutation or operation allocation.
It reports the input hash, desired files, removals, and the body checks still required during apply.
`--operation ID --resume` continues the same complete input and original operation.
Apply returns success only with a ready current tree. Its current result includes
`library.library_id`, `library.database_id`, `library.data_source_id`, operation,
Skill/page identities, input hash, files and relation summary. Brokers use this
binding to invalidate only the corresponding directory after mutation.
These commands do not create content versions.

`ctl library source apply INPUT --entry ENTRY` accepts one complete bounded JSON
`{version:1,definition,contributions}`. `source refresh SOURCE_ID --entry ENTRY`
reads that declaration from the current Source and uses the same coordinator.
Regular Git files from GitHub or credential-free HTTP(S) Git origins support manual/pinned policy and local machine authentication. All selected discovered members are included; contributions preserve stable identity overrides. New identities are deterministic. Upstream member deletion, including an empty selection, retires pure Source Skills and Files. Provider failures do not authorize deletion. Contribution mapping/exclude uses exact member-relative file paths; Selection filtering chooses members.

Source dry-run reads the provider and affected current directories, with zero
semantic writes. Source success returns the same `library` triple, `state: ready`,
Source/page identities, affected Skill IDs and child results. Retired children have `state: removed`, `status: removed` and `files: 0`; completed current children remain `state: ready`. Rebuilt physical page IDs can change while stable Skill IDs remain. These results invalidate matching Broker discovery, without adopting content from the write result. Resume uses the
original operation, complete declaration and frozen commit; a changed visible
Notion declaration cannot replace that original input. Parent progress is a
finite target cursor, removed with the operation on completion. Desired paths explicitly replace native/resource authority; excluded native bodies and unrelated contributors are preserved. Generated projections do not gate completion. Both paths share the same
HTTP budget; Git subprocess HTTP/wire bytes are unmetered, while deadline and
file limits still apply. See [authoring](shared-authoring.md#apply-or-refresh-a-git-source).

`ctl library projection PAGE_ID --entry ENTRY` reads the current complete tree and
verified originals, renders source/resource text with the existing renderer, and
checks the actual Skills/Files bodies. Native bodies are verified without writing;
non-text files are explicitly skipped. `--dry-run` inspects without writes. Equal
complete bodies are a zero-write no-op. Projection keeps the real Skill ready, so
an unfinished generated-body intent does not block ordinary consumption.

`projection --daily --entry ENTRY` selects Source 日用 current members ∪ Skill 日用
∪ Default Context. Complete checkbox-schema and pagination checks precede target
writes. Existing Enabled and 期望删除 are reported and preserved. The batch stops
on the first failure and reports completed/remaining targets plus the exact
single-Skill operation. Resume it with `projection PAGE_ID --entry ENTRY
--operation ID --resume`, then rerun daily. Daily rejects `--operation` and
`--resume`; projection exposes no supersede. One invocation budget covers the
whole batch. See [text generation](shared-authoring.md#generate-readable-text-in-notion).

Profiles have one current Record and a conflict-detection fingerprint.
`profile set` replaces the full rule set and requires `--name`, `--enabled`, and `--expect`.
Omitted optional rules are removed.
`--reconcile` observes an unresolved Profile intent without repeating its mutation.
Profiles and Views do not bypass access or Enabled checks.

## SDK 2

The package exports the Node ESM module `ntn-skills/sdk` and its TypeScript declarations.
`SDK_VERSION` is 2. Payload contract versions remain separate from the SDK version.

| Export | Result or behavior |
| --- | --- |
| `listCatalog`, `listSkills` | Directory metadata and bounded list pages |
| `readSkill`, `listSkill` | Selected file read or complete file directory |
| `consume` | Contract version 1 instruction preparation with complete manifests |
| `readResources` | Contract version 1 acquisition of a bounded exact file set |
| `decodeConsumeResult`, `decodeResourceReadResult` | Local validation of the corresponding result contract |

SDK calls accept an optional environment, working directory, abort signal, and request-metrics callback.
They use the same credential provider, Store, and request engine as the CLI.
Consumption does not mutate Notion. Current import and Profile commands are CLI management entrypoints.

Consumption effects contain exactly `version: 1`, `remote_writes`, and `author_content`.
`remote_writes: "none"` requires `author_content: "unchanged"` and is backed by the
read-only transport boundary. Hosts preserve `unknown` when a result is missing,
invalid, or truncated; a later zero-write result cannot erase that uncertainty.
The retired `retained` outcome and `retention` field are rejected, including an empty array.

`consume` and `readResources` return discriminated `ready`, `failed`, or `cancelled` results.
A ready result distinguishes complete manifest metadata from the files whose bytes are ready.
Preparation does not establish host delivery or activation.
The host remains responsible for those outcomes.

```ts
import { consume, SDK_VERSION } from "ntn-skills/sdk"

const result = await consume(
	{ version: 1, targets: ["EXACT_REF_FROM_LIST"], purpose: "use" },
	{ database: "LIBRARY_ENTRY" },
)
```

The generated SDK declarations own the exact input and output types.
Nonempty `requestedFiles` in `consume` is reserved and rejected.
Use `readResources` for a selected supporting-file set.

## Requests and limits

Limits apply to different boundaries. A small output page does not imply a fixed HTTP cost.

| Boundary | Current limit or behavior |
| --- | --- |
| `list --limit` | 1–500 returned metadata records, default 50 |
| Current file index | Complete pagination for the selected owner before claiming a complete directory |
| Graph preparation | Defaults of 64 nodes, depth 16, 1 MiB instructions, and 256 KiB context |
| `readResources` | Defaults of 16 files, 1 MiB, and 30 seconds; maxima of 64 files, 16 MiB, and 120 seconds |
| Notion service | Four concurrent attempts by default; `NTN_SKILLS_NOTION_CONCURRENCY` accepts 1–64 |
| Local request schedule | Default 350 ms admission spacing, shared by participating CLI processes on one machine |
| Admission | One five-minute deadline across a request's retries; bounded queue of 256 |
| HTTP attempt | `NTN_SKILLS_REQUEST_TIMEOUT_MS`, default 30 seconds, for each attempt |
| Current import, Source management and projection | `--max-requests` default 1000 attempts; `--max-bytes` default 536870912 payload bytes; `--timeout` default 600000 ms for the complete invocation |

Graph budgets count nodes and bytes; they are not HTTP request-count limits.
Current import includes library lookup, relation closure, retries, uploads,
provider downloads, native body writes, pagination, cleanup and readback in one
invocation budget. Projection similarly includes daily selection, all selected
Skills, original acquisition, generated bodies and readback. The three flags
require positive safe integers. Nested calls
reuse the same budget. Success and operational errors report the budget snapshot.

Known request bytes must fit before dispatch. An admitted response is accounted
at its response boundary and can exceed the byte limit; no subsequent request
is admitted after exhaustion. Limits exclude HTTP/TLS framing. A timeout or
exhausted budget preserves uncertain effects and the unfinished operation. A new
explicit resume gets a fresh invocation budget without creating content history.
A per-attempt timeout alone does not bound an unrelated command or full census.

Eligible identical in-flight reads share one request execution.
Completed responses use the separate cache policy.
Mutations and file-bearing requests do not coalesce.
Other machines and clients outside this engine do not share the local scheduler.
Admission spacing does not guarantee exact server arrival spacing.

Eligible transient reads retry at most three times after the initial attempt.
A mutation retry requires a structured rejection proving that the attempt had no effect.
An uncertain write is left for its original operation to reconcile.

Set `NTN_SKILLS_REQUEST_TRACE_LIMIT` to retain a bounded safe HTTP trace.
Where supported, `--metrics` adds measured request information to structured output.
Metrics distinguish callers, coalescing, queue waits, retries, and actual network attempts.
Missing or truncated trace data does not prove that no request occurred.
A complete zero-request observation requires enabled tracing, zero total requests, an empty trace,
zero dropped events, and no in-flight requests.

Content cache age defaults to 300,000 ms and catalog age to 60,000 ms.
Explicit read age wins over a stable Skill's Profile override, then its Profile default, then the product default.
Long age delays change visibility. Full-body and current-eligibility checks retain independent deadlines.
A cache hit does not improve discovery coverage.

## Environment and local storage

The runtime requires Node.js 22.22.3 or later within 22.x, or Node.js 24.20.0 or later.
Bun builds the repository and runs applicable tests; it is not the product runtime.

Authentication selects nonempty `config.token` before nonempty `NOTION_API_TOKEN`.
`ctl config set-token --stdin` stores a private local plaintext value.
`ctl config clear-token` removes that override.
Configuration output omits the token.

| Data | Explicit application directory | XDG fallback | Home fallback |
| --- | --- | --- | --- |
| Configuration | `NTN_SKILLS_CONFIG_HOME` | `XDG_CONFIG_HOME/ntn-skills` | `~/.config/ntn-skills` |
| Local state | `NTN_SKILLS_HOME` | `XDG_STATE_HOME/ntn-skills` | `~/.local/state/ntn-skills` |
| Cache | `NTN_SKILLS_CACHE_HOME` | `XDG_CACHE_HOME/ntn-skills` | `~/.cache/ntn-skills` |
| Builtin data | `NTN_SKILLS_DATA_HOME` | `XDG_DATA_HOME/ntn-skills` | `~/.local/share/ntn-skills` |

An explicit root names the application directory itself.
Pending current operations belong to local state and are not cache entries.
`ctl cache clear` retires disposable observations without resolving an operation or changing Notion.
Uninstalling the package does not remove these directories.

## Failure boundaries

| Failure | Required response |
| --- | --- |
| `AUTH_REQUIRED`, `ACCESS_DENIED` | Check the selected credential and exact library access |
| `CURRENT_SCHEMA_REQUIRED` | Complete the explicit current-content cutover |
| `STATE_CUTOVER_REQUIRED` | Use a fresh `NTN_SKILLS_HOME` for the current SQLite schema; use a fresh `NTN_SKILLS_CONFIG_HOME` if the configuration still contains retired bindings. Preserve the old roots for explicit content migration. |
| `CURRENT_OPERATION_PENDING`, `CURRENT_SKILL_NOT_READY`, `CURRENT_SOURCE_NOT_READY` | Inspect the original current operation; resume only its same input |
| `CURRENT_IMPORT_UNSUPPORTED`, `CURRENT_IMPORT_ENTRYPOINT` | Correct the local input contract before retrying |
| `CURRENT_SOURCE_MANAGEMENT_REQUIRED` | Preserve the existing Source File ID, logical path and Source binding. Contribution/exclusion management is required before removing, taking over, renaming or rebinding it; omitting the file or assigning a new ID cannot bypass this boundary. |
| `INPUT_CHANGED`, `INVALID_ARCHIVE`, `ARCHIVE_TOO_LARGE` | Fix the admitted local tree, archive, or size |
| `SHARED_ACQUISITION_CHANGED`, `SNAPSHOT_MISSING` | Reselect current content when the exact selection is unavailable |
| `WRITE_OUTCOME_UNKNOWN` | Retain the operation and reconcile its uncertain effect |
| `REQUEST_BUDGET_EXHAUSTED` | Inspect the reported budget; resume an unfinished operation explicitly with the same input |
| `RATE_LIMITED`, `NOTION_QUEUE_FULL`, `NOTION_SCHEDULER_UNAVAILABLE` | Inspect the request or scheduler failure without changing content authority |
| `STATE_RUNTIME_UNSUPPORTED` | Run the supported Node runtime before opening local state |

Source takeover/restore-follow and disable/removal are current explicit commands.
Pro-wide census, non-daily conversion and governance across related objects have
separate delivery boundaries.
The selected-owner index does not certify global orphan cleanup.
Local CLI and SDK checks do not certify the live Notion tables or Pi delivery.
