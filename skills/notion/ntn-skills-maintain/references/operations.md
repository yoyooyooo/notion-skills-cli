# Current content operations

- [Inspect](#inspect-the-complete-tree)
- [Native create and update](#manage-native-skills)
- [Register a Notion page](#register-an-authored-notion-page)
- [Remove a Skill](#remove-a-skill)
- [Complete import](#import-a-complete-current-tree)
- [Notion text](#generate-notion-text)
- [Trash recovery](#restore-a-trashed-skill)
- [Unfinished work](#incomplete-current-work)
- [Cleanup](#cleanup-boundaries)

Use `ntn-skills schema ctl library skill` for daily authoring, or the exact
subcommand's help. Current content consumption is read-only. Complete import is
a separate full-tree replacement with explicit library and stable Skill identity.

## Inspect the complete tree

```sh
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
ntn-skills files SNAPSHOT_ID
ntn-skills export SNAPSHOT_ID --output NEW_DIRECTORY
```

The first result is metadata-only. It includes main and supporting File IDs,
owners, paths, authority and current state. A successful export acquires all
selected bytes and preserves modes. For one file use
`read SNAPSHOT_ID --path PATH --output NEW_FILE`.
An arbitrary multiple-path export option is not available.

## Manage native Skills

```sh
ntn-skills ctl library skill create INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
ntn-skills ctl library skill create INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library skill update TARGET --entry ENTRY --input LOCAL_FILE
ntn-skills ctl library skill update TARGET --entry ENTRY --input ./guide.md --path references/guide.md
ntn-skills ctl library skill update TARGET --entry ENTRY --file references/guide.md=./guide.md --remove-file references/old.md
```

TARGET is an exact current page ID, page URL or stable Skill ID in this library.
A display title never selects a write. Create accepts the complete local input;
`.md` and `.markdown` files become native and other files become exact resources.
It does not require a separate --native selection. Use complete import below when
you intend to replace an existing whole tree.

Update without --path replaces the main; an explicit path selects one file.
Repeated --file PATH=LOCAL and --remove-file PATH declare file changes. Omitted
files keep their identities, authority and current Notion bodies, including
human edits. Do not export and reimport a whole tree to change one paragraph.
Keep authored local links valid when removing a referenced path. Source-owned
changes require explicit Source management; editing a generated page is not takeover.

Use --name and --description for discovery metadata, and --enabled true|false or
--default-context true|false for those author policies. These values do not rewrite
frontmatter. Repeated --members TARGET or --requires TARGET replaces the selected
complete relation set. A lone empty string clears it; omission preserves it.
Targets must satisfy the current same-library relation rules. Other properties,
including user 日用 and 期望删除 checkboxes, remain unchanged.

Native authoring, explicit --native import and --as native takeover share one
Markdown rule. They accept supported UTF-8 Markdown with normal LF/CRLF and a
terminal newline. The full Notion readback must preserve text, code payloads,
link destinations and supported document structure. Formatting changes alone may
be accepted; `native.verified` counts verified native bodies and
`native.normalized_paths` lists equivalent changed representations. Unsupported
shapes, including unknown HTML/Notion tags, mixed inline images and indented code,
fail admission; lost content or
changed meaning leaves the operation unfinished. The input bytes and fingerprint
remain the original intent, while native read/export uses the current Notion body
plus exact stored frontmatter and mode. Use resources when exact Markdown bytes
are the requirement. The writer never silently falls back to resource authority.

The CLI supplies Skill/Main/File IDs, Content, owner relations and operation
fields. Do not ask an Agent to synthesize those columns. A complete native result
needs no projection; subsequent direct Notion edits are current author content.
Repeat the same command and intent after interruption. Equal current semantics
make zero semantic writes; a changed or unresolved competing intent is not ignored.
All skill actions support --dry-run and the shared request/byte/deadline limits.

## Register an authored Notion page

```sh
ntn-skills ctl library skill register PAGE_ID --entry ENTRY
ntn-skills ctl library skill register PAGE_ID --entry ENTRY --skill-id SKILL_ID --name 'Name' --description 'What this workflow does'
```

Register only an exact page already in this library's Skills data source. It
keeps the body intact, including any frontmatter-looking text. Missing Content
becomes native with an empty stored frontmatter and mode 100644. Existing valid
native metadata and identities stay intact; no resource or Source authority is
silently converted. A complete valid native registration is an unchanged result.

Name and Description come from valid existing properties or explicit options;
missing business meaning is not invented. Missing Kind defaults to skill; an
existing valid skill/router/prompt is retained. Missing Skill ID defaults to
`skill-` plus the original page UUID without hyphens; --skill-id selects an explicit
identity. The CLI supplies missing Main/File IDs. A new registration defaults to
Enabled true and Default Context false; existing author policies are preserved
unless explicitly changed with their options.

Existing native supporting pages may be registered with the owner. Each needs
an explicit valid Path and exactly one Skill relation; the CLI cannot infer a
filename from a title or adopt an arbitrary workspace page. Registration verifies
the current complete tree. Conflicting identities, foreign owners, ambiguous
paths and unfinished operations fail instead of being repaired speculatively.

## Remove a Skill

```sh
ntn-skills ctl library skill remove TARGET --entry ENTRY --dry-run
ntn-skills ctl library skill remove TARGET --entry ENTRY
```

The removal plan includes the exact Skill, supporting Files, unused resources
owned by that Skill, and incoming same-library Members/Requires references.
Source-owned content or contributions require Source management instead.
The CLI removes only that target from those relation sets and preserves the
referencing Skills and their other values. It reads complete relation pages and
checks the affected scope before writing; a truncated list cannot authorize cleanup.
Profile v2 contains View/freshness rules, not Skill membership, so removal does
not rewrite Profiles. It does not rewrite prose links, unrelated Notion pages or
Source declarations as a side effect.

Typed relationships and owned objects are handled inside the finite operation,
then the Skill enters Trash. No Agent sweep of internal tables is required after
a successful removal. Conflicts, unresolved operations or a relation replacement
beyond Notion's supported bound stop with an explicit failure. Repeat the same
intent to continue interrupted work; inspect the actual result before reporting
completion. This scoped removal is not a whole-workspace orphan cleanup.

A completed removal reports `status: removed` and `cleanup_verified: true`.
With no pending removal, an already trashed exact page reports
`status: already_trashed`, zero writes and `cleanup_verified: false`; an absent
stable ID reports `status: not_found` with the same unverified cleanup boundary.
Notion hides relations to trashed owners, so these zero-write results do not
certify cleanup after a manual deletion or authorize an orphan sweep.

## Import a complete current tree

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID
```

Inspect removals and authority changes before applying an authorized complete
input. A target with any Source main or supporting file returns
CURRENT_SOURCE_MANAGEMENT_REQUIRED in dry-run and apply because import selects
resource or native authority. An unchanged export is also refused. Use current
Source apply/refresh for contributions or explicit takeover through notion/ntn-skills-sync;
omitting or reidentifying files is not a takeover route. Ordinary directory/ZIP input requires root SKILL.md. Portable v2
uses the kind's canonical entrypoint. Relations contain same-library unpinned stable Skill
refs; omitted fields preserve, [] clears, and a list replaces that entire field.
Prompt relations, old projection/materialization and unknown fields are rejected.
A single selected Markdown file is the only
automatic entrypoint rename.

Use real physical paths. The loader rejects symlinks, unsafe ZIP entries, input
changes during reading, more than 10,000 entries or more than 128 MiB of originals.
One original is limited to 64 MiB. Keep raw bytes and regular executable modes.
Local Markdown references are checked before Notion access. A deleted or moved
target needs matching changes to its inbound links in the complete input.
Ordinary links may target real directories derived from that input, including
directories without a README. Images must target files. Escaped HTML remains
literal text; missing targets and paths escaping the Skill still fail validation.

Default resource import preserves exact originals and complete file metadata.
Generate full text with the explicit projection command below; missing generated
bodies do not prevent consumption. Unsupported upload types use a deterministic single-original ZIP. Uploads larger
than the direct limit use bounded multipart transport. A source or native file
is not silently replaced merely by editing its generated page.

Use repeated --native PATH to select editable author bodies, including a main
or supporting path. Paths are exact and canonical after the single-file rename;
duplicates, unknown paths and invalid text are refused before network access.
Bodies use the [shared native semantics](#manage-native-skills), including supported
formatting normalization and complete semantic readback. Stored frontmatter and
executable mode stay exact. A semantic mismatch leaves the intent unfinished; no
fallback changes authority. Reimporting a
local native copy replaces human edits made since that copy; export current edits
first if they must be retained. The native path set is part of the input fingerprint.

An import preserves existing Skill identity and stable File IDs for retained
paths. It trashes omitted Notion-owned supporting rows and unreferenced resources
after checking current content. Unspecified enablement, default context and authored relations
remain unchanged. A complete equal input is a zero-write no-op.

Explicit Members/Requires resolve every logical target to one enabled ready Skill
in the same registered Skills data source. Their schema must be single_property;
a dual relation could also change another owner and is refused. Reads finish all
relation pages, including more than 25 values. Changed sets may contain at most
100 targets; larger sets can only be retained unchanged. Changed Requires check
the reachable metadata closure for cycles, then recheck it before ready. No
target body or whole-library census is required for this closure.

Export carries both complete current relation sets. Keep its library identity and
edit the exact stable refs; names, page URLs, pins, foreign libraries, duplicates
and self-references are invalid. Relation writes use the same finite operation
as files. A lost PATCH response is observed by that operation before resuming.

The complete invocation defaults to 1000 HTTP attempts, 512 MiB payload bytes and
600000 ms. --max-requests, --max-bytes and --timeout accept positive integers;
--timeout is in ms. Library lookup, retries, relation queries, projection, upload,
download and cleanup share these limits. An admitted response may finish beyond
the byte limit; its actual cost is reported and no next request is admitted.
Nested calls cannot reset or increase this budget.
Exhaustion stops new requests and retains pending. An explicit resume receives
a fresh invocation budget.

## Generate Notion text

```sh
ntn-skills ctl library projection PAGE_ID --entry ENTRY --dry-run
ntn-skills ctl library projection PAGE_ID --entry ENTRY
ntn-skills ctl library projection --daily --entry ENTRY --dry-run
ntn-skills ctl library projection --daily --entry ENTRY
```

Run after import or Source refresh. The main stays on Skills. Source supporting
reading defaults to **/*.md and excludes test, fixture, dependency and generated
directories. Repeat --include GLOB or --exclude GLOB to replace that default list.
Use --include '' for only the mandatory main and all Notion-owned files, or
--exclude '' for no exclusion patterns. Do not mix an empty value and other
patterns for one flag. Omission keeps defaults; no persistent policy is saved.
The command creates missing selected Files, updates Source descriptors and
archives excluded or upstream-removed Source rows, then renders and reads back
the complete selected text. Source manifests and Contributions still supply the
full consumption tree, including scripts and tests. Reading filters must never
be written into Contributions.exclude. Notion-owned native/resource rows are
preserved; native bodies are verified without writes and resource text stays
readable. Non-text originals are skipped. An equal result makes zero semantic writes.

Daily is current Source 日用 members, Skill 日用 and Default Context combined.
Enabled and 期望删除 are reported without changing or silently excluding them.
Missing source manifests or inaccessible selected bytes are failures. Missing
selected reading pages are reconstructed. Dry-run reports complete-tree count,
selected/excluded paths and row/body changes.
The whole daily invocation shares the same request, byte and deadline limits.

Projection uses a finite intent while the real Skill stays ready for consumption.
After interruption, repeat the same single-Skill or daily command. Without
--operation, it continues an unfinished projection only when the target, effective
reading policy and complete current input fingerprint match. Content operations,
changed input or policy, and unconfirmed CREATE/append outcomes remain blocked.
A daily batch stops on the first failure with completed/remaining scope and an
exact single-Skill recovery command carrying the original policy and requested
budgets. Keep the original state and credential scope. Explicit recovery uses:

```sh
ntn-skills ctl library projection PAGE_ID --entry ENTRY --operation OPERATION_ID --resume
```

Omitted filters use the unfinished intent's frozen policy; supplied filters must
match. Completion retires the policy with the intent, so new projections use
their supplied filters or defaults. Already-complete bodies make no writes.
To stop the old intent before changing policy, use its exact --operation ID
--cancel. Only the pending action is reconciled; the remaining work is not run or
reported complete. Daily rejects --operation, --resume and --cancel; projection
has no supersede mode.
Unknown append is reconciled, not blindly replayed. Ordinary reads never project.

## Restore a trashed Skill

Restore one completed Skill from Trash using its original exact page ID or URL:

```sh
ntn-skills ctl library projection PAGE_ID --restore --entry ENTRY
```

Use this single command to restore the original owner and run the normal complete
projection. The narrow restore intent changes only in_trash to false, verifies
the same ready owner and retires; automatic projection then reconciles selected
Files, renders text and reads it back. Preserve page/Main File/existing File IDs,
Enabled, Default Context, 日用, 期望删除, human properties and native/resource
authority. Native author bodies remain untouched.

Pass the original --include/--exclude filters for a custom reading selection.
Both stages share --max-requests, --max-bytes and --timeout. Reject combinations
with --daily, --dry-run, --operation, --resume or --cancel. Use current Source
originals; do not advance their HEAD or call refresh as part of restoration.

Repeat the same command after its own restore or later projection interruption.
Restore errors return that --restore route with the frozen policy and requested
budgets. Preserve original state and credential scope. Do not clear pending or
patch missing bodies separately. Unknown CREATE/append still needs an observable
matching result; it cannot be retried merely because a query found nothing.

Require scope:skill/status:complete and a complete projection result. Its
restoration.status is restored or unchanged, with an optional restore operation_id.
Restoring the owner makes the overall result applied even if text is unchanged.
Repeat on the live complete page to establish zero semantic writes.

Refuse foreign or duplicate live identities, unavailable/permanently lost pages
or originals and unfinished content work. If an older projection was pending
when an external actor trashed the page, preserve that marker and refuse with no
writes. This route cannot reconstruct missing native content or human policies
from Git. Report failure rather than claiming that untrashing alone completed
the reading projection.

## Incomplete current work

Content writes require an empty Operation before ready. Applying and attention
identify an unfinished content intent; consumers refuse those states before body
acquisition. Projection intents preserve the real Skill's ready state.

```sh
ntn-skills ctl library operation SKILL_ID --kind skill --entry ENTRY
```

Read exact current Record, owner, local lifecycle and in-flight coordinates.
Inspection makes no semantic writes and does not reconcile. status:not_found with
operation:null means no intent was observable; it does not certify an owner is
ready, present or retired. Use the original input and returned operation context.

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --operation OPERATION_ID --resume
```

Resupply the same complete input and original --native paths. Keep the original
local state and credential scope. A fingerprint does not store missing input bytes;
empty state or another machine cannot safely recover an unknown CREATE. Unknown CREATE and append are not repeated from absence. Accepted
results continue after exact current observation; an observed partial append can
remain blocked. Do not clear the operation or change ready by hand.

To change an unfinished complete import, provide a distinct successor:

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --supersede OLD_OPERATION_ID --operation NEW_OPERATION_ID
```

The kernel reconciles the named predecessor before handing its one current owner
to the new intent. Unknown CREATE/append cannot be discarded or replayed. A Source
child cannot be superseded independently through local import. Use the owning
Source action. Supersede and resume are mutually exclusive and both refuse dry-run.
Failure before handoff still belongs to the predecessor; after handoff, resume the
new operation with its complete input. Preserve the returned exact error context.
For a semantic mismatch in a complete native import, preserve the failed input bytes and hash.
Accepting changed meaning requires a separate complete input and explicit successor;
format-only normalization already belongs to the shared native write contract.
Complete import has no general cancel command. The projection-only cancel route
does not apply to a content intent.

Archive recovery uses the exact physical page even after it leaves active queries.
Completion checks the current tree, publishes ready, then retires the remote intent
and clears local pending. No old body versions, review chain or permanent proofs
are required. Local locks are not cross-machine CAS.

## Cleanup boundaries

Target inspection does not prove whole-library coverage. Whole-library cleanup
needs complete authorized ownership, reverse relations and all pages of inventory.
Transfer uniquely current bytes before retiring their old carrier.

Source declaration, file authority and lifecycle use the coordinator through
notion/ntn-skills-sync. Source remove proves no current Content or Origin references
inside the selected library before retiring its own resources and page. This
bounded reverse check does not establish global orphan or backlink cleanup.
Cross-owner relationship repair, full census and production data conversion are
not supplied by this import. Report the exact missing capability
instead of invoking retired publication, history, sync or repair commands.
