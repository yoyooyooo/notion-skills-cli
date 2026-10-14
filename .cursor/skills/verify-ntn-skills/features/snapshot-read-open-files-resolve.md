# Snapshots, reading, opening, files and relative resolution

Users obtain a complete immutable Skill version, read only the requested file, browse supporting paths and follow relative links without drifting to a newer version.

Current-target reads use bounded cache policy, while pinned targets remain immutable/offline. [Cache cases](sync-cache-verification-plan.md#cache-time-and-identity-matrix), [command coverage](README.md#accepted-design-coverage) and [protocol](../../../../docs/protocol.md#success) own detailed acceptance/contracts. Explicit --refresh protects every fresh live observation below; adding this recipe is not a passing result.

## Sub-features

- `snapshot-current`: current read/open/files with default/refresh/offline/max-age and explicit source/freshness.
- `snapshot-pinned`: pinned refs and snapshot IDs consume existing immutable local content.
- `snapshot-files`: full manifests and file/directory filtering.
- `snapshot-relative`: read and resolve relative to a containing-file ref.
- `snapshot-output`: inclusive line slices, raw text and exact local byte output.

## How to get to it (user POV)

Each entry point below requires its own proof:

- `read`, `open` and `files` with an unpinned target; their shared selector forms are display Name, invocation alias, page ID, page URL and `skill://` ref. Exercise every selector form being claimed, not just the easiest one.
- `read`, `open` and `files` with a returned pinned ref or cached snapshot ID; prove both pinned-ref and snapshot-ID forms when claimed.
- `read --path`, `files --path` and a returned file ref.
- `read relative-path --from` and offline `resolve relative-path --from`.
- `read --lines`, `read --raw` and `read --output`, including identical-output reuse and differing-output rejection.

## Driving it with control-ntn-skills

Preconditions:

- Follow the [index](./README.md). Use one selected plan entry already available online. Get current identities from `list --database "$DATABASE" --refresh`; bind `TITLE`, `SKILL_ALIAS`, `PAGE_ID`, `PAGE_URL` and the unpinned `TARGET` to actual returned identities/the returned page's Notion URL.
- Select real file paths from `files` and links from read content. All output destinations are under `$RUN/evidence`.

- **Fresh current reads and selector forms.** Drive each current target with --refresh so read/open/files validate live access and the complete version independently. Repeat every required actual Name/alias/page-ID/URL/unpinned-ref form. Require source=notion and capture freshness, snapshot/version/ref, database identity and complete manifest. Open omits bodies. Keep ordinary warm/offline policy evidence separate.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$TARGET" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- open "$TARGET" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$TARGET" --database "$DATABASE" --refresh
  ```

- **Bounded cache policy.** After the fresh read, invoke each current command without policy, with --offline, and with --max-age 30s. Eligible hits report source=local_cache without moving validated_at; defaults are 300000 ms for content. Use clock-controlled cases for exact expiry, rollback and failures rather than sleeps. Ordinary reads may retain an independently edited remote version during TTL; a current --refresh sees the edit immediately. Expired validation failures must fail without automatic fallback, then an intentional safe-scope offline read can use old bytes. Official-login local identity may require online checking and must not be labeled zero-network. Save policy/age/source/request evidence for C1–C15.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$TARGET" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- open "$TARGET" --database "$DATABASE" --offline
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$TARGET" --database "$DATABASE" --max-age 30s
  ```

- **Fixed version.** Bind `SNAPSHOT` and `REF` from a successful current read. Drive all three commands with the snapshot; repeat each using its pinned ref. Reads report `source=local_snapshot`, identical bytes and the fixed version; an explicit selected database must match cached ownership. Prove offline consumption in a run environment where network access is unavailable without replacing the official transport.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$SNAPSHOT" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- open "$SNAPSHOT"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$SNAPSHOT"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$REF"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- open "$REF"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$REF"
  ```

  `files "$REF"` lists only the ref's file when it contains a path. `files "$SNAPSHOT"` lists the whole Skill.

  Pinned responses report pinned policy and no latest-remote freshness assertion. Test redundant --offline success, then --refresh/--max-age rejection on snapshot, pinned ref and relative pinned --from; never add refresh to the fixed-version examples. Mutually exclusive policies, repeated singleton flags and invalid durations fail exit 2 before online work.

- **Path filtering and file refs.** Choose `FILE_PATH` and `FILE_REF` from the complete list; choose `DIRECTORY_PATH` from an existing directory prefix. Compare returned paths and byte counts to that list, and compare read bytes to the plan when source bytes are preserved.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$SNAPSHOT" --path "$FILE_PATH"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$SNAPSHOT" --path "$FILE_PATH"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$SNAPSHOT" --path "$DIRECTORY_PATH"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$FILE_REF"
  ```

- **Relative links.** Bind `REF` to the containing file's pinned ref and `RELATIVE_PATH` to a real relative link. Resolve preserves its snapshot; relative read and read of the returned `RESOLVED_REF` return the same actual file/bytes. Resolve alone does not prove that a file exists.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- resolve "$RELATIVE_PATH" --from "$REF"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$RELATIVE_PATH" --from "$REF"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$RESOLVED_REF"
  ```

- **Output modes.** Select a text `FILE_REF` with at least one line. Compare the 1-based first line and `range`/`has_more` to the complete read; raw success emits only UTF-8 text. Retain the ref/snapshot separately because raw output omits them. Exact output emits `output`, `bytes`, `reused=false` initially and `reused=true` on repetition. Compare saved bytes/hashes with the selected source. Repeat `--output` with a different actual file ref against the same destination to prove `OUTPUT_CONFLICT` and preservation of its original bytes; choose a binary ref separately if available.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$FILE_REF" --lines 1-1
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$FILE_REF" --raw
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$FILE_REF" --output "$RUN/evidence/read-file.bytes"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$FILE_REF" --output "$RUN/evidence/read-file.bytes"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$DIFFERENT_FILE_REF" --output "$RUN/evidence/read-file.bytes"
  ```

## Gotchas

- `open` is optional: `read` obtains its own complete snapshot. Historical pinned versions must already exist locally; arbitrary old exports cannot be downloaded.
- There is no `--snapshot` flag. A ref containing a path rejects `--path`; relative `--from` rejects a non-relative target or `--path`.
- `--lines` is incompatible with `--output`; `--raw` is also incompatible with `--output`. Binary content requires exact output and an appropriate viewer, not raw/text decoding.
- References inclusion comes from the References property. Body-only online links do not imply cached files. No script is auto-executed by reading, opening, resolving or exporting.
- Retained Skill inspection does not activate instructions. Hosts keep source/freshness in activation state and use current --refresh only when the task requires current remote access/content; pinned supporting reads remain fixed.
- Cleanup removes scratch snapshots, so retain required byte and metadata proof under `$RUN/evidence` before cleanup. Retained user Notion skills remain intact.
