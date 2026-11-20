import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseRef } from "../packages/core/src/ref.ts"

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const script = fileURLToPath(new URL("./cutover-audit-current-references.ts", import.meta.url))

function fixture(duplicateTarget = false) {
  const directory = mkdtempSync(join(tmpdir(), "ah513-reference-audit-"))
  const file = (
    owner: string,
    path: string,
    markdown: string,
    authority: "native" | "resource" | "source" = "native",
  ) => {
    const bytes = Buffer.from(markdown)
    const local = join(directory, digest(owner + path))
    writeFileSync(local, bytes)
    return {
      path,
      authority,
      sha256: digest(bytes),
      bytes: bytes.length,
      local_bytes_path: local,
      main: path === "SKILL.md",
      binding: { file_id: `${owner}-${path}` },
      ...(authority === "source"
        ? { source: { source_page_id: "origin", source_path: `skills/${owner}/${path}` } }
        : {}),
    }
  }
  const definitions = [
    {
      id: "a",
      member: "skills/a",
      name: "a",
      files: [
        file(
          "a",
          "SKILL.md",
          [
            "[exact](../b/guide.md)",
            "[main](../b/SKILL.md)",
            "[anchor](../b/guide.md#part)",
            "![image](../b/guide.md)",
            "[name alone](../display-name-only/SKILL.md)",
            "[placeholder](url)",
            "[directory](references/)",
          ].join("\n"),
        ),
        file("a", "references/source.md", "[exact](../../b/guide.md)", "source"),
        file("a", "references/resource.md", "[exact](../../b/guide.md)", "resource"),
      ],
    },
    {
      id: "b",
      member: "skills/b",
      name: "b",
      files: [file("b", "SKILL.md", "main"), file("b", "guide.md", "guide")],
    },
    {
      id: "c",
      member: "skills/different",
      name: "display-name-only",
      files: [file("c", "SKILL.md", "main")],
    },
  ]
  if (duplicateTarget)
    definitions.push({
      id: "d",
      member: "skills/b",
      name: "duplicate source coordinate",
      files: [file("d", "SKILL.md", "main"), file("d", "guide.md", "guide")],
    })
  const tree = {
    library_id: "library-test",
    owners: definitions.map((owner) => ({
      owner_page_id: owner.id,
      skill_id: `skill-${owner.id}`,
      name: owner.name,
      enabled: owner.id !== "b",
      files: owner.files,
    })),
  }
  const treePath = join(directory, "tree.json")
  const rawTree = JSON.stringify(tree)
  writeFileSync(treePath, rawTree)
  const admission = join(directory, "admission.json")
  writeFileSync(
    admission,
    JSON.stringify({
      inputs: { tree: { sha256: digest(rawTree) } },
      owners: tree.owners.map((owner) => ({
        owner_page_id: owner.owner_page_id,
        status: owner.owner_page_id === "a" ? "fail" : "pass",
      })),
    }),
  )
  const skills = join(directory, "skills.json")
  writeFileSync(
    skills,
    JSON.stringify(
      definitions.map((owner) => ({
        id: owner.id,
        properties: {
          Origin: { type: "relation", relation: [{ id: "origin" }], has_more: false },
          "Source Member": { rich_text: [{ plain_text: owner.member }] },
        },
      })),
    ),
  )
  const output = join(directory, "report.json")
  const inputs = [
    treePath,
    admission,
    skills,
    ...definitions.flatMap((owner) => owner.files.map((file) => file.local_bytes_path)),
  ]
  const initial = inputs.map((path) => digest(readFileSync(path)))
  return {
    tree,
    treePath,
    output,
    unchanged: () =>
      inputs
        .map((path) => digest(readFileSync(path)))
        .every((hash, index) => hash === initial[index]),
    run: () =>
      spawnSync(
        process.execPath,
        [
          script,
          "--tree",
          treePath,
          "--admission",
          admission,
          "--skills",
          skills,
          "--output",
          output,
        ],
        { encoding: "utf8" },
      ),
    report: () => JSON.parse(readFileSync(output, "utf8")),
  }
}

test("reference audit proves exact identities without admitting escapes or modifying originals", () => {
  const input = fixture()
  const result = input.run()
  expect(result.status).toBe(0)
  const report = input.report()
  expect(report.summary).toEqual({
    original_failed_owners: 1,
    now_pass: 0,
    still_fail: 1,
    findings: {
      exact_cross_owner_target: 6,
      missing_cross_owner_target: 1,
      missing_local_target: 1,
      existing_directory: 1,
    },
  })
  expect(input.unchanged()).toBe(true)
  const findings = report.owners[0].findings
  const exact = findings.find((item: { href: string }) => item.href === "../b/guide.md")
  expect(exact.target.enabled).toBe(false)
  expect(parseRef(exact.repair_candidate.target_ref)).toEqual({
    selector: "shared_skill:library-test:skill-b",
    path: "guide.md",
    file_id: "b-guide.md",
  })
  const main = findings.find((item: { href: string }) => item.href === "../b/SKILL.md")
  expect(parseRef(main.repair_candidate.target_ref).file_id).toBeUndefined()
  for (const item of findings.filter(
    (item: { repair_candidate?: { suffix_or_image_policy_required: boolean } }) =>
      item.repair_candidate?.suffix_or_image_policy_required,
  ))
    expect(item.repair_candidate.replacement_href).toBeNull()
  for (const [authority, boundary] of [
    ["native", "explicit_native_body_edit"],
    ["source", "explicit_source_takeover_or_upstream_edit"],
    ["resource", "explicit_resource_replacement"],
  ])
    expect(
      findings.find(
        (item: { authority: string; repair_candidate?: unknown }) =>
          item.authority === authority && item.repair_candidate,
      ).repair_candidate.content_change_boundary,
    ).toBe(boundary)
  expect(findings.find((item: { href: string }) => item.href === "url").placeholder_possible).toBe(
    true,
  )
  expect(
    findings.find((item: { href: string }) => item.href.includes("display-name-only")).kind,
  ).toBe("missing_cross_owner_target")
})

test("reference audit refuses to choose between duplicate exact Source coordinates", () => {
  const input = fixture(true)
  expect(input.run().status).toBe(0)
  const report = input.report()
  expect(report.summary.findings.ambiguous_cross_owner_target).toBe(6)
  expect(report.summary.findings.exact_cross_owner_target).toBeUndefined()
  expect(
    report.owners[0].findings.every(
      (item: { repair_candidate?: unknown }) => !item.repair_candidate,
    ),
  ).toBe(true)
  expect(input.unchanged()).toBe(true)
})

test("reference audit rejects changed frozen bytes before producing repair candidates", () => {
  const input = fixture()
  writeFileSync(input.tree.owners[0]!.files[0]!.local_bytes_path, "changed after freeze")
  const result = input.run()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("Frozen bytes changed")
  expect(existsSync(input.output)).toBe(false)
})

test("reference audit binds every candidate to the exact admitted tree", () => {
  const input = fixture()
  writeFileSync(input.treePath, JSON.stringify({ ...input.tree, library_id: "different-library" }))
  const result = input.run()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("different frozen tree")
  expect(existsSync(input.output)).toBe(false)
})

test("reference audit cannot overwrite an existing file at its output path", () => {
  const input = fixture()
  writeFileSync(input.output, "previous review")
  expect(input.run().status).not.toBe(0)
  expect(readFileSync(input.output, "utf8")).toBe("previous review")
  expect(input.unchanged()).toBe(true)
})
