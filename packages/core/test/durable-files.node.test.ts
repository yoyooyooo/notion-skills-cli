import { expect, test } from "@effect/vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
function launch(root: string, body: string, boundary = "", preamble = "") {
  const code = `${preamble}import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {Effect,FileSystem,Layer,ConfigProvider} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive,sha256} from ${JSON.stringify(core + "store.ts")};
import {SnapshotSchema} from ${JSON.stringify(core + "model.ts")};
import {loadSnapshot} from ${JSON.stringify(core + "snapshot.ts")};
const root=${JSON.stringify(root)};
const boundary=Layer.effect(FileSystem.FileSystem,Effect.map(FileSystem.FileSystem,fs=>({...fs,${boundary}}))).pipe(Layer.provide(NodeServices.layer));
const services=Layer.merge(NodeServices.layer,boundary);
Effect.runPromise(Effect.gen(function*(){const store=yield* Store;const bytes=new TextEncoder().encode('durable content');const hash=yield* sha256(bytes);const id='s_'+(yield* sha256(JSON.stringify(['scope','notion_page:page','v_fixture'])));const key='snapshots/'+id+'.json';const snapshot={snapshot_id:id,scope:'scope',version_id:'v_fixture',entrypoint:'SKILL.md',created_at:123,record:{id:'notion_page:page',kind:'skill',entrypoint:'SKILL.md',locator:{type:'notion_page',page_id:'page',database_id:'db',data_source_id:'ds'},name:'fixture',alias:'fixture',description:'fixture',ref:'skill://page/SKILL.md',default_context:false},files:[{path:'SKILL.md',bytes:bytes.length,sha256:hash}]};${body}}).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(services))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(e=>{console.error(String(e));process.exitCode=1});`
  const worker = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env,
      NTN_SKILLS_HOME: root,
      NTN_SKILLS_CONFIG_HOME: root + "-config",
      NTN_SKILLS_CACHE_HOME: root + "-cache",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const done = once(worker, "close").then(([exit]) => ({ exit, stdout, stderr }))
  return { worker, done }
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-durable-"))
  try {
    await run(directory)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
}
const publish =
  "yield* store.writeBytes('objects/'+hash,bytes);yield* store.writeJson(key,snapshot);console.log('published')"
const consume =
  "const recovered=yield* loadSnapshot(id);console.log(JSON.stringify(recovered));console.log(new TextDecoder().decode(yield* store.readBytes('objects/'+recovered.files[0].sha256)))"

test("first nested directory parent barrier failure cannot publish a snapshot pointer", () =>
  temporary(async (directory) => {
    const root = join(directory, "first", "nested", "state")
    const initialized = await launch(root, "console.log('initialized')").done
    expect(initialized.exit, initialized.stderr).toBe(0)
    const failed = await launch(
      root,
      publish,
      `open:(p,o)=>Effect.map(fs.open(p,o),file=>Object.create(file,{sync:{value:Effect.andThen(Effect.sync(()=>console.log('sync:'+p)),p===${JSON.stringify(directory)}?Effect.fail(new Error('parent-entry barrier failed')):file.sync)}}))`,
    ).done
    expect(failed.exit).not.toBe(0)
    expect(failed.stderr).toContain("Could not durably publish local content")
    const order = failed.stdout.trim().split("\n")
    expect(order.indexOf("sync:" + root + "/objects")).toBeLessThan(order.indexOf("sync:" + root))
    expect(order.indexOf("sync:" + root)).toBeLessThan(
      order.indexOf("sync:" + join(directory, "first", "nested")),
    )
    expect(order.indexOf("sync:" + join(directory, "first", "nested"))).toBeLessThan(
      order.indexOf("sync:" + directory),
    )
    // The injected ancestor barrier fails the object publication's directory chain after the
    // object file is installed, so the installed object must remain readable while the pointer
    // publication is never reached.
    expect(failed.stdout).not.toContain("published")
    const object = await launch(
      root,
      "console.log(new TextDecoder().decode(yield* store.readBytes('objects/'+hash)))",
    ).done
    expect(object.exit, object.stderr).toBe(0)
    expect(object.stdout.trim()).toBe("durable content")
    const pointers = await launch(
      root,
      "console.log(JSON.stringify(yield* store.listKeys('snapshots/')))",
    ).done
    expect(pointers.exit, pointers.stderr).toBe(0)
    expect(pointers.stdout.trim()).toBe("[]")
    // The failed publication must leave the canonical SQLite state opened by the initializer
    // intact: same file bytes header and a schema-valid read through a fresh connection.
    expect(
      new TextDecoder().decode((await readFile(join(root, "state.sqlite"))).subarray(0, 16)),
    ).toBe("SQLite format 3\u0000")
    const canonical = await launch(
      root,
      "console.log((yield* store.readJson('snapshots/missing.json',SnapshotSchema))===undefined)",
    ).done
    expect(canonical.exit, canonical.stderr).toBe(0)
    expect(canonical.stdout.trim()).toBe("true")
  }))

test("reuse requires its own file and directory barriers before publishing a pointer", () =>
  temporary(async (directory) => {
    const root = join(directory, "state")
    expect((await launch(root, "yield* store.writeBytes('objects/'+hash,bytes)").done).exit).toBe(0)
    for (const target of ["file", "directory"]) {
      const failed = await launch(
        root,
        publish,
        `open:(p,o)=>Effect.map(fs.open(p,o),file=>Object.create(file,{sync:{value:(p.includes('/objects/')&& !p.endsWith('.pending') && ${JSON.stringify(target)}==='file')||(p===root+'/objects'&&${JSON.stringify(target)}==='directory')?Effect.fail(new Error('reuse barrier failed')):file.sync}}))`,
      ).done
      expect(failed.exit).not.toBe(0)
      expect(failed.stderr).toContain("Could not durably publish local content")
      const pointers = await launch(
        root,
        "console.log(JSON.stringify(yield* store.listKeys('snapshots/')))",
      ).done
      expect(pointers.exit, pointers.stderr).toBe(0)
      expect(pointers.stdout.trim()).toBe("[]")
      const retained = await launch(
        root,
        "console.log(new TextDecoder().decode(yield* store.readBytes('objects/'+hash)))",
      ).done
      expect(retained.exit, retained.stderr).toBe(0)
      expect(retained.stdout.trim()).toBe("durable content")
    }
    expect((await launch(root, publish).done).exit).toBe(0)
    const consumer = await launch(root, consume).done
    expect(consumer.exit, consumer.stderr).toBe(0)
    expect(consumer.stdout).toContain("durable content")
  }))

test("two publishers reuse an installed object while its first publisher is killed before directory sync", () =>
  temporary(async (directory) => {
    const root = join(directory, "state")
    const first = launch(
      root,
      publish,
      `link:(a,b)=>Effect.andThen(fs.link(a,b),b.includes('/objects/')?Effect.andThen(Effect.sync(()=>console.log('object-installed')),Effect.never):Effect.void)`,
    )
    const [signal] = (await once(first.worker.stdout, "data")) as [Buffer]
    expect(signal.toString()).toContain("object-installed")
    try {
      const second = await launch(root, publish).done
      expect(second.exit, second.stderr).toBe(0)
    } finally {
      first.worker.kill("SIGKILL")
      await first.done
    }
    const consumer = await launch(root, consume).done
    expect(consumer.exit, consumer.stderr).toBe(0)
    expect(consumer.stdout).toContain("durable content")
  }))

test("killed manifest publisher is recovered by a fresh snapshot consumer with its original timestamp", () =>
  temporary(async (directory) => {
    const root = join(directory, "state")
    const first = launch(
      root,
      publish,
      `open:(p,o)=>Effect.map(fs.open(p,o),file=>Object.create(file,{sync:{value:p===root+'/snapshots'?Effect.andThen(Effect.sync(()=>console.log('manifest-installed')),Effect.never):file.sync}}))`,
    )
    const signal = await Promise.race([
      once(first.worker.stdout, "data").then(([chunk]) => String(chunk)),
      first.done.then((result) => {
        throw new Error(JSON.stringify(result))
      }),
    ])
    expect(signal).toContain("manifest-installed")
    first.worker.kill("SIGKILL")
    await first.done
    const before = await launch(
      root,
      "console.log(JSON.stringify(yield* store.listKeys('snapshots/')))",
    ).done
    expect(before.stdout.trim()).toBe("[]")
    const consumer = await launch(root, consume).done
    expect(consumer.exit, consumer.stderr).toBe(0)
    expect(consumer.stdout).toContain('"created_at":123')
    expect(consumer.stdout).toContain("durable content")
    const after = await launch(
      root,
      "console.log(JSON.stringify(yield* store.listKeys('snapshots/')))",
    ).done
    expect(after.stdout).toContain("snapshots/s_")
  }))

test("concurrent snapshot publishers with different clocks retain one canonical timestamp", () =>
  temporary(async (directory) => {
    const root = join(directory, "state")
    const timestamps = [Date.now(), Date.now() + 60_000]
    const results = await Promise.all(
      timestamps.map(
        (createdAt) =>
          launch(
            root,
            `snapshot.created_at=${createdAt};yield* store.writeBytes('objects/'+hash,bytes);yield* store.writeJson(key,snapshot);const canonical=yield* loadSnapshot(id);console.log(JSON.stringify(canonical))`,
          ).done,
      ),
    )
    const published = results.map((result) => {
      expect(result.exit, result.stderr).toBe(0)
      return JSON.parse(result.stdout.trim())
    })
    expect(timestamps).toContain(published[0].created_at)
    expect(published[1]).toEqual(published[0])
    const recovered = await launch(root, "console.log(JSON.stringify(yield* loadSnapshot(id)))")
      .done
    expect(recovered.exit, recovered.stderr).toBe(0)
    expect(JSON.parse(recovered.stdout.trim())).toEqual(published[0])
  }))

test("competing different immutable bytes are refused and retain the winning content", () =>
  temporary(async (directory) => {
    const root = join(directory, "state")
    const results = await Promise.all(
      ["winner-a", "winner-b"].map(
        (value) =>
          launch(
            root,
            `yield* store.writeBytes('objects/contended',new TextEncoder().encode(${JSON.stringify(value)}))`,
          ).done,
      ),
    )
    expect(results.filter((result) => result.exit === 0)).toHaveLength(1)
    const retained = await readFile(join(root, "objects", "contended"), "utf8")
    expect(["winner-a", "winner-b"]).toContain(retained)
    const refused = await launch(
      root,
      `yield* store.writeBytes('objects/contended',new TextEncoder().encode('different'))`,
    ).done
    expect(refused.exit).not.toBe(0)
    expect(await readFile(join(root, "objects", "contended"), "utf8")).toBe(retained)
  }))

test("invalid orphan identity and corrupt referenced bytes never become registered snapshots", () =>
  temporary(async (directory) => {
    for (const invalid of ["identity", "object"]) {
      const root = join(directory, invalid)
      const retained = await launch(
        root,
        `yield* store.writeBytes('objects/'+hash,bytes);yield* store.writeBytes(key,new TextEncoder().encode(JSON.stringify(${JSON.stringify(invalid)}==='identity'?{...snapshot,version_id:'different-version'}:snapshot)));${invalid === "object" ? "yield* (yield* FileSystem.FileSystem).writeFile(root+'/objects/'+hash,new TextEncoder().encode('corrupt'));" : ""}`,
      ).done
      expect(retained.exit, retained.stderr).toBe(0)
      const id = (await launch(root, "console.log(id)").done).stdout.trim()
      const manifest = await readFile(join(root, "snapshots", id + ".json"), "utf8")
      const consumer = await launch(root, consume).done
      expect(consumer.exit).not.toBe(0)
      const pointers = await launch(
        root,
        "console.log(JSON.stringify(yield* store.listKeys('snapshots/')))",
      ).done
      expect(pointers.stdout.trim()).toBe("[]")
      expect(await readFile(join(root, "snapshots", id + ".json"), "utf8")).toBe(manifest)
    }
  }))
test("garbage collection keeps referenced history and retires unreachable objects only through Trash", () =>
  temporary(async (directory) => {
    const root = join(directory, "gc")
    const published = await launch(root, publish).done
    expect(published.exit, published.stderr).toBe(0)
    const orphan = await launch(
      root,
      "const orphan=new TextEncoder().encode('orphan');const orphanHash=yield* sha256(orphan);yield* store.writeBytes('objects/'+orphanHash,orphan);console.log(orphanHash)",
    ).done
    expect(orphan.exit, orphan.stderr).toBe(0)
    const orphanHash = orphan.stdout.trim()
    const applied = await launch(
      root,
      "console.log(JSON.stringify(yield* garbageCollectCache()))",
      "",
      "import {garbageCollectCache} from " + JSON.stringify(core + "cache.ts") + ";",
    ).done
    expect(applied.exit, applied.stderr).toBe(0)
    const result = JSON.parse(applied.stdout.trim())
    expect(result).toMatchObject({
      operation: "cache_gc",
      dry_run: false,
      online: false,
      unreachable_snapshots: [],
      unreachable_objects: [orphanHash],
    })
    const id = (await launch(root, "console.log(id)").done).stdout.trim()
    expect(await readFile(join(root, "snapshots", id + ".json"), "utf8")).toContain(id)
    const orphanPath = join(root, "objects", orphanHash)
    if (process.platform === "darwin") {
      expect(result.retained).toEqual([])
      await expect(readFile(orphanPath)).rejects.toThrow()
    } else {
      expect(result.retained).toEqual([orphanPath])
      expect(await readFile(orphanPath, "utf8")).toBe("orphan")
    }
    const referenced = await launch(root, consume).done
    expect(referenced.exit, referenced.stderr).toBe(0)
    expect(referenced.stdout).toContain("durable content")
  }))
