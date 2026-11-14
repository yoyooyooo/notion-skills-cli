# EMPTY: start with a new library, then maintain the same objects

Owner: AH-1040 and AH-1041–AH-1047. This is a new entry in the existing
`verify-ntn-skills` workflow, not a replacement verification system.

## Starting conditions

Use one authorized test container, create a new child page, and let the public
`ctl library init --parent` create its databases. Config, state, cache and data
start empty. Inherit an authorized token only through the environment; do not
copy the maintenance machine's config, SQLite, object store, pins or receipts.
Capture the normal config hash as a sentinel, never its contents.

The setup observer may create the empty child page that a human would otherwise
create. It must not create database fields, register a descriptor, fill identity
columns, bind relationships or seed business rows. All subsequent product work
uses the public CLI. Direct API writes are allowed only for explicitly named
simulated Notion author actions on this run's own pages, separately labeled.

## Journey and table expectations

| Slice | User action | Expected state and independent observation |
| --- | --- | --- |
| EMPTY01 / AH-1041 | Initialize, query empty library, repeat and attach | Four registered tables, exact field/relationship targets, no business rows; repeat does not create another table. A partial initialization is not ready. |
| EMPTY02 / AH-1042 | First complete folder upload | One Skill and one File per supporting resource; no extra File for the main. Exact raw resources/modes and semantic Markdown; necessary initial records, no invented Source. |
| EMPTY03 / AH-1043 | Split main, edit/add/move/delete/revive references | Keep owner and stable File/page identities, valid links and old pins. New links without allocated targets refuse before writes. Stage added files, then finish linking. |
| EMPTY04 / AH-1044 | Native edits/draft adoption, activation, relations, raw resources | Whole edited file becomes custom; unrelated files and metadata stay unchanged. Members are lazy, Requires explicit. Disabled is availability, not historical revocation. |
| EMPTY05 / AH-1045 | First Source/member, one update, rename/consolidate/remove | Zero bindings is a normal setup state. Explicit admission establishes ownership. Version selection and actual page updates are separate. Preserve differing options and outside owners. |
| EMPTY06 / AH-1046 | Refusal, partial/unknown result, audit pause/resume | No guessed ACK or duplicate create. Count actual writes and retain original failure. A partial audit cannot prove absence of orphans. |
| EMPTY07 / AH-1047 | New empty client and actual Pi | Recover current and retained old content from shared facts, not the author's private Store. Inspect actual tool/serializer/session outputs; do not claim model behavior from a controlled provider. |

Each driven action retains its original argv/result, a complete before/after
table observation and a semantic check. Compare page IDs, stable IDs, logical
paths, owners, relation targets and relevant content hashes, not counts alone.
Classify Records growth by purpose. A no-op must not create another operation or
body merely to document that it did nothing. Preserve legitimate history,
tombstones and independent acceptance evidence.

## Statechart thinking and proof boundaries

Treat the following as a test-design transition table, **not a TLC result**:

| Starting state | Action | Result to distinguish |
| --- | --- | --- |
| Empty parent | Initialize | Initializing, ready core with Sources pending, or ready empty library |
| Ready empty | Create complete input | Complete enabled item, disabled incomplete item, or preflight refusal |
| Active v1 | Add file before linking | Valid staged file, not a failed tree or permission to recreate it |
| Active/staged | Apply fresh edits | Active v2; stale/link rejection; or original partial/unknown result |
| Active | Move/delete/revive | Same identity moved, tombstone retained, same identity revived |
| Following file | Native author edit | Whole-file custom, independent of the other files |
| Source without members | Check/admit | Discovered candidate, explicit disabled admission, verified activation |
| In-flight operation | Lost response | Unknown stays unknown; a complete original ACK may permit only its unsent suffix |

Use existing ImportCreate, MaintenanceApply, IndependentAcceptance and
AcknowledgedContinuation mappings only for the contracts they actually model.
Changed model behavior requires its existing positive and negative configurations;
real initialization schemas, provider rendering and four-table deltas need code
regressions and live observations. Do not add a universal state machine or a new
TLA model for every action. Do not label an unreachable assumption as verified
runtime behavior, or hide the failed/unknown branch in a diagram.

## Execute the first slice

```sh
RUN="$(mktemp -d /tmp/ntn-empty-library.XXXXXX)"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$RUN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts empty --run "$RUN" \
  --stage init --parent AUTHORIZED_TEST_CONTAINER_PAGE
```

`empty` reuses the existing command launcher, isolated environment and evidence
directory. It creates a new child page and starts the real public initializer;
it never points the command at a production entry. A failed attempt preserves
the same parent and original command record. Re-entering the stage does not
issue another parent POST. Review the saved state and returned product route
before any incomplete initializer is continued.

Use `--stage census` to read all four tables independently. Later slices reuse
the exact entry from `evidence/empty-library/state.json`, never a copied global
alias. The observer uses the same Notion transport with read-only capability and
records metadata only; it does not seed or repair the product's state. Detailed
row snapshots are private run evidence, not committed examples.

For subsequent product actions use `--stage command -- CLI_ARGS` with exactly
one explicit `--database ENTRY` or `--entry ENTRY`. The boundary rejects a
different entry and a fixed ref belonging to another library before launching
the product. Passing a test entry does not make a production pin safe: pinned
refs preserve their original library. Offline help and independent cold-client
commands retain the existing `control.ts cli` entry and their explicit scope.

## Completion

Keep the original failed and unrun cases in the result ledger. Completion of a
slice does not complete the parent. No publication, multi-version deployment,
physical Mini, all-host/model matrix or large-library cleanup is required.
Retain the original Store while an operation needs it; cleanup touches only
objects explicitly created by this run, and does not imply permanent erasure.

## Controlled faults from empty schema

```sh
bun run build
bun .cursor/skills/verify-ntn-skills/scripts/empty-http.ts \
  --out /absolute/new/empty-http-run \
  --cli /absolute/notion-skills-cli/packages/cli/dist/ntn-skills.js
```

This extends the existing authoring HTTP fixture with empty schema storage. The real Node initializer creates all four tables, then the same CLI creates the first business rows. The server drops an original native create response and a later completion response separately. Observe no repeated unknown allocation, original acknowledged-prefix recovery and zero-write repetition through real Node SQLite. No client snapshot or acknowledgement is seeded. This is controlled HTTP evidence, not a real Notion outage or a model-behavior result. Keep fixture rendering assertions separate from production projection logic.

The move regression uses a moderately sized main and an explicitly moved linked file. Check the compact original parent, final-path native link mapping, no-op read-only projections and an explicitly reviewed partial parent; these boundaries were hidden by the smaller existing happy-path fixtures. Generated statecharts must include known_failed, reviewed_failure and partial separately from full completion and unknown.

## Cold history and bounded Agent checks

A current read in a new client is a shared-library test. An old private `s_...`
snapshot is different: absent local history must report `SNAPSHOT_MISSING`, not
be silently substituted with current content. To test cross-client old history,
authorize the existing `ctl library snapshot save` for that exact snapshot, then
use `snapshot restore` in the independent empty client. The second client reads
Notion's verified history; do not copy its author's SQLite or objects. Record the
new historical manifest and any deduplicated objects separately from a no-op.

An actual bounded model session must be reported separately from the controlled
Pi transport test. Retain safety-guard refusals, incomplete calls and the original
helper grade. Inspect final accepted actions and effective payload bodies rather
than turning a model's final narrative into proof. No out-of-scope call becomes
permitted solely because it would make the model test pass. The public onboarding
entrypoint is the package builtin, available before any remote library exists.

Continue an interrupted Pi test on its original Session when the product writes
are already known; do not replay the writer to restart the harness. Check that
the saved Session prefix is unchanged. A provider failure after a successful
tool call does not necessarily confirm a new active selection: verify the
previous selection on restart, then make one explicit successful read-only
refresh before claiming the new reference replaced it. Finish with a no-tool
turn to check the effective payload remains stable.

The actual serializer's HTTP reconstruction has no native `isError` field.
Check the public result envelope in that wire context and verify native tool
error flags independently in the original Session. A repeated preparation may
return a compact record without its directory. A controlled selector may reuse
only an already visible directory whose fixed owner ref exactly matches that
record; it must not guess a resource from its name, private cache or oracle.
Preserve failed selectors as test-driver failures, not new product write intent.

The separate installed Pi maintenance lane preallocates its native reference
baseline through the installed public CLI and records that fixture setup before
starting Pi. Pi must then perform its own authoring read and the requested
joint edits. This lane does not claim autonomous new-page allocation; the
progressive-maintenance lane proves new-page staging and the zero-write refusal.
For main-body assertions, retain the raw native body and separately derive the
portable representation from the independently observed owner's exact File/page
bindings. Only explicit bound link destinations may change; literal code, HTML
and foreign pages remain untouched. The posthoc check must not call the product's
writer/reader projection or replace a failed original grade. Retained original
source, Session and HTTP inputs may support a separate read-only re-evaluation.

The live Source journey intentionally distinguishes a verified version selection
from a verified editable-body update. Existing automatic policy still refuses an
unsafe body replacement. A user-approved `restore-follow` on the selected file
is the bounded explicit path; customized files remain untouched. A Notion
rendering mismatch keeps its old operation and exact full observation. A new
projection rule can guide a new explicit intent after independent review; it
cannot retroactively turn the old outcome into applied.
