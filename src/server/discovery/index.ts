import net from 'node:net';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { logger } from '../log.js';
import { scrapeSource } from './scrape.js';
import { buildSources } from './sources.js';

const log = logger('discovery');

export interface Candidate {
  host: string;
  port: number;
}
export interface SourceCandidates {
  id: string;
  found: number;
  pages: number;
  error: string | null;
  /** Addresses this source lists that are neither tracked nor on the deny list (deduplicated across sources, first source wins; bare IPs left out unless TRACK_IP_HOSTS). */
  fresh: Candidate[];
}

/**
 * Scrape every list site for the given countries and report the addresses the database does not know yet.
 * Read-only: nothing is added, the operator reviews the output and puts what is worth tracking in a seed file.
 */
export async function discoverCandidates(db: Db, opts: { countries?: string[]; onSource?: (s: SourceCandidates) => void } = {}): Promise<SourceCandidates[]> {
  const { sources, unknown } = buildSources(opts.countries);
  if (unknown.length) log.warn(`no list-site slugs for ${unknown.join(', ')} (add them to discovery/sources.ts COUNTRIES)`);
  const seen = new Set<string>();
  const out: SourceCandidates[] = [];
  for (const src of sources) {
    if (src.enabled === false) continue;
    let s: SourceCandidates;
    try {
      const r = await scrapeSource(src);
      const fresh = r.addresses.filter((a) => {
        const key = `${a.host}:${a.port}`;
        if (seen.has(key) || (!config.trackIpHosts && net.isIP(a.host)) || db.isKnownAddress(a.host, a.port)) return false;
        seen.add(key);
        return true;
      });
      s = { id: src.id, found: r.addresses.length, pages: r.pagesFetched, error: r.error, fresh };
    } catch (err) {
      s = { id: src.id, found: 0, pages: 0, error: (err as Error).message, fresh: [] };
    }
    out.push(s);
    opts.onSource?.(s);
  }
  return out;
}

/** Seed-file text (`host[:port]  # note`) for the review: one block per source, so lines can be copied into data/seeds/ as is. */
export function formatCandidates(results: SourceCandidates[], now = new Date()): string {
  const total = results.reduce((a, s) => a + s.fresh.length, 0);
  const lines = [
    `# ${total} addresses found by list-site scraping on ${now.toISOString().slice(0, 16)}Z that are not tracked and not deny-listed.`,
    '# Review them (npm run ping -- <addr>) and copy the keepers into a data/seeds/*.txt file; nothing here is tracked yet.',
  ];
  for (const s of results) {
    lines.push('', `# ${s.id}: ${s.found} listed, ${s.fresh.length} new${s.error ? ` (${s.error})` : ''}`);
    for (const c of s.fresh) lines.push(c.port === 25565 ? c.host : `${c.host}:${c.port}`);
  }
  return lines.join('\n') + '\n';
}
