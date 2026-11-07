# Shared Notion architecture

Notion owns editable Skill content, management metadata, file ownership and retained history. The CLI resolves those facts into immutable snapshots. Pi and other hosts consume selected snapshots through the CLI or its public SDK and own only their session choices and presentation.

See the [protocol](protocol.md#shared-notion-library) for command and response semantics, [authoring guide](shared-authoring.md) for user workflows, [Sources guide](sources-management.md) for upstream configuration, and [consumer contract](consumer-contract.md) for the CLI/SDK boundary. This document explains the durable design decisions; individual test runs and deployment records belong outside the source tree.

## Storage and authority

| Database | Facts it owns |
| --- | --- |
| Skills | Stable Skill identity, Kind, name, description, tags, enabled state, relationships and the editable main page |
| Files | Stable file identity, owner relation, logical path, body-page binding, state and supporting-page navigation |
| Records | Source selections, Profiles, ownership events, original operations, immutable objects and shared snapshot manifests |
| Sources | Editable provider configuration and the exact Skills that use it; selected content versions remain separate |

The Skills database is the library entrypoint. Its versioned descriptor binds the library, databases, data sources, properties and schema. Display names are not identity. Initialization creates and verifies the declared relations before publishing the descriptor; attaching to an existing library does not silently upgrade its schema.

The main instructions use the Skills page body. Supporting files use their Files pages, with an original Skill link for navigation. Consumption queries the forward Files owner relation with complete pagination; the UI's reverse relation is not a complete index. A source-only script or binary can remain in a fixed source manifest without a separate editable Notion page. There must be one current editable body for each logical file.

| Fact | Authority | Permitted local copies |
| --- | --- | --- |
| Identity, metadata, enabled state, View and Profile | Notion | Validated catalog and machine Profile binding |
| Source configuration and selected version | Notion | Provider objects, downloads and parsed manifests |
| Projection baseline, persistent ownership, paths and tombstones | Notion | Last observations and derived indexes |
| Historical bytes and shared snapshot manifests | Notion records or retained attachments | Verified content-addressed objects and materializations |
| In-flight requests and local admission state | Current process or machine | No distributed-lock claim |
| Selected graph, context and activation | Host session | Fixed source identities and delivery receipts |

Shared-consumption catalogs, observations and materializations are derived state. SQLite also holds durable local operation intents, dispatch and recovery receipts, bindings and synchronization baselines; preserve them according to their own lifecycle. Shared file ownership and management decisions remain authoritative in Notion.

## Identity and file state

Skill ID and File ID survive renames, path moves and machine changes. A resource is identified by `(scope, owner Skill ID, file_id)`; different owners may use the same File ID. Physical Notion page IDs bind content locations. Duplicate identities within an owner, conflicting page bindings and path collisions are errors.

Snapshots bind complete file manifests, exact object hashes and lengths, source selections, management facts and conversion versions. A signed download URL is an access location, not content identity. Old pins cannot silently adopt current metadata, relationships or bytes.

| State | Effective content | Transition boundary |
| --- | --- | --- |
| following | The selected fixed source object | Confirm the editable projection was not changed |
| custom | Exact content retained after Notion adoption | Keep ownership until an explicit restore-follow operation |
| tombstone | No current file; history and deletion intent remain | An upstream path reappearing does not revive it |
| unresolved | Incomplete observation, incompatible facts or unfinished operation | Preserve candidates and report the reason |

Changing tags, names, descriptions, Views or enabled state does not transfer body ownership. Editing the body is also not authorization to execute its workflow.

## Whole-file adoption and authoring

Compare a complete observed body with that file's last actual projection baseline. Do not compare against the latest upstream text. A meaningful edit adopts the whole file, preserving its bytes and recording the ownership event before exposing a new snapshot. Returning to the old text, an upstream update, a rename or clearing local caches does not release adoption.

The normalization contract is versioned and preserves authored content. The basic newline normalization must not expand into silent trimming or removal of code, links or instructions. Metadata validation time, body download time and full-body validation time are separate. Reusing a metadata observation must not extend the independent full-body verification deadline.

`create` validates complete UTF-8 input before enabling a new native Skill. `apply` freezes the selected body and metadata changes, validates the resulting file tree, then executes the declared sequence. It is not an atomic multi-file transaction: later failure retains earlier verified changes and the original remaining intent. Individual add, delete, move and restore-follow operations retain stable file identity and history. See the [authoring guide](shared-authoring.md) for supported combinations and recovery commands.

### Unknown operations

Shared observation writes retain an original plan, the body object and the ownership event as distinct facts. The frozen plan includes the original identities, parent events, body hash and length, and actual observation time. Size checks happen before remote writes. Compact operation headers locate unfinished facts; headers alone do not establish the contents or outcome of a plan.

Reconciliation checks the original operation and its exact facts. It does not resend an unknown mutation. A completed observation reconciliation requires a new current read rather than presenting old plan bytes with a newly observed metadata timestamp. Local pending records protect the same client's restart; shared visible facts support independent clients.

If the first plan write has an unknown result, remains invisible to shared queries, and another client has no original recovery receipt, that client cannot distinguish it from an operation never sent. Stable IDs, empty query results and local locks do not establish distributed exactly-once execution. Preserve that limitation and the original operation instead of manufacturing certainty.

### Concurrent edits

The implemented Notion page/Markdown interfaces do not provide a proven revision compare-and-swap contract. A timestamp, page lock, matching old text or successful readback cannot prove that an intervening human edit was impossible. Authoring detects observed conflicts and retains original operations and available content; it must not claim global atomicity or linearizability.

Copy-on-write page replacement is not an adopted shortcut. A future replacement scheme would need to preserve predecessor edits, concurrent metadata, a unique usable entrypoint and bounded revalidation work. Creating a new page and immediately retiring its predecessor is insufficient evidence. Do not add such a scheme without a concrete measured need and a complete recovery contract.

## Fixed sources and snapshots

Editable Sources configuration is separate from selected content. Registering a source candidate does not select it, create a projection baseline or overwrite a body. Git branch movement does not alter a selected commit. HTTP resources need a fixed version or digest; mutable bytes needed for historical recovery must be retained. Machine-local sources preserve their machine/workspace scope and fail explicitly elsewhere.

Resolve Base and Mount inputs, apply whole-file overrides and tombstones, generate required metadata, then validate the complete effective tree. Reject escaping paths, collisions and broken deterministic local references. A valid upstream subtree does not prove that a preserved custom main still links to valid resources. Current cached/offline reads perform the same reference validation against verified local bytes without additional network requests.

A fixed manifest permits lazy acquisition of its exact missing objects. It does not permit fetching today's unfixed Notion body into an old pin. Shared `snapshot save` retains the exact objects before the manifest; `snapshot restore` verifies identities, permissions, hashes and lengths before local materialization. Missing historical content is an error, never a fallback to latest. Complete export verification and selected-file consumption remain distinct operations.

Routers use their registered Members property and complete metadata inventory. Members are candidates; selecting a Router does not read every Member body. A Router snapshot fixes its generated member index, but does not by itself pin all Member bodies. `use` fixes the selected roots and full Requires closure; `read`/inspect keeps independent read intent.

## Request reuse and cache boundaries

Cache catalogs, file metadata, Records observations, source manifests, immutable objects and materialized snapshots separately. Keys include permission scope, library and relevant content identities. A matching object hash is not current authorization.

- A complete valid TTL observation may avoid remote requests under the declared read policy. Access does not renew its validation time.
- Expired unchanged content should require only the necessary metadata and fact checks. Unchanged verified body objects remain reusable.
- Metadata-only changes may regenerate a derived entrypoint without downloading unrelated resources or changing body ownership.
- Forced refresh, missing baselines and full verification use their own explicit paths and cost accounting.
- Pagination, cursor progress and complete coverage remain mandatory. A recent delta alone cannot prove removal from a View, deletion or lost permissions.

Within one operation, complete compatible metadata and Records facts may be shared across callers. Preserve scope, descriptor, freshness, selected identity and coverage; a subset cannot pose as a complete inventory. Authoring phases and unknown-operation recovery retain their own fresh checks. Records Payload containing source text counts as retained-body transfer even when returned by a query endpoint.

Validated Records envelopes use content-addressed objects and small page-version observations. Before reuse, verify complete current headers, owner/Kind/Entity/Hash bindings, the object digest and canonical envelope. Missing facts, conflicting IDs, incomplete reviews or damaged objects cannot be repaired by pretending a stale cache is authoritative.

Current observations can update their existing local identity instead of appending equivalent rows. Immutable content can be reused across processes, while per-process mutable aliases and old pinned versions have separate lifetimes. A stable repeat-read sample does not prove a global cache bound. Retire derived entries only when their ownership and references can be established; preserve persistent sessions and exact history.

The [graph preparation guide](graph-preparation-performance.md), [metadata contract](shared-metadata-consumption.md) and [selected snapshot contract](selected-snapshot-consumption.md) define the corresponding read plans.

## Request engine and cancellation

CLI and SDK use the same Effect runtime services for HTTP, credentials, storage, clock and request admission. Read-only in-flight coalescing includes credential scope, method, path and request data. It is not a completed-response cache and does not combine writes or file-bearing requests. Cancelling one waiter leaves other consumers intact; cancelling the last waiter releases the shared request.

Bounded concurrency and machine-level admission share the logical request deadline. Backoff does not hold the permit; retries do not reset the whole operation budget. An attempted mutation cannot be reclassified as unsent because a deadline expired. Rate limits, permission failures, safe read retries and unknown writes retain distinct outcomes. Local admission does not provide a cross-machine lock or require a new central service.

## Verification and maintenance

Use the [shared SSOT recipe](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/shared-ssot.md) and the consumption maps for public CLI, installed SDK, host and real-service checks. Preserve failures and not-run cases with their exact inputs and artifact identity. Controlled clocks/providers, real Notion, separate physical machines, actual host delivery and model task quality prove different things.

Performance reports bind the selected workload and cache state to actual attempts, bytes, body categories, queue/retry waits and task results. Do not add slice improvements into an unmeasured whole-task gain. Unknown coverage remains unknown; a successful command, HTTP status or complete body alone does not establish a successful Agent task.
