import { describe, expect, test } from "bun:test";

import {
  addDays,
  CalendarError,
  daysBetween,
  formatDate,
  fromOrdinal,
  midnightInstant,
  parseDate,
  toOrdinal,
} from "./calendar.ts";

// The differential harness proves agreement with CPython's `date` under six
// timezones. What is pinned here is the shape of the contract itself: that
// nothing in this module consults a clock or a zone, and that the values it
// refuses are refused for a named reason.

describe("parseDate", () => {
  test("accepts exactly YYYY-MM-DD", () => {
    expect(parseDate("2026-08-13")).toEqual({ year: 2026, month: 8, day: 13 });
  });

  test("rejects every other spelling of the same day", () => {
    for (
      const text of [
        "2026-8-13",
        "20260813",
        "2026-08-13T00:00:00Z",
        " 2026-08-13",
        "2026-08-13 ",
        "2026/08/13",
      ]
    ) {
      expect(() => parseDate(text)).toThrow(/malformed-date/);
    }
  });

  test("applies the full Gregorian leap rule", () => {
    expect(() => parseDate("2024-02-29")).not.toThrow();
    expect(() => parseDate("2000-02-29")).not.toThrow();
    expect(() => parseDate("2023-02-29")).toThrow(/calendar-invalid-date/);
    expect(() => parseDate("1900-02-29")).toThrow(/calendar-invalid-date/);
    expect(() => parseDate("2100-02-29")).toThrow(/calendar-invalid-date/);
  });

  test("rejects out-of-range months and days", () => {
    for (const text of ["2026-00-10", "2026-13-01", "2026-01-00", "2026-04-31"]) {
      expect(() => parseDate(text)).toThrow(/calendar-invalid-date/);
    }
  });
});

describe("day numbers", () => {
  test("agree with the oracle's epoch, where 0001-01-01 is 1", () => {
    // A span is blind to a shared offset, so anchoring the absolute value is
    // what distinguishes a correct day number from a uniformly wrong one.
    expect(toOrdinal(parseDate("0001-01-01"))).toBe(1);
    expect(toOrdinal(parseDate("1970-01-01"))).toBe(719163);
  });

  test("fromOrdinal inverts toOrdinal", () => {
    for (const text of ["0001-01-01", "2024-02-29", "2026-08-13", "9999-12-31"]) {
      const date = parseDate(text);
      expect(formatDate(fromOrdinal(toOrdinal(date)))).toBe(text);
    }
  });

  test("refuse to leave the representable range", () => {
    expect(() => addDays(parseDate("0001-01-01"), -1)).toThrow(
      /calendar-date-out-of-range/,
    );
    expect(() => addDays(parseDate("9999-12-31"), 1)).toThrow(
      /calendar-date-out-of-range/,
    );
  });

  test("refuse a fractional offset", () => {
    expect(() => addDays(parseDate("2026-01-01"), 1.5)).toThrow(
      /calendar-invalid-offset/,
    );
  });
});

describe("timezone independence", () => {
  // Santiago moves its clock at midnight, so 2026-09-06T00:00:00 does not
  // exist there. Any implementation that routes a date through a wall clock
  // drifts by a day across this pair; this one never builds one.
  test("a DST transition that deletes midnight is still one day", () => {
    expect(
      daysBetween(parseDate("2026-09-06"), parseDate("2026-09-07")),
    ).toBe(1);
    expect(formatDate(addDays(parseDate("2026-09-06"), 1))).toBe("2026-09-07");
  });

  test("spans are signed and symmetric", () => {
    const from = parseDate("2026-01-01");
    const to = parseDate("2026-12-31");
    expect(daysBetween(from, to)).toBe(364);
    expect(daysBetween(to, from)).toBe(-364);
    expect(daysBetween(from, from)).toBe(0);
  });
});

describe("midnightInstant", () => {
  test("matches the generated_at pattern the graph schema fixes", () => {
    const pattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$/;
    expect(midnightInstant(parseDate("2026-08-13"))).toBe(
      "2026-08-13T00:00:00Z",
    );
    expect(pattern.test(midnightInstant(parseDate("0001-01-01")))).toBe(true);
  });

  test("carries no milliseconds", () => {
    // `toISOString()` would append .000 and fail the schema pattern.
    expect(midnightInstant(parseDate("2026-08-13"))).not.toContain(".");
  });
});

describe("error taxonomy", () => {
  test("every refusal is a CalendarError", () => {
    for (const run of [
      () => parseDate("nope"),
      () => parseDate("2026-02-30"),
      () => addDays(parseDate("9999-12-31"), 1),
      () => fromOrdinal(1.5),
    ]) {
      expect(run).toThrow(CalendarError);
    }
  });

  test("refuses a year the day-number arithmetic cannot hold", () => {
    // Well-formed by shape, outside the calendar: the year starts at 1. Both
    // ends of the module must agree, or a date parses and then cannot be
    // shifted.
    for (const text of ["0000-01-01", "0000-12-31", "0000-02-29"]) {
      expect(() => parseDate(text)).toThrow(/calendar-date-out-of-range/);
    }
    expect(parseDate("0001-01-01").year).toBe(1);
  });
});
