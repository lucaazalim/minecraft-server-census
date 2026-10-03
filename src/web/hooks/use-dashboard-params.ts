import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

export type Range = '24h' | '7d' | '30d' | 'all';
export const RANGES: { value: Range; label: string; hours: number; days: number }[] = [
  { value: '24h', label: '24h', hours: 24, days: 1 },
  { value: '7d', label: '7d', hours: 168, days: 7 },
  { value: '30d', label: '30d', hours: 720, days: 30 },
  { value: 'all', label: 'All', hours: 0, days: 0 },
];

export function parseRange(v: string | null): Range {
  return RANGES.some((r) => r.value === v) ? (v as Range) : '24h';
}
/** Country codes are upper-cased; region codes (3+ letters, validated by the API) are kept lower-case. */
export function parseScopeParam(v: string | null): string {
  if (!v || v === 'all') return 'all';
  if (/^[a-z]{2}$/i.test(v)) return v.toUpperCase();
  return /^[a-z]{3,16}$/i.test(v) ? v.toLowerCase() : 'all';
}

/** Dashboard view state lives in the URL (?scope=BR&range=7d) so every view is shareable. */
export function useDashboardParams() {
  const [params, setParams] = useSearchParams();
  const scope = parseScopeParam(params.get('scope'));
  const range = parseRange(params.get('range'));
  const info = RANGES.find((r) => r.value === range)!;
  const setScope = useCallback(
    (s: string) =>
      setParams(
        (p) => {
          if (s === 'all') p.delete('scope');
          else p.set('scope', s);
          return p;
        },
        { replace: false },
      ),
    [setParams],
  );
  const setRange = useCallback(
    (r: Range) =>
      setParams(
        (p) => {
          if (r === '24h') p.delete('range');
          else p.set('range', r);
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  const search = useMemo(() => {
    const q = new URLSearchParams();
    if (scope !== 'all') q.set('scope', scope);
    if (range !== '24h') q.set('range', range);
    const s = q.toString();
    return s ? `?${s}` : '';
  }, [scope, range]);
  return { scope, range, hours: info.hours, days: info.days, setScope, setRange, search };
}
