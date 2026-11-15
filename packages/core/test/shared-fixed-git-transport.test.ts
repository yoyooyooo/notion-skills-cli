import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile, chmod, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

/** Real Git and a trusted, temporary per-process origin rewrite. It does not
 * edit the user's Git configuration and source content cannot select commands. */
test("fixed Git object transfer preserves exact requested pinned bytes/modes without checkout or script execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-fixed-transfer-")),
    work = join(directory, "work"),
    remote = join(directory, "origin.git")
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixed transport fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixed transport fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  }
  await mkdir(join(work, "skills/demo/scripts"), { recursive: true })
  await mkdir(join(work, "unselected"))
  const git = (root: string, args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  git(work, ["init", "-b", "main"])
  const content = new Map<string, Uint8Array>([
    [
      "SKILL.md",
      new TextEncoder().encode(
        "---\nname: exact-fixed\ndescription: No execution\n---\n\nRead only.\n",
      ),
    ],
    [
      "scripts/run.sh",
      new TextEncoder().encode(`#!/bin/sh\ntouch '${join(directory, "must-not-exist")}'\n`),
    ],
    ["payload.bin", new Uint8Array([0, 255, 11, 10, 17])],
  ])
  for (const [path, bytes] of content) await writeFile(join(work, "skills/demo", path), bytes)
  await chmod(join(work, "skills/demo/scripts/run.sh"), 0o755)
  await writeFile(join(work, "unselected/large.bin"), new Uint8Array(2 * 1024 * 1024).fill(73))
  git(work, ["add", "."])
  git(work, ["commit", "--no-gpg-sign", "-m", "original exact source"])
  const commit = git(work, ["rev-parse", "HEAD"]),
    tree = git(work, ["rev-parse", "HEAD^{tree}"])
  const files = [...content].map(([path, bytes]) => ({
    path,
    source_path: "skills/demo/" + path,
    git_oid: git(work, ["rev-parse", commit + ":skills/demo/" + path]),
    bytes: bytes.length,
    mode: path.endsWith(".sh") ? "100755" : "100644",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }))
  await writeFile(join(work, "skills/demo/payload.bin"), "new HEAD must not replace pin")
  git(work, ["add", "."])
  git(work, ["commit", "--no-gpg-sign", "-m", "new unselected version"])
  git(directory, ["clone", "--bare", work, remote])
  git(remote, ["config", "uploadpack.allowFilter", "true"])
  git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"])
  const config = join(directory, "gitconfig")
  await writeFile(
    config,
    `[url "${pathToFileURL(remote).href}"]\n\tinsteadOf = https://github.com/example/fixed-transport.git\n`,
  )
  const source = {
    url: "https://github.com/example/fixed-transport",
    commit,
    tree,
    root: "skills/demo",
    files,
  }
  await writeFile(join(directory, "source.json"), JSON.stringify(source))
  const root = resolve(import.meta.dir, "../../.."),
    script = join(directory, "probe.ts")
  await writeFile(
    script,
    `
import assert from 'node:assert/strict';import {readFile,writeFile,access} from 'node:fs/promises';
import {Effect,Layer} from ${JSON.stringify(join(root, "node_modules/effect/dist/index.js"))};
import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {readFixedGitObjects} from ${JSON.stringify(join(root, "packages/core/src/shared-fixed-git-transport.ts"))};
import {createRequestMetrics} from ${JSON.stringify(join(root, "packages/core/src/request-metrics.ts"))};
const directory=process.argv[2],source=JSON.parse(await readFile(directory+'/source.json','utf8'));
const metrics=createRequestMetrics();const selected=source.files.filter(f=>f.path!=='SKILL.md');
const result=await Effect.runPromise(readFixedGitObjects({source,files:selected,metrics}).pipe(Effect.provide(NodeServices.layer)));
assert.equal(result.size,2);assert.deepEqual([...result.get(source.files.find(f=>f.path==='payload.bin').git_oid)],[0,255,11,10,17]);
assert.equal(result.has(source.files.find(f=>f.path==='SKILL.md').git_oid),false);
const badTree=await Effect.runPromise(readFixedGitObjects({source:{...source,tree:'f'.repeat(40)},files:selected}).pipe(Effect.result,Effect.provide(NodeServices.layer)));
assert.equal(badTree._tag,'Failure');assert.equal(badTree.failure.code,'FIXED_GIT_TREE_MISMATCH');
const badEntry={...selected[0],bytes:selected[0].bytes+1};const badSelection=await Effect.runPromise(readFixedGitObjects({source,files:[badEntry]}).pipe(Effect.result,Effect.provide(NodeServices.layer)));
assert.equal(badSelection._tag,'Failure');assert.equal(badSelection.failure.code,'FIXED_GIT_SELECTION_INVALID');
const badHashSource={...source,files:source.files.map(f=>f.path==='payload.bin'?{...f,sha256:'0'.repeat(64)}:f)};
const badHash=await Effect.runPromise(readFixedGitObjects({source:badHashSource,files:[badHashSource.files.find(f=>f.path==='payload.bin')]}).pipe(Effect.result,Effect.provide(NodeServices.layer)));
assert.equal(badHash._tag,'Failure');assert.equal(badHash.failure.code,'GITHUB_BLOB_MISMATCH');
let executed=true;try{await access(directory+'/must-not-exist')}catch{executed=false}assert.equal(executed,false);
const proof={commit:source.commit,selectedFiles:selected.map(f=>f.path),tree:source.tree,returnedBlobs:result.size,scriptExecuted:false,
 changedHEADIgnored:true,wrongTreeAndEntryAndHashRejected:true,metrics:metrics.snapshot()};
await writeFile(directory+'/proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
`,
  )
  const child = Bun.spawn([process.execPath, script, directory], {
    env: { ...env, GIT_CONFIG_GLOBAL: config },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, stdout + stderr).toBe(0)
  const proof = JSON.parse(await readFile(join(directory, "proof.json"), "utf8"))
  expect(proof).toMatchObject({
    returnedBlobs: 2,
    scriptExecuted: false,
    changedHEADIgnored: true,
    wrongTreeAndEntryAndHashRejected: true,
  })
  expect(proof.metrics.source_acquisitions.attempts).toBe(1)
  expect(proof.metrics.source_acquisitions.wire_bytes).toBeNull()
  if (process.env.NTN_FIXED_GIT_EVIDENCE)
    await writeFile(
      process.env.NTN_FIXED_GIT_EVIDENCE,
      JSON.stringify({ directory, proof }, null, 2),
    )
}, 60000)
