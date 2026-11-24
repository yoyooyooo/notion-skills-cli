# Move an existing Library to its root identity

Library v2 uses the canonical UUID of its owning Notion page as `library_id`.
The four database and data source bindings remain in the sole descriptor in
the Skills database description. The marker is `ntn-skills-library:v2 `.
`operation_id` preserves initialization provenance; `parent_page_id` is absent.

An existing dedicated parent can become the root without moving or recreating
any database. When several Libraries share a parent, give each its own root,
move the exact existing databases through a supported Notion operation, then
verify their actual parents. The migration tool refuses to promote a shared
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

Current data and historical evidence are different scopes. The tool reads only
current operation/profile Records and never rewrites old audit payloads. Existing
snapshot ownership is not a migration input to mutate. If an actively used old
pin needs a replacement, explicitly reacquire and verify a new snapshot through
the current public workflow.

The one-time parser also recognizes `shared_skill:<old-library>:<skill-id>`
authorities and old page-UUID authorities. The former must name the exact Library
being migrated; the latter must match an observed current row when it is not
already an exact Skill ID. Both become the single current protocol. This does
not make those spellings valid in the CLI, SDK or Broker after cutover.

Code formatting does not establish that a reference is only an example. The
audit scans inline code, fenced code and ordinary text. Only the exact
`skill://...` placeholder and a bare `skill://` scheme carry no identity to map.
A code block is never edited automatically, and an embedded reference that
needs rebinding blocks the plan. An unknown authority also blocks the plan;
the tool cannot guess that a database UUID means a Skill or a normal Notion URL.

For a source-owned file, publishing replacement bytes also requires a new valid
Source manifest and revision. Creating an object with a new hash and retaining
the old Source revision is not a valid repair. Preserve the original object,
prepare an exact author patch, accept the new content through the Source workflow,
and regenerate the cutover inventory. A missing local object first requires
reacquiring its exact recorded bytes; absence from one machine's object cache
does not by itself prove remote data loss.

## Prepare the maintenance window

Inventory every caller before selecting a root: CLI config, Broker sources,
portable exports, profiles, scripts and scheduled writers. A database found in
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

## Build a read-only plan

Run the following commands from a `notion-skills-cli` repository checkout on
`next`. These one-time scripts live in the repository. Use Node 26 and the
existing `ntn` command. Supply the approved Notion token only
through `NOTION_API_TOKEN` in the process environment. The tool never reads a
secret manager, evaluates token commands or prints credentials. Keep its
inventory, plans and journal in a task-owned private directory; they contain
current metadata and native content.

```sh
node scripts/library-root-migrate.mjs inspect \
  --entry OLD_SKILLS_DATABASE_UUID \
  --root LIBRARY_ROOT_PAGE_UUID \
  --store /absolute/original/ntn-skills-state \
  --objects-root /absolute/verified/objects \
  --output /absolute/owned/migration/inventory.json

node scripts/library-root-migrate.mjs plan \
  --inventory /absolute/owned/migration/inventory.json \
  --output /absolute/owned/migration/plan.json
```

Repeat `--store` for the original local Stores and `--objects-root` for existing
content-addressed object directories. Both are read-only inputs. Each object is
accepted only when its byte count and SHA-256 match the current Content field.
Missing source/resource bytes produce `CONTENT_COVERAGE_MISSING`; they are not
assumed reference-free. Obtain the exact bytes with the original public consumer
or its verified fixed source, and collect a new inventory. Do not resolve latest
to fill the gap. An external reference requiring new bytes must be changed by
its author and accepted through its current Source/resource workflow.

`inspect` completes pagination for the root, each table and every native body.
It verifies actual parent ownership, current row identity, stable property IDs
and the original Store. Synced content owned elsewhere is not silently adopted.
The generated plan includes:

- The exact old logical Library, old Skills database and new root mapping.
- Every old/new Skill ID and its unchanged Notion page ID.
- An ordered list of existing-object PATCHes, before/after values and hashes.
- Separate counts for page, block and descriptor writes.
- Blockers for pending work, incomplete content or an unsafe reference.
- An inventory digest and a digest of the complete plan.

Plans can be generated while work is blocked for review. A blocked plan cannot
be applied. Resolve the recorded condition, then collect and plan again before
the first write. Never edit a plan's blocker list or recompute its hash by hand.

## Apply and recover the exact plan

After the original work has settled, regenerate the final inventory while
writers are quiescent. Review its concrete patch list and use that exact digest:

```sh
node scripts/library-root-migrate.mjs apply \
  --inventory /absolute/owned/migration/inventory.json \
  --plan /absolute/owned/migration/plan.json \
  --journal /absolute/owned/migration/journal \
  --ack-plan EXACT_PLAN_SHA256 \
  --writers-quiesced
```

The tool rereads original local pending state, remote current operations,
owner operation pointers and actual table ownership before writing. It also
enumerates the complete original four-table input and native body collection
at the start of every apply/resume and again before the descriptor commits.
Only the listed PATCH fields may equal their exact planned before or after
values. Added or removed rows/blocks, changed unlisted properties, schema or
owner changes fail as `INVENTORY_DRIFT`. Notion's generated timestamps, actor
metadata, object display URLs and rich-text display fields are excluded from
this comparison; row parents, archived state and relation schema remain inputs.
Local snapshot history and object-cache locations are not current identity.

The tool compares each target's current value with the planned before/after values, records intent
durably, sends one idempotent PATCH, then reads the result back. It creates no
Notion object and writes no historical record.

The descriptor PATCH is last and requires every earlier PATCH to be observed
at its exact after value. A committed descriptor with an earlier PATCH still
at its before value is rejected. Resume always reads the original inventory's
fixed tables, including after the descriptor has changed; it never follows a
new resolver binding. These repeated reads do not provide a remote transaction
or prevent an external writer from changing data after a read. Keep the
maintenance window active throughout.

If an acknowledgement is lost, retain the same
inventory, plan and journal and rerun the same command while the maintenance
window remains active. A target already equal to the exact planned result is
observed as applied. A target with another value fails as drift. An uncertain
request is never retried blindly, and a partial cutover is not reported complete.
Do not collect a new plan from a partly migrated Library: its original admission
proof belongs to the retained inventory. Resume the original plan forward.

## Adopt the new caller selection

After remote migration verifies, generate a private config candidate:

```sh
node scripts/library-root-migrate.mjs config \
  --input /absolute/current/config.json \
  --plan /absolute/owned/migration/plan.json \
  --output /absolute/owned/migration/config.candidate.json
```

The output uses exclusive creation and mode 0600. The command prints its path
and digest, not the configuration or token. Review the nonsecret selection and
install the candidate through the caller's normal configuration workflow.
`portable` adds `--tree /absolute/exported/package` for an explicitly selected
`.ntn-skills.json` candidate. It checks that package's ordinary files before
changing its origin. An affected document reference blocks the candidate until
the corresponding author change is reviewed; changing the manifest alone must
not silently rebind old short references. It never discovers arbitrary exports
or modifies their files on disk.

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

## Executable proof and limits

```sh
node --test scripts/library-root-migration.test.mjs
```

The tests enumerate a lost acknowledgement at every patch position, require the
descriptor to remain last, exercise observation-based continuation and refuse
foreign ownership, shared parents, incomplete enumeration, pending work,
changed plans, ambiguous IDs and pin rebinding. They also cover current Profiles,
portable origins and stale cached config descriptors. These are deterministic
model and adapter proofs; live permissions, existing Store recovery and actual
caller adoption require separate observed evidence.

The migration implementation is confined to
`scripts/library-root-migration.mjs` and `scripts/library-root-migrate.mjs`.
Neither is imported by the product resolver or packaged as an alternative
selection API. Remove the one-time tool once the supported installed Libraries
and owned portable exports have completed the cutover; preserve the bounded
operator evidence needed to explain the transition.
