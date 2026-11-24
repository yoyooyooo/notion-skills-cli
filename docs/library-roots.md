# Library roots and selection

A Library's identity is the UUID of its dedicated Notion root page. The CLI,
consumer SDK and Broker use that same identity. A Skills database ID identifies
one physical table; it is not a Library selector.

## Create and reuse a Library

```sh
ntn-skills ctl library init --parent AUTHORIZED_CONTAINER_PAGE
```

Init creates a root page and four direct children: Skills, Files, Records and
Sources. Keep `library.library_id` and `root_url` from the result. Every system
table has an exact database ID, data source ID and stable property bindings in
the single descriptor stored in the Skills database description.

```sh
ntn-skills ctl library inspect --library LIBRARY_ROOT_ID
ntn-skills ctl library init --library LIBRARY_ROOT_ID
```

Both commands are read-only. They enumerate the root's complete direct-child
inventory and verify each physical parent and binding. An empty Skills table is
a valid Library. Helpers, ordinary pages, documentation and unrelated databases
may also live under the root; display names do not assign system roles.

Each new `init --parent` creates a new root, including when that container already
holds another completed Library. Reusing a Library requires its explicit root.
Init does not set a default, import packaged Skills, register Sources or connect
a host. The returned next command is a read-only list.

| Change in Notion | Identity and result |
| --- | --- |
| Rename the root | Same Library |
| Move the entire root | Same Library; the connection still needs access |
| Add docs, subpages or a helper database | Same Library |
| Move one system database outside the root | Binding validation fails |
| Replace a database or data source under the same root | Old frozen operations fail; they cannot adopt the replacement |
| Copy the root or recreate it after deletion | New Library identity; a copied old descriptor is invalid |

## Select the Library once

Use `--library` for consumption and management. It accepts a canonical UUID, a
Notion root URL, a UUID without dashes, or an exact locally registered Library
alias. UUID case and URL spelling normalize before equality, cache keys or
operation identity are constructed. Aliases resolve to a root before work starts.

```sh
ntn-skills list --library LIBRARY_ROOT_ID --refresh
ntn-skills ctl library import /absolute/skill --library LIBRARY_ROOT_ID --skill-id example
ntn-skills ctl config set default_library LIBRARY_ROOT_ID
ntn-skills list
```

`default_library` is the one optional global consumption preference. The SDK
reads the same configuration and exposes read-only `resolveLibrary({ library? })`
for hosts, including for empty Libraries. SDK v3 uses `library`; retired
`database` and `entry` options are rejected. It does not introduce an SDK writer.
Existing authentication selection remains independent of Library selection.

`selectLibrary` in SDK 3 reads the current local selection without Notion requests.
Hosts call it when admitting a new input, then use `resolveLibrary` to validate a
new root. A running input retains its captured root when the local default changes.

| Input | Selected Library |
| --- | --- |
| Bare list or a short ref at a CLI entry | Explicit `--library`, otherwise `default_library`; missing context is an error |
| Complete ref with `?library=A`, default B | A |
| Complete ref with `?library=A`, explicit `--library B` | Conflict; no target lookup or write |
| Short ref inside a document from A, default B | A |
| `list --all` | Explicit search and registered-source discovery; search is not workspace exhaustive |
| Import, create, update or another writer | Its explicit Library and frozen task target; consumption defaults do not select writes |
| A denied, missing or malformed Library | Failure for that exact Library; no same-name fallback elsewhere |

`--all` cannot also select a Library, View or Profile. Pagination describes the
observed directory; reaching its final page does not make workspace search
exhaustive. View membership and Profile rules remain scoped to the selected root.
Machine Profile preferences store only `{ library_id, profile_id }`.

## References and authored links

```text
skill://architect
skill://architect/references/design.md
skill://architect?library=11111111-1111-4111-8111-111111111111
```

The authority component is the stable Skill ID. The optional `library` query is
the root UUID. A `snapshot=s_<sha256>` parameter selects exact frozen content;
copy it from tool results rather than constructing it. Display names, invocation
aliases and a locator's internal `shared_skill` tag are not part of this URI.
Omitting the path selects the target's declared main file; it does not imply
`SKILL.md`. Native hyperlink transport can add the neutral path pair
`entrypoint.md/..` without changing that selection, the Library or a snapshot.
This is an export spelling, not another reference protocol or a supporting file.

Use ordinary relative paths within a Skill. Cross-Skill relative links require
the containing file's reliable Source contribution mapping, or the explicit
roots admitted by `import-batch`/`members-plan`. A cache's directory layout and a
similar filename cannot establish identity. Prefer `skill://` when authoring
cross-Skill links that must remain portable without repository context.

On a first local import, omitted Members may be filled from proven active links.
Ambiguous, missing or unsupported references remain unresolved. Existing Members,
explicit lists and explicit empty lists retain their established semantics;
Requires is maintained explicitly. The import report exposes `members_discovery`
so authors and Agents can review what was inferred and what needs maintenance.

## Broker sessions and accepted work

Enabled Sources describe which Libraries the Broker may use. A branch selection
describes the next work's default; enabling a Source does not select it and
switching Libraries does not disable the previous Source.

The Broker captures the selected Library when it accepts each interactive/RPC
input, including ordinary text. A later switch changes future inputs. Existing
turns, exact cross-Library targets and frozen file selections retain their owners.
Directory requests and caches carry Library identity so a late result from A
cannot publish into B's directory.

A requested Library that fails validation stays blocked on that branch until an
explicit successful selection. The host does not quietly keep using the previous
Library. A selected root without a matching enabled Source is unavailable; the
Broker does not create or enable Sources automatically. Complete refs can route
to other explicitly enabled Sources without changing the branch default.
An explicit `$name@source` selects that configured Source and retains its actual
Library in the resulting reference. An unqualified name searches only the
current default Library, even when the same input also names another Source.

## Interrupted setup and writes

Before root CREATE, init durably retains its original operation. The root's
operation marker is included in the same CREATE request. That marker proves only
initialization provenance; the Skills descriptor remains the sole current Library
binding. Titles and creation times do not prove operation ownership.

```sh
ntn-skills ctl library init --parent ORIGINAL_CONTAINER --operation ORIGINAL_OPERATION
ntn-skills ctl library init --parent ORIGINAL_CONTAINER --operation ORIGINAL_OPERATION --resume
```

The first command observes only. The second continues confirmed unfinished work
with its original local state. Known root, database, data source and property IDs
can be extended but never replaced. An unknown CREATE that is not visible stays
unresolved. Missing local state does not authorize reconstruction or replay.

Current management intents, Source synchronization and import plans retain the
root plus full physical bindings in the original Store. Their local lookup keys
do not move when a table is replaced. Resume checks the saved binding, input,
owner and execution constraints. Changed aliases or defaults cannot retarget it.

Ready is a verified observation. Another user may later change Notion; preflight
readback and a subsequent write are not a remote transaction or distributed CAS.
The implementation freezes actual request destinations and rejects observed
drift. It cannot revoke a request that was already dispatched.

## Existing Libraries and test isolation

Existing deployments use the explicit one-time migration tool and its reviewed
plan. Stop original writers, account for pending work in their original Stores,
verify actual parent/table identities, then migrate current metadata and commit
the v2 descriptor. Preserve physical Notion row IDs, content and relations.
Do not rewrite historical snapshot owners or turn an old pin into a current read.

A dedicated existing parent can become the root if all four tables already are
its direct children and inventory proves the binding. Otherwise the migration
must arrange the actual tables under a dedicated root before cutover. Merely
changing a descriptor's parent claim does not migrate Notion objects.

Create separate test roots with init. Use the same token for A and B when testing
routing, with overlapping Skill IDs and distinct content. Inspect actual request
destinations, returned content and the untouched Library. Permission denial alone
does not prove correct routing. Keep test config/state/cache/scheduler roots
separate and record exact root IDs; no new implicit import-target environment
variable is required.
