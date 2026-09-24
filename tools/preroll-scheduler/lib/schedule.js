/**
 * @typedef {{ id: number, name: string, start_date: string|null, end_date: string|null, start_time: string|null, end_time: string|null, enabled: number|boolean, repeat_yearly?: number|boolean }} Schedule
 */

/**
 * Parse YYYY-MM-DD as local calendar date (no timezone shift).
 * @param {string} dateStr
 * @returns {{ y: number, m: number, d: number }|null}
 */
export function parseDate(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/**
 * @param {string} timeStr HH:MM or HH:MM:SS
 * @returns {number|null} minutes since midnight
 */
export function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function dateKey(parts) {
  return parts.y * 10000 + parts.m * 100 + parts.d;
}

/** Month-day key for yearly comparison (ignores year). */
function monthDayKey(parts) {
  return parts.m * 100 + parts.d;
}

function isYearly(schedule) {
  return schedule.repeat_yearly === 1 || schedule.repeat_yearly === true;
}

/**
 * Day-of-year in a non-leap reference year (1..365) for span math.
 * @param {{ m: number, d: number }} parts
 */
function dayOfYear(parts) {
  return (
    Math.floor(Date.UTC(2001, parts.m - 1, parts.d) - Date.UTC(2001, 0, 1)) /
      86400000 +
    1
  );
}

/**
 * Inclusive day span length. Null dates mean unbounded (treated as default).
 * Yearly schedules use seasonal window length (supports year wrap).
 * @param {Schedule} schedule
 * @returns {number|null} null = default (no date restriction)
 */
export function dateSpanDays(schedule) {
  const start = parseDate(schedule.start_date);
  const end = parseDate(schedule.end_date);
  if (!start && !end) return null;
  if (!start || !end) {
    // Partial range: treat as very long so fully bounded schedules win
    return 36500;
  }

  if (isYearly(schedule)) {
    const a = dayOfYear(start);
    const b = dayOfYear(end);
    if (a <= b) return b - a + 1;
    // Wraps New Year: Dec 20 → Jan 5
    return 365 - a + 1 + b;
  }

  const a = Date.UTC(start.y, start.m - 1, start.d);
  const b = Date.UTC(end.y, end.m - 1, end.d);
  return Math.floor((b - a) / 86400000) + 1;
}

/**
 * @param {Schedule} schedule
 * @param {Date} now
 */
export function scheduleMatches(schedule, now = new Date()) {
  if (schedule.enabled === 0 || schedule.enabled === false) return false;
  if (schedule.enabled == null) return false;

  const today = {
    y: now.getFullYear(),
    m: now.getMonth() + 1,
    d: now.getDate(),
  };

  const start = parseDate(schedule.start_date);
  const end = parseDate(schedule.end_date);

  if (isYearly(schedule)) {
    if (start || end) {
      const todayMd = monthDayKey(today);
      if (start && end) {
        const startMd = monthDayKey(start);
        const endMd = monthDayKey(end);
        if (startMd <= endMd) {
          if (todayMd < startMd || todayMd > endMd) return false;
        } else {
          // Wraps New Year: active if on/after start OR on/before end
          if (todayMd < startMd && todayMd > endMd) return false;
        }
      } else if (start && todayMd < monthDayKey(start)) {
        return false;
      } else if (end && todayMd > monthDayKey(end)) {
        return false;
      }
    }
  } else {
    const todayKey = dateKey(today);
    if (start && todayKey < dateKey(start)) return false;
    if (end && todayKey > dateKey(end)) return false;
  }

  const startMin = parseTimeToMinutes(schedule.start_time);
  const endMin = parseTimeToMinutes(schedule.end_time);
  if (startMin != null || endMin != null) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (startMin != null && nowMin < startMin) return false;
    if (endMin != null && nowMin > endMin) return false;
  }

  return true;
}

/**
 * Pick the active schedule from candidates.
 * Priority: shorter date span wins; dated beats default; equal spans → later start_date; then lower id.
 * @param {Schedule[]} schedules
 * @param {Date} now
 * @returns {Schedule|null}
 */
export function resolveActiveSchedule(schedules, now = new Date()) {
  const matching = (schedules || []).filter((s) => scheduleMatches(s, now));
  if (matching.length === 0) return null;

  matching.sort((a, b) => {
    const spanA = dateSpanDays(a);
    const spanB = dateSpanDays(b);
    const isDefaultA = spanA == null;
    const isDefaultB = spanB == null;
    if (isDefaultA !== isDefaultB) return isDefaultA ? 1 : -1;
    if (!isDefaultA && !isDefaultB && spanA !== spanB) return spanA - spanB;

    const startA = parseDate(a.start_date);
    const startB = parseDate(b.start_date);
    // For yearly, compare month-day; otherwise full date
    const keyA = startA
      ? isYearly(a)
        ? monthDayKey(startA)
        : dateKey(startA)
      : 0;
    const keyB = startB
      ? isYearly(b)
        ? monthDayKey(startB)
        : dateKey(startB)
      : 0;
    if (keyA !== keyB) return keyB - keyA; // later start wins

    return Number(a.id) - Number(b.id);
  });

  return matching[0];
}

export const SCHEDULE_PRIORITY_HELP =
  'When schedules overlap, the shortest date range wins. A dated schedule always beats the default (no dates). Equal ranges: later start date, then lower id. Use “Repeat every year” for Halloween/Christmas so the month and day apply every year.';
