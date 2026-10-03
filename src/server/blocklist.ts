import { createHash } from 'node:crypto';
import { config } from './config.js';
import type { Db } from './db.js';
import { logger } from './log.js';
import { isShuttingDown, shutdownSignal } from './shutdown.js';
import { state } from './state.js';
import { nowSec } from './util.js';

const log = logger('blocklist');

export const BLOCKLIST_URL = 'https://sessionserver.mojang.com/blockedservers';

/**
 * Mojang's server blocklist: a text file with one SHA-1 per line, each the hash of a blocked address pattern.
 * The vanilla client refuses to connect when any of these matches (lowercase, ISO-8859-1, no port):
 *   - the address itself:          mc.example.com          1.2.3.4
 *   - wildcards (one per level):   *.example.com, *.com    1.2.3.*, 1.2.*, 1.*
 * Modern clients test the typed hostname, the SRV target it redirects to, and the resolved IP.
 * The hashes cannot be reversed, but we know the addresses we track, so we hash our candidates and look them up.
 */
export function blocklistPatterns(address: string): string[] {
  let a = address.trim().toLowerCase().replace(/\.+$/, '');
  // "host:port" (how SRV targets are stored); a single colon cannot be an IPv6 literal.
  if (a.indexOf(':') === a.lastIndexOf(':')) a = a.replace(/:\d+$/, '');
  if (!a) return [];
  const parts = a.split('.');
  const out = [a];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) {
    for (let i = 3; i >= 1; i--) out.push(`${parts.slice(0, i).join('.')}.*`);
  } else {
    for (let i = 1; i < parts.length; i++) out.push(`*.${parts.slice(i).join('.')}`);
  }
  return out;
}

export function blocklistHash(pattern: string): string {
  return createHash('sha1').update(Buffer.from(pattern, 'latin1')).digest('hex');
}

export type BlockedVia = 'host' | 'srv' | 'ip';

export interface BlockMatch {
  /** The plaintext pattern whose hash is on the list, e.g. "*.example.com". */
  pattern: string;
  /** Which of the server's addresses the pattern matched. */
  via: BlockedVia;
}

/** First pattern on the list for any of a server's addresses, in the order the client checks them. */
export function findBlockMatch(hashes: ReadonlySet<string>, addr: { host: string; srvTarget?: string | null; ip?: string | null }): BlockMatch | null {
  if (!hashes.size) return null;
  const candidates: [BlockedVia, string | null | undefined][] = [
    ['host', addr.host],
    ['srv', addr.srvTarget],
    ['ip', addr.ip],
  ];
  for (const [via, value] of candidates) {
    if (!value) continue;
    for (const pattern of blocklistPatterns(value)) if (hashes.has(blocklistHash(pattern))) return { pattern, via };
  }
  return null;
}

export function parseBlocklist(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const h = line.trim().toLowerCase();
    if (/^[0-9a-f]{40}$/.test(h)) out.add(h);
  }
  return out;
}

export async function fetchBlocklist(): Promise<Set<string>> {
  const res = await fetch(BLOCKLIST_URL, {
    headers: { 'user-agent': 'mc-server-census/0.1' },
    signal: AbortSignal.any([AbortSignal.timeout(20_000), shutdownSignal]),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hashes = parseBlocklist(await res.text());
  if (!hashes.size) throw new Error('empty blocklist');
  return hashes;
}

let cached: Set<string> | null = null;

/** Hashes currently in use: the last fetch, or what the database remembers from a previous run. */
export function currentBlocklist(db: Db): Set<string> {
  if (!cached) {
    cached = db.loadBlocklist();
    state.blocklist.hashes = cached.size;
    const at = db.getMeta('blocklist_fetched_at');
    if (at) state.blocklist.fetchedAt = Number.parseInt(at, 10);
  }
  return cached;
}

/**
 * Re-download the list when it is older than BLOCKLIST_INTERVAL_HOURS (or `force`), then re-check every tracked
 * server against it. Cheap enough to run after every sweep, so servers whose IP or SRV target changed are re-checked.
 */
export async function runBlocklistCheck(db: Db, opts: { force?: boolean } = {}): Promise<{ hashes: number; blocked: number; changed: number }> {
  if (!config.blocklistEnabled) return { hashes: 0, blocked: 0, changed: 0 };
  let hashes = currentBlocklist(db);
  const stale = !state.blocklist.fetchedAt || state.blocklist.fetchedAt < nowSec() - config.blocklistIntervalHours * 3600;
  if ((opts.force || stale || !hashes.size) && !isShuttingDown()) {
    try {
      const fresh = await fetchBlocklist();
      db.replaceBlocklist(fresh);
      cached = hashes = fresh;
      state.blocklist.fetchedAt = nowSec();
      state.blocklist.lastError = null;
      state.blocklist.hashes = fresh.size;
      log.info(`fetched ${fresh.size} hashes`);
    } catch (err) {
      state.blocklist.lastError = (err as Error).message;
      log.warn('fetch failed, using the stored list', err);
    }
  }
  const result = db.applyBlocklist((s) => findBlockMatch(hashes, { host: s.host, srvTarget: s.srv_target, ip: s.resolved_ip }));
  state.blocklist.checkedAt = nowSec();
  state.blocklist.blocked = result.blocked;
  if (result.changed) log.info(`${result.blocked} tracked servers on the blocklist (${result.changed} changed)`);
  return { hashes: hashes.size, ...result };
}
