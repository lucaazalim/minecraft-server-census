const int = new Intl.NumberFormat('en');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' });
const dateTime = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const dateYear = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' });
const weekdayTime = new Intl.DateTimeFormat('en', { weekday: 'short', hour: 'numeric' });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export const fmtInt = (n: number | null | undefined): string => (n == null || Number.isNaN(n) ? '–' : int.format(Math.round(n)));
export const fmtCompact = (n: number): string => compact.format(n);
export const fmtPct = (n: number | null | undefined, digits = 1): string => (n == null || Number.isNaN(n) ? '–' : `${n.toFixed(digits)}%`);
export const fmtTime = (sec: number): string => time.format(sec * 1000);
export const fmtDate = (sec: number): string => date.format(sec * 1000);
export const fmtDateYear = (sec: number): string => dateYear.format(sec * 1000);
export const fmtDateTime = (sec: number | null | undefined): string => (sec == null ? '–' : dateTime.format(sec * 1000));
export const fmtWeekdayTime = (sec: number): string => weekdayTime.format(sec * 1000);
export const fmtLatency = (ms: number | null | undefined): string => (ms == null ? '–' : `${Math.round(ms)} ms`);

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "3 min ago" / "in 4 min" (seconds since epoch). */
export function fmtRelative(sec: number | null | undefined, now = Date.now() / 1000): string {
  if (sec == null) return '–';
  const diff = sec - now;
  const abs = Math.abs(diff);
  if (abs < 45) return diff <= 0 ? 'just now' : 'in a moment';
  if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(diff / 3600), 'hour');
  if (abs < 30 * 86400) return relative.format(Math.round(diff / 86400), 'day');
  return relative.format(Math.round(diff / (30 * 86400)), 'month');
}

/** Local timezone name for chart captions, e.g. "America/Sao_Paulo" -> "São Paulo time" is overkill; the IANA id is fine. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local time';
  } catch {
    return 'local time';
  }
}
