import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"

/** Pure publication fixtures exercise real local locks, but not host Trash.
 * Retain only their released fences with the same inode and owner receipt.
 * Other commands still use the real process service. */
export const retainedLockFixture = (ownedRoots: ReadonlySet<string>) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return {
        ...real,
        exitCode: (command: Parameters<typeof real.exitCode>[0]) => {
          if (command._tag !== "StandardCommand") return real.exitCode(command)
          if (
            command.command === "/bin/test" &&
            command.args.length === 2 &&
            command.args[0] === "-x" &&
            command.args[1] === "/usr/bin/trash"
          )
            return Effect.promise(() =>
              fs.access("/usr/bin/trash", constants.X_OK).then(
                () => ChildProcessSpawner.ExitCode(0),
                () => ChildProcessSpawner.ExitCode(1),
              ),
            )
          if (command.command !== "/usr/bin/trash") return real.exitCode(command)
          return Effect.promise(async () => {
            const source = command.args[0]
            assert.equal(command.args.length, 1)
            assert.ok(source, "A released fixture fence is required")
            const root = [...ownedRoots].find(
              (value) => dirname(source) === join(value, "sync/locks"),
            )
            assert.ok(root, "Refusing retention outside the fixture's owned lock roots")
            assert.match(basename(source), /^[a-f0-9]{64}\.[a-f0-9-]{36}\.released$/u)
            const before = await fs.lstat(source, { bigint: true })
            const receipt = await fs.readFile(join(source, "owner.json"))
            assert.ok(before.isDirectory())
            assert.equal(JSON.parse(receipt.toString()).pid, process.pid)
            const retained = join(root, "retained-locks")
            await fs.mkdir(retained, { recursive: true })
            const destination = join(retained, randomUUID())
            await fs.rename(source, destination)
            const after = await fs.lstat(destination, { bigint: true })
            assert.deepEqual([after.dev, after.ino], [before.dev, before.ino])
            assert.deepEqual(await fs.readFile(join(destination, "owner.json")), receipt)
            await assert.rejects(fs.lstat(source), { code: "ENOENT" })
            return ChildProcessSpawner.ExitCode(0)
          })
        },
      }
    }),
  ).pipe(Layer.provide(NodeServices.layer))
