// How argparse reads a word, for the commands whose oracle uses argparse.
//
// Two of them do — the instance server and the demo viewer — and they offer
// the same three option strings, so the rules below were written once for the
// first and are shared rather than transcribed twice. What each command does
// with a word it has been handed stays its own: this module only says what
// the word is.
//
// Ported from _parse_optional and the front of parse_known_args in CPython's
// argparse, as reached from scripts/serve_instance.py and scripts/view_demo.py.

/** One argument, classified the way `_parse_optional` classifies it. */
export type Word =
  | { readonly kind: "positional"; readonly value: string }
  /**
   * The first bare `--`, which is a word in its own right and not a nothing.
   *
   * The oracle's parser gives it a pattern character of its own, distinct from
   * both an option and a value, and then leaves it in the line. What that
   * means for a caller is two things it would not get by dropping the word:
   * an option's value can never be `--` — the pattern an option matches its
   * value against has the separator stripped out of it, so `--port -- 9000`
   * leaves `--port` with nothing — and a separator nothing else takes is an
   * argument the parser could not place, like any other.
   */
  | { readonly kind: "separator" }
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous"; readonly matched: readonly string[] }
  | {
      readonly kind: "option";
      /** The action addressed, named by its long spelling. */
      readonly option: string;
      /** Whether the caller spelled it with one dash, which changes a refusal. */
      readonly short: boolean;
      /** A value attached to the word itself, by `=` or by juxtaposition. */
      readonly explicit: string | null;
      /**
       * How that value was attached: `=` or nothing at all.
       *
       * The parser keeps these apart, and for an option that takes no value it
       * is the whole difference between printing help and refusing: `-hx` is
       * `-h` followed by more short options, `-h=x` is `-h` handed an argument
       * it has no use for.
       */
      readonly sep: "=" | "" | null;
    };

/** A word the parser kept: an ambiguous one never becomes anything. */
export type Placed = Exclude<Word, { readonly kind: "ambiguous" }>;

const asOption = (
  option: string,
  short: boolean,
  explicit: string | null,
  sep: "=" | "" | null,
): Word => ({
  kind: "option",
  // Both spellings of help address one action, named here by the long one so
  // a caller compares against a single name.
  option: option === "-h" ? "--help" : option,
  short,
  explicit,
  sep,
});

/**
 * Read one argument as the oracle's parser reads it, before anything is used.
 *
 * The order is argparse's and it is load-bearing: an exact spelling wins, then
 * an exact spelling with `=value`, then an unambiguous *prefix* — `--po` is
 * `--port` because `allow_abbrev` is on by default — and only what is left
 * over is measured against the two rules that hand a word back to the
 * positionals: a negative number (neither caller has an option that looks like
 * one) and an argument with a space in it, which was meant to be a path.
 */
export function classify(argument: string, options: readonly string[]): Word {
  const positional = { kind: "positional", value: argument } as const;
  if (argument === "" || !argument.startsWith("-")) return positional;
  // A lone dash names a file by convention, so it is never an option.
  if (argument === "-") return positional;
  if (options.includes(argument)) {
    return asOption(argument, !argument.startsWith("--"), null, null);
  }
  const equals = argument.indexOf("=");
  const beforeEquals = equals < 0 ? argument : argument.slice(0, equals);
  const afterEquals = equals < 0 ? null : argument.slice(equals + 1);
  if (equals >= 0 && options.includes(beforeEquals)) {
    return asOption(beforeEquals, !beforeEquals.startsWith("--"), afterEquals, "=");
  }
  const matches: Word[] = [];
  const matched: string[] = [];
  if (argument.startsWith("--")) {
    // Two dashes: the word is split at `=` and the rest is a prefix. `--=1`
    // has the empty prefix, which is every option at once.
    for (const option of options) {
      if (option.startsWith(beforeEquals)) {
        matches.push(asOption(option, false, afterEquals, afterEquals === null ? null : "="));
        matched.push(option);
      }
    }
  } else {
    // One dash: a short option carries its value in the same word, so `-hx`
    // addresses `-h` and hands it an `x` with nothing between them.
    for (const option of options) {
      if (option === argument.slice(0, 2)) {
        matches.push(asOption(option, true, argument.slice(2), ""));
        matched.push(option);
      } else if (option.startsWith(argument)) {
        matches.push(asOption(option, false, null, null));
        matched.push(option);
      }
    }
  }
  if (matches.length > 1) return { kind: "ambiguous", matched };
  if (matches.length === 1) return matches[0] as Word;
  // `\d` in the oracle's matcher is every Unicode decimal, not the ten ASCII
  // ones, so `-١` is a name and not an option nobody wrote. JavaScript's `\d`
  // is the ten, which is why this asks for the category by name.
  if (/^-\p{Nd}+$|^-\p{Nd}*\.\p{Nd}+$/u.test(argument)) return positional;
  if (argument.includes(" ")) return positional;
  return { kind: "unknown" };
}

export type Reading =
  | { readonly kind: "words"; readonly words: readonly Placed[] }
  | { readonly kind: "error"; readonly message: string };

/**
 * Classify the whole line before any word of it is used.
 *
 * argparse builds its pattern first, which is why an ambiguous option later in
 * the line is refused even though `-h` came earlier and would have printed
 * help.
 */
export function readWords(argv: readonly string[], options: readonly string[]): Reading {
  const words: Placed[] = [];
  let separated = false;
  for (const argument of argv) {
    if (separated) {
      words.push({ kind: "positional", value: argument });
      continue;
    }
    // The first bare `--` stops the classifying — and stays in the line.
    if (argument === "--") {
      separated = true;
      words.push({ kind: "separator" });
      continue;
    }
    const word = classify(argument, options);
    if (word.kind === "ambiguous") {
      return {
        kind: "error",
        message: `ambiguous option: ${argument} could match ${word.matched.join(", ")}`,
      };
    }
    words.push(word);
  }
  return { kind: "words", words };
}

/**
 * The characters `int()` skips around a number.
 *
 * Neither `String.trim()` nor `str.strip()`: `int()` rewrites the string
 * before it parses it, and that pass only asks Unicode about characters past
 * ASCII. So the next-line character is skipped and the file separator — which
 * `str.strip()` does remove — is not, and the byte-order mark `trim()` removes
 * is not skipped either.
 */
const INT_SPACE =
  "[\\t\\n\\v\\f\\r \\x85\\xa0\\u1680\\u2000-\\u200a"
  + "\\u2028\\u2029\\u202f\\u205f\\u3000]";
const INT_STRIP = new RegExp(`^${INT_SPACE}+|${INT_SPACE}+$`, "gu");

/**
 * The value of one decimal digit, in any script that writes them.
 *
 * `int()` reads every character Unicode gives a decimal value, not the ten
 * ASCII ones, so `--port ٨١٣٨` is port 8138 to the oracle. Unicode encodes
 * each set of ten contiguously and in ascending order, so a digit's value is
 * its distance from the start of the run of digits it sits in, and the runs
 * that abut (the mathematical alphanumerics) are whole sets end to end — hence
 * the remainder. The runtime's Unicode table can be newer than the oracle's,
 * which is a difference about which scripts have digits at all.
 */
function decimalValue(digit: string): number {
  const isDigit = (code: number): boolean => /^\p{Nd}$/u.test(String.fromCodePoint(code));
  const code = digit.codePointAt(0) as number;
  let start = code;
  while (start > 0 && isDigit(start - 1)) start -= 1;
  return (code - start) % 10;
}

/**
 * `int(value)`, or null where CPython would raise ValueError.
 *
 * CPython's `int()` takes surrounding whitespace, a sign, and underscores
 * between digits; anything else is a refusal. The result is a number rather
 * than a bigint because both callers immediately measure it against a port
 * range, and a value past that range is refused whatever its precision.
 */
export function pythonInt(value: string): number | null {
  const text = value.replace(INT_STRIP, "");
  const digits = /^[+-]?(\p{Nd}(?:_?\p{Nd})*)$/u.exec(text);
  if (digits === null) return null;
  const sign = text.startsWith("-") ? -1 : 1;
  const written = [...(digits[1] as string)]
    .filter((character) => character !== "_")
    .map((character) => decimalValue(character))
    .join("");
  return sign * Number(written);
}
