import { expect, test } from "bun:test"
import { prepareSharedBodyWrite } from "../src/shared-body-write.ts"
import { prepareSharedFileTakeover } from "../src/shared-file-takeover.ts"
import { readSharedFileRequest } from "../src/shared-file-request.ts"
import { restoreSelectedSharedFile } from "../src/shared-file-restore.ts"
import { property } from "../src/model.ts"
import { sharedSnapshotFixture, library, skillPage, rich } from "./shared-snapshot-fixture.ts"

test("native takeover, restore, request and authoring reject raw following even at an .md path before reading the management body", async () => {
  const f = sharedSnapshotFixture({ fileCount: 2 })
  property(f.main.properties).source = rich("source", "source-" + "a".repeat(64))
  f.seedFact(
    {
      kind: "resource_followed",
      event_id: "raw-follow",
      file_id: "file-1",
      parents: [],
      source_id: "source-" + "a".repeat(64),
      source_revision: "a".repeat(40),
      path: "references/1.md",
      source_path: "references/1.md",
      content: {
        kind: "resource",
        object_id: "raw-1",
        sha256: "b".repeat(64),
        bytes: 4,
        mode: "100755",
      },
      retained: null,
    },
    "file_event",
    "file-1",
    "raw-follow",
  )
  const input = { library, skillPageId: skillPage, path: "references/1.md" }
  await expect(f.run(prepareSharedFileTakeover(input))).rejects.toMatchObject({
    code: "SHARED_FILE_INTENT_UNSUPPORTED",
  })
  await expect(f.run(readSharedFileRequest(input))).rejects.toMatchObject({
    code: "SHARED_FILE_INTENT_UNSUPPORTED",
  })
  await expect(f.run(restoreSelectedSharedFile({ ...input, dryRun: true }))).rejects.toMatchObject({
    code: "SHARED_RESTORE_UNSUPPORTED",
  })
  await expect(
    f.run(
      prepareSharedBodyWrite({
        library,
        skillPageId: skillPage,
        fileId: "file-1",
        action: "write",
        candidateMarkdown: "Not the raw bytes",
      }),
    ),
  ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNSUPPORTED" })
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
})
