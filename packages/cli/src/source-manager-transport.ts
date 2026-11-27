import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Schema } from "effect"
import { fail, property } from "../../core/src/model.ts"
import type { CurrentSourceSyncRequest } from "../../core/src/shared-current-source-sync-model.ts"
import type { SourceMaterializationRequest } from "../../core/src/shared-source-materialization-model.ts"
import type { OperationOptions } from "./operation-runtime.ts"

const Library = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
const Identity = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const BindingSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("ssh"),
    library: Library,
    execution_id: Identity,
    host: Schema.String,
    command: Schema.String,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("local"),
    library: Library,
    execution_id: Identity,
    command: Schema.String,
  }),
])
export type SourceManagerBinding = typeof BindingSchema.Type
export type SourceManagerCommand =
  | {
      readonly version: 1
      readonly action: "materialize"
      readonly input: SourceMaterializationRequest
    }
  | {
      readonly version: 1
      readonly action: "sync"
      readonly input: CurrentSourceSyncRequest & { readonly library: string }
    }

/** Credentials and manager bindings use private regular files, never shell fragments. */
export async function readSourceManagerJson(path: string): Promise<unknown> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
    throw fail(
      "SOURCE_MANAGER_CONFIG_INVALID",
      "Use a canonical absolute manager configuration path.",
    )
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 65_536
    )
      throw fail(
        "SOURCE_MANAGER_CONFIG_INVALID",
        "The manager configuration must be a private bounded file.",
      )
    const raw = await handle.readFile("utf8")
    if (Buffer.byteLength(raw) > 65_536)
      throw fail("SOURCE_MANAGER_CONFIG_INVALID", "The manager configuration is too large.")
    return JSON.parse(raw)
  } finally {
    await handle.close()
  }
}

export async function sourceManagerBinding(
  options: OperationOptions,
): Promise<SourceManagerBinding | undefined> {
  const env = options.env ?? process.env
  const config =
    env.NTN_SKILLS_CONFIG_HOME ??
    (env.XDG_CONFIG_HOME === undefined
      ? join(env.HOME ?? homedir(), ".config", "ntn-skills")
      : join(env.XDG_CONFIG_HOME, "ntn-skills"))
  const path =
    env.NTN_SKILLS_SOURCE_MANAGER_BINDING ??
    resolve(options.cwd ?? ".", config, "source-manager.json")
  try {
    await lstat(path)
  } catch (error) {
    if (env.NTN_SKILLS_SOURCE_MANAGER_BINDING === undefined && property(error).code === "ENOENT")
      return undefined
    throw fail(
      "SOURCE_MANAGER_CONFIG_INVALID",
      "The configured Source manager binding is unavailable.",
    )
  }
  let binding: SourceManagerBinding
  try {
    binding = Schema.decodeUnknownSync(BindingSchema)(await readSourceManagerJson(path), {
      onExcessProperty: "error",
    })
  } catch {
    throw fail("SOURCE_MANAGER_CONFIG_INVALID", "The Source manager binding is invalid.")
  }
  // OpenSSH passes its command through a remote shell. This fixed path grammar
  // has no shell syntax; all business values are sent as bounded stdin JSON.
  if (
    !/^\/[A-Za-z0-9_./-]+$/u.test(binding.command) ||
    resolve(binding.command) !== binding.command ||
    (binding.kind === "ssh" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(binding.host))
  )
    throw fail(
      "SOURCE_MANAGER_CONFIG_INVALID",
      "The manager needs a fixed executable path and SSH host.",
    )
  if (binding.kind === "local") {
    const info = await lstat(binding.command)
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      (info.mode & 0o111) === 0 ||
      (await realpath(binding.command)) !== binding.command
    )
      throw fail(
        "SOURCE_MANAGER_CONFIG_INVALID",
        "The local manager entry is not a canonical executable file.",
      )
  }
  return binding
}

/** Cancellation ends the foreground wait. It never terminates an accepted writer. */
export async function invokeSourceManager(
  command: SourceManagerCommand,
  binding: SourceManagerBinding,
  options: OperationOptions,
): Promise<unknown> {
  if (command.input.library !== binding.library)
    throw fail(
      "SOURCE_MANAGER_SCOPE_MISMATCH",
      "The request belongs to another configured Library.",
    )
  if (options.signal?.aborted)
    throw fail("CANCELLED", "The manager request was not dispatched.", { phase: "not_dispatched" })
  const requestId = command.action === "materialize" ? command.input.request_id : randomUUID()
  const bytes =
    JSON.stringify({
      version: 1,
      request_id: requestId,
      execution_id: binding.execution_id,
      library: binding.library,
      command,
    }) + "\n"
  if (Buffer.byteLength(bytes) > 65_536)
    throw fail("INVALID_ARGUMENT", "The manager request exceeds 64 KiB.")
  const env: NodeJS.ProcessEnv = {
    HOME: homedir(),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
  }
  if (binding.kind === "ssh" && process.env.SSH_AUTH_SOCK !== undefined)
    env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK
  const executable = binding.kind === "ssh" ? "/usr/bin/ssh" : binding.command
  const args =
    binding.kind === "ssh"
      ? [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=2",
          binding.host,
          binding.command,
        ]
      : []
  return await new Promise<unknown>((accept, reject) => {
    const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"], detached: true })
    let output = "",
      outputBytes = 0,
      errorBytes = 0,
      finished = false
    const finish = (error?: unknown, result?: unknown) => {
      if (finished) return
      finished = true
      options.signal?.removeEventListener("abort", abort)
      if (error !== undefined) reject(error)
      else accept(result)
    }
    const abort = () => {
      finish(
        fail(
          "CANCELLED",
          "Stopped waiting for the manager. The original operation may still be running.",
          { phase: "outcome_unknown", request_id: requestId },
        ),
      )
      child.unref()
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes <= 1_048_576) output += chunk
      else
        finish(
          fail("SOURCE_MANAGER_RESPONSE_INVALID", "The manager response exceeded its bound.", {
            phase: "outcome_unknown",
            request_id: requestId,
          }),
        )
    })
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.byteLength
      if (errorBytes > 1_048_576)
        finish(
          fail("SOURCE_MANAGER_RESPONSE_INVALID", "The manager diagnostics exceeded their bound.", {
            phase: "outcome_unknown",
            request_id: requestId,
          }),
        )
    })
    child.on("error", () =>
      finish(
        fail("SOURCE_MANAGER_UNAVAILABLE", "The configured manager could not be started.", {
          request_id: requestId,
        }),
      ),
    )
    child.stdin.on("error", () =>
      finish(
        fail("SOURCE_MANAGER_UNAVAILABLE", "The manager request channel failed.", {
          phase: "outcome_unknown",
          request_id: requestId,
        }),
      ),
    )
    child.on("close", (exit) => {
      if (finished) return
      try {
        const reply = property(JSON.parse(output))
        if (
          exit !== 0 ||
          reply.version !== 1 ||
          reply.request_id !== requestId ||
          reply.execution_id !== binding.execution_id ||
          reply.library !== binding.library
        )
          throw fail(
            "SOURCE_MANAGER_RESPONSE_INVALID",
            "The manager identity or response differs from this request.",
            { phase: "outcome_unknown", request_id: requestId },
          )
        if (reply.ok !== true) {
          const error = property(reply.error)
          if (typeof error.code !== "string" || typeof error.message !== "string")
            throw new Error("invalid manager error")
          throw fail(error.code, error.message, { phase: "outcome_unknown", request_id: requestId })
        }
        finish(undefined, reply.result)
      } catch (error) {
        finish(
          error instanceof Error && "code" in error
            ? error
            : fail("SOURCE_MANAGER_RESPONSE_INVALID", "The manager returned an invalid response.", {
                phase: "outcome_unknown",
                request_id: requestId,
              }),
        )
      }
    })
    child.stdin.end(bytes)
    if (options.signal?.aborted) abort()
  })
}
