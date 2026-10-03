import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/server/ (tsx) and dist/server/ (compiled): project root is two levels up.
export const PROJECT_ROOT = path.resolve(here, '..', '..');

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function envList(name: string, def: number[]): number[] {
  const v = process.env[name];
  if (!v) return def;
  const out = v.split(/[,\s]+/).map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n));
  return out.length ? out : def;
}

/** Protocol numbers used by the daily "which versions does this server accept?" probe. */
export const DEFAULT_PROBE_PROTOCOLS = [
  47, // 1.8.x
  107, // 1.9
  210, // 1.10.x
  340, // 1.12.2
  404, // 1.13.2
  498, // 1.14.4
  578, // 1.15.2
  754, // 1.16.5
  758, // 1.18.2
  762, // 1.19.4
  763, // 1.20.1
  765, // 1.20.4
  767, // 1.21.1
  769, // 1.21.4
  771, // 1.21.6
  773, // 1.21.9/1.21.10
  774, // 1.21.11
  775, // 26.1.x
  776, // 26.2
  777, // 26.3 (latest release as of 2026-09-19)
];

export const config = {
  dataDir: envStr('DATA_DIR', path.join(PROJECT_ROOT, 'data', 'db')),
  seedsDir: envStr('SEEDS_DIR', path.join(PROJECT_ROOT, 'data', 'seeds')),
  /** Built dashboard (Vite output). */
  publicDir: envStr('PUBLIC_DIR', path.join(PROJECT_ROOT, 'dist', 'web')),
  protocolVersionsFile: path.join(PROJECT_ROOT, 'data', 'protocol-versions.json'),

  /** Dashboard/API listener. */
  httpPort: envInt('PORT', 8080),
  httpHost: envStr('HOST', '0.0.0.0'),

  pingIntervalMinutes: envInt('PING_INTERVAL_MINUTES', 10),
  pingConcurrency: envInt('PING_CONCURRENCY', 64),
  pingTimeoutMs: envInt('PING_TIMEOUT_MS', 6000),
  /** Protocol version sent in the handshake for the regular sweep. -1 lets the server report its native version. */
  pingProtocol: envInt('PING_PROTOCOL', -1),
  /**
   * DNS servers for SRV/A/CNAME lookups (comma-separated IPs). Public resolvers by default because the system one
   * often cannot take a burst of PING_CONCURRENCY x 3 queries (Tailscale MagicDNS, home routers). `system` = OS list.
   */
  dnsServers: envStr('DNS_SERVERS', '1.1.1.1,8.8.8.8').split(',').map((s) => s.trim()).filter((s) => s && s !== 'system'),
  /** Per-query resolver timeout and retry count. Resolution happens before the TCP connect, on top of PING_TIMEOUT_MS. */
  dnsTimeoutMs: envInt('DNS_TIMEOUT_MS', 4000),
  dnsTries: envInt('DNS_TRIES', 2),
  /** How long a successful (and a failed) resolution is reused before the name is looked up again. */
  dnsCacheMinutes: envInt('DNS_CACHE_MINUTES', 20),
  dnsNegativeCacheMinutes: envInt('DNS_NEGATIVE_CACHE_MINUTES', 5),

  probeEnabled: envBool('PROBE_ENABLED', true),
  probeIntervalHours: envInt('PROBE_INTERVAL_HOURS', 24),
  probeConcurrency: envInt('PROBE_CONCURRENCY', 16),
  probeProtocols: envList('PROBE_PROTOCOLS', DEFAULT_PROBE_PROTOCOLS),
  /** Delay after boot before the first probe run, so the first sweeps are not slowed down. */
  probeInitialDelayMinutes: envInt('PROBE_INITIAL_DELAY_MINUTES', 20),
  /** Only servers seen online within this window are probed; dead hosts would just time out once per protocol. */
  probeOnlineWithinHours: envInt('PROBE_ONLINE_WITHIN_HOURS', 24),
  /** Per-handshake timeout during the probe (a server that answered the sweep does not need the full sweep timeout). */
  probeTimeoutMs: envInt('PROBE_TIMEOUT_MS', 5000),
  /** Pause between consecutive handshakes to the same server, so a probe does not look like a connection flood. */
  probeHandshakeDelayMs: envInt('PROBE_HANDSHAKE_DELAY_MS', 150),

  /** ISO country codes whose list-site pages `npm run discover` scrapes (see discovery/sources.ts COUNTRIES for the supported set). */
  discoveryCountries: envStr('DISCOVERY_COUNTRIES', 'US,BR,DE,GB,FR,RU,PL,ES,CA,TR').toUpperCase().split(/[,\s]+/).filter(Boolean),
  /** Pause between page fetches of one list site (a source can override it with its own `delayMs`). */
  discoveryPageDelayMs: envInt('DISCOVERY_PAGE_DELAY_MS', 1500),

  /**
   * Geolocate resolved IPs with ip-api.com's batch endpoint (free tier: 15 batch requests per minute, at most 100 IPs
   * per request). One lookup pass runs after every sweep and stops after GEOIP_BATCHES_PER_SWEEP requests.
   */
  geoIpEnabled: envBool('GEOIP_ENABLED', true),
  geoIpBatchSize: envInt('GEOIP_BATCH_SIZE', 100),
  geoIpBatchesPerSweep: envInt('GEOIP_BATCHES_PER_SWEEP', 6),
  /** Pause between two batch requests; 4.5s keeps a pass under the 15/min quota with headroom. */
  geoIpBatchDelayMs: envInt('GEOIP_BATCH_DELAY_MS', 4500),
  /** A server's IP is looked up again after this many days (hosting moves are rare and the quota is small). */
  geoIpCacheDays: envInt('GEOIP_CACHE_DAYS', 7),

  /** Flag servers on Mojang's blocklist (sessionserver.mojang.com/blockedservers); the list is re-downloaded at this interval. */
  blocklistEnabled: envBool('BLOCKLIST_ENABLED', true),
  blocklistIntervalHours: envInt('BLOCKLIST_INTERVAL_HOURS', 6),

  /** Track bare IP:port addresses too. Off by default: those are almost always hobby servers, not the commercial market. */
  trackIpHosts: envBool('TRACK_IP_HOSTS', false),

  /** De-dup: two hostnames whose player counts differ by more than this (percent, floor 3 players) are never merged. */
  dedupTolerancePct: envInt('DEDUP_TOLERANCE_PCT', 5),

  /** Keep raw ping rows for this many days (0 = forever). The week-long study wants everything, so default is forever. */
  pingRetentionDays: envInt('RETENTION_DAYS', 0),

  logLevel: envStr('LOG_LEVEL', 'info'),
};

export type Config = typeof config;
