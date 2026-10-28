# Broker consumption

This map owns the CLI boundary used by the `pi-context-broker` Notion source adapter provided in its separate repository. It is a recipe, not a completed acceptance result. Broker installation, host registration, default catalogs, Read interception, `$` selection and native skill commands belong to the broker's separate verification maps.

For the daily Tern/OMP installation boundary, use the broker repository's [daily installation and native UI map](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md) and `node scripts/verify-daily-notion-ui.mjs` from that checkout. It verifies the installed broker and companion against the actual daily source configuration and a selected existing Notion page. `captured` observes live Notion instructions at a controlled provider boundary; `model` requires an authorized real model and task prompt. CLI consumption here does not substitute for the slash menu, dollar chips, manual picker, or model response evidence.
Compare provider instructions with the selected snapshot's explicit `--projection snapshot` export entry after removing frontmatter. Require the complete entry bytes to equal `read.content` before stripping frontmatter. The daily captured route must also retain exactly one body when switching from native `/skill:` to automatic `$` and manual picker selections; candidate display alone does not establish either consumption or deduplication.

For independent Pi/OMP real-model consumption, use the broker's [host discovery/read map](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/host-skill-discovery-read.md): `node scripts/verify-notion-integration.mjs run --mode model --database DB --skill-ref skill://PAGE/SKILL.md --model magpie/group/flash-free --model-prompt TEXT`. It runs both hosts by default; `--host pi|omp` selects one and records the other as unrun. Each host must discover metadata without bodies, choose native entry/resource reads and return a nonempty successful assistant final reply. Pi terminal `$` and native `/skill:` selection use the separate [Pi terminal procedure](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端); Tern/OMP UI evidence does not cover Pi.

## Sub-features

- `broker-list`: metadata-only discovery preserves scope, fetched time, freshness, database map, coverage/failures, `default_context` and actual page IDs without instruction bodies or manifests. Missing or unchecked `Default Context` is false; full discovery keeps every record.
- `broker-activate`: select a page ID, validate current scope against discovery, read instructions and retain the returned pinned snapshot/version/ref.
- `broker-materialize`: export that snapshot with `--projection snapshot` as a directory, match manifest `main`, response `main_path` and dynamic `entrypoint`, and require entry bytes equal `read.content`. Preserve every file and verify receipt byte counts, hashes, roles and projection.
- `broker-output`: identical directory reuse, differing-output conflict and unchanged occupied bytes.
- `broker-installed`: actual npm installation and installed Node.js/bin consumption, including a portable `workflow.md` entry.
- `broker-offline-scope`: immutable pinned behavior without authentication; synthetic same-user/different-token current-cache isolation, saved-token precedence and environment fallback.

The Broker's existing default-discovery map now owns View selection and first-message injection. Run `node scripts/verify-notion-integration.mjs run --mode deterministic --view-discovery true` in the Broker repo. It checks actual Pi/OMP provider payloads for first-message timing, switches, configured/first fallback, empty/error views, out-of-View explicit reads, session resume/fork and independent sessions. Controlled providers do not prove real LLM behavior. Native real-model acceptance uses an already accessible View containing the target and `--view VIEW_ID`; no remote property changes are required.

Shared Notion cache acceptance uses the Broker's [session/cache map](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/session-cache-recovery.md#共享-notion-缓存): `node scripts/verify-notion-integration.mjs run --mode deterministic --shared-catalog true`. Different project directories, Pi/OMP, source labels and equivalent executable/database spellings must share one catalog and immutable export without renewing `validated_at`. A refresh changes the shared catalog; active conversations retain A, fresh sessions share B. The route drives actual hosts with controlled source/provider boundaries; real Notion, native menus and real models require their existing independent recipes. CLI identity changes are covered by [C20](sync-cache-verification-plan.md#cache-time-and-identity-matrix).

## How to get to it (user POV)

The product entry points are existing `ntn-skills list --database`, `read PAGE_ID`, `files SNAPSHOT_ID`, and `export SNAPSHOT_ID --projection snapshot --format directory --output DIRECTORY`. There is no broker-specific CLI command. Success requires both exit zero and `ok: true`; errors remain failures with their original code. `read/files/export.scope` is snapshot provenance. Current activation compares it to `list.scope`; pinned responses retain historical scope without claiming present access.

`.ntn-skills.json` uses `{format:"ntn-skills",version:2,kind,name,description,main}`. Match manifest `main` to response `main_path` and `entrypoint`, using the selected record's dynamic entrypoint rather than assuming `SKILL.md`. Require `projection:"snapshot"`, entry bytes equal to `read.content`, and the complete receipt inventory's `path`, `bytes`, SHA-256 `hash` and `role` (`entrypoint`, `resource`, `source_bundle`, `manifest`) to match actual output. The manifest carries no page/version/snapshot IDs or credential scope; retain response identities separately. Resolve the entry relative to the exported directory and preserve the complete tree. Default `source` projection preserves authored portable bytes and is a separate export contract; it does not establish read-view equality.

Installed consumers launch `node node_modules/ntn-skills/dist/ntn-skills.js` or the declared npm bin with argument arrays. The helper verifies the supplied installed bin against its package manifest. It does not change global configuration or register host hooks.

## Driving it with control-ntn-skills

Prepare once from the checkout root, with the real database selected for this run:

```bash
bun install --frozen-lockfile
bun run build
RUN="$(mktemp -d "${TMPDIR:-/tmp}/ntn-skills-verification-XXXXXX")"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$RUN"
```

For source consumption of a selected accessible database:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts consumption --run "$RUN" --database "$DATABASE"
```

`DATABASE` is the actual database ID/URL or locally registered exact alias. An optional `--target "$PAGE_ID"` selects only that real catalog page; the default selects the first metadata row. The mode refreshes metadata, validates scope, reads the selected page, enumerates pinned files, exports into evidence, inspects the actual entry/files/manifest, repeats for reuse, changes only an owned scratch copy to prove `OUTPUT_CONFLICT`, and rereads the pinned ref offline. It writes `evidence/consumption-source.json` plus exact command/exit records. It never creates or changes remote pages.

For the package boundary and deterministic credential/entrypoint cases:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts package --run "$RUN"
```

This reuses `scripts/package-check.ts` and `scripts/package-smoke.ts`: pack the built CLI, build/pack the independent migration tool, pass both through `--archive` and required `--migration-archive`, install them separately into fresh npm prefixes and drive actual installed Node.js/bin commands. The fixture is explicitly synthetic and offline, imported through the migration product boundary. It covers metadata/list-to-read-to-pinned-directory export, page/scope/version identities, `workflow.md` portable entry, complete bytes, reuse/conflict, saved token versus environment, same-user/different-token absent-scope errors and pinned survival. Inspect the recorded check names and `installed-consumer.json`; do not infer a pass from this recipe.

To drive the same live read-only contract through that installed package, select its actual executable from `$RUN/evidence/package.json` (the package smoke reports its `executable`):

```bash
INSTALLED_BIN="$(jq -er '.smoke.executable' "$RUN/evidence/package.json")"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts consumption --run "$RUN" --database "$DATABASE" --target "$PAGE_ID" --installed-bin "$INSTALLED_BIN"
```

The installed mode writes `evidence/consumption-installed.json`. Obtain `PAGE_ID` from the source consumption catalog or the dedicated live fixture receipt; it is a page identity, not a name or alias. The broker integration helper owns the separately authorized live fixture lifecycle: public CLI create of one uniquely named Skill with a reference and resource canary, CLI read/list/export, both hosts, then official `ntn api v1/pages/ID --notion-version 2026-03-11 -X PATCH --data @-` with stdin `{"in_trash":true}` and GET readback for every owned page. Preserve IDs before later steps and run fixture cleanup in `finally`, including failures. CLI consumption mode does not create a second fixture or archive user pages.

Keep `evidence/commands/*.json`, `consumption-source.json`, `consumption-installed.json`, their directories/manifests/file hashes, `installed-consumer.json`, both integrity-checked tarballs and the broker fixture create/cleanup receipts. Raw transport stderr and token stdin are excluded. Local cleanup is:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cleanup --run "$RUN"
test -f "$RUN/evidence/cleanup.json"
```

The helper moves only owned scratch/package directories through macOS system Trash and preserves evidence. Non-macOS hosts retain scratch until a verified recycle capability is available. Archive remote fixtures through their owning integration helper before retiring local state; do not permanently delete anything or kill processes by name.

## Gotchas

- The broker adapter is provided in its separate repository; this CLI package does not install it. CLI boundary proof cannot establish default host catalogs, Read interception or native skill activation.
- Credential scope must match between metadata and current activation. A saved CLI token overrides an environment token; copying personal configuration can defeat intended isolation. Scope changes require rediscovery.
- Search-limited or failed discovery is incomplete; freshness cannot upgrade coverage. The automated consumption mode requires an exhaustive explicit-database result and reports failures rather than selecting arbitrary stale metadata.
- Pinned reads/exports retain fixed versions locally. They do not establish current permission or latest freshness; failed online validation must not fall back silently.
- Export can preserve arbitrary source filenames and frontmatter, while read returns the normalized `SKILL.md` view. Use manifest `main` and export `main_path`; keep relative resources in their original directory.
- Synthetic smoke proves installed offline behavior only. Live fixtures require actual create/read/export/cleanup receipts from the separately authorized integration run.
- Nothing automatically executes imported scripts. Differing output is a conflict, not overwrite authorization. Evidence may contain private instructions and IDs; keep it outside the checkout.

## Missing-reference boundary

Broker treats unmatched names, aliases, sources and qualified references as exact ordinary user text, including `$bunfs/root/chunks/cli-nxfh2cp0.js`. This is host submission policy, not permission to turn CLI failures into successful CLI receipts. Retain the exact typed selected-target not-found receipt so Broker can soft-pass that target; do not classify permission/network/incomplete-catalog/integrity failures by message text or silently reuse stale bytes. Never fall back to another source.

Use the Broker selection map's Missing-reference regression route for Pi/OMP and affected native/terminal surfaces: unknown bare and qualified references alone and mixed with valid Skill/Prompt/Router, two rounds with changed task text and real images, exactly one provider dispatch per accepted round, and valid preparation once per identity per round. Metadata misses cause no target read/export; typed selected-target not-found can retain its attempted read but no export. Verify no toast/error/abort for misses, active Skill/Router deduplication, fresh Prompt task content and lazy Router members. Delay a valid read, cancel or change session, await completion and require no late dispatch plus a successful next draft. Preserve bootstrap/escaped/fenced-example guards. Capture actual CLI calls, provider deltas, images and lifecycle/UI evidence; unavailable branches remain blocked/unrun. This recipe reports no execution and cannot replace frozen verdicts.
