import { oracleAnswer } from "./oracle.ts";
import {
  addDays,
  CalendarError,
  daysBetween,
  formatDate,
  fromOrdinal,
  midnightInstant,
  parseDate,
  toOrdinal,
} from "../src/calendar.ts";

// The oracle is CPython's `datetime.date`, which is what the Python
// implementation folds with. Every quantity below is timezone-free by
// construction on the oracle side; this harness exists to prove the
// TypeScript side is too, so it is run under several hostile TZ values
// (see package.json) rather than only under the developer's own.
// Dates chosen to break implementations that route through a wall-clock
// type: DST transitions (including Santiago's, which deletes midnight
// itself), leap days, the Gregorian century rules, and year ends.
const DATES: string[] = [
  "0001-01-01",
  "1582-10-15",
  "1899-12-31",
  "1900-02-28",
  "1900-03-01",
  "1970-01-01",
  "1999-12-31",
  "2000-01-01",
  "2000-02-29",
  "2024-02-29",
  "2026-01-01",
  "2026-03-08",
  "2026-03-09",
  "2026-03-29",
  "2026-03-30",
  "2026-09-05",
  "2026-09-06",
  "2026-09-07",
  "2026-10-25",
  "2026-10-26",
  "2026-11-01",
  "2026-11-02",
  "2026-12-31",
  "2027-01-01",
  "2100-02-28",
  "2100-03-01",
  "2400-02-29",
  "9999-12-31",
];

// Spans include every §14.7 freshness threshold and each DST-crossing pair,
// where a millisecond-difference implementation drifts by a whole day.
const SPANS: [string, string][] = [
  ["2026-03-08", "2026-03-09"],
  ["2026-03-29", "2026-03-30"],
  ["2026-09-06", "2026-09-07"],
  ["2026-09-05", "2026-09-06"],
  ["2026-10-25", "2026-10-26"],
  ["2026-11-01", "2026-11-02"],
  ["2026-03-01", "2026-11-30"],
  ["2026-01-01", "2026-01-01"],
  ["2026-01-01", "2026-01-08"],
  ["2026-01-01", "2026-01-31"],
  ["2026-01-01", "2026-03-02"],
  ["2026-01-01", "2026-07-01"],
  ["2026-01-01", "2027-01-01"],
  ["2027-01-01", "2026-01-01"],
  ["2024-02-28", "2024-03-01"],
  ["2023-02-28", "2023-03-01"],
  ["1900-02-28", "1900-03-01"],
  ["2000-02-28", "2000-03-01"],
  ["0001-01-01", "9999-12-31"],
];

const INVALID: string[] = [
  "2026-02-30",
  "2026-13-01",
  "2026-00-10",
  "2026-01-00",
  "2026-01-32",
  "2023-02-29",
  "1900-02-29",
  "2100-02-29",
  "2026-04-31",
  "2026-06-31",
  "2026-09-31",
  "2026-11-31",
  // Well-formed by the YYYY-MM-DD shape and out of range by the calendar:
  // the oracle's year starts at 1. Without these the module could accept a
  // date at one end that its own day-number arithmetic refuses at the other.
  "0000-01-01",
  "0000-12-31",
  "0000-02-29",
];

// Rejected by Atlas's grammar but not necessarily by the oracle's parser:
// the shape is fixed at exactly YYYY-MM-DD, so these never reach a date.
const MALFORMED: string[] = [
  "",
  "2026-1-1",
  "20260101",
  "2026-01-01T00:00:00Z",
  "2026-01-01 ",
  " 2026-01-01",
  "2026-01-0１",
  "+2026-01-01",
  "2026/01/01",
  "not-a-date",
];

// Reaching back by a whole number of days is how §14.7 turns an as-of date
// into a freshness boundary, so the offsets here are the thresholds plus
// the cases that walk off either end of the representable range.
const SHIFTS: [string, number][] = [
  ["2026-03-08", 1],
  ["2026-03-09", -1],
  ["2026-09-06", 1],
  ["2026-09-06", -1],
  ["2026-10-25", 1],
  ["2026-11-01", -1],
  ["2026-01-01", 0],
  ["2026-01-01", -7],
  ["2026-01-01", -30],
  ["2026-01-01", -60],
  ["2026-01-01", -180],
  ["2026-01-01", -365],
  ["2026-01-01", 365],
  ["2024-03-01", -1],
  ["2023-03-01", -1],
  ["1900-03-01", -1],
  ["2000-03-01", -1],
  ["2100-03-01", -1],
  ["0001-01-01", -1],
  ["9999-12-31", 1],
];

const GENERATED_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$/;

interface OracleResult {
  dates: { iso: string; ordinal: number; midnight: string }[];
  spans: number[];
  invalid: boolean[];
  shifts: (string | null)[];
}

function runOracle(): OracleResult {
  const payload = JSON.stringify({
    dates: DATES,
    spans: SPANS,
    invalid: INVALID,
    shifts: SHIFTS,
  });
  return oracleAnswer("calendar", payload) as OracleResult;
}

let divergences = 0;
let compared = 0;

function check(label: string, actual: unknown, wanted: unknown): void {
  compared += 1;
  if (actual !== wanted) {
    divergences += 1;
    console.error(`DIVERGENCE ${label}`);
    console.error(`  oracle: ${JSON.stringify(wanted)}`);
    console.error(`  ours:   ${JSON.stringify(actual)}`);
  }
}

const oracle = runOracle();

for (let i = 0; i < DATES.length; i += 1) {
  const text = DATES[i] as string;
  const expected = oracle.dates[i] as OracleResult["dates"][number];

  // A regression that rejects a date the oracle accepts is a divergence
  // like any other, so it is reported rather than left to abort the run
  // and take the remaining comparisons with it.
  let date;
  try {
    date = parseDate(text);
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
    compared += 1;
    divergences += 1;
    console.error(`DIVERGENCE parse ${text} rejected; oracle accepted it`);
    console.error(`  ours:   ${error.message}`);
    continue;
  }

  check(`round-trip ${text}`, formatDate(date), expected.iso);
  check(`ordinal ${text}`, toOrdinal(date), expected.ordinal);
  check(`midnight ${text}`, midnightInstant(date), expected.midnight);

  // Round-tripping through the day number proves `fromOrdinal` is the exact
  // inverse of `toOrdinal`, which is what lets a shift be arithmetic rather
  // than a second, independently-wrong calendar.
  check(
    `ordinal round-trip ${text}`,
    formatDate(fromOrdinal(toOrdinal(date))),
    text,
  );

  compared += 1;
  if (!GENERATED_AT.test(midnightInstant(date))) {
    divergences += 1;
    console.error(`DIVERGENCE generated_at pattern ${text}`);
    console.error(`  ours:   ${JSON.stringify(midnightInstant(date))}`);
  }
}

for (let i = 0; i < SPANS.length; i += 1) {
  const [from, to] = SPANS[i] as [string, string];
  let span: number | null = null;
  try {
    span = daysBetween(parseDate(from), parseDate(to));
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
  }
  check(`span ${from}..${to}`, span, oracle.spans[i]);
}

for (let i = 0; i < SHIFTS.length; i += 1) {
  const [text, days] = SHIFTS[i] as [string, number];
  const wanted = oracle.shifts[i] ?? null;
  compared += 1;
  let actual: string | null = null;
  try {
    actual = formatDate(addDays(parseDate(text), days));
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
  }
  if (actual !== wanted) {
    divergences += 1;
    console.error(`DIVERGENCE shift ${text} ${days >= 0 ? "+" : ""}${days}`);
    console.error(`  oracle: ${JSON.stringify(wanted)}`);
    console.error(`  ours:   ${JSON.stringify(actual)}`);
  }
}

for (let i = 0; i < INVALID.length; i += 1) {
  const text = INVALID[i] as string;
  compared += 1;
  const oracleAccepted = oracle.invalid[i];
  let accepted = true;
  try {
    parseDate(text);
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
    accepted = false;
  }
  if (accepted !== oracleAccepted) {
    divergences += 1;
    console.error(`DIVERGENCE invalid ${JSON.stringify(text)}`);
    console.error(`  oracle accepted: ${oracleAccepted}`);
    console.error(`  ours accepted:   ${accepted}`);
  }
}

for (const text of MALFORMED) {
  compared += 1;
  let accepted = true;
  try {
    parseDate(text);
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
    accepted = false;
  }
  if (accepted) {
    divergences += 1;
    console.error(`DIVERGENCE malformed ${JSON.stringify(text)} was accepted`);
  }
}

const zone = process.env["TZ"] ?? "<unset>";
console.log(
  `differential calendar [TZ=${zone}]: ${compared} comparisons, ` +
    `${divergences} divergences`,
);
process.exit(divergences === 0 ? 0 : 1);
