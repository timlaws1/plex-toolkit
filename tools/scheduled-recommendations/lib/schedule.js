import { normaliseCap } from './ratings.js';

export const WEEKDAYS = [
  { id: 0, label: 'Sun' },
  { id: 1, label: 'Mon' },
  { id: 2, label: 'Tue' },
  { id: 3, label: 'Wed' },
  { id: 4, label: 'Thu' },
  { id: 5, label: 'Fri' },
  { id: 6, label: 'Sat' },
];

export const PRESETS = {
  tonight: {
    name: 'Tonight',
    days: [0, 1, 2, 3, 4, 5, 6],
    time: '18:00',
    count: 3,
    runtimeMin: '',
    runtimeMax: 150,
    allowStreaming: true,
    preferPlex: true,
    genres: '',
    output: 'email',
  },
  'film-night': {
    name: 'Film Night',
    days: [5],
    time: '19:00',
    count: 3,
    runtimeMin: 90,
    runtimeMax: 150,
    allowStreaming: false,
    preferPlex: true,
    genres: '',
    output: 'collection',
  },
  'every-night': {
    name: 'One Film Every Night',
    days: [0, 1, 2, 3, 4, 5, 6],
    time: '20:00',
    count: 1,
    runtimeMin: '',
    runtimeMax: 120,
    allowStreaming: false,
    preferPlex: true,
    genres: '',
    output: 'collection',
  },
  weekend: {
    name: 'Weekend Films',
    days: [6, 0],
    time: '15:00',
    count: 3,
    runtimeMin: '',
    runtimeMax: '',
    allowStreaming: true,
    preferPlex: true,
    genres: '',
    output: 'email',
  },
};

export function parseDays(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(Number).filter((n) => n >= 0 && n <= 6))];
  }
  try {
    const parsed = JSON.parse(value || '[]');
    if (Array.isArray(parsed)) return parseDays(parsed);
  } catch {
    /* stored text was not JSON */
  }
  return [];
}

export function slotDate(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isScheduleDue(schedule, now, ranSlot) {
  if (!Number(schedule.enabled)) return false;
  if (ranSlot === slotDate(now)) return false;
  const days = parseDays(schedule.days);
  if (!days.includes(now.getDay())) return false;
  return minutesOf(now) >= minutesOfTime(schedule.time_local);
}

export function nextRunDate(schedule, now) {
  const days = parseDays(schedule.days);
  if (!days.length) return null;
  const [hh, mm] = minutesParts(schedule.time_local);
  for (let add = 0; add < 8; add++) {
    const when = new Date(now.getTime());
    when.setDate(when.getDate() + add);
    when.setHours(hh, mm, 0, 0);
    if (!days.includes(when.getDay())) continue;
    if (when.getTime() <= now.getTime()) continue;
    return when;
  }
  return null;
}

export function formatWhen(schedule) {
  const days = parseDays(schedule.days);
  if (days.length === 7) return `Every day ${schedule.time_local || ''}`.trim();
  const labels = WEEKDAYS.filter((day) => days.includes(day.id)).map((day) => day.label);
  return `${labels.join(', ')} ${schedule.time_local || ''}`.trim();
}

export const OUTPUTS = [
  { id: 'collection', label: 'Plex collection' },
  { id: 'playlist', label: 'Plex playlist' },
  { id: 'email', label: 'Email' },
];

/**
 * Streaming titles are not in the Plex library, so a schedule that includes them can only email.
 */
export function effectiveOutput(schedule) {
  if (Number(schedule.allow_streaming)) return 'email';
  const output = String(schedule.output_type || '');
  if (output === 'watchlist') return 'email';
  return OUTPUTS.some((row) => row.id === output) ? output : 'collection';
}

export function scheduleFromBody(body) {
  const days = WEEKDAYS.map((day) => day.id).filter((id) => body[`day_${id}`] === '1' || body[`day_${id}`] === 'on');
  const count = Math.min(10, Math.max(1, Number(body.film_count || 1)));
  const allowStreaming = body.allow_streaming === '1' || body.allow_streaming === 'on' ? 1 : 0;
  const output = effectiveOutput({ allow_streaming: allowStreaming, output_type: body.output_type });
  return {
    name: String(body.name || '').trim(),
    enabled: body.enabled === '1' || body.enabled === 'on' ? 1 : 0,
    days: JSON.stringify(days),
    time_local: /^\d{2}:\d{2}$/.test(body.time_local || '') ? body.time_local : '18:00',
    film_count: count,
    runtime_min: intOrNull(body.runtime_min),
    runtime_max: intOrNull(body.runtime_max),
    prefer_plex: body.prefer_plex === '1' || body.prefer_plex === 'on' ? 1 : 0,
    allow_streaming: allowStreaming,
    genres: String(body.genres || '').trim(),
    excluded_genres: String(body.excluded_genres || '').trim(),
    rating_min: numOrNull(body.rating_min),
    rating_max: numOrNull(body.rating_max),
    output_type: output,
    plex_section_id: String(body.plex_section_id || '').trim() || null,
    replace_on_watch: body.replace_on_watch === '1' || body.replace_on_watch === 'on' ? 1 : 0,
    remove_watchlist: 0,
    certificate_max: normaliseCap(body.certificate_max),
    preset: String(body.preset || '').trim() || null,
  };
}

function minutesOf(now) {
  return now.getHours() * 60 + now.getMinutes();
}

function minutesOfTime(value) {
  const [hh, mm] = minutesParts(value);
  return hh * 60 + mm;
}

function minutesParts(value) {
  const [hh, mm] = String(value || '18:00').split(':');
  return [Number(hh) || 0, Number(mm) || 0];
}

function intOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function numOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
