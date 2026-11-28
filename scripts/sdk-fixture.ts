import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { property } from "../packages/core/src/model.ts"
import { librarySchemaResponse } from "../packages/core/test/library-schema-fixture.ts"
import {
  currentBytes,
  currentDigest,
  currentId,
  currentLibrary,
  currentRich,
  currentSnapshotFixture,
} from "../packages/core/test/shared-current-fixture.ts"

const args = process.argv.slice(2)
const flags = new Set(args.slice(2))
if (
  ![2, 3, 4].includes(args.length) ||
  args[0] !== "--outdir" ||
  !isAbsolute(args[1] ?? "") ||
  flags.size !== args.length - 2 ||
  [...flags].some((flag) => !["--catalog", "--materialization"].includes(flag))
)
  throw new Error(
    "Usage: node scripts/sdk-fixture.ts --outdir /new/absolute/directory [--catalog] [--materialization]",
  )
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
if (flags.has("--catalog"))
  for (let n = 1; n <= 100; n++) {
    const row = structuredClone(main)
    row.id = currentId(2000 + n)
    row.properties.Name.title = [{ plain_text: `Current catalog ${n}` }]
    row.properties["Skill ID"] = currentRich("skill-id", `catalog-${n}`)
    row.properties["Main File ID"] = currentRich("main-id", `main-catalog-${n}`)
    skills.push(row)
  }
const envPath = join(root, "env.json")
const roles = ["skills", "files", "records", "sources"] as const
const outerParent = currentId(800000)
const rootPage = {
  ...property(librarySchemaResponse("v1/pages/" + currentLibrary.library_id, currentLibrary)),
  parent: { type: "page_id", page_id: outerParent },
}
const rootChildren = property(
  librarySchemaResponse("v1/blocks/" + currentLibrary.library_id + "/children", currentLibrary),
).results
const schemas = roles.map((role) => {
  const binding = currentLibrary[role]
  return {
    database: property(
      librarySchemaResponse("v1/databases/" + binding.database_id, currentLibrary),
    ),
    dataSource: {
      ...property(
        librarySchemaResponse("v1/data_sources/" + binding.data_source_id, currentLibrary),
      ),
      parent: { type: "database_id", database_id: binding.database_id },
    },
  }
})
const sourceMaterialization = async () => {
  const repository = join(root, "upstream.git")
  await mkdir(repository)
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Controlled Source",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Controlled Source",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  }
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  git(["init", "-b", "main"])
  git(["config", "uploadpack.allowFilter", "true"])
  const members = []
  for (const [index, name] of ["lazy-root", "lazy-required", "lazy-sibling"].entries()) {
    const member_key = "skills/" + name
    const description = "Controlled complete " + name + " document"
    const originals = [
      {
        path: "SKILL.md",
        bytes: Buffer.from(
          `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nThis is the complete original ${name} document.\n\nEvery paragraph belongs to the fixed Git commit.\n`,
        ),
        mode: "100644" as const,
      },
      {
        path: "references/guide.md",
        bytes: Buffer.from(`# ${name} guide\n\nComplete supporting text, including α and 😀.\n`),
        mode: "100644" as const,
      },
      {
        path: "scripts/run.sh",
        bytes: Buffer.from(`#!/bin/sh\nprintf '%s\\n' '${name}'\n`),
        mode: "100755" as const,
      },
      {
        path: "assets/raw.bin",
        bytes: Buffer.from([0, 255, index, 128, 13, 10]),
        mode: "100644" as const,
      },
    ]
    const files = []
    for (const original of originals) {
      const source_path = member_key + "/" + original.path
      const destination = join(repository, source_path)
      await mkdir(join(destination, ".."), { recursive: true })
      await writeFile(destination, original.bytes, {
        flag: "wx",
        mode: original.mode === "100755" ? 0o755 : 0o644,
      })
      await chmod(destination, original.mode === "100755" ? 0o755 : 0o644)
      const binary = original.path.endsWith(".bin")
      files.push({
        path: original.path,
        source_path,
        git_oid: createHash("sha1")
          .update(`blob ${original.bytes.length}\0`)
          .update(original.bytes)
          .digest("hex"),
        sha256: currentDigest(original.bytes),
        bytes: original.bytes.length,
        mode: original.mode,
        encoding: binary ? "base64" : "utf8",
        content: original.bytes.toString(binary ? "base64" : "utf8"),
      })
    }
    members.push({
      member_key,
      name,
      description,
      legacy_skill_id: "legacy-" + name,
      legacy_page_id: currentId(830010 + index),
      legacy_main_file_id: "legacy-main-" + name,
      files,
    })
  }
  git(["add", "skills"])
  git(["commit", "--no-gpg-sign", "-m", "Controlled Source originals"])
  const commit = git(["rev-parse", "HEAD"])
  const tree = git(["rev-parse", "HEAD^{tree}"])
  const rootMain = members[0]!.files.find((file) => file.path === "SKILL.md")!
  const unacceptedRoot = rootMain.content.replace(
    "Every paragraph belongs to the fixed Git commit.",
    "UNACCEPTED FUTURE HEAD: these changed bytes must not be delivered.",
  )
  await writeFile(join(repository, rootMain.source_path), unacceptedRoot)
  await writeFile(join(repository, "future-only.txt"), "An unrelated file in the later commit.\n")
  git(["add", "skills", "future-only.txt"])
  git(["commit", "--no-gpg-sign", "-m", "Unaccepted future upstream HEAD"])
  return {
    version: 1,
    repository,
    source_id: "controlled-lazy-source",
    source_page_id: currentId(830000),
    commit,
    tree,
    head_commit: git(["rev-parse", "HEAD"]),
    unaccepted_root: {
      content: unacceptedRoot,
      sha256: currentDigest(Buffer.from(unacceptedRoot)),
      git_oid: git(["rev-parse", "HEAD:" + rootMain.source_path]),
    },
    members,
  }
}
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
  library_id: currentLibrary.library_id,
  database: currentLibrary.skills.database_id,
  root_page_id: main.id,
  env: envPath,
  notion: {
    library: currentLibrary,
    root: rootPage,
    root_children: rootChildren,
    databases: schemas.map((schema) => schema.database),
    data_sources: schemas.map((schema) => schema.dataSource),
    main,
    skills,
    files: structuredClone(f.files),
    records: structuredClone([...f.records.values()]),
    sources: [],
    bodies: Object.fromEntries(f.bodies),
  },
  expected: {
    catalog_count: skills.length,
    file_count: expectedFiles.length,
    files: expectedFiles,
  },
  ...(flags.has("--materialization")
    ? { source_materialization: await sourceMaterialization() }
    : {}),
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
