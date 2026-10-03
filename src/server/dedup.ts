/**
 * Server de-duplication: decide which hostnames that answered in one sweep are the *same* server
 * (same player pool), so their players are counted once.
 *
 * Neither DNS nor status metadata alone is enough:
 *  - one network spreads a pool over several IP:ports (Mush: 2 IPs x 2 SRV ports x 5 hostnames), and
 *  - hostname-routed proxies (TCPShield, DDoS shields, Aternos) put many unrelated servers on ONE IP:port.
 * So every rule combines a link (shared endpoint / DNS name / favicon...) with corroboration from the
 * status response itself, chiefly "player counts agree". Rules are applied in order of strength and the
 * winning rule is recorded per server so merges can be audited on the dashboard.
 */
import net from 'node:net';

export type MergeReason = 'sample' | 'endpoint' | 'dns' | 'fingerprint';
export const MERGE_REASONS: MergeReason[] = ['sample', 'endpoint', 'dns', 'fingerprint'];

export interface DedupInput {
  id: number;
  host: string;
  players: number | null;
  playersMax: number | null;
  faviconHash: string | null;
  motd: string | null;
  /** ip:port list the hostname can resolve to. */
  endpoints: string[];
  /** SRV target / CNAME chain names. */
  dnsTargets: string[];
  /** Sample entries as "uuid|name" (only real-looking ones, see sampleKeys). */
  sampleKeys: string[];
}

export interface GroupAssignment {
  /** Representative server id of the group (the shortest hostname). */
  rep: number;
  /** Rule that first linked this server to another one; null for singletons and representatives. */
  reason: MergeReason | null;
}

export interface DedupOptions {
  /** Player counts may differ by this much (percent of the larger count, floor of 3 players) and still be "the same pool". */
  tolerancePct: number;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/;

/** Keys for the sample-overlap rule: only genuine-looking v4 UUIDs with a plausible player name (MOTD plugins fake the rest). */
export function sampleKeys(sample: { name: string; id: string | null }[]): string[] {
  const out: string[] = [];
  for (const p of sample) {
    const id = (p.id ?? '').toLowerCase();
    const name = p.name.replace(/§./g, '').trim();
    if (!UUID_V4.test(id) || !PLAYER_NAME.test(name)) continue;
    out.push(`${id}|${name.toLowerCase()}`);
  }
  return out;
}

/** MOTD stripped of formatting and whitespace differences; null when there is nothing to compare. */
export function normalizeMotd(motd: string | null): string | null {
  if (!motd) return null;
  const t = motd
    .replace(/§./g, '')
    .replace(/&[0-9a-fk-or]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return t.length >= 3 ? t : null;
}

// Second-level labels under 2-letter ccTLDs that act like a TLD (com.br, co.uk, ...).
const CC_SLD = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'mil', 'adv', 'art', 'blog', 'eng', 'esp', 'inf', 'jor', 'mus', 'nom', 'pro', 'rec', 'srv', 'tur', 'vet', 'wiki', 'eti', 'emp', 'psc', 'agr']);
// Hosting / dynamic-DNS domains where the subdomain is the customer: two subdomains are two different servers.
const SHARED_PARENTS = new Set([
  'aternos.me', 'exaroton.me', 'falixsrv.me', 'falix.gg', 'mcserv.me', 'myserver.gs', 'my-serv.com', 'mcnetwork.me', 'serveminecraft.net',
  'duckdns.org', 'ddns.net', 'no-ip.org', 'no-ip.com', 'hopto.org', 'zapto.org', 'sytes.net', 'ply.gg', 'playit.gg', 'minehut.gg', 'mchost.pro',
  'pika.host', 'jartex.fun', 'craftyourserver.com', 'urubuhost.com.br', 'reishost.com.br', 'enxadahost.com', 'enxada.host', 'astralhost.com.br',
  'astralcloud.com.br', 'hostmine.com.br', 'othhost.com', 'mcsh.io', 'minecraftserver.buzz',
]);

/** eTLD+1-ish owner of a hostname: "jogar.mush.com.br" -> "mush.com.br"; IPs and shared-hosting subdomains stay unique. */
export function registrableDomain(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (net.isIP(h)) return null;
  const labels = h.split('.');
  if (labels.length < 2) return null;
  let n = 2;
  const tld = labels[labels.length - 1]!;
  const sld = labels[labels.length - 2]!;
  if (tld.length === 2 && CC_SLD.has(sld) && labels.length >= 3) n = 3;
  let dom = labels.slice(-n).join('.');
  if (SHARED_PARENTS.has(dom) && labels.length > n) dom = labels.slice(-(n + 1)).join('.');
  return dom;
}

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    let r = x;
    while (this.parent.get(r) !== undefined && this.parent.get(r) !== r) r = this.parent.get(r)!;
    // path compression
    let c = x;
    while (this.parent.get(c) !== undefined && this.parent.get(c) !== r) {
      const next = this.parent.get(c)!;
      this.parent.set(c, r);
      c = next;
    }
    return r;
  }
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
    return true;
  }
}

const SMALL_SERVER = 10;

/** Player counts within `pct` percent of the larger one (floor of 3 players). Exported for the server page's evidence line. */
export function playersAgree(a: Pick<DedupInput, 'players'>, b: Pick<DedupInput, 'players'>, pct: number): boolean {
  if (a.players == null || b.players == null) return false;
  const hi = Math.max(a.players, b.players);
  return Math.abs(a.players - b.players) <= Math.max(3, (pct / 100) * hi);
}

/** Status-level evidence that two hostnames answering from a shared address/DNS name are one server, not proxy neighbours. */
function corroborates(a: DedupInput, b: DedupInput, pct: number): boolean {
  if (!playersAgree(a, b, pct)) return false;
  const favicon = a.faviconHash != null && a.faviconHash === b.faviconHash;
  const motd = a.motd != null && a.motd === b.motd;
  // Tiny counts "agree" by the 3-player floor alone, so small servers must look identical; this is also where
  // hosting providers put many unrelated customers behind one address.
  if (Math.max(a.players ?? 0, b.players ?? 0) < SMALL_SERVER) return favicon && motd;
  const da = registrableDomain(a.host);
  const domain = da != null && da === registrableDomain(b.host);
  return favicon || motd || domain;
}

function fingerprintMatch(a: DedupInput, b: DedupInput, pct: number): boolean {
  if (a.faviconHash == null || a.faviconHash !== b.faviconHash) return false;
  if (a.motd == null || a.motd !== b.motd) return false;
  if (a.playersMax == null || a.playersMax !== b.playersMax) return false;
  if (!playersAgree(a, b, pct)) return false;
  if ((a.players ?? 0) > 0 && (b.players ?? 0) > 0) return true;
  const da = registrableDomain(a.host);
  return da != null && da === registrableDomain(b.host);
}

/** Group the online servers of one sweep. Returns an assignment for every input id. */
export function computeGroups(rows: DedupInput[], opts: DedupOptions): Map<number, GroupAssignment> {
  const uf = new UnionFind();
  const reason = new Map<number, MergeReason>();
  const link = (a: number, b: number, why: MergeReason) => {
    if (!uf.union(a, b)) return;
    if (!reason.has(a)) reason.set(a, why);
    if (!reason.has(b)) reason.set(b, why);
  };

  // 1. same real player in both samples
  const bySample = bucket(rows, (r) => r.sampleKeys);
  for (const members of bySample.values()) pairwise(members, (a, b) => link(a.id, b.id, 'sample'));

  // 2. shared ip:port + status agrees
  const byEndpoint = bucket(rows, (r) => r.endpoints);
  for (const members of byEndpoint.values()) pairwise(members, (a, b) => corroborates(a, b, opts.tolerancePct) && link(a.id, b.id, 'endpoint'));

  // 3. shared SRV target / CNAME + status agrees
  const byDns = bucket(rows, (r) => r.dnsTargets);
  for (const members of byDns.values()) pairwise(members, (a, b) => corroborates(a, b, opts.tolerancePct) && link(a.id, b.id, 'dns'));

  // 4. identical look (favicon + MOTD + max) + counts agree, regardless of address
  const byFavicon = bucket(rows, (r) => (r.faviconHash ? [r.faviconHash] : []));
  for (const members of byFavicon.values()) pairwise(members, (a, b) => fingerprintMatch(a, b, opts.tolerancePct) && link(a.id, b.id, 'fingerprint'));

  // representative = shortest hostname (then alphabetical) of each component
  const groups = new Map<number, DedupInput[]>();
  for (const r of rows) {
    const root = uf.find(r.id);
    const g = groups.get(root);
    if (g) g.push(r);
    else groups.set(root, [r]);
  }
  const out = new Map<number, GroupAssignment>();
  for (const members of groups.values()) {
    members.sort((a, b) => a.host.length - b.host.length || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0) || a.id - b.id);
    const rep = members[0]!.id;
    for (const m of members) out.set(m.id, { rep, reason: m.id === rep || members.length === 1 ? null : (reason.get(m.id) ?? null) });
  }
  return out;
}

function bucket(rows: DedupInput[], keys: (r: DedupInput) => string[]): Map<string, DedupInput[]> {
  const m = new Map<string, DedupInput[]>();
  for (const r of rows) {
    for (const k of new Set(keys(r))) {
      const list = m.get(k);
      if (list) list.push(r);
      else m.set(k, [r]);
    }
  }
  return m;
}

const MAX_BUCKET = 400; // a bucket this big is a mass-hosting address; pairwise work stays bounded (~80k checks)
function pairwise(members: DedupInput[], fn: (a: DedupInput, b: DedupInput) => unknown): void {
  const list = members.length > MAX_BUCKET ? members.slice(0, MAX_BUCKET) : members;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) fn(list[i]!, list[j]!);
}
