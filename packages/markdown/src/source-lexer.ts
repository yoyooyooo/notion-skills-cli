import { defaults, Lexer, Tokenizer } from "marked"

/** Marked's GFM text fallback groups adjacent tildes and backticks. When a
 * tilde did not open deletion, that can consume the next code span's opening
 * delimiter. Keep the literal tilde run and let the ordinary code tokenizer
 * consume its own delimiter on the next iteration. Deletion and code tokens
 * run before this fallback; raw HTML text must remain uninterpreted. */
class LiteralTildeTokenizer extends Tokenizer {
  override inlineText(source: string) {
    const token = super.inlineText(source)
    const literal = /^~+(?=`)/.exec(source)?.[0]
    return token && !token.escaped && literal && token.raw.length > literal.length
      ? { ...token, raw: literal, text: literal }
      : token
  }
}

/** A fresh tokenizer per call preserves Marked's defaults and avoids shared
 * lexer state. Source bytes, links, fences and all other grammar are unchanged. */
export class SourceLexer {
  static lex(source: string) {
    return Lexer.lex(source, { ...defaults, tokenizer: new LiteralTildeTokenizer() })
  }

  static lexInline(source: string) {
    return Lexer.lexInline(source, { ...defaults, tokenizer: new LiteralTildeTokenizer() })
  }
}
