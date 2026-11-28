# Current Markdown parser

This private package exposes `SourceLexer`, the shared parser for current human reading projections, native inline code boundaries, and package documentation checks. It performs no I/O and never executes source text.

```ts
import { SourceLexer } from "@notion-skills-cli/markdown"

const blocks = SourceLexer.lex(markdown)
const inline = SourceLexer.lexInline(markdown)
```

The parser retains authored token text and explicit link destinations. Its local grammar correction keeps a single tilde followed by a code span from being reinterpreted as strikethrough. Each call owns its lexer state; reference definitions from one document do not leak into another.

Current body ownership, complete directory validation, native page links, uploads, and readable Notion blocks belong to their core modules. This package does not compare publication receipts or reconstruct historical readbacks.

## Verify the parser

```sh
node --test packages/markdown/test/source-lexer.node.test.mjs
bun test packages/core/test/shared-current-projection.test.ts packages/core/test/typed-links-code-label.test.ts
```
