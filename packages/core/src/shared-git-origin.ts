import { fail } from "./model.ts"

const invalid = () =>
  fail(
    "INVALID_GIT_SOURCE",
    "Use a credential-free HTTP(S) Git repository or a GitHub SSH repository identity.",
  )

/** Shared identities never contain credentials, local paths or executable transports.
 * GitHub's HTTPS and SSH spellings identify the same repository. Other hosts keep
 * their exact repository path, including a declared .git suffix. */
export function canonicalGitUrl(input: string): string {
  if (!input || input.length > 4096 || /[\s\\\u0000-\u001f\u007f-\u009f]/u.test(input))
    throw invalid()
  const scp = /^git@github\.com:([^?#]+)$/u.exec(input)
  const ssh = /^ssh:\/\/git@github\.com(?::22)?\/([^?#]+)$/u.exec(input)
  const githubPath = scp?.[1] ?? ssh?.[1]
  const candidate = githubPath === undefined ? input : `https://github.com/${githubPath}`
  const parts = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/u.exec(candidate)
  if (!parts) throw invalid()
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw invalid()
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) throw invalid()
  const path = (parts[3] ?? "").replace(/\/$/u, "")
  const segments = path.slice(1).split("/")
  if (
    !path ||
    segments.some((segment) => {
      try {
        const decoded = decodeURIComponent(segment)
        return (
          !decoded ||
          decoded === "." ||
          decoded === ".." ||
          /[\/\\\u0000-\u001f\u007f-\u009f]/u.test(decoded)
        )
      } catch {
        return true
      }
    })
  )
    throw invalid()
  if (url.protocol === "https:" && url.hostname === "github.com" && url.port === "") {
    const owner = segments[0]
    const repository = segments[1]?.replace(/\.git$/u, "")
    if (
      segments.length !== 2 ||
      owner === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(owner) ||
      repository === undefined ||
      !/^[A-Za-z0-9_.-]{1,100}$/u.test(repository) ||
      repository === "." ||
      repository === ".."
    )
      throw invalid()
    return `https://github.com/${owner}/${repository}`
  }
  return `${url.origin}${path}`
}

export function isGithubGitUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(url)
}

/** Only GitHub's canonical browser identity needs its known clone suffix. */
export function gitRemoteUrl(url: string): string {
  const canonical = canonicalGitUrl(url)
  return isGithubGitUrl(canonical) ? `${canonical}.git` : canonical
}
