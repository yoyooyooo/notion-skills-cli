# Synchronize upstream Sources

Use explicit management to publish newer Git content into the current Notion
library. Consumers, including `ntn-skills/sdk` and Pi, continue reading the
selected Source content in Notion. Opening another consumer session does not
advance an upstream branch or publish a Source.

The CLI and management SDK own checking, exact commit selection, publication and
compatible recovery. A scheduler such as Dagu or cron chooses when to invoke
them. No scheduler is embedded in the package.

## Check an explicit Source set

```bash
ntn-skills ctl library source check \
  --library LIBRARY_ID \
  --source team-skills \
  --source shared-tools
```

`--library` accepts a Library root page ID, Notion URL or exact registered
alias. The root identifies the complete Library; a Skills database ID is not
a Library selector. Repeat `--source` for 1 to 256 stable Source IDs. There is no implicit
whole-library selection. Both commands emit JSON without `--json`.

Check reads current declarations and complete pending-owner information, then
observes the exact Git refs. It does not publish content or write Notion
properties, bodies or Operations. Inline Source plans need no Git content
download. A resource-backed plan still requires its current owned manifest.
Equal origin/ref observations share work within one invocation. A later
invocation checks again; there is no persistent upstream-ref TTL.

`upstream_unchanged` means the observed upstream commit and supplied
configuration match the selected Source. It does not prove that every target
file or reading projection is complete. An unfinished operation on the Source
or an affected Skill blocks the check.

Disabled Sources, pinned policies and explicit fixed refs are reported as
`skipped`, with `disabled`, `pinned` or `fixed_ref` as the reason. A short ref that
names both a branch and a tag is rejected. Use an exact `refs/heads/...` or
`refs/tags/...` value in the Source declaration to disambiguate.

## Publish and reconcile

```bash
ntn-skills ctl library source sync \
  --library LIBRARY_ID \
  --source team-skills \
  --source shared-tools \
  --manager scheduled-sync \
  --execution-id PACKAGE_SHA256 \
  --mode changed \
  --projection markdown \
  --max-requests 1000 \
  --max-bytes 536870912 \
  --timeout 600000
```

`changed` is the default mode. The first run reconciles the complete selected
content. Later runs may skip full acquisition when the upstream, current Source
configuration, selected content and previous successful local observation all
match. Configuration includes selection, adapter options and complete member
contributions. A same-commit mapping or exclusion change still requires
reconciliation.

Use `--mode full` to reconcile current targets even when the upstream commit has
not changed. This is useful for deliberate repairs after a target or reading
page was removed. Disabled and fixed Sources remain skipped by this upstream
synchronization command.

A Source may set `options.require_all_included` to a boolean. When it is `true`,
every literal member path in `selection.include` must still contain `SKILL.md`
at the selected commit. A missing required member fails preparation before
publication; it cannot authorize removing the corresponding targets. This does
not make wildcard patterns require a match. When the option is absent or `false`,
the normal complete-selection rules allow vanished members and empty selections
to reconcile. The option remains part of the frozen Source configuration.

`--projection none` is the default. `--projection markdown` generates the
standard selected reading pages after content publication. The report separates
content from projection, so a published Source with unfinished projection is
visible as such. Complete consumption manifests retain scripts, tests and
other supported files regardless of reading-page selection.

The manager freezes one exact advertised commit before full preparation. The
existing Source writer then validates the complete selected files and publishes
them. Provider failures or incomplete discovery do not authorize deletion.
Current native/resource ownership and contribution exclusions follow the same
rules as explicit Source apply and refresh.

### Identity and retry

Keep `--manager` stable for a workflow and `--execution-id` stable for its frozen
installed implementation. For an interactive installed CLI, manager defaults to
`manual` and execution identity defaults to the SHA-256 of its complete JS
bundle. Direct TypeScript source execution requires an explicit execution ID.
A deployment may supply the digest of its entire installed package instead.

Keep the original local state directory across attempts. For each selected
Source, its original manager and execution identity resume compatible unfinished
work before observing a newer upstream commit. The stored intent retains its
original commit and projection request even when the next invocation changes
between `full` and `changed`. After resuming that Source, the command reports
its result and continues with other selected Sources; it checks a newer commit
for that Source on a later invocation. Budget changes apply to the current
attempt and do not replace the stored intent.

A new execution identity, a different manager, changed Source configuration or
another owner's pending operation blocks automatic continuation. Read the
returned error details and original operation identity before changing the
workflow. Neither a scheduled tick nor an invocation UUID is an execution
identity. Clearing the state directory does not resolve remote pending work.

### Retain progress across bounded attempts

An unfinished Source synchronization keeps its frozen input alongside the
existing Source operation. After content publication, reading projection records
each completed target in a durable ordered prefix. Recovery verifies the Source,
target identities and pending owners before continuing from the next target. It
does not repeat the completed prefix's projection work. A new unfinished intent
on a completed target blocks recovery rather than being treated as success.
Once content and requested projection finish, the Source pending record is
retired and a bounded latest observation remains.

A `full` invocation also keeps one finite traversal for its manager and library
access scope. It freezes the selected library, Source IDs, projection request
and execution identity. Every terminal Source result advances the ordered
prefix by one, including a nonretryable `blocked` or `failed` result. A retryable
result or exhausted invocation budget leaves the current Source next in line.
The next compatible `full` invocation starts there, so earlier completed
Sources do not consume every later attempt's budget. Changing the frozen
selection or projection while that full traversal remains unfinished is a
conflict; changing an attempt's budget is allowed.

The saved prefix includes each complete result. A later retry cannot erase an
earlier failure or report the whole traversal as successful merely because the
remaining Sources succeed. After every selected Source has a terminal result,
the full traversal is retired. A later `full` invocation starts a fresh
traversal; the state directory does not accumulate a permanent record of
scheduled ticks.

`changed` invocations remain independent of this full traversal. They resume
each selected Source's owned pending work first and otherwise inspect its
current upstream ref. While a full traversal is unfinished, calls for the same
manager and library must retain its credential scope and execution identity.
A `changed` call may still choose its own Source selection and projection
request; it is not converted into a `full` call. When it finishes pending work
owned by an unfinished full traversal, it saves that exact Source result in the
traversal's ordered prefix before retiring the Source pending record. Later
`changed` calls can publish newer commits and replace the latest observation
without losing the full traversal's completed work. Its next invocation returns
the saved result at that earlier processing time and continues with the remaining
Sources. It does not chase another upstream commit for an already completed item.

The protected batch prefix is the completion evidence. A disposable cache
observation or its `completed_at` timestamp never advances full traversal
progress. If saving the parent completion fails, the original Source pending
record remains and the next compatible call resumes it before inspecting a new
upstream ref. If the parent completion was saved but retiring the Source pending
record failed, recovery checks that the parent proves the same operation,
selection and complete requested projection, then only finishes local cleanup.
An unresolved cleanup error remains visible in the report and keeps the batch
from retiring. A later `full` call starts a new traversal only after the previous
one has finished.

Each attempt still needs enough allowance to discover the library, verify
ownership and advance an individual content or projection operation. Persistent
progress does not make an arbitrarily small request or time budget sufficient.

There is one invocation budget and a cooperative local lock for a synchronization
batch. Different Sources can contribute to the same Skill, so the coordinator
processes publication in sequence. The local lock is not a distributed lock.
Configure one writer for a library and preserve its original state directory.

## Interpret the report

The report has `version: 1`, `kind: "current_source_sync"`, `action`, an overall
`status`, `library_id`, `results`, `budget` and `request_metrics`. CLI output also
sets `ok` from the overall outcome.

Each Source result includes its stable `source_id`, an `operation_id` when work
has started, `content`, `projection`, `status`, `retryable` and `error`. Content
records whether the exact selection was only observed or published. A check-only
observation has `revision: null` because it has not prepared the observed
commit's content plan; published content has an exact plan revision. Projection
records whether it was requested, completed, or remains pending with completed
target IDs. Unstarted Sources remain explicit when the batch stops.

For a resumed `full` traversal, `results` includes the saved completed prefix
and this attempt's remaining results. Each item describes the Source when that
item was processed. The combined report is not an atomic snapshot of every
Source at the final report time. `budget` and `request_metrics` describe only
the current invocation, including its recovery work.

| Overall status | Exit | Scheduler action |
| --- | --- | --- |
| `complete` | `0` | Finish this invocation |
| `retryable` | `75` | Retry the same frozen request with a bounded policy |
| `partial`, `blocked`, `failed` | `1` | Retain the report and inspect the failing items |
| Invalid command arguments | `2` | Correct the request before another attempt |

Per-item statuses include `upstream_unchanged`, `update_available`, `applied`,
`reconciled`, `skipped`, `pending`, `blocked`, `failed` and `not_started`.
A partially completed batch is not an unconditional retry instruction. Unknown
write outcomes, ownership conflicts and missing recovery inputs need the exact
reported recovery path.

`max-requests` and `max-bytes` bound HTTP attempts and payload bytes across
library lookup, Source reads, writes, retries and projection. `timeout` is the
whole invocation deadline in milliseconds, including Git work. Git internal
wire requests and bytes are not included in HTTP counters. Git acquisition has
its own output/file bounds and metrics. Omitted budgets use the values shown in
the example.

## Use the management SDK

```ts
import {
  checkSources,
  syncSources,
  currentSourceSyncExitCode,
  type SourceSyncInput,
} from "ntn-skills/management"

const input: SourceSyncInput = {
  entry: "LIBRARY_ID",
  source_ids: ["team-skills", "shared-tools"],
  manager_id: "scheduled-sync",
  execution_id: "FROZEN_PACKAGE_SHA256",
  mode: "changed",
  projection: "markdown",
  limits: { requests: 1000, bytes: 536870912, duration_ms: 600000 },
}

const options = {
  env: process.env,
  cwd: process.cwd(),
  signal: AbortSignal.timeout(610000),
}

const observation = await checkSources({
  entry: input.entry,
  source_ids: input.source_ids,
  limits: input.limits,
}, options)

const result = await syncSources(input, options)
process.stdout.write(JSON.stringify(result) + "\n")
process.exitCode = currentSourceSyncExitCode(result)
```

The preliminary check is optional. `syncSources` already performs its own check,
freezes the selected commit and handles compatible recovery. Do not build a
separate check/prepare/apply protocol in the scheduler.

The management SDK requires explicit `manager_id` and `execution_id`. Both
methods return Promises and use one environment snapshot, one runtime and one
budget per call. `env` is a complete environment when supplied, and relative
configuration roots resolve against `cwd` without changing the process cwd.
`signal`, `metrics` and `onRequestMetrics` have the same runtime semantics as
the consumption SDK. Input or setup errors reject; reported per-Source
outcomes remain in the returned result. Cancellation rejects with `CANCELLED`
after transport cleanup and retains recoverable pending work.

`ntn-skills/sdk` remains the consumption entry. It does not export these
management calls, and adding a `readOnly` option cannot change either API's
capability.

## Schedule it externally

Have the scheduler invoke one command or `syncSources` call per explicit batch.
Choose the interval, timezone, queue, retained JSON output and bounded retries
there. Permit retries only for exit `75`; keep the same deployment and state
directory for those attempts. A scheduler should not invent a new operation or
execution identity on each retry.

Each invocation first continues compatible owned work; a `full` invocation also
continues its unfinished traversal. Other work observes current upstream state.
Historical scheduled ticks do not represent separate content partitions that
must all be replayed. An hourly `changed` command and a daily `full` command can
share the same manager, execution identity, Source selection and state directory.
The SDK manages their compatible Source recovery and finite traversal progress;
the scheduler only starts calls and interprets their reports and exit codes.
If a deployment changes while work is unfinished, retain the original installed
generation until that work is completed or explicitly reconciled.

After publication, consumer sessions still follow their ordinary current-content
freshness policy. A consumer that has already selected immutable bytes retains
that selection. There is no consumer-startup call to GitHub or implicit Source
publication in this design.
