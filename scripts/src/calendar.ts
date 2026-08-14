export class CalendarError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "CalendarError";
  }
}

const DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] as number;
}

export function parseDate(text: string): CalendarDate {
  const match = DATE_PATTERN.exec(text);
  if (match === null) {
    throw new CalendarError(
      `malformed-date; expected YYYY-MM-DD, got ${JSON.stringify(text)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // The pattern admits 0000, which the day-number range below refuses and the
  // oracle rejects outright ("year 0 is out of range"). Without this the two
  // ends of the module disagree: a date parses but cannot be shifted.
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new CalendarError(
      "calendar-date-out-of-range; expected a year within 1..9999",
    );
  }
  if (month < 1 || month > 12) {
    throw new CalendarError(`calendar-invalid-date; month out of range`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new CalendarError(`calendar-invalid-date; day out of range`);
  }
  return { year, month, day };
}

export function formatDate(date: CalendarDate): string {
  const year = String(date.year).padStart(4, "0");
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// The civil-from-days algorithm counts from 0000-03-01, where leap days
// land at the end of the year and the month arithmetic stays branch-free.
// The oracle's `date.toordinal()` counts from 0001-01-01 = 1. The shift is
// the 305 days between those epochs. Carrying it means both directions
// agree with the oracle exactly, not merely up to a constant — a span is
// blind to a shared offset, so without this the harness could not tell a
// correct day number from a uniformly wrong one.
const ORDINAL_SHIFT = 305;
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

export function toOrdinal(date: CalendarDate): number {
  const shiftedYear = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const monthTerm = date.month > 2 ? date.month - 3 : date.month + 9;
  const dayOfYear = Math.floor((153 * monthTerm + 2) / 5) + date.day - 1;
  const dayOfEra = yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - ORDINAL_SHIFT;
}

export function fromOrdinal(ordinal: number): CalendarDate {
  if (!Number.isSafeInteger(ordinal)) {
    throw new CalendarError(
      "calendar-invalid-ordinal; expected an exact day number",
    );
  }
  const shifted = ordinal + ORDINAL_SHIFT;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra -
    (365 * yearOfEra +
      Math.floor(yearOfEra / 4) -
      Math.floor(yearOfEra / 100));
  const monthTerm = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthTerm + 2) / 5) + 1;
  const month = monthTerm < 10 ? monthTerm + 3 : monthTerm - 9;
  const shiftedYear = yearOfEra + era * 400;
  const year = month <= 2 ? shiftedYear + 1 : shiftedYear;
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new CalendarError(
      "calendar-date-out-of-range; expected a year within 1..9999",
    );
  }
  return { year, month, day };
}

export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return toOrdinal(to) - toOrdinal(from);
}

// The fold reaches back from an as-of date by a whole number of days
// (§14.7). Going through the day number keeps that subtraction on the
// calendar, where a wall clock would let a zone offset move the result.
export function addDays(date: CalendarDate, days: number): CalendarDate {
  if (!Number.isSafeInteger(days)) {
    throw new CalendarError(
      "calendar-invalid-offset; expected a whole number of days",
    );
  }
  return fromOrdinal(toOrdinal(date) + days);
}

export function midnightInstant(date: CalendarDate): string {
  return `${formatDate(date)}T00:00:00Z`;
}
