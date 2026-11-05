# Current Skill metadata consumption

SC11 / AH-628 reuses one complete Skills metadata observation within a scalar
current read. Public CLI and SDK results keep their existing shape. The
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

Only native-reference metadata resolution uses this new handoff. Graph preparation
keeps its existing complete graph inventory and metadata batching. Members and
Requires retain their existing relation/inventory path. Reusing a six-property
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
