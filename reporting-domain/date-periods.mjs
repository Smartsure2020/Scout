/**
 * Deterministic date and period utilities for Scout reporting.
 *
 * Date-only calculations intentionally use UTC-midnight arithmetic so the
 * result does not depend on the machine running the code. Period boundaries
 * are converted to Africa/Johannesburg instants only at the API boundary.
 */

export const BUSINESS_TIME_ZONE = "Africa/Johannesburg";

// This is the exact holiday coverage used by the current claims page. Keep it
// isolated and explicit until a maintained calendar source is approved.
export const SA_PUBLIC_HOLIDAYS = Object.freeze([
  "2024-01-01",
  "2024-03-21",
  "2024-03-29",
  "2024-04-01",
  "2024-04-27",
  "2024-05-01",
  "2024-06-16",
  "2024-06-17",
  "2024-08-09",
  "2024-09-24",
  "2024-12-16",
  "2024-12-25",
  "2024-12-26",
  "2025-01-01",
  "2025-03-21",
  "2025-04-18",
  "2025-04-21",
  "2025-04-27",
  "2025-04-28",
  "2025-05-01",
  "2025-06-16",
  "2025-08-09",
  "2025-09-24",
  "2025-12-16",
  "2025-12-25",
  "2025-12-26",
  "2026-01-01",
  "2026-04-03",
  "2026-04-06",
  "2026-04-27",
  "2026-05-01",
  "2026-06-16",
  "2026-08-09",
  "2026-08-10",
  "2026-09-24",
  "2026-12-16",
  "2026-12-25",
  "2027-01-01",
  "2027-03-21",
  "2027-03-22",
  "2027-03-26",
  "2027-03-29",
  "2027-04-27",
  "2027-06-16",
  "2027-08-09",
  "2027-09-24",
  "2027-12-16",
  "2027-12-27",
]);

export const SUPPORTED_HOLIDAY_YEARS = Object.freeze([2024, 2025, 2026, 2027]);

export class UnsupportedCalendarCoverageError extends RangeError {
  constructor(years) {
    const list = [...new Set(years)].sort((a, b) => a - b).join(", ");
    super(
      `South African public-holiday coverage is unsupported for year(s): ${list}`,
    );
    this.name = "UnsupportedCalendarCoverageError";
    this.years = [...new Set(years)].sort((a, b) => a - b);
  }
}

const HOLIDAY_SET = new Set(SA_PUBLIC_HOLIDAYS);

function pad(value) {
  return String(value).padStart(2, "0");
}

function datePartsToString({ year, month, day }) {
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

function assertValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid date: ${year}-${month}-${day}`);
  }
}

/** Return a canonical YYYY-MM-DD date or null when no value is supplied. */
export function toDateOnly(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError("Invalid Date");
    return datePartsToString({
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
    });
  }
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(text);
  if (!match) throw new RangeError(`Expected an ISO date, received: ${text}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  assertValidDateParts(year, month, day);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function dateToUtcMidnight(value) {
  const date = toDateOnly(value);
  if (!date) return null;
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function addDateOnly(value, days) {
  const date = dateToUtcMidnight(value);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + Number(days));
  return datePartsToString({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

/** Calendar age follows the claims page: start date is day zero. */
export function calendarDaysBetween(startDate, endDate) {
  const start = dateToUtcMidnight(startDate);
  const end = dateToUtcMidnight(endDate);
  if (!start || !end) return null;
  return Math.max(0, Math.floor((end - start) / 86400000));
}

export function calendarAgeBand(age) {
  const value = Number(age);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value <= 30) return "0-30";
  if (value <= 60) return "31-60";
  if (value <= 90) return "61-90";
  return "91+";
}

export function calendarCoverage(startDate, endDate) {
  const start = toDateOnly(startDate);
  const end = toDateOnly(endDate);
  if (!start || !end) return { supported: true, unsupportedYears: [] };
  const years = [];
  for (
    let date = dateToUtcMidnight(start);
    date < dateToUtcMidnight(end);
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    years.push(date.getUTCFullYear());
  }
  const unsupportedYears = [...new Set(years)].filter(
    (year) => !SUPPORTED_HOLIDAY_YEARS.includes(year),
  );
  return { supported: unsupportedYears.length === 0, unsupportedYears };
}

function assertCoverage(startDate, endDate, onUnsupported) {
  const coverage = calendarCoverage(startDate, endDate);
  if (!coverage.supported && onUnsupported === "throw") {
    throw new UnsupportedCalendarCoverageError(coverage.unsupportedYears);
  }
  return coverage;
}

export function isBusinessDay(date, { onUnsupported = "throw" } = {}) {
  const value = toDateOnly(date);
  if (!value) return null;
  const coverage = calendarCoverage(value, addDateOnly(value, 1));
  if (!coverage.supported && onUnsupported === "throw") {
    throw new UnsupportedCalendarCoverageError(coverage.unsupportedYears);
  }
  const weekday = dateToUtcMidnight(value).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !HOLIDAY_SET.has(value);
}

/**
 * Working age counts the start date and excludes the end date, matching the
 * existing claims page. Future/unsupported holiday years must be opted into
 * explicitly; they are never silently treated as weekday-only.
 */
export function workingDaysBetween(
  startDate,
  endDate,
  { onUnsupported = "throw" } = {},
) {
  const start = toDateOnly(startDate);
  const end = toDateOnly(endDate);
  if (!start || !end) return null;
  assertCoverage(start, end, onUnsupported);
  let count = 0;
  for (
    let cursor = dateToUtcMidnight(start);
    cursor < dateToUtcMidnight(end);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = datePartsToString({
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
    });
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !HOLIDAY_SET.has(date)) count += 1;
  }
  return count;
}

function localDateParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid timestamp");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, Number(part)]),
  );
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
  const wallUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second,
  );
  return wallUtc - date.getTime();
}

export function localDateTimeToInstant(
  dateOnly,
  time = "00:00:00",
  timeZone = BUSINESS_TIME_ZONE,
) {
  const date = toDateOnly(dateOnly);
  if (!date) return null;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) throw new RangeError(`Expected HH:MM[:SS], received: ${time}`);
  const [year, month, day] = date.split("-").map(Number);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59)
    throw new RangeError(`Invalid local time: ${time}`);
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuess = new Date(naiveUtc);
  return new Date(naiveUtc - timeZoneOffsetMs(firstGuess, timeZone));
}

function periodForLocalDate(localDate, unit, timeZone) {
  const start = localDateTimeToInstant(localDate, "00:00:00", timeZone);
  const endLocalDate =
    unit === "week" ? addDateOnly(localDate, 5) : addDateOnly(localDate, 1);
  return {
    unit,
    timeZone,
    startLocalDate: localDate,
    endLocalDateExclusive: endLocalDate,
    start,
    end: localDateTimeToInstant(endLocalDate, "00:00:00", timeZone),
  };
}

export function weeklyPeriod(value, timeZone = BUSINESS_TIME_ZONE) {
  const localDate =
    value instanceof Date
      ? datePartsToString(localDateParts(value, timeZone))
      : toDateOnly(value);
  if (!localDate) return null;
  const weekday = dateToUtcMidnight(localDate).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return periodForLocalDate(
    addDateOnly(localDate, -daysSinceMonday),
    "week",
    timeZone,
  );
}

export function monthlyPeriod(value, timeZone = BUSINESS_TIME_ZONE) {
  const localDate =
    value instanceof Date
      ? datePartsToString(localDateParts(value, timeZone))
      : toDateOnly(value);
  if (!localDate) return null;
  const [year, month] = localDate.split("-").map(Number);
  const start = `${year}-${pad(month)}-01`;
  const next =
    month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return {
    unit: "month",
    timeZone,
    startLocalDate: start,
    endLocalDateExclusive: next,
    start: localDateTimeToInstant(start, "00:00:00", timeZone),
    end: localDateTimeToInstant(next, "00:00:00", timeZone),
  };
}

export function containsTimestamp(timestamp, period) {
  const value = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(value.getTime())) return false;
  return value >= period.start && value < period.end;
}
