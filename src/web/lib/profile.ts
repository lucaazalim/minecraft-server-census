import type { ProfilePoint } from './types';

export interface HourBucket {
  hour: number;
  avg: number;
  samples: number;
}
export interface WeekdayBucket {
  weekday: number; // 0 = Sunday, local
  avg: number;
  samples: number;
}

/** Shift UTC (weekday, hour) buckets into the viewer's timezone. 2024-01-07 is a Sunday. */
function toLocal(p: ProfilePoint): { hour: number; weekday: number } {
  const d = new Date(Date.UTC(2024, 0, 7 + p.weekday, p.hour));
  return { hour: d.getHours(), weekday: d.getDay() };
}

export function hourlyProfile(points: ProfilePoint[]): HourBucket[] {
  const sum = new Array<number>(24).fill(0);
  const n = new Array<number>(24).fill(0);
  for (const p of points) {
    const { hour } = toLocal(p);
    sum[hour]! += p.avg_players * p.samples;
    n[hour]! += p.samples;
  }
  return sum.map((s, hour) => ({ hour, avg: n[hour] ? s / n[hour]! : 0, samples: n[hour]! }));
}

export function weekdayProfile(points: ProfilePoint[]): WeekdayBucket[] {
  const sum = new Array<number>(7).fill(0);
  const n = new Array<number>(7).fill(0);
  for (const p of points) {
    const { weekday } = toLocal(p);
    sum[weekday]! += p.avg_players * p.samples;
    n[weekday]! += p.samples;
  }
  return sum.map((s, weekday) => ({ weekday, avg: n[weekday] ? s / n[weekday]! : 0, samples: n[weekday]! }));
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
