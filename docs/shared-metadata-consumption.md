# Current Skill metadata consumption

One complete Skills metadata observation can be reused within a scalar
current read. Successful public CLI and SDK results keep their existing shape. The
[selected-snapshot contract](selected-snapshot-consumption.md) continues to own
source bytes, current-tree validation and fixed-file selection.

## One observation within the read

A logical Skill selector needs a fresh directory observation before opening its
current page. Native links in the resulting Markdown tree may need the same
directory to resolve external Skill identities. The scalar path carries the
first observation through to that compilation instead of querying it again.

The observation contains all rows from the authorized Skills data source,
including disabled rows. The ordinary catalog still exposes enabled records and
its existing failure coverage. Its records cannot substitute for the complete
observation: doing so would lose disabled targets and identity-conflict evidence.

The query uses the registered property IDs for exactly these six properties:

| Property | Purpose |
| --- | --- |
| Name | Display and invocation identity |
| Description | Directory and reference metadata |
| Kind | Skill, Router and Prompt classification |
| Skill ID | Stable logical identity and conflict checks |
| Enabled | Availability without activating or reading a target |
| Default Context | Existing metadata semantics |

Every page uses `page_size: 100`; `has_more` and a valid advancing cursor determine
completion. Short or empty intermediate pages do not terminate the observation.
The list envelope, incomplete query status, missing/repeated cursors, non-null
terminal cursor and the existing native inventory cursor bound are checked before
the result can be carried to another consumer. Record decoding, parent scope,
physical-page duplicates and logical identity conflicts remain caller-owned.

## Scope and freshness

The internal `freshCatalogForRead` creates a new observation map inside each Effect
execution and forces online catalog refresh. Each observation retains the
authenticated scope and a copy of the complete library descriptor. The consumer
checks that scope, descriptor, data-source identity and completeness before using
the observation. No global cache, TTL extension or additional persisted receipt is
introduced. Raw inventory rows do not enter public catalog results, the catalog
cache, CLI JSON or the SDK protocol.

Native-reference compilation and Members/Requires target metadata resolution use
this handoff. The selected current page still supplies each actual relation, with
its existing complete relation pagination and validation. Graph preparation keeps
its complete graph inventory and metadata batching. Reusing a six-property
observation does not authorize a consumer that requires additional fields.

## Current page and identity

The selected current page is still fetched independently. Directory rows cannot
supply its Source, Files, ownership or full relation state. Source planning and the
complete current-tree checks therefore keep their existing inputs and barriers.

A logical selector's stable Skill ID must still match that current page; identity
drift fails before source acquisition or body observation. A physical page-ID read
continues to select that page's current identity. Name and Description changes are
allowed, and the current selected record owns self-reference metadata. Its logical
identity claim remains present even if an external inventory omits the current
page, so another page cannot silently claim the selected Skill's identity.

An external target remains available, disabled or unavailable according to the
complete metadata observation. Resolution never fetches the target's body. A later
refresh obtains another observation rather than retaining the previous invocation's
directory. This is an observation within one call, not a remote snapshot transaction.

### Unregistered disabled pages

A complete metadata row with an exactly empty Skill ID and `Enabled=false` is
unregistered. It stays in the raw inventory but outside both consumable catalog
projections. People can leave an unfinished Notion page in the Skills table
without making every other Skill unavailable. Its title and description may still
be empty and its native Kind selection may be null; the property structures and
parent identity must remain complete. This classification uses the same
six-property query and does not read the page body, Files or Records.

Directory eligibility does not prove that a page is safe for initial adoption.
An exact authoring operation still checks its Main File ID, Source, existing
Files/Records and pending operations. Selected managed-page reads keep the strict
identity requirement. A new create also checks unregistered names and aliases,
so an unfinished same-name page cannot silently become a duplicate Skill.

### Skill ID diagnostics

A selected managed page requires a nonempty stable Skill ID. An enabled row with
an empty ID, or any row with a malformed or overlong nonempty ID, still fails with
`INVALID_SHARED_SKILL` and the existing message. Its optional `details` identifies the validated
`page_id`, `data_source_id`, canonical `property` and registered `property_id`,
plus `reason` (`empty`, `invalid_format` or `too_long`) and `value_length` in
UTF-16 code units. It excludes the original value, title and other row metadata.
These fields use the current parser inputs and add no requests or body reads.

The combined SDK `listCatalog({database, directory: {}})` retains optional
`SkillsError.details` for each failed projection. Full catalog failure remains a
failure even when an independent selected View succeeds. Registered disabled rows
still participate in duplicate identity checks; unregistered pages make no stable
identity claim. The valid View's existing isolation and pagination gates remain.

## Verification and remaining costs

The [CLI verification recipe](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/skill-consumption.md)
connects public-read regression, independently installed SDK/CLI consumption and
the existing live-source cost driver. Controlled fixtures record exact property
IDs, cursors, row counts and decoded JSON bytes. Live request metrics remain a
separate measurement; controlled counts do not establish live latency.

The change removes repeated directory acquisition in the affected scalar path.
It does not remove the first complete directory observation, change graph field
projections, implement selected-ID metadata batching, or eliminate first-current
body observation and retained-source costs. SC11's wider projection and batching
matrix remains independently tracked.

### Relation metadata reuse within one scalar read

`openSharedSnapshot` passes its validated `skillsInventory` to Members and Requires readers when no graph inventory exists. Both readers retain selected-target identity, kind, availability and complete-relation checks. The selected-page permission check still runs; missing or incomplete relations fail. A later refresh creates a new observation, while fixed snapshots keep their original relation metadata. Records headers, missing-Payload reads, pending-operation checks and source acquisition keep their own boundaries.

The metadata consumption regressions compare complete public results and frozen snapshots against physical-page reads, including paged inventories, changed relation metadata, old pins, revoked selected-page access, missing targets and incomplete relations. Installed and live-source checks must use their own artifact identities and complete request ledgers.

## Optimization decisions

A single-current inspect prototype narrowed graph metadata to six identity fields plus an extra selected-page GET. It reduced response bytes for the measured large library, but failed the frozen complete-call and root-ready latency adoption gate and increased bytes for the smallest controlled case. It was not adopted. Graph preparation retains its complete required inventory; scalar reuse above is independent of that experiment.

Likewise, do not remove independent scope/descriptor revalidation between combined catalog and directory projections, or replace a selected physical-page read with a logical selector merely to save a request. Those changes alter which identity or permission observation is made. A future optimization needs a concrete mechanism preserving those boundaries and a new comparison fixed before execution. Keep original failed runs outside the checkout; do not relabel them after a different candidate passes.
