/**
 * Five-field cron expressions, in UTC.
 *
 * `minute hour day-of-month month day-of-week`, with ranges, steps, lists,
 * names, and the usual macros. UTC because a Worker's cron trigger is UTC, and
 * a schedule that meant something else would drift twice a year.
 *
 * The one rule that surprises everybody is kept: when *both* day-of-month and
 * day-of-week are restricted, a day matches if either does. `0 0 13 * 1` fires
 * on the 13th and on every Monday, not on Monday the 13th.
 */

export interface CronSchedule {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /**
   * Whether the field admits every value it could, which decides how the two
   * day fields combine.
   *
   * Judged by what the field matches rather than by how it was written. A step
   * of one covers the whole range, so a star with a step of one restricts
   * nothing - and a day field that restricts nothing must not drag the other
   * into a union with it.
   */
  readonly dayOfMonthUnrestricted: boolean;
  readonly dayOfWeekUnrestricted: boolean;
}

const MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

/** Turns a name into its number, or reads a plain integer. */
function value(token: string, spec: FieldSpec): number | null {
  const lowered = token.toLowerCase();
  if (spec.names !== undefined) {
    const index = spec.names.indexOf(lowered);
    if (index !== -1) return index + (spec.names === MONTHS ? 1 : 0);
  }

  if (!/^\d+$/.test(token)) return null;
  const parsed = Number(token);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** One comma-separated term: a star, a number, `1-5`, a star with a step, `1-5/2`. */
function parseTerm(term: string, spec: FieldSpec, into: Set<number>): boolean {
  const [rangePart, stepPart, ...rest] = term.split("/");
  if (rangePart === undefined || rest.length > 0) return false;

  let step = 1;
  if (stepPart !== undefined) {
    if (!/^\d+$/.test(stepPart)) return false;
    step = Number(stepPart);
    if (step < 1) return false;
  }

  let from: number;
  let to: number;

  if (rangePart === "*") {
    from = spec.min;
    to = spec.max;
  } else if (rangePart.includes("-")) {
    const [low, high, ...extra] = rangePart.split("-");
    if (low === undefined || high === undefined || extra.length > 0) return false;
    const start = value(low, spec);
    const end = value(high, spec);
    if (start === null || end === null || start > end) return false;
    from = start;
    to = end;
  } else {
    const only = value(rangePart, spec);
    if (only === null) return false;
    // `5/2` means "from 5 to the end of the field, every 2".
    from = only;
    to = stepPart === undefined ? only : spec.max;
  }

  if (from < spec.min || to > spec.max) return false;
  for (let current = from; current <= to; current += step) into.add(current);
  return true;
}

function parseField(field: string, spec: FieldSpec): Set<number> | null {
  const values = new Set<number>();
  for (const term of field.split(",")) {
    if (term === "" || !parseTerm(term, spec, values)) return null;
  }
  return values.size === 0 ? null : values;
}

export function parseCron(expression: string): CronSchedule | null {
  const normalized = (MACROS[expression.trim().toLowerCase()] ?? expression).trim();
  if (normalized.startsWith("@")) return null;

  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];

  const minutes = parseField(minute, { min: 0, max: 59 });
  const hours = parseField(hour, { min: 0, max: 23 });
  const daysOfMonth = parseField(dayOfMonth, { min: 1, max: 31 });
  const months = parseField(month, { min: 1, max: 12, names: MONTHS });
  const daysOfWeek = parseField(dayOfWeek, { min: 0, max: 7, names: WEEKDAYS });
  if (minutes === null || hours === null || daysOfMonth === null || months === null || daysOfWeek === null) {
    return null;
  }

  // Vixie cron takes both 0 and 7 for Sunday.
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthUnrestricted: daysOfMonth.size === 31,
    dayOfWeekUnrestricted: daysOfWeek.size === 7,
  };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

/**
 * Whether a date's day matches.
 *
 * With both day fields restricted the match is a union, which is what every
 * cron since Vixie's has done and what `0 0 13 * 5` - "the 13th, and every
 * Friday" - is understood to mean.
 */
function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const dayOfMonth = schedule.daysOfMonth.has(date.getUTCDate());
  const dayOfWeek = schedule.daysOfWeek.has(date.getUTCDay());

  if (schedule.dayOfMonthUnrestricted && schedule.dayOfWeekUnrestricted) return true;
  if (schedule.dayOfMonthUnrestricted) return dayOfWeek;
  if (schedule.dayOfWeekUnrestricted) return dayOfMonth;
  return dayOfMonth || dayOfWeek;
}

/**
 * A schedule can be unsatisfiable - `0 0 30 2 *` names the 30th of February.
 * Eight years is more than two leap cycles, so anything that can happen has by
 * then; anything that has not, never will.
 */
const MAX_DAYS_AHEAD = 8 * 366;

/**
 * The first instant strictly after `after` at which the schedule fires, or null
 * when it never does.
 *
 * Advances a field at a time rather than a minute at a time: `0 0 29 2 *` is
 * two years away, and two years of minutes is a million wasted iterations.
 */
export function nextRun(expression: string, after: number): number | null {
  const schedule = parseCron(expression);
  if (schedule === null) return null;

  // Strictly after: start from the next whole minute.
  const cursor = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  const limit = new Date(cursor.getTime() + MAX_DAYS_AHEAD * 86_400_000);

  while (cursor.getTime() <= limit.getTime()) {
    if (!schedule.months.has(cursor.getUTCMonth() + 1)) {
      // Skip to the first instant of the next month.
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!dayMatches(schedule, cursor)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!schedule.hours.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    if (!schedule.minutes.has(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    return cursor.getTime();
  }

  return null;
}

/** True when the schedule was due at or before `now`. */
export function isDue(nextRunAt: number | null, now: number): boolean {
  return nextRunAt !== null && nextRunAt <= now;
}
