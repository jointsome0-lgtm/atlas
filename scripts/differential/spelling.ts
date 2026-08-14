// The differences between the two sides that are spelling, not meaning.
//
// What a diagnostic promises is the place and the reason: the path, the line,
// the §-tag, the ids around it. Those are compared as they stand. The English
// between them is not a promise, and neither is the punctuation CPython puts
// around a value — insisting on either would pin accidents of the
// implementation being replaced as the contract of the one replacing it.
//
// Every fold here is applied to both sides. A fold that ran on one side only
// would manufacture divergences out of agreement, which is how the first
// version of this went wrong.

/**
 * A message with apostrophe-delimited values rewritten to double quotes.
 *
 * Python's `repr` delimits a string with apostrophes where `JSON.stringify`
 * uses double quotes, and that is the whole of the difference — so only the
 * apostrophes acting as delimiters may move. An apostrophe with a word
 * character on each side is inside a word (`material's slug`, `it's`), never a
 * delimiter, and rewriting it would corrupt the sentence on one side and leave
 * the other alone.
 *
 * This stays deliberately narrow: two messages can only be folded together
 * when they differ exactly where one spells a delimiter and the other spells
 * the same delimiter differently. A value that itself contains a quote
 * character is not folded into agreement — CPython switches to double quotes
 * there and the two spellings genuinely diverge (#133).
 */
export const foldQuotes = (text: string): string =>
  text.replaceAll(/(?<![\p{L}\p{N}_])'|'(?![\p{L}\p{N}_])/gu, '"');

/**
 * A parser's own prose replaced by a marker, keeping everything in front of it.
 *
 * CPython names the token it wanted ("Expecting ',' delimiter"); this port
 * names the rule that was broken. The path and the line in front of both are
 * identical, and that is the half a consumer reads — §24.4 asks a diagnostic
 * for a reason code and a place, not for a sentence.
 */
export const foldParserProse = (text: string): string =>
  text.replace(/invalid JSON: .*$/, "invalid JSON: <parser prose>");
