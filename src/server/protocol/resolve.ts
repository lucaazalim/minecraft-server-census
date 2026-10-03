import dns from 'node:dns';
import net from 'node:net';
import { config } from '../config.js';
import { PingError } from './errors.js';

export interface Resolved {
  /** Address the TCP connection goes to. */
  ip: string;
  port: number;
  /** Host/port to put in the handshake (SRV target if one existed, mirroring the vanilla client). */
  handshakeHost: string;
  handshakePort: number;
  srvTarget: string | null;
  /** Every ip:port this hostname can land on (all SRV records x all A/AAAA of each target). Used for de-duplication. */
  endpoints: string[];
  /** DNS names on the way to the IP: SRV target host and the CNAME chain. Used for de-duplication. */
  dnsTargets: string[];
  fromCache: boolean;
}

const resolver = new dns.promises.Resolver({ timeout: config.dnsTimeoutMs, tries: config.dnsTries });
if (config.dnsServers.length) resolver.setServers(config.dnsServers);

interface CacheEntry {
  value: Resolved;
  expires: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = config.dnsCacheMinutes * 60 * 1000;
const NEG_CACHE_TTL_MS = config.dnsNegativeCacheMinutes * 60 * 1000;
const negCache = new Map<string, { message: string; expires: number }>();

export function clearDnsCache(): void {
  cache.clear();
  negCache.clear();
}

const MAX_SRV_RECORDS = 8;
const MAX_ADDRESSES = 16;
const MAX_CNAME_HOPS = 4;

async function resolveSrv(host: string): Promise<{ target: string; port: number }[]> {
  try {
    const records = await resolver.resolveSrv(`_minecraft._tcp.${host}`);
    records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
    return records
      .map((r) => ({ target: r.name.replace(/\.$/, ''), port: r.port }))
      .filter((r) => r.target && r.target !== '.')
      .slice(0, MAX_SRV_RECORDS);
  } catch {
    return [];
  }
}

/** All A (or, failing that, AAAA) records of a name; the first one is the address we connect to. */
async function resolveAddresses(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  try {
    const a = await resolver.resolve4(host);
    if (a.length) return a.slice(0, MAX_ADDRESSES);
  } catch {
    /* fall through */
  }
  try {
    const aaaa = await resolver.resolve6(host);
    if (aaaa.length) return aaaa.slice(0, MAX_ADDRESSES);
  } catch {
    /* fall through */
  }
  // Last resort: system resolver (honours /etc/hosts, search domains).
  const res = await dns.promises.lookup(host);
  return [res.address];
}

/** Follow the CNAME chain of `host` (best effort; empty when it is not an alias). */
async function resolveCnameChain(host: string): Promise<string[]> {
  const chain: string[] = [];
  let cur = host;
  for (let i = 0; i < MAX_CNAME_HOPS && !net.isIP(cur); i++) {
    let next: string[];
    try {
      next = await resolver.resolveCname(cur);
    } catch {
      break;
    }
    const target = next[0]?.replace(/\.$/, '').toLowerCase();
    if (!target || chain.includes(target) || target === host) break;
    chain.push(target);
    cur = target;
  }
  return chain;
}

export async function resolveServer(host: string, port: number): Promise<Resolved> {
  const key = `${host}:${port}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return { ...hit.value, fromCache: true };
  const neg = negCache.get(key);
  if (neg && neg.expires > now) throw new PingError('DNS', neg.message);

  try {
    let handshakeHost = host;
    let handshakePort = port;
    let srvTarget: string | null = null;
    const endpoints = new Set<string>();
    const dnsTargets = new Set<string>();
    const srv = !net.isIP(host) && port === 25565 ? await resolveSrv(host) : [];
    if (srv.length) {
      // Vanilla connects to the best SRV record; the others are still the same server's front doors.
      const best = srv[0]!;
      handshakeHost = best.target;
      handshakePort = best.port;
      srvTarget = `${best.target}:${best.port}`;
      for (const r of srv) dnsTargets.add(r.target.toLowerCase());
    }
    const primary = await resolveAddresses(handshakeHost);
    const ip = primary[0]!;
    for (const r of srv.length ? srv : [{ target: host, port }]) {
      const addrs = r.target === handshakeHost ? primary : await resolveAddresses(r.target).catch(() => []);
      for (const a of addrs) endpoints.add(`${a}:${r.port}`);
    }
    for (const c of await resolveCnameChain(handshakeHost)) dnsTargets.add(c);
    const value: Resolved = {
      ip,
      port: handshakePort,
      handshakeHost,
      handshakePort,
      srvTarget,
      endpoints: [...endpoints].sort(),
      dnsTargets: [...dnsTargets].sort(),
      fromCache: false,
    };
    cache.set(key, { value, expires: now + CACHE_TTL_MS });
    return value;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const message = `${e.code ?? 'DNS'}: ${e.message ?? String(err)}`;
    negCache.set(key, { message, expires: now + NEG_CACHE_TTL_MS });
    throw new PingError('DNS', message);
  }
}
