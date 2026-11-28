# Existing Library cutover requirements

The one-time migration executor has been retired from the current repository.
This guide preserves the ownership, recovery and adoption requirements of the
transition; it does not expose another supported command or identity resolver.
The original executor, inventory, exact plan, journal and readback evidence remain
with the operator's cutover records. Current CLI and SDK
operations use the root-page contract described in [Library roots](library-roots.md).

Library v2 uses the canonical UUID of its owning Notion page as `library_id`.
The four database and data source bindings remain in the sole descriptor in
the Skills database description. The marker is `ntn-skills-library:v2 `.
`operation_id` preserves initialization provenance; `parent_page_id` is absent.

An existing dedicated parent can become the root without moving or recreating
any database. When several Libraries share a parent, give each its own root,
move the exact existing databases through a supported Notion operation, then
verify their actual parents. A safe cutover must refuse to promote a shared
parent. A title, a copied descriptor or a search result cannot establish ownership.

This procedure is a one-time cutover. It does not add a v1 resolver, an alias
table, automatic old-config handling or a second runtime identity path.

## What changes

| Surface | Treatment |
| --- | --- |
| Database, data source and Notion row IDs | Preserve them and verify their actual owners. |
| Descriptor | Replace the v1 description with v2 after current metadata and reference patches verify. |
| Git-only admission IDs | Prove each old `library_id + Source page + member` hash before deriving its new root-scoped ID. Keep the Skill page and its relations. Qualify a proven bare marker with its exact Source page. |
| Source Contributions | Rebind exact current Skill IDs through that mapping. Keep membership, file mapping, exclusions and pinned content. |
| Current Profiles | Keep the existing record page and rules; recompute root-scoped Record ID, payload and envelope hash together. |
| Native links | Rebind exact `skill://` destinations and whole reference text, including inline-code text and table cells. Preserve labels, formatting and other Library owners. Embedded prose and code-block changes require review. |
| Legacy `References` index | Parse the complete `file_links` JSON envelope and rewrite only proven `target` identities. Preserve `from`, `href` and fixed external URLs. Duplicate source destinations or an unmapped Library block migration. |
| Portable metadata | Rebind the declared origin and explicit Members/Requires through exact IDs. Names never authorize a match. |
| Global config | Create a private candidate using the observed remote descriptor. Preserve token bytes and physical bindings; use `default_library` and `{library_id, profile_id}`. |
| Historical Records, snapshots and source/resource bytes | Preserve them. An affected pin or immutable content reference blocks automatic cutover; never replace its owner or remove the pin to select latest. |
| Pending operations | Settle them with the original package, Store, owner and frozen inputs before changing identity. |

Current data and historical evidence are different scopes. The inventory covers only
current operation/profile Records and never rewrites old audit payloads. Existing
snapshot ownership is not a migration input to mutate. If an actively used old
pin needs a replacement, explicitly reacquire and verify a new snapshot through
the current public workflow.

The retired parser recognized `shared_skill:<old-library>:<skill-id>`
authorities and old page-UUID authorities. The former must name the exact Library
being migrated; the latter must match an observed current row when it is not
already an exact Skill ID. Both were converted to the single current protocol. This does
not make those spellings valid in the CLI, SDK or Broker after cutover.

Code formatting does not establish that a reference is only an example. The
audit scans inline code, fenced code and ordinary text. Only the exact
`skill://...` placeholder and a bare `skill://` scheme carry no identity to map.
A code block is never edited automatically, and an embedded reference that
needs rebinding blocks the plan. An unknown authority also blocks the plan;
a database UUID cannot be guessed to mean a Skill or a normal Notion URL.

For a source-owned file, publishing replacement bytes also requires a new valid
Source manifest and revision. Creating an object with a new hash and retaining
the old Source revision is not a valid repair. Preserve the original object,
prepare an exact author patch, accept the new content through the Source workflow,
and regenerate the cutover inventory. A missing local object first requires
reacquiring its exact recorded bytes; absence from one machine's object cache
does not by itself prove remote data loss.

## Prepare the maintenance window

Inventory every caller before selecting a root: CLI config, Broker sources,
every configured `discoveryCatalogs` file, portable exports, profiles, scripts
and scheduled writers. Local Router catalogs can retain remote member identities
even when the Source configuration already selects the new root. Audit their
Library, Skill, page, database and data source IDs against the exact migration
mapping. Rebind only proven current members with the selected CLI's reference
formatter; preserve paths, labels and local members. A fixed snapshot blocks
automatic rebinding. Preserve original bytes, compare the exact intended
changes and replace each reviewed file only if its original hash still matches.
Check generated catalog owners too, so regeneration cannot restore old identities.
A database found in
Trash is a stale selection, not permission to recreate or revive a Library.

Suspend scheduled admission and account for queued and active attempts. A stopped
process may have a remote write in flight. Read the original Store dispatch
records, every nonretired `operations/shared-profile-pending/` key regardless
of its category, and remote current operation/Profile Records. A clean Store on one
machine does not prove another machine or task Store is clean.

Reconcile original work under its accepted complete generation and credential.
Preserve the original operation, execution ID, content commit and Store until
the SDK confirms completion. Do not clear dispatch rows, change owners, create a
fresh Store, invent a successor UUID or choose a newer upstream commit to make
the migration pass. Unknown outcomes require observation. Unsettled work blocks
the cutover.

Keep writers quiescent throughout inventory, all remote patches and caller
adoption. Notion does not provide a transaction across this migration. The
explicit maintenance window supplies that boundary; a local journal is not a
distributed lock. Avoid consuming the Library while its current IDs are being
rebound under the old descriptor.

## Preserve the exact inventory and plan

A legacy installation requires a separately reviewed cutover. Keep the accepted
original package and Store available for pending-operation recovery; the current
runtime cannot reinterpret an old descriptor or pin. Evidence must identify the
exact old logical Library, physical tables and new root, with no name-based match.

The cutover inventory must enumerate the root, each table and every native body,
including pagination, actual parents, stable property IDs and original pending
state. Read-only object-cache inputs are accepted only when their byte count and
SHA-256 match the current Content field. Missing local bytes are not proof that
content has no references. Reacquire the exact recorded bytes through the original
consumer or verified fixed source before preparing a complete inventory.

The reviewed plan records:

- The old logical Library, unchanged Skills database and new root mapping.
- Every old/new Skill ID and its unchanged Notion page ID.
- Ordered existing-object PATCHes, exact before/after values and hashes.
- Separate page, block and descriptor write counts.
- Blockers for pending work, incomplete content, ambiguous identity and affected pins.
- Digests of the complete inventory and plan.

A blocked plan cannot authorize writes. Resolve its cause and recollect before
the first write. Never remove blockers or recompute a modified plan's digest by
hand. Synced content owned elsewhere and source-owned bytes require their own
owner's reviewed change; they cannot be silently adopted by this migration.

## Keep recovery bound to the original plan

The bounded procedure rereads original pending state, current operation/Profile
Records, owner pointers and actual table ownership before writing. It compares
the complete table and native-body inventory at admission and before committing
the descriptor. Only listed fields may equal their exact planned before or after
values. Added or removed rows/blocks, changed unlisted properties, schema or owner
changes are drift, even when the intended patch itself appears safe.

Each patch has a durable intent, an idempotent update to an existing object and
an independent readback. The descriptor commits last, after every earlier patch
matches its planned result. The cutover does not create replacement Notion
objects, write historical Records or manufacture a new binding for an old pin.
Notion's mirror of the Skills database description into its registered data
source is acceptable only when both exact original and planned values agree;
the Skills database remains the sole descriptor authority.

If an acknowledgement is lost, preserve the original inventory, plan, journal
and maintenance window. Observe the exact target: the planned after-value proves
that patch applied; another value is drift. An uncertain request is not blindly
replayed. Do not generate a replacement plan from a partly migrated Library,
because the original admission proof belongs to the retained inventory.
These reads do not create a Notion transaction or prevent an external writer from
changing data afterward; writer quiescence remains necessary throughout adoption.

## Adopt and verify the current selection

Prepare each private configuration from the independently observed v2 descriptor
and exact mapping. Preserve credentials and unrelated settings. Create new
candidate files with private permissions, record their digests, and replace an
existing file only if its observed original bytes still match. Report paths and
nonsecret selection facts, not tokens or entire credential-bearing files.

For an owned portable package, verify its ordinary files as well as its origin
manifest. An affected document reference requires its corresponding author
change; changing only the manifest must not rebind old short references. Inventory
only the explicitly reviewed exports, and record the scope that was actually read.

Broker Notion sources select `library: <root UUID>`. CLI commands and SDK 3 use
`--library` / `options.library`. The default is `default_library`; explicit
selections remain independent of that default. Remove old public `--entry` and
`--database` selectors from managed callers in the same wave.

Mini's `notion-skills-upstream-sync` is a separate writer with a fixed installed
package, private config and original task Store. Its Automation config v2 uses
`library` and rejects v1 `entry`. Adopt the accepted SDK 3 generation, config and
matching Automation source together while admission remains suspended. Keep the
same Source allowlist, original Store and request scheduler. Check the host
checkout, live catalog and newly created attempt definition separately. Do not
use a production sync tick merely to smoke-test deployment.

Verify explicit root selection with the accepted CLI and Broker, including the
same-token independent test Libraries, exact references and read-only consumer
request metrics. Only then restore scheduled admission and record the actual
adopted package and source identities.

## Evidence and retirement

The archived deterministic tests cover lost acknowledgements at every patch
position, descriptor-last publication, observation-based continuation, foreign
ownership, shared parents, incomplete enumeration, pending work, changed plans,
ambiguous IDs and pin rebinding. They also cover current Profiles, portable
origins and stale cached descriptors. Those model and adapter results do not prove
live permissions, original Store recovery or actual caller adoption.

Keep original inputs, executor hashes, mutation receipts, independent readbacks
and caller-adoption results as static evidence. State any truncated relation
projection or body-read limit explicitly. Retiring the executable does not erase
an unfinished writer or turn an untested caller into a successful adoption.
The current repository and packages expose one root-identity path; they contain
no one-time legacy migration command or compatibility alias.
