import { beforeAll, expect, test } from "bun:test"
import { access, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
const node = (() => {
  const executable = Bun.which("node")
  if (!executable) throw new Error("Production source-command tests require Node.js.")
  const resolved = Bun.spawnSync([executable, "--print", "process.execPath"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (resolved.exitCode !== 0) throw new Error("Could not resolve the actual Node.js runtime.")
  return resolved.stdout.toString().trim()
})()
beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ])
  if (exit !== 0) throw new Error(`Production CLI build failed: ${stdout}\n${stderr}`)
}, 120_000)

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`
const skillPage = id(1)
const library = {
  version: 1,
  library_id: "library-source-cli",
  operation_id: "library-source-cli",
  parent_page_id: id(2),
  skills: {
    database_id: id(3),
    data_source_id: id(4),
    property_ids: {
      Name: "title",
      Description: "description",
      Kind: "kind",
      Tags: "tags",
      Enabled: "enabled",
      "Default Context": "default",
      References: "references",
      "Skill ID": "skill_id",
      "Main File ID": "main_file_id",
      Projection: "projection",
      Source: "source",
    },
  },
  files: {
    database_id: id(5),
    data_source_id: id(6),
    property_ids: {
      Name: "title",
      "File ID": "file_id",
      Path: "path",
      Projection: "projection",
      Status: "status",
      Skill: "skill",
    },
  },
  records: {
    database_id: id(7),
    data_source_id: id(8),
    property_ids: {
      Name: "title",
      "Record ID": "record",
      Kind: "kind",
      "Entity ID": "entity",
      Hash: "hash",
      Payload: "payload",
      Skill: "skill",
    },
  },
}
const emptyPlan = { version: 1, kind: "composition", base: null, mounts: [] }
const baseArgs = ["ctl", "library", "source"]
async function directory() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ntn-library-sources-cli-"))
  // Retain controlled temporary roots for review; no permanent cleanup.
  return root
}
async function invoke(root: string, args: string[], provider?: string) {
  const marker = join(root, "unexpected-online"),
    blocked = join(root, "blocked-ntn")
  await writeFile(
    blocked,
    `#!${node}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n'); process.exitCode=97;\n`,
  )
  await chmod(blocked, 0o700)
  const child = Bun.spawn([node, main, ...baseArgs, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      NOTION_API_TOKEN: provider === undefined ? "" : "controlled-source-cli-token",
      NOTION_WORKSPACE_ID: "",
      NOTION_API_BASE_URL: "",
      HOME: join(root, "home"),
      NTN_SKILLS_DATA_HOME: "",
      NTN_SKILLS_NTN_BIN: provider ?? blocked,
      NTN_SKILLS_HOME: join(root, "state"),
      NTN_SKILLS_CONFIG_HOME: join(root, "config"),
      NTN_SKILLS_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
    },
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const online = await access(marker).then(
    () => true,
    () => false,
  )
  return { stdout, stderr, exit, online }
}
function success(result: Awaited<ReturnType<typeof invoke>>): Record<string, unknown> {
  if (result.exit !== 0)
    throw new Error(`Source command failed: ${result.stdout}\n${result.stderr}`)
  const value: unknown = JSON.parse(result.stdout)
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected command JSON object")
  const output = { ...value } as Record<string, unknown>
  expect(output.ok).toBe(true)
  return output
}
function failure(result: Awaited<ReturnType<typeof invoke>>, code: string) {
  expect(result.exit).not.toBe(0)
  const value = JSON.parse(result.stdout)
  expect(value).toMatchObject({ ok: false, error: { code } })
}

test("composition inspect produces a deterministic public plan with no Notion or provider contact", async () => {
  const root = await directory(),
    manifest = join(root, "plan.json")
  await writeFile(manifest, JSON.stringify(emptyPlan))
  const one = await invoke(root, ["composition", "inspect", manifest])
  const output = success(one)
  expect(output.source_plan_id).toMatch(/^source-plan-[a-f0-9]{64}$/)
  expect(output).toMatchObject({ paths: [], local_paths: [], metadata_only: true, plan: emptyPlan })
  expect(one.online).toBe(false)
  expect(success(await invoke(root, ["composition", "inspect", manifest])).source_plan_id).toBe(
    output.source_plan_id,
  )
})

test("resource commands persist machine-only local identities and redact roots and signed retrieval URLs", async () => {
  const root = await directory(),
    assets = join(root, "private-assets")
  await mkdir(assets)
  const bound = await invoke(root, [
    "resource",
    "bind-local",
    "assets",
    "--machine-scope",
    "machine-cli",
    "--workspace-scope",
    "workspace-cli",
    "--workspace-root",
    root,
    "--root",
    assets,
  ])
  expect(success(bound)).toMatchObject({
    binding_key: "assets",
    machine_scope: "machine-cli",
    workspace_scope: "workspace-cli",
  })
  expect(bound.online).toBe(false)
  success(
    await invoke(root, ["resource", "http-policy", "--origin", "https://resources.example.com"]),
  )
  const manifest = join(root, "files.json"),
    locations = join(root, "locations.json"),
    hash = "1".repeat(64)
  await writeFile(
    manifest,
    JSON.stringify({ version: 1, files: [{ path: "file.bin", sha256: hash, bytes: 1 }] }),
  )
  await writeFile(
    locations,
    JSON.stringify([
      { sha256: hash, url: "https://resources.example.com/object?signature=private-query-value" },
    ]),
  )
  success(
    await invoke(root, [
      "resource",
      "http-locations",
      "--manifest",
      manifest,
      "--locations",
      locations,
    ]),
  )
  const shown = await invoke(root, ["resource", "show"])
  success(shown)
  expect(shown.stdout).not.toContain(root)
  expect(shown.stdout).not.toContain("private-query-value")
  expect(shown.stdout).not.toContain("/object")
  expect(shown.stdout).not.toContain("controlled-source-cli-token")
  expect(shown.online).toBe(false)
  success(
    await invoke(root, [
      "resource",
      "unbind-local",
      "assets",
      "--workspace-scope",
      "workspace-cli",
    ]),
  )
  success(await invoke(root, ["resource", "http-policy", "--deny-all"]))
})

test("invalid policy and ambiguous Source intent fail without contacting Notion", async () => {
  const root = await directory()
  const none = await invoke(root, ["resource", "http-policy"])
  failure(none, "INVALID_ARGUMENT")
  expect(none.online).toBe(false)
  const privateOrigin = await invoke(root, [
    "resource",
    "http-policy",
    "--origin",
    "https://127.0.0.1",
  ])
  failure(privateOrigin, "INVALID_HTTP_RESOURCE_URL")
  expect(privateOrigin.online).toBe(false)
  const contradictory = await invoke(root, [
    "select",
    "prepare",
    skillPage,
    "--entry",
    library.skills.database_id,
    "--native",
    "--source",
    `source-plan-${"0".repeat(64)}`,
  ])
  failure(contradictory, "INVALID_ARGUMENT")
  expect(contradictory.online).toBe(false)
})

async function fakeNotion(root: string, unknownSourceCreate = false) {
  const statePath = join(root, "notion-state.json"),
    executable = join(root, "controlled-ntn")
  const rich = (id: string, content: string) => ({
    id,
    type: "rich_text",
    rich_text: [{ type: "text", plain_text: content, text: { content } }],
    has_more: false,
  })
  await writeFile(
    statePath,
    JSON.stringify({
      library,
      skillPage,
      calls: [],
      records: [],
      nextPage: 100,
      unknownSourceCreate,
      main: {
        object: "page",
        id: skillPage,
        last_edited_time: "2026-01-01T00:00:00.000Z",
        parent: {
          type: "data_source_id",
          data_source_id: library.skills.data_source_id,
          database_id: library.skills.database_id,
        },
        properties: {
          title: {
            id: "title",
            type: "title",
            title: [
              {
                type: "text",
                plain_text: "CLI source target",
                text: { content: "CLI source target" },
              },
            ],
          },
          description: rich("description", "Fixed source command fixture"),
          kind: { id: "kind", type: "select", select: { name: "skill" } },
          enabled: { id: "enabled", type: "checkbox", checkbox: true },
          default: { id: "default", type: "checkbox", checkbox: false },
          skill_id: rich("skill_id", "stable-cli-skill"),
          main_file_id: rich("main_file_id", "main-cli-file"),
          projection: rich("projection", ""),
          source: rich("source", ""),
        },
      },
    }),
  )
  const script = `#!${node}
const fs = require('node:fs');
const filename = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(filename,'utf8'));
const args = process.argv.slice(2);
if(args[0] === '--version') { process.stdout.write('ntn 1.0.0\\n'); process.exit(0); }
const url = new URL(args[1], 'https://api.notion.com/');
const method = args[args.indexOf('-X') + 1];
const raw = args.includes('--data') ? fs.readFileSync(0,'utf8') : '';
const body = raw ? JSON.parse(raw) : undefined;
state.calls.push({path:url.pathname,method});
const save = () => fs.writeFileSync(filename,JSON.stringify(state));
const send = (value) => { save(); process.stdout.write(JSON.stringify(value)); };
const text = (spans) => (spans || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
const matches = (row,filter) => { if(filter.and) return filter.and.every(x=>matches(row,x)); const field=row.properties[filter.property]; if(!field) return false; if(filter.relation) return field.relation.some(x=>x.id===filter.relation.contains); if(filter.select) return field.select.name===filter.select.equals; if(filter.rich_text) return text(field.rich_text)===filter.rich_text.equals; return false; };
const property = (id,value) => ({id,type:Object.keys(value)[0],...value,...(value.rich_text || value.relation ? {has_more:false} : {})});
if(url.pathname === '/v1/users/me') send({object:'user',id:'controlled-cli-user'});
else if(url.pathname === '/v1/databases/'+state.library.skills.database_id) send({object:'database',id:state.library.skills.database_id,title:[{plain_text:'Controlled source library'}],description:[{plain_text:'ntn-skills-library:v1 '+JSON.stringify(state.library)}],data_sources:[{id:state.library.skills.data_source_id}]});
else if(url.pathname === '/v1/pages/'+state.skillPage) { if(method==='PATCH') { for(const [key,value] of Object.entries(body.properties)) state.main.properties[key]=property(key,value); state.main.last_edited_time=new Date().toISOString(); } send(state.main); }
else if(url.pathname === '/v1/data_sources/'+state.library.records.data_source_id+'/query') send({object:'list',results:state.records.filter(row=>matches(row,body.filter)),has_more:false,next_cursor:null});
else if(url.pathname === '/v1/pages' && method === 'POST') { if(state.unknownSourceCreate && body.properties.kind.select.name==='source') {state.unknownSourceCreate=false; save(); process.stderr.write('controlled original create response lost\\n'); process.exitCode=5;} else {const id='00000000-0000-4000-8000-'+(state.nextPage++).toString(16).padStart(12,'0'); const row={object:'page',id,parent:{...body.parent,database_id:state.library.records.database_id},properties:Object.fromEntries(Object.entries(body.properties).map(([key,value])=>[key,property(key,value)]))}; state.records.push(row); send(row);}}
else { save(); process.stderr.write('Unexpected controlled endpoint\\n'); process.exitCode=97; }
`
  await writeFile(executable, script)
  await chmod(executable, 0o700)
  return { executable, read: async () => JSON.parse(await readFile(statePath, "utf8")) }
}

test("production CLI registers a composition, preserves its prepare file, and applies/reconciles only Source", async () => {
  const root = await directory(),
    fixture = await fakeNotion(root),
    manifest = join(root, "plan.json"),
    operation = join(root, "selection.json")
  await writeFile(manifest, JSON.stringify(emptyPlan))
  const registered = success(
    await invoke(
      root,
      [
        "composition",
        "register",
        skillPage,
        "--entry",
        library.skills.database_id,
        "--manifest",
        manifest,
      ],
      fixture.executable,
    ),
  )
  const binding = registered.binding
  if (
    binding === null ||
    typeof binding !== "object" ||
    !("source_plan_id" in binding) ||
    typeof binding.source_plan_id !== "string"
  )
    throw new Error("Expected registered immutable source ID")
  const prepared = success(
    await invoke(
      root,
      [
        "select",
        "prepare",
        skillPage,
        "--entry",
        library.skills.database_id,
        "--source",
        binding.source_plan_id,
        "--output",
        operation,
      ],
      fixture.executable,
    ),
  )
  expect(prepared.protection).toMatchObject({ conditional: false })
  const frozen = JSON.parse(await readFile(operation, "utf8"))
  expect(frozen).toMatchObject({
    kind: "metadata_write",
    changes: [{ field: "Source", before: "", after: binding.source_plan_id }],
  })
  const applied = success(
    await invoke(
      root,
      ["select", "apply", operation, "--entry", library.skills.database_id],
      fixture.executable,
    ),
  )
  expect(applied.status).toBe("applied")
  expect(
    success(
      await invoke(
        root,
        ["select", "reconcile", operation, "--entry", library.skills.database_id],
        fixture.executable,
      ),
    ).status,
  ).toBe("applied")
  expect(JSON.parse(await readFile(operation, "utf8"))).toEqual(frozen)
  const state = await fixture.read()
  expect(state.calls.filter((call: { method: string }) => call.method === "PATCH")).toHaveLength(1)
  expect(state.calls.some((call: { path: string }) => call.path.includes("/markdown"))).toBe(false)
  expect(state.main.properties.source.rich_text[0].text.content).toBe(binding.source_plan_id)
}, 90_000)

test("production CLI ordinary registration retry reconciles its invisible unknown original create", async () => {
  const root = await directory(),
    fixture = await fakeNotion(root, true),
    manifest = join(root, "plan.json")
  await writeFile(manifest, JSON.stringify(emptyPlan))
  const args = [
    "composition",
    "register",
    skillPage,
    "--entry",
    library.skills.database_id,
    "--manifest",
    manifest,
  ]
  failure(await invoke(root, args, fixture.executable), "WRITE_OUTCOME_UNKNOWN")
  failure(await invoke(root, args, fixture.executable), "SHARED_RECORD_UNRESOLVED")
  const state = await fixture.read()
  expect(
    state.calls.filter(
      (call: { path: string; method: string }) =>
        call.path === "/v1/pages" && call.method === "POST",
    ),
  ).toHaveLength(1)
  expect(state.records).toHaveLength(0)
  expect(state.main.properties.source.rich_text[0].text.content).toBe("")
}, 60_000)
