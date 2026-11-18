import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { LIBRARY_MARKER } from "../packages/core/src/shared-library-model.ts"
import {
  currentBytes,
  currentDigest,
  currentId,
  currentLibrary,
  currentRich,
  currentSnapshotFixture,
} from "../packages/core/test/shared-current-fixture.ts"

const args = process.argv.slice(2)
if (
  ![2, 3].includes(args.length) ||
  args[0] !== "--outdir" ||
  !isAbsolute(args[1] ?? "") ||
  (args.length === 3 && args[2] !== "--catalog")
)
  throw new Error("Usage: node scripts/sdk-fixture.ts --outdir /new/absolute/directory [--catalog]")
const root = args[1]!
await mkdir(root, { mode: 0o700 })
const f = currentSnapshotFixture({ fileCount: 101 })
const main = {
  ...structuredClone(f.main),
  parent: { ...f.main.parent, database_id: currentLibrary.skills.database_id },
}
const expectedFiles: Array<{
  path: string
  sha256: string
  bytes: number
  mode: "100644" | "100755"
  encoding: "utf8" | "base64"
  content: string
}> = []
const declare = (
  path: string,
  bytes: Uint8Array,
  mode: "100644" | "100755" = "100644",
  binary = false,
) => {
  expectedFiles.push({
    path,
    sha256: currentDigest(bytes),
    bytes: bytes.length,
    mode,
    encoding: binary ? "base64" : "utf8",
    content: binary ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes),
  })
}
const frontmatter = JSON.parse(main.properties.Content.rich_text[0]!.plain_text).frontmatter
const mainBody = f.bodies.get(main.id)!
declare("SKILL.md", currentBytes(frontmatter + mainBody))
declare("references/0.md", currentBytes(f.bodies.get(f.files[0]!.id)!))
for (let n = 1; n < f.files.length; n++) {
  const path =
    n === 1
      ? "references/guide.txt"
      : n === 2
        ? "assets/raw.bin"
        : n === 3
          ? "scripts/run.sh"
          : n === 4
            ? "references/empty.txt"
            : `references/${n}.txt`
  const bytes =
    n === 2
      ? Uint8Array.from([0, 255, 1, 128, 13, 10])
      : currentBytes(
          n === 1
            ? "完整资源正文 α 😀.\r\n"
            : n === 3
              ? "#!/bin/sh\nprintf 'current resource\\n'\n"
              : n === 4
                ? ""
                : `Current supporting file ${n}.\n`,
        )
  const mode = n === 3 ? "100755" : "100644"
  await f.resource(n, path, bytes, mode)
  f.bodies.set(
    f.files[n]!.id,
    n === 2
      ? "Binary original is attached to its current resource Record.\n"
      : new TextDecoder().decode(bytes),
  )
  declare(path, bytes, mode, n === 2)
}
const skills = [main]
if (args[2] === "--catalog")
  for (let n = 1; n <= 100; n++) {
    const row = structuredClone(main)
    row.id = currentId(2000 + n)
    row.properties.Name.title = [{ plain_text: `Current catalog ${n}` }]
    row.properties["Skill ID"] = currentRich("skill-id", `catalog-${n}`)
    row.properties["Main File ID"] = currentRich("main-id", `main-catalog-${n}`)
    skills.push(row)
  }
const envPath = join(root, "env.json")
await writeFile(
  envPath,
  JSON.stringify(
    {
      NOTION_API_TOKEN: "current-sdk-controlled-token",
      NOTION_WORKSPACE_ID: "",
      NTN_SKILLS_HOME: "state",
      NTN_SKILLS_CONFIG_HOME: "config",
      NTN_SKILLS_CACHE_HOME: "cache",
      NTN_SKILLS_NOTION_INTERVAL_MS: "100",
      NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600, flag: "wx" },
)
const fixture = {
  version: 2,
  kind: "current-notion-service",
  database: currentLibrary.skills.database_id,
  root_page_id: main.id,
  env: envPath,
  notion: {
    library: currentLibrary,
    database: {
      object: "database",
      id: currentLibrary.skills.database_id,
      database_type: null,
      title: [{ plain_text: "Current SDK fixture" }],
      description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(currentLibrary) }],
      data_sources: [{ id: currentLibrary.skills.data_source_id, name: "Skills" }],
    },
    main,
    skills,
    files: structuredClone(f.files),
    records: structuredClone([...f.records.values()]),
    bodies: Object.fromEntries(f.bodies),
  },
  expected: {
    catalog_count: skills.length,
    file_count: expectedFiles.length,
    files: expectedFiles,
  },
}
await writeFile(join(root, "fixture.json"), JSON.stringify(fixture, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
})
console.log(
  JSON.stringify({
    fixture: join(root, "fixture.json"),
    contract: "current-only",
    skills: skills.length,
    files: expectedFiles.length,
    production_network: false,
  }),
)
