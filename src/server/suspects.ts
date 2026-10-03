import { normalizeMotd } from './dedup.js';

/**
 * Heuristics for servers that inflate their player count. The recurring trick (akumamc, mchub, oplegends, sunrealms,
 * lemoncloud, ...) is one vanity hostname per server-list site, each answering that site's ping with a different,
 * larger number than the address players actually use. Nothing here is proof: the report is for an operator to
 * review and act on with `npm run remove`.
 */

export interface SuspectRow {
  host: string;
  port: number;
  source: string | null;
  online: number;
  max: number;
  faviconHash: string | null;
  motd: string | null;
  sampleSize: number;
}

export type Signal =
  | 'over-capacity' // more players than slots (max > 1: some servers set max=1 as a joke)
  | 'auto-max' // max == online + 1: the proxy advertises whatever it is told, plus one
  | 'list-hostname'; // hostname label is a list-site code (ms, sm, smc, mp, mps, mmp, buzz, bee, best, topg, ml, ...)

export interface SuspectGroup {
  /** Same favicon + MOTD: the same server behind every hostname. */
  key: string;
  members: (SuspectRow & { signals: Signal[] })[];
  /** Largest count divided by the smallest non-zero one. */
  spread: number;
  /** Members reporting the smallest count: the address players use, most of the time. */
  honest: string[];
}

export interface SuspectReport {
  groups: SuspectGroup[];
  /** Servers flagged alone (no fingerprint twin). */
  singles: (SuspectRow & { signals: Signal[] })[];
}

const LIST_LABELS = /^(ms|sm|smc|mcs|mp|mps|mmp|mcmp|mr|mb|mbz|buzz|bee|best|bms|topg|ml|mcl|mcip|pmc|pm|org|mcsl|mcsorg|vote|top)$/;

export function signalsFor(r: SuspectRow): Signal[] {
  const out: Signal[] = [];
  if (r.max > 1 && r.online > r.max) out.push('over-capacity');
  if (r.online >= 200 && r.max === r.online + 1) out.push('auto-max');
  const label = r.host.split('.')[0] ?? '';
  if (r.online >= 500 && LIST_LABELS.test(label)) out.push('list-hostname');
  return out;
}

export function fingerprint(r: SuspectRow): string | null {
  const motd = normalizeMotd(r.motd);
  if (!r.faviconHash && !motd) return null;
  return `${r.faviconHash ?? '-'}|${(motd ?? '').slice(0, 40)}`;
}

/**
 * Group online servers by fingerprint and keep the groups whose counts disagree by more than `minSpread`
 * (largest >= `minOnline`), plus lone servers with a hard signal. Both are sorted by the largest count.
 */
export function suspectReport(rows: SuspectRow[], opts: { minSpread?: number; minOnline?: number } = {}): SuspectReport {
  const minSpread = opts.minSpread ?? 3;
  const minOnline = opts.minOnline ?? 300;
  const byFp = new Map<string, SuspectRow[]>();
  for (const r of rows) {
    const fp = fingerprint(r);
    if (!fp) continue;
    const list = byFp.get(fp) ?? [];
    list.push(r);
    byFp.set(fp, list);
  }
  const groups: SuspectGroup[] = [];
  const grouped = new Set<SuspectRow>();
  for (const [key, list] of byFp) {
    if (list.length < 2) continue;
    const counts = list.map((r) => r.online);
    const hi = Math.max(...counts);
    const lo = Math.min(...counts.filter((c) => c > 0), hi);
    const spread = lo > 0 ? hi / lo : Number.POSITIVE_INFINITY;
    if (hi < minOnline || spread <= minSpread) continue;
    for (const r of list) grouped.add(r);
    groups.push({
      key,
      spread,
      honest: list.filter((r) => r.online === lo).map((r) => r.host),
      members: list.map((r) => ({ ...r, signals: signalsFor(r) })).sort((a, b) => b.online - a.online),
    });
  }
  groups.sort((a, b) => b.members[0]!.online - a.members[0]!.online);
  const singles = rows
    .filter((r) => !grouped.has(r))
    .map((r) => ({ ...r, signals: signalsFor(r) }))
    .filter((r) => r.signals.includes('over-capacity') || (r.signals.includes('list-hostname') && r.signals.includes('auto-max')))
    .sort((a, b) => b.online - a.online);
  return { groups, singles };
}
