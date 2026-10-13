import { readFileSync } from "node:fs"

const pattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

function parse(value: string) {
  const match = pattern.exec(value)
  if (!match) throw new Error(`Invalid release version: ${value}`)
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    pre: match[4]?.split(".") ?? [],
  }
}

function compare(left: string, right: string): number {
  const l = parse(left)
  const r = parse(right)
  for (let i = 0; i < 3; i++) {
    if (l.core[i] !== r.core[i]) return l.core[i]! < r.core[i]! ? -1 : 1
  }
  if (!l.pre.length) return r.pre.length ? 1 : 0
  if (!r.pre.length) return -1
  for (let i = 0; i < Math.max(l.pre.length, r.pre.length); i++) {
    const a = l.pre[i]
    const b = r.pre[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const an = /^\d+$/.test(a)
    const bn = /^\d+$/.test(b)
    if (an && bn) return BigInt(a) < BigInt(b) ? -1 : 1
    if (an !== bn) return an ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

const [command, ...args] = process.argv.slice(2)
if (command === "version" && args.length === 1) {
  parse(args[0]!)
} else if (command === "channel" && args.length === 3) {
  const [version, channel, alreadyPublished] = args as [string, string, string]
  const order = compare(channel, version)
  if (order !== 0 && !(alreadyPublished === "true" && order > 0)) {
    throw new Error(`Registry channel mismatch: expected ${version}, got ${channel}`)
  }
} else if (command === "manifest" && args.length === 1) {
  const manifest = JSON.parse(readFileSync(args[0]!, "utf8"))
  if (
    manifest.name !== process.env.PACKAGE_NAME ||
    manifest.version !== process.env.PACKAGE_VERSION
  ) {
    throw new Error("Packed manifest name/version does not match the tagged release")
  }
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
    "overrides",
    "resolutions",
  ]) {
    const dependencies = JSON.stringify(manifest[field] ?? {})
    if (/catalog:|workspace:/.test(dependencies))
      throw new Error(`Unresolved package reference in ${field}`)
  }
} else {
  throw new Error(
    "Usage: release-evidence.ts version VERSION | channel VERSION CHANNEL_VERSION ALREADY_PUBLISHED | manifest PACKED_JSON",
  )
}
