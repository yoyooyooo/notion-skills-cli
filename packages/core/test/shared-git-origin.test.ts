import { expect, test } from "bun:test"
import { canonicalGitUrl, gitRemoteUrl } from "../src/shared-git-origin.ts"
import { validateFixedGithubSource } from "../src/shared-github-source.ts"

test("GitHub SSH spellings normalize to one current repository identity", () => {
  for (const url of [
    "https://github.com/example/skills.git",
    "git@github.com:example/skills.git",
    "ssh://git@github.com/example/skills.git",
    "ssh://git@github.com:22/example/skills.git",
  ]) {
    expect(canonicalGitUrl(url)).toBe("https://github.com/example/skills")
    expect(gitRemoteUrl(url)).toBe("https://github.com/example/skills.git")
  }
})

test.each([
  "https://private.example.test/team/skills.git",
  "https://private.example.test/team/skills",
  "http://private.example.test:8888/team/skills.git",
])("a private HTTP(S) origin preserves its exact remote path: %s", (url) => {
  expect(canonicalGitUrl(url)).toBe(url)
  expect(gitRemoteUrl(url)).toBe(url)
  const source = { url, commit: "a".repeat(40), tree: "b".repeat(40), root: "", files: [] }
  expect(validateFixedGithubSource(source)).toEqual(source)
})

test.each([
  "https://user:secret@private.example.test/team/skills.git",
  "http://user@private.example.test/team/skills.git",
  "https://private.example.test/team/skills.git?token=secret",
  "https://private.example.test/team/skills.git#fragment",
  "https://private.example.test/team/../secret.git",
  "https://private.example.test/team/%2e%2e/secret.git",
  "https://private.example.test/team/%2fsecret.git",
  "https://private.example.test/team/%00secret.git",
  "https://private.example.test//team/skills.git",
  "file:///private/repository",
  "/private/repository",
  "ssh://git@private.example.test/team/skills.git",
  "ssh://git@github.com:2222/example/skills.git",
  "ext::sh -c command",
])("shared origin rejects credentials, traversal and executable/local transport: %s", (url) => {
  expect(() => canonicalGitUrl(url)).toThrow()
})
