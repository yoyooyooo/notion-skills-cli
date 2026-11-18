# Current library contract

This is the implementation contract for the single `next` line. Notion owns current
management decisions and Notion-authored content. Git-only, mixed and Notion-native
Skills share this contract. The system does not retain content versions, page
generations, historical graph releases or permanent recovery pins.

The work is tracked by [AH-499](https://linear.app/yoyooyooo/issue/AH-499) and its
[implementation parent](https://linear.app/yoyooyooo/issue/AH-498). This document
defines the destination. It does **not** claim that the existing production tables,
installed CLI or Pi runtime have been converted. The last section names the current
cutover blockers.

## One current owner for each fact

| Table | Current responsibility | Authoritative writer | Rebuildable display |
| --- | --- | --- | --- |
| Skills | Stable Skill/Router/Prompt identity, management metadata, enablement, default discovery, main-file binding, Members and Requires | Human metadata edits and the current management kernel; identity and relationship changes use that kernel | Source-backed main-body rendering and supporting-file navigation |
| Files | Every supporting file, stable File ID, exact Skill owner, logical path, authority and current content locator | Current management kernel; native author bodies remain directly editable in Notion | Full source/resource text rendering, attachments and reading status |
| Sources | Current provider, location, selected revision, selected members, include/exclude/mapping/patch rules and each target's contribution | Current source-management kernel | Last-check result and reciprocal navigation |
| Records | Necessary current exact-byte objects, one current Profile configuration, and unfinished management intents | The corresponding resource, Profile or operation writer | Human labels; no content history |

The main document lives on the Skills page. Its stable `Main File ID` participates
in the same file namespace, but Files does not contain another editable main
document. Every other effective path has one Files row, including files supplied
entirely by Git. A complete local or SDK directory is not a substitute for those
human-readable rows.

Use registered property IDs for access. Display names, including names ending in
`1`, are not identities or sufficient evidence for deletion. The cutover resolves
each actual property ID once, preserves the chosen binding, and removes duplicate
properties only after their current data and inbound relationships have been
accounted for.

## Fields and relationships

### Skills

Keep `Name`, `Description`, `Kind`, `Tags`, `Enabled`, `Default Context`, `Skill ID`,
`Main File ID`, `Members` and `Requires`. Name and Description manage discovery;
they do not silently rewrite source bytes or a file's authored frontmatter.

The main file has the same current authority/content descriptor as a supporting
file. Its page body is either the current native author body or a generated reading
projection. The descriptor makes that distinction explicit. Editing a generated
page does not silently transfer authority.

`Supporting Files` is the reciprocal Files-to-Skill relationship. `Origin` names
current Source contributions; native Skills do not need an artificial Source.
Source membership and mount mappings belong to the current contribution, not to a
historical import or publication record. Multiple Sources may contribute to one
Skill, but two contributors cannot claim the same effective path without an
explicit whole-file override.

Retire old `Source` values that select snapshot/archive carriers, `Source Archive`
attachments, publication status/proof fields, and the old `Projection` ownership
marker. A display fingerprint may be retained as disposable projection metadata;
it cannot decide file ownership. Replace the text `References` mirror with current
typed Members/Requires and body references where those carry the intended meaning.
Do not keep both an editable relation and an independently authoritative JSON copy.

### Files and main-file descriptors

Keep `Name` as display, `File ID` as stable identity, `Path` as a canonical relative
path and `Skill` as exactly one owner. Add one explicit authority and one current
content descriptor. Decode them into a discriminated union at the boundary:

| Current authority and representation | Bytes come from | What the Notion body means |
| --- | --- | --- |
| Notion native Markdown | Current page body plus explicitly stored current file metadata | Editable author content |
| Notion exact resource | Current Records resource locator and exact size/hash/mode | Generated full text for readable resources; an original usable attachment for opaque resources |
| Selected Source file | Current Source contribution, exact selected revision and source path | Generated full reading projection |

Authority describes who controls the file. Representation describes how its bytes
are stored. A resource managed by Notion is still Notion-owned even when its exact
bytes are in Records and its Files body is generated. The UI and CLI must say which
body is editable author content. They must never infer authority from whether a
page has Markdown, from its title, or from the presence of a projection hash.

The descriptor contains only applicable current facts: representation, mode,
current native frontmatter where needed, current resource locator or current
Source/path binding. Raw resource and source descriptors include exact byte size
and content identity. Native author bodies are hashed after reading; a stale
stored hash must not prevent a direct Notion edit from being read. Reading that edit
writes only disposable local cache data, never an adoption event or remote object.

For native text, specify normalization and round-trip behavior. Do not claim to
preserve arbitrary source bytes through a native representation that changes them.
If native transport cannot preserve the selected text, retain its **current** exact
resource and render the entire readable text. Import never silently normalizes a
BOM, line ending or executable mode. An explicitly requested conversion is a new
current edit, not a reason to keep both past and present content.

`following/custom/tombstone` event-derived status is retired. Authority is direct.
Deletion removes the active row. If an upstream path still exists, its exclusion
is kept in the current Source contribution so refresh cannot resurrect it. This
exclusion contains no old file bytes. Renaming a source-backed file updates its
current mapping while preserving File ID; it does not leave an old-path file row.

An explicit whole-file takeover changes authority to Notion after writing and
checking the complete selected file. A current origin binding may remain solely to
support an explicit restore-follow action. Restore-follow reads the currently
selected Source and may overwrite current customization; it does not create a
prior-pin backup. Removing a Source preserves Notion-owned files and clears or
reports any now-unusable restore-follow binding.

### Sources

The current Source contains provider/location, a concrete selected revision,
selection and contribution mapping, exclusions and declared transformations.
`Ref` may express the desired upstream branch/tag; the current `Revision` is the
resolved content selection. Ordinary reads do not advance it. A source check may
report a newer revision; only authorized management applies it.

Reuse existing Provider, Location, Ref, Selection, Options, Enabled and Policy
bindings where their meanings fit. `Last Revision` becomes the current selected
revision rather than a history cursor. Last Checked/Result are informational.
Source definitions, member roots and contributions must be reconstructible from
Notion with an empty local cache. Machine paths and credentials remain local
bindings; a missing binding fails explicitly and does not authorize uploading
private local bytes.

A Source needs a complete current manifest. Keep a bounded manifest inline or use
a current exact-resource locator for a large manifest; do not add a manifest-history
table. Shared targets retain each Source's separate contribution. Disabling or
removing a Source must resolve its affected current files explicitly and cannot
silently delete another Source's files or Notion-owned overrides.

Automatic Source Routers derive current active member links. Human Routers retain
their explicitly authored membership. Requires expands mandatory Skill
dependencies; Members provides candidates. Disabled content and permission-denied
content remain distinct results, and a failing dependency identifies its owner.

### Records

Only three durable kinds are needed at the target boundary:

| Kind | Current key and owner | Lifetime |
| --- | --- | --- |
| Resource | Exact current object/chunk identity plus the current Skill/File or Source owner | While referenced by current data or an unfinished authorized write |
| Profile | Stable library/Profile ID; current name, enabled state, default View and freshness rules | One current record, updated in place |
| Operation | Stable current intent ID and its exact affected owner/path set | Only while needed to finish, reconcile or abandon that intent |

Hash, size and mode verify current bytes. They do not promise historical retrieval.
Updating a current resource may create new immutable chunks before switching the
current pointer, then collect unreferenced old chunks. No old pointer, snapshot or
release is retained to preserve a version. Shared chunks are deleted only after
their current references have been completely checked.

A Profile has no parent revision or revision graph. A current fingerprint may
detect a changed baseline for a management action; it is not a stored predecessor
or a distributed compare-and-swap guarantee. Multiple current rows for one stable
Profile ID are a duplicate to reconcile, not competing branches to replay.

The target removes `file_event`, `snapshot`, `archive`, historical Source bundles,
original-review/completion chains and Profile revision rows. Old `object` rows are
not all garbage: first move any uniquely current bytes they still hold, then
remove the obsolete carrier and all its references.

## Current operations and state

The operation result distinguishes budget exhaustion, user cancellation, partial
success, conflict and unknown remote outcome. The persistent states stay small:

```mermaid
stateDiagram-v2
    [*] --> Ready
    Ready --> Applying: Authorized current intent
    Applying --> Ready: Current result complete
    Applying --> Attention: Partial or unknown
    Attention --> Applying: Reconcile remaining scope
    Attention --> Ready: Verify current result or abandon and clean
```

`Ready` is established from the actual current scope, required relationships and
usable content. A missing old ACK, ancestor event or historical completion cannot
invalidate an already-correct current result. An affected incomplete Skill cannot
be reported as a complete tree; unrelated ready members remain usable.

For unknown CREATE outcomes, query the exact stable current identity before any
retry. For replacement, compare current intended content and reconcile only the
remaining work. Do not reconstruct an old success claim. A completed or explicitly
abandoned intent is removed after its current effects and any late duplicate have
been accounted for. There is no second permanent acceptance/completion ceremony.

Notion property writes, `last_edited_time` and local mutexes are not distributed
CAS. Overlapping writers must stop or surface a conflict. The cutover stops old
writers before converting their data. This contract does not introduce a central
coordinator or promise atomic publication of an entire multi-Skill Source batch.

## Consumer and reading projection

List, read, use, resource read and export perform zero semantic remote writes.
They do not repair pages, retain history, update a selected Source or clear residue.
Management owns those actions. A current reader only needs current identities,
permissions, relationships, selected Source data and usable bytes.

Keep a complete file directory separate from the set of locally materialized
paths. Fetch the entry first, then exact requested files. The single acquisition
contract uses source capabilities (`tree` or `git_member`) and per-file source or
resource routes. It has one accepted schema; old acquisition decoders are removed.
Protocol numbers identify incompatible wire formats, not content versions.

A task selection may retain its exact directory and bytes in local cache for
consistent delivery. If that local selection or required content has gone, return
an actionable reselection error. Never replace missing selected bytes with later
page content, revive a remote historical snapshot, or promise permanent/cross-machine
recovery. A historical snapshot cannot be reintroduced under a generic Source kind.

Pure reading columns, generated layout and unrelated library-property bindings
must not change effective content identity. Hash content, path/mode, authority,
selected source revision and required consumption semantics. Refresh current
display metadata separately; a cache hit must not freeze an obsolete owner
descriptor or undo a known permission denial.

Every supporting text file has its **full** current text on its linked Files page.
Markdown uses readable blocks where faithful, and code/JSON/YAML/HTML/scripts use
complete language-appropriate text blocks. Splitting a long text across blocks is
allowed; truncation, hash-only notes, a download link or a cache path is not a full
reading projection. Images and opaque binaries expose the usable original file.
Projection writes are idempotent and never overwrite a native author body.

Explicit export supports a whole Skill or an explicit path set, preserving complete
selected bytes and modes. Missing paths, unsafe paths, collisions and cancellation
are reported accurately. Export/edit/import replaces current selected content
through the same management writer. There is no separate backup/version subsystem.

Pi is the first daily host. Its Notion consumption uses the current paired SDK for
discovery, consume and resource reads; no custom-command or CLI full-export fallback
remains. The CLI remains available for explicit management and diagnostics.
OMP/Tern adaptation and host acceptance are deferred. Their local Skill content
still belongs in the Pro migration inventory.

## Requests, cleanup and the finite cutover

Preserve the existing request engine, complete pagination, scoped metadata batches,
TTL cache, read coalescing and request attribution. A limit applies to one invocation,
including its retries and children. A resumed invocation gets a new budget. A
partial page or exhausted budget cannot establish absence, authorize deletion or
claim a complete inventory. Fetch only changed/requested bodies after metadata
admission; do not scan Records history to answer a current read.

The implementation proceeds on `next` without compatibility readers, dual writers,
legacy flags or a parallel daily protocol:

1. Freeze the current field/owner contract and stop old writers for the selected
   cutover scope. Build the paired CLI/SDK/Broker artifact from that contract.
2. Run a finite conversion that reads old carriers only to extract current unique
   content and current management intent. Old plans, receipts and caches do not
   become authority for the new model.
3. Write current rows and complete reading projections. Verify the selected
   scope, full file paths, bytes/modes, relationships and ordinary zero-write reads.
4. Retire old properties, rows, pages, attachments, source bundles, Profiles,
   navigation, CLI routes, host exposures and writers after current references have
   been resolved. Remove the one-time conversion entry when the scope is complete.
5. Clear incompatible disposable sessions/caches and select current content. Keep
   any still-unique local author copy until that item has a verified current home.

Pro inventory distinguishes active local assets and real host registrations from
copies in old worktrees, package caches and verification exports. Physical
`SKILL.md` counts are not the migration denominator. An uninspected or sensitive
scope remains explicitly unresolved; it is never silently counted as migrated.
AK Models, Agents, providers and unrelated host operations remain separate assets.

Use the existing verification Skills and the
[bounded current-convergence journey](https://github.com/yoyooyooo/notion-skills-cli/blob/next/.cursor/skills/verify-ntn-skills/features/current-convergence.md).
The six checks have explicit stop conditions; do not add another runner, evidence
archive, recursive proof requirement or broad new platform. The final shared
journey is the real Notion → CLI/SDK → Pi use, followed by the scoped residue check.
First daily use does not close the separate Pro-wide migration task.

## Implementation status and remaining cutover blockers

The current code change unifies acquisition, rejects incompatible cached selections,
removes missing-cache historical recovery and rejects historical snapshot Sources.
The existing verification entrypoints are being retargeted to this contract.

Current Profile management now replaces one stable Record page in place. Its
fingerprint describes only current rules; duplicate physical rows fail, unknown
writes reconcile without replay, and completion clears the finite local pending
rules. Focused local tests cover these changes and preserve View, scope, pagination
and freshness behavior. Production Profile rows have not been converted.

The production contract is **not switched yet**. Before installation/data cutover,
the following must be replaced or removed in the same implementation line:

- Event-DAG file ownership, read-triggered adoption and original-operation proof
  gates in current tree assembly ([AH-1140](https://linear.app/yoyooyooo/issue/AH-1140)).
- Existing Profile rows and incompatible local Profile state still require the
  finite current-only cutover. Current field schema/types and the remaining paired
  management writers must also be completed
  ([AH-499](https://linear.app/yoyooyooo/issue/AH-499),
  [AH-504](https://linear.app/yoyooyooo/issue/AH-504),
  [AH-507](https://linear.app/yoyooyooo/issue/AH-507)).
- Git-only Files population, complete resource text rendering and safe relationship
  maintenance ([AH-501](https://linear.app/yoyooyooo/issue/AH-501),
  [AH-505](https://linear.app/yoyooyooo/issue/AH-505)).
- Legacy retained bundles that fetch a whole ZIP for a missing member, historic
  resource carriers and live obsolete Notion data
  ([AH-513](https://linear.app/yoyooyooo/issue/AH-513),
  [AH-517](https://linear.app/yoyooyooo/issue/AH-517)).
- Reserved/constant consumer fields, content identity mixed with display metadata,
  coordinated cache invalidation and full export coverage
  ([AH-1142](https://linear.app/yoyooyooo/issue/AH-1142)).
- A packaged matching SDK, actual Pi installation and the bounded daily-use journey
  ([AH-617](https://linear.app/yoyooyooo/issue/AH-617),
  [AH-1063](https://linear.app/yoyooyooo/issue/AH-1063)), followed by all Pro-local
  Skill migration and exposure cleanup
  ([AH-516](https://linear.app/yoyooyooo/issue/AH-516)).

Old tests that require those retired behaviors cannot certify this destination.
Change their assertions only together with the behavior they cover. Keep current
identity, permission, fidelity, interruption and request-budget protections.
