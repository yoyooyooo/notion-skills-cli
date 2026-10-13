import { gzipSync } from "fflate"

export interface TarEntry {
  readonly name: string
  readonly content: string | Uint8Array
  readonly type?: string
}
export function tarGzip(entries: readonly TarEntry[]) {
  const chunks: Uint8Array[] = []
  const encoder = new TextEncoder()
  for (const entry of entries) {
    const content =
      typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content
    const header = new Uint8Array(512)
    const put = (offset: number, value: string) => header.set(encoder.encode(value), offset)
    put(0, entry.name)
    put(100, "0000600\0")
    put(108, "0000000\0")
    put(116, "0000000\0")
    put(124, content.length.toString(8).padStart(11, "0") + "\0")
    put(136, "00000000000\0")
    put(148, "        ")
    put(156, entry.type ?? "0")
    put(257, "ustar\0")
    put(263, "00")
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    put(148, checksum.toString(8).padStart(6, "0") + "\0 ")
    chunks.push(header, content, new Uint8Array((512 - (content.length % 512)) % 512))
  }
  chunks.push(new Uint8Array(1024))
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return gzipSync(bytes)
}

export const mainContent =
  "---\nname: sample-skill\ndescription: Use when reviewing sample resources.\n---\nRead references/guide.md\n"
export const skillBundle = tarGzip([
  { name: "sample-skill/SKILL.md", content: mainContent },
  { name: "sample-skill/references/guide.md", content: "\ufeff第一行\n第二行\n第三行" },
  { name: "sample-skill/assets/data.bin", content: new Uint8Array([0, 1, 2]) },
])
