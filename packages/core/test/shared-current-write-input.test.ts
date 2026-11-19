import { describe, expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect } from "effect"
import { zipSync, type Zippable } from "fflate"
import {
  prepareCurrentSharedResource,
  validatePreparedCurrentSharedResource,
  type PreparedCurrentSharedResource,
} from "../src/shared-current-resource.ts"
import {
  copyValidatedCurrentSkillWrite,
  copyValidatedCurrentWriteFile,
  currentWriteFileFingerprint,
  prepareCurrentSkillWrite,
  prepareCurrentWriteFile,
  type CurrentSkillWriteInput,
} from "../src/shared-current-write-input.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sha256 } from "../src/store.ts"

const bytes = (text: string) => new TextEncoder().encode(text)
const input = (files: CurrentSkillWriteInput["files"]): CurrentSkillWriteInput => ({
  skill_id: "input-boundary",
  kind: "skill",
  name: "Input boundary",
  description: "Current input validation",
  files,
})
const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const main = { path: "SKILL.md", bytes: bytes("# Main\n") }
const sourceAuthority = {
  kind: "source",
  source_id: "provider",
  revision: "a".repeat(64),
  source_path: "upstream/current",
} satisfies NonNullable<CurrentSkillWriteInput["files"][number]["authority"]>

describe("current write input boundaries", () => {
  test("the complete input cannot remove a file that its main or a child still references", async () => {
    for (const files of [
      [{ path: "SKILL.md", bytes: bytes("[Guide](references/guide.md)\n") }],
      [main, { path: "references/guide.md", bytes: bytes("[Other](other.md)\n") }],
    ])
      await expect(run(prepareCurrentSkillWrite(input(files)))).rejects.toMatchObject({
        code: "SHARED_REFERENCE_BROKEN",
      })
    const plan = await run(
      prepareCurrentSkillWrite(
        input([
          { path: "SKILL.md", bytes: bytes("[Guide](references/guide.md)\n") },
          { path: "references/guide.md", bytes: bytes("[Main](../SKILL.md)\n") },
        ]),
      ),
    )
    expect(plan.files).toHaveLength(2)
  })

  test("JavaScript callers cannot turn a numeric File ID into a partly applied remote tree", async () => {
    const selected = input([
      main,
      {
        path: "child.md",
        bytes: bytes("# Child\n"),
        authority: { kind: "native" },
        // @ts-expect-error The public runtime boundary also receives untyped JavaScript inputs.
        file_id: 123,
      },
    ])
    await expect(run(prepareCurrentSkillWrite(selected))).rejects.toMatchObject({
      code: "CURRENT_WRITE_INPUT_INVALID",
    })
  })

  test("prepared input revalidates File ID types before trusting its content fingerprint", async () => {
    const plan = await run(prepareCurrentSkillWrite(input([main])))
    const changed = { ...plan, files: plan.files.map((file) => ({ ...file, file_id: 123 })) }
    // @ts-expect-error Reproduce an invalid prepared plan crossing the asynchronous API boundary.
    await expect(run(copyValidatedCurrentSkillWrite(changed))).rejects.toMatchObject({
      code: "CURRENT_WRITE_INPUT_INVALID",
    })
  })

  test("native Content size is checked in UTF-8 bytes during preparation; resource keeps the complete original", async () => {
    for (const header of ["x".repeat(200000), "字".repeat(45000)]) {
      const original = bytes("---\nnote: " + header + "\n---\n# Short body\n")
      const selected = { path: "child.md", bytes: original }
      await expect(
        run(
          prepareCurrentSkillWrite(input([main, { ...selected, authority: { kind: "native" } }])),
        ),
      ).rejects.toMatchObject({
        code: "CURRENT_WRITE_INPUT_INVALID",
        message: expect.stringContaining("Content property"),
      })
      const resource = await run(
        prepareCurrentSkillWrite(input([main, { ...selected, authority: { kind: "resource" } }])),
      )
      const child = resource.files.find((file) => file.path === "child.md")!
      expect(child.kind).toBe("resource")
      expect(child.bytes).toEqual(original)
    }
  })

  test("one Source file can be prepared without inventing a main body; complete input still checks its tree", async () => {
    const file = {
      path: "references/guide.md",
      bytes: bytes("[Main](../SKILL.md)\n"),
      authority: sourceAuthority,
    }
    const prepared = await run(prepareCurrentWriteFile(file))
    expect(prepared).toMatchObject({
      path: file.path,
      kind: "source",
      content: sourceAuthority,
      reading_resource: null,
    })
    expect(await run(copyValidatedCurrentWriteFile(prepared))).toEqual(prepared)
    await expect(run(prepareCurrentSkillWrite(input([file])))).rejects.toMatchObject({
      code: "COMPOSITION_MISSING_ENTRYPOINT",
    })
    expect((await run(prepareCurrentSkillWrite(input([main, file])))).files).toHaveLength(2)
    await expect(
      run(prepareCurrentWriteFile({ ...file, path: "../outside.md" })),
    ).rejects.toBeDefined()
  })

  test("binary Source content keeps its authority and gains one exact raw or ZIP reading attachment", async () => {
    const originals = [
      { path: "assets/manual.pdf", bytes: bytes("%PDF-1.7\nOpaque original\n"), mode: "100644" },
      { path: "assets/font.woff", bytes: bytes("Opaque font bytes"), mode: "100755" },
    ] satisfies CurrentSkillWriteInput["files"]
    for (const original of originals) {
      const prepared = await run(
        prepareCurrentWriteFile({ ...original, authority: sourceAuthority }),
      )
      if (prepared.kind !== "source" || prepared.reading_resource === null)
        throw new Error("Expected a Source reading attachment")
      expect(prepared.content).toEqual({
        ...sourceAuthority,
        mode: original.mode,
        bytes: original.bytes.byteLength,
        sha256: await run(sha256(original.bytes)),
      })
      expect(prepared.reading_resource.status).toBe("needs_attachment")
      expect(prepared.reading_resource.manifest.storage).toMatchObject(
        original.path.endsWith(".pdf")
          ? { kind: "attachment" }
          : { kind: "zip_attachment", entry: original.path },
      )
      const reading = await run(validatePreparedCurrentSharedResource(prepared.reading_resource))
      expect(reading.bytes).toEqual(original.bytes)
      expect(reading.content.mode).toBe(original.mode)
      expect(await run(copyValidatedCurrentWriteFile(prepared))).toEqual(prepared)
    }
  })

  test("a Source reading attachment must match its original, storage need and path", async () => {
    const file = await run(
      prepareCurrentWriteFile({
        path: "assets/tool.bin",
        bytes: bytes("opaque original"),
        mode: "100755",
        authority: sourceAuthority,
      }),
    )
    if (file.kind !== "source" || file.reading_resource === null)
      throw new Error("Expected binary Source")
    const wrongBytes = await run(
      prepareCurrentSharedResource(bytes("different original"), file.mode, {
        storage: "attachment",
        archiveName: file.path,
      }),
    )
    const wrongPath = await run(
      prepareCurrentSharedResource(file.bytes, file.mode, {
        storage: "attachment",
        archiveName: "assets/other.bin",
      }),
    )
    const inline = await run(prepareCurrentSharedResource(file.bytes, file.mode))
    for (const reading_resource of [null, inline, wrongBytes, wrongPath])
      await expect(
        run(copyValidatedCurrentWriteFile({ ...file, reading_resource })),
      ).rejects.toMatchObject({
        code: "CURRENT_WRITE_INPUT_INVALID",
      })
    const text = await run(
      prepareCurrentWriteFile({
        path: "notes.md",
        bytes: file.bytes,
        authority: sourceAuthority,
      }),
    )
    if (text.kind !== "source") throw new Error("Expected text Source")
    expect(text.reading_resource).toBeNull()
    await expect(
      run(copyValidatedCurrentWriteFile({ ...text, reading_resource: file.reading_resource })),
    ).rejects.toMatchObject({
      code: "CURRENT_WRITE_INPUT_INVALID",
    })
  })

  test("Source reading carriers are frozen in the input fingerprint and copied without recompressing ZIP", async () => {
    const plan = await run(
      prepareCurrentSkillWrite(
        input([
          main,
          {
            path: "assets/tool.bin",
            bytes: bytes("exact current original\n".repeat(200)),
            mode: "100755",
            authority: sourceAuthority,
          },
        ]),
      ),
    )
    const file = plan.files.find((file) => file.path === "assets/tool.bin")
    if (file?.kind !== "source" || file.reading_resource?.status !== "needs_attachment")
      throw new Error("Expected one prepared Source attachment")
    expect(await run(copyValidatedCurrentSkillWrite(plan))).toEqual(plan)
    const entries: Zippable = Object.create(null)
    entries[file.path] = [
      file.bytes,
      { level: 6, mtime: new Date(1980, 0, 2), os: 3, attrs: (0o100755 << 16) >>> 0 },
    ]
    const wire = zipSync(entries)
    expect(wire).not.toEqual(file.reading_resource.bytes)
    const manifest: PreparedCurrentSharedResource["manifest"] = {
      ...file.reading_resource.manifest,
      storage: {
        kind: "zip_attachment",
        entry: file.path,
        bytes: wire.byteLength,
        sha256: await run(sha256(wire)),
      },
    }
    const reading_resource: PreparedCurrentSharedResource = {
      status: "needs_attachment",
      bytes: wire,
      manifest,
      content: {
        ...file.reading_resource.content,
        object_id: `resource-${await run(sha256(canonicalSharedJson(manifest)))}`,
      },
    }
    const changed = { ...file, reading_resource }
    const copied = await run(copyValidatedCurrentWriteFile(changed))
    if (copied.kind !== "source" || copied.reading_resource?.status !== "needs_attachment")
      throw new Error("Expected the selected current attachment")
    expect(copied).toEqual(changed)
    expect(copied.bytes).not.toBe(changed.bytes)
    expect(copied.reading_resource.bytes).toEqual(wire)
    expect(copied.reading_resource.bytes).not.toBe(wire)
    expect(copied.content).toEqual(file.content)
    expect(currentWriteFileFingerprint(copied)).not.toEqual(currentWriteFileFingerprint(file))
    await expect(
      run(
        copyValidatedCurrentSkillWrite({
          ...plan,
          files: plan.files.map((selected) => (selected.path === file.path ? changed : selected)),
        }),
      ),
    ).rejects.toMatchObject({
      code: "CURRENT_WRITE_INPUT_INVALID",
      message: expect.stringContaining("fingerprint changed"),
    })
  })
})
