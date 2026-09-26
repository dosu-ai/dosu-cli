/**
 * `--since` / `--until` parsing for list commands that filter by creation time.
 *
 * Same grammar as the MCP tool's `review_knowledge(action="list")` since/until (dosu
 * `backend/public_api/mcp/tools/review_time_range.py`): a relative duration back from now, a
 * UTC date, or an ISO-8601 datetime. Each bound resolves to an absolute instant; the backend
 * filters the half-open window `[since, until)` and only accepts offset-bearing ISO datetimes,
 * so relative and date-only values must be resolved here.
 */

import { InvalidArgumentError } from "commander";

const RELATIVE_BOUND = /^(\d+)([hdw])$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const HOUR_MS = 60 * 60 * 1000;
const RELATIVE_UNIT_MS: Record<string, number> = {
  h: HOUR_MS,
  d: 24 * HOUR_MS,
  w: 7 * 24 * HOUR_MS,
};

const INVALID_BOUND =
  'must be a duration like "24h", "7d", or "2w", a UTC date like "2026-09-01", ' +
  'or an ISO-8601 datetime like "2026-09-01T14:00:00Z"';

/** UTC epoch ms for a calendar date, or undefined when it doesn't exist (e.g. 2026-02-30). */
function utcDay(year: string, month: string, day: string): number | undefined {
  const [y, m, d] = [Number(year), Number(month), Number(day)];
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  const exists =
    check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
  return exists ? ms : undefined;
}

/** Offset in ms east of UTC for `Z` / `+05:30` / `-0800` / `+05`; naive values read as UTC. */
function offsetMs(offset: string | undefined): number | undefined {
  if (!offset || offset.toUpperCase() === "Z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2) || "0");
  if (hours > 23 || minutes > 59) return undefined;
  return sign * (hours * HOUR_MS + minutes * 60 * 1000);
}

function parseIsoDatetime(text: string): number | undefined {
  const match = ISO_DATETIME.exec(text);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = "0", fraction = "", offset] = match;
  const dayMs = utcDay(year, month, day);
  const offsetValue = offsetMs(offset);
  const [h, mi, s] = [Number(hour), Number(minute), Number(second)];
  if (dayMs === undefined || offsetValue === undefined || h > 23 || mi > 59 || s > 59) {
    return undefined;
  }
  const ms = Number(fraction.padEnd(3, "0").slice(0, 3));
  return dayMs + h * HOUR_MS + mi * 60 * 1000 + s * 1000 + ms - offsetValue;
}

/**
 * Resolve one bound to an instant. `24h`/`7d`/`2w` count back from `now`; `YYYY-MM-DD` is UTC
 * midnight, or the next midnight when `endOfDay` (so an `--until` date includes that whole day);
 * anything else must be an ISO-8601 datetime. Throws `InvalidArgumentError` otherwise.
 */
export function parseTimeBound(value: string, opts: { endOfDay: boolean; now: Date }): Date {
  const text = value.trim();
  let ms: number | undefined;

  const relative = RELATIVE_BOUND.exec(text);
  const dateOnly = DATE_ONLY.exec(text);
  if (relative) {
    ms = opts.now.getTime() - Number(relative[1]) * RELATIVE_UNIT_MS[relative[2]];
  } else if (dateOnly) {
    const day = utcDay(dateOnly[1], dateOnly[2], dateOnly[3]);
    ms = day === undefined ? undefined : day + (opts.endOfDay ? 24 * HOUR_MS : 0);
  } else {
    ms = parseIsoDatetime(text);
  }

  const date = ms === undefined ? undefined : new Date(ms);
  if (!date || Number.isNaN(date.getTime())) throw new InvalidArgumentError(INVALID_BOUND);
  return date;
}

/** Commander arg parser: rejects a malformed bound at parse time, keeps the raw text. */
export function timeBound(value: string): string {
  parseTimeBound(value, { endOfDay: false, now: new Date() });
  return value.trim();
}

/**
 * Resolve `--since` / `--until` against one shared `now`, so equal relative bounds (`7d` and
 * `7d`) resolve to the same instant and are rejected rather than leaving a sliver window.
 */
export function resolveTimeRange(
  since: string | undefined,
  until: string | undefined,
  now: Date = new Date(),
): { since?: Date; until?: Date } {
  const range = {
    since: since ? parseTimeBound(since, { endOfDay: false, now }) : undefined,
    until: until ? parseTimeBound(until, { endOfDay: true, now }) : undefined,
  };
  if (range.since && range.until && range.since >= range.until) {
    throw new InvalidArgumentError("--since must be earlier than --until");
  }
  return range;
}

/** Human label for the window, e.g. `since 2026-09-21T14:00Z and before 2026-09-22T00:00Z`. */
export function describeTimeRange(range: { since?: Date; until?: Date }): string {
  const fmt = (d: Date) => `${d.toISOString().slice(0, 16)}Z`;
  const parts: string[] = [];
  if (range.since) parts.push(`since ${fmt(range.since)}`);
  if (range.until) parts.push(`before ${fmt(range.until)}`);
  return parts.join(" and ");
}
