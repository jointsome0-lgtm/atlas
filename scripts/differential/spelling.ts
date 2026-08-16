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
 *
 * That last sentence is enforced rather than hoped for, and structurally
 * rather than by a veto over the whole message. Both delimiters are matched
 * together with the value between them, and the value may not contain a quote
 * of either kind. So `'"'` and `"'"` — the two spellings a port could confuse
 * — both fail to match and are compared as they stand, which is the point:
 * substituting blindly would turn both into `"""` and let a port that named
 * the wrong character agree with the oracle about a value it got wrong. `''`
 * still folds, because the empty string is the one value where `''` and `""`
 * mean the same thing and nothing else.
 *
 * Matching the pair is also what keeps the fold out of the path. An earlier
 * version rewrote every delimiter-looking apostrophe on its own, so a path
 * that differed from the oracle's by exactly a quote character — `/x/'bad.fm`
 * against `/x/"bad.fm` — folded into agreement with it. A path is not prose
 * and it is not punctuation; it is the half of the diagnostic that is
 * promised. Here the closing delimiter has to be there, delimiting, before the
 * opening one moves, and a quote inside a path has nothing to close.
 *
 * The value class excluding both quote characters carries a second property
 * worth naming: a fold can never reach across one delimiter to another, so two
 * separate values in one message can never be run together.
 */
const DELIMITED = /(?<![\p{L}\p{N}_])'([^'"]*)'(?![\p{L}\p{N}_])/gu;

export const foldQuotes = (text: string): string => text.replaceAll(DELIMITED, '"$1"');

/**
 * A parser's own prose replaced by a marker, keeping everything in front of it.
 *
 * CPython names the token it wanted ("Expecting ',' delimiter"); this port
 * names the rule that was broken. The path and the line in front of both are
 * identical, and that is the half a consumer reads — §24.4 asks a diagnostic
 * for a reason code and a place, not for a sentence.
 *
 * Which is exactly why the whole diagnostic has to be matched and not just the
 * lead-in. Every one of these messages is `<path>:<line>: invalid JSON: ` and
 * then the prose, so that is what is required here. Looking for the lead-in
 * alone would find it inside a path that happened to contain it and throw away
 * the line, the §-tag and the identity behind it — the half that is promised —
 * folding two unrelated diagnostics into one.
 *
 * `s` because a path may contain a newline: POSIX allows one, and without the
 * flag the lead-in simply stops matching and two messages differing only in
 * parser prose are reported as a divergence. The match stays greedy, so a path
 * that contains the lead-in itself loses to the real one at the end.
 */
export const foldParserProse = (text: string): string =>
  text.replace(/^(.*:\d+: invalid JSON: ).*$/s, "$1<parser prose>");
