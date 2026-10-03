import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { config } from './config.js';
import { logger } from './log.js';
import type { SuspectRow } from './suspects.js';
import { computeGroups, normalizeMotd, sampleKeys, type DedupInput, type GroupAssignment } from './dedup.js';
import type { PingResult, PingSuccess } from './protocol/ping.js';
import { nowSec, sha1 } from './util.js';

const log = logger('db');

/** Bump only for incompatible changes; there are no in-place migrations, an old database must be deleted. */
export const SCHEMA_VERSION = 1;

/**
 * SQL expression for a server's country (alias `s` = servers): operator override, then the ccTLD of the hostname,
 * then GeoIP. Bump COUNTRY_RULE whenever this changes so every finished sweep is re-aggregated on the next start
 * (~60 ms per sweep, before the HTTP server listens: mind the health-check grace period on a long history).
 */
export const COUNTRY_SQL = 'COALESCE(s.country_override, s.tld_country, s.country)';
const COUNTRY_RULE = '2';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 25565,
  source TEXT,
  added_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Country: COUNTRY_SQL = COALESCE(country_override, tld_country, country). The ccTLD says who a server is *for*,
  -- GeoIP only says where its datacenter is (a .com.br on OVH Canada is Brazilian); the override is set from the CLI.
  tld_country TEXT,
  country_override TEXT,
  -- DNS
  resolved_ip TEXT,
  resolved_port INTEGER,
  srv_target TEXT,
  dns_error TEXT,
  dns_checked_at INTEGER,
  -- Geo (from resolved_ip)
  country TEXT,
  region TEXT,
  city TEXT,
  isp TEXT,
  org TEXT,
  asn TEXT,
  geo_checked_at INTEGER,
  -- Rolling state
  first_online_at INTEGER,
  last_online_at INTEGER,
  last_ping_at INTEGER,
  last_ok INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_ping_at INTEGER NOT NULL DEFAULT 0,
  total_pings INTEGER NOT NULL DEFAULT 0,
  ok_pings INTEGER NOT NULL DEFAULT 0,
  -- Last successful status
  last_method TEXT,
  last_latency_ms INTEGER,
  last_players_online INTEGER,
  last_players_max INTEGER,
  last_sample_json TEXT,
  last_version_name TEXT,
  last_protocol INTEGER,
  last_software TEXT,
  last_motd TEXT,
  last_status_hash TEXT,
  mod_count INTEGER,
  enforces_secure_chat INTEGER,
  prevents_chat_reports INTEGER,
  favicon_hash TEXT,          -- the image itself lives in favicons (a 9 KB data URL here made every ping rewrite ~3 pages)
  peak_players INTEGER,
  peak_at INTEGER,
  notes TEXT,
  -- De-duplication (see dedup.ts). endpoints_json: {"ip:port": lastSeenTs}; dns_targets_json: ["cname", ...]
  -- group_rep: representative server id of the group this server was merged into.
  endpoints_json TEXT,
  dns_targets_json TEXT,
  group_rep INTEGER,
  group_reason TEXT,
  group_size INTEGER,
  -- status_snapshots row of last_status_hash, and the sightings of it not yet added to its seen_count/last_seen
  -- (flushed every SNAPSHOT_FLUSH_PINGS pings or when the payload changes, so a ping does not rewrite a snapshot page).
  last_snapshot_id INTEGER,
  snapshot_pending INTEGER NOT NULL DEFAULT 0,
  UNIQUE(host, port)
);
CREATE INDEX IF NOT EXISTS idx_servers_next_ping ON servers(enabled, next_ping_at);
CREATE INDEX IF NOT EXISTS idx_servers_ip ON servers(resolved_ip, resolved_port);
CREATE INDEX IF NOT EXISTS idx_servers_country ON servers(country);
CREATE INDEX IF NOT EXISTS idx_servers_players ON servers(last_players_online);
CREATE INDEX IF NOT EXISTS idx_servers_group ON servers(group_rep);

CREATE TABLE IF NOT EXISTS sweeps (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  servers_total INTEGER,
  servers_attempted INTEGER,
  servers_online INTEGER,
  servers_online_br INTEGER,
  players_online INTEGER,
  players_online_raw INTEGER,
  players_online_br INTEGER,
  players_online_br_raw INTEGER,
  groups_online INTEGER,
  groups_online_br INTEGER,
  errors_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sweeps_started ON sweeps(started_at);

-- The bulk of the database (~0.7M rows a day). Keep rows narrow and indexes few: every index costs a random page write
-- per ping. version_name/status_hash are only filled on rows written before snapshot_id existed (the snapshot has both).
CREATE TABLE IF NOT EXISTS pings (
  id INTEGER PRIMARY KEY,
  sweep_id INTEGER NOT NULL,
  server_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  method TEXT,
  latency_ms INTEGER,
  players_online INTEGER,
  players_max INTEGER,
  sample_count INTEGER,
  protocol INTEGER,
  version_name TEXT,
  status_hash TEXT,
  error_code TEXT,
  error TEXT,
  sample_uuids TEXT,
  group_rep INTEGER,
  group_reason TEXT,
  snapshot_id INTEGER
);
-- The only index. A server's history is read per sweep: sweep_id IN (sweeps of the window) AND server_id = ? seeks it;
-- ranges past RAW_HISTORY_HOURS read server_hours instead. (server_id, ts) and (ts) indexes were dropped (see migrate).
CREATE INDEX IF NOT EXISTS idx_pings_sweep_server ON pings(sweep_id, server_id);

-- One row per distinct status payload (MOTD/version/mods...) per server. The hash (statusHash) ignores player counts
-- (online, max, sample) and digit runs in the MOTD, so counters ("1403735 servers created") and max = online + 1 do
-- not mint a row per ping; motd/players_max/raw_json are refreshed to the latest sighting when pending sightings flush.
CREATE TABLE IF NOT EXISTS status_snapshots (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL,
  hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  version_name TEXT,
  protocol INTEGER,
  software TEXT,
  players_max INTEGER,
  motd TEXT,
  mod_kind TEXT,
  mod_count INTEGER,
  mods_json TEXT,
  enforces_secure_chat INTEGER,
  previews_chat INTEGER,
  prevents_chat_reports INTEGER,
  extra_keys TEXT,
  raw_json TEXT,
  UNIQUE(server_id, hash)
);

CREATE TABLE IF NOT EXISTS version_probes (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  protocol_sent INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  protocol_received INTEGER,
  version_name TEXT,
  supported INTEGER,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_probes_server ON version_probes(server_id, protocol_sent, ts);
CREATE INDEX IF NOT EXISTS idx_probes_ts ON version_probes(ts);
-- Latest version_probes row per (server, protocol), kept by recordProbes: /api/probes reads ~100k rows here instead of
-- grouping every probe ever run.
CREATE TABLE IF NOT EXISTS probe_latest (
  server_id INTEGER NOT NULL,
  protocol_sent INTEGER NOT NULL,
  probe_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  supported INTEGER,
  PRIMARY KEY (server_id, protocol_sent)
) WITHOUT ROWID;

-- Favicons by content hash (servers.favicon_hash); networks share one image across hostnames.
CREATE TABLE IF NOT EXISTS favicons (
  hash TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

-- Hourly per-server rollup of pings, the source of every history longer than RAW_HISTORY_HOURS (server page, top
-- servers). hour = start of the UTC hour the ping's *sweep* started in. Written once per hour by rollupHours for hours
-- whose sweeps are all finished; later hours are read from pings. players_* and latency_* cover answered pings only.
CREATE TABLE IF NOT EXISTS server_hours (
  server_id INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  pings INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  players_sum INTEGER NOT NULL,
  players_n INTEGER NOT NULL,
  players_max INTEGER,
  latency_sum INTEGER NOT NULL,
  latency_n INTEGER NOT NULL,
  PRIMARY KEY (server_id, hour)
) WITHOUT ROWID;

-- Mojang's server blocklist (see blocklist.ts): the raw SHA-1 list as last downloaded, and which tracked servers match it.
CREATE TABLE IF NOT EXISTS blocklist (
  hash TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS blocked_servers (
  server_id INTEGER PRIMARY KEY,
  pattern TEXT NOT NULL,      -- plaintext whose hash is on the list, e.g. "*.example.com"
  via TEXT NOT NULL,          -- which address matched: host | srv | ip
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
-- Addresses the operator removed (npm run remove): never re-added by seeds or scrapes until npm run add lifts the entry.
CREATE TABLE IF NOT EXISTS denied_servers (
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  reason TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (host, port)
);

-- Per-sweep totals per country (country = COUNTRY_SQL), the source of every
-- country-scoped chart. A duplicate group's MAX count is attributed to every country any of its members belongs to
-- (same semantic as players_online_br). Additive: backfilled from existing sweeps on start, see backfillSweepCountries.
CREATE TABLE IF NOT EXISTS sweep_countries (
  sweep_id INTEGER NOT NULL,
  country TEXT NOT NULL,
  servers_online INTEGER NOT NULL,
  groups_online INTEGER NOT NULL,
  players_online INTEGER NOT NULL,
  players_online_raw INTEGER NOT NULL,
  PRIMARY KEY (sweep_id, country)
);
CREATE INDEX IF NOT EXISTS idx_sweep_countries_country ON sweep_countries(country, sweep_id);
`;

export interface ServerRow {
  id: number;
  host: string;
  port: number;
  source: string | null;
  added_at: number;
  enabled: number;
  tld_country: string | null;
  country_override: string | null;
  resolved_ip: string | null;
  resolved_port: number | null;
  srv_target: string | null;
  dns_error: string | null;
  dns_checked_at: number | null;
  country: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
  org: string | null;
  asn: string | null;
  geo_checked_at: number | null;
  first_online_at: number | null;
  last_online_at: number | null;
  last_ping_at: number | null;
  last_ok: number | null;
  last_error: string | null;
  consecutive_failures: number;
  next_ping_at: number;
  total_pings: number;
  ok_pings: number;
  last_method: string | null;
  last_latency_ms: number | null;
  last_players_online: number | null;
  last_players_max: number | null;
  last_sample_json: string | null;
  last_version_name: string | null;
  last_protocol: number | null;
  last_software: string | null;
  last_motd: string | null;
  last_status_hash: string | null;
  mod_count: number | null;
  enforces_secure_chat: number | null;
  prevents_chat_reports: number | null;
  favicon_hash: string | null;
  peak_players: number | null;
  peak_at: number | null;
  notes: string | null;
  endpoints_json: string | null;
  dns_targets_json: string | null;
  group_rep: number | null;
  group_reason: string | null;
  group_size: number | null;
  last_snapshot_id: number | null;
  snapshot_pending: number;
}

/** Histories up to this many hours are read ping by ping; longer ones come from server_hours (see bucketSeconds). */
export const RAW_HISTORY_HOURS = 72;
/** A server's sightings of an unchanged status payload are added to its snapshot row every this many pings (~1 h). */
export const SNAPSHOT_FLUSH_PINGS = 12;
/** Pings per write transaction during a sweep (the servers rows a batch touches are rewritten once per batch). */
export const PING_BATCH = 1000;

/**
 * Snapshot identity of a status payload: everything but the player counts, with digit runs in the MOTD collapsed so a
 * counter or a clock in the MOTD does not create a new snapshot on every ping.
 */
export function statusHash(r: PingSuccess): string {
  const digitless = (v: unknown) => (v == null ? null : JSON.stringify(v).replace(/\d+/g, '#'));
  return sha1(
    JSON.stringify({
      v: r.versionName,
      p: r.protocol,
      m: digitless(r.motd),
      d: digitless(r.descriptionRaw),
      mods: r.modInfo,
      esc: r.enforcesSecureChat,
      pc: r.previewsChat,
      pcr: r.preventsChatReports,
      k: r.extraKeys,
    }),
  );
}

export type ServerLite = Pick<
  ServerRow,
  'id' | 'host' | 'port' | 'tld_country' | 'country' | 'consecutive_failures' | 'first_online_at' | 'last_online_at'
>;

function tldCountry(host: string): string | null {
  const m = host.match(/\.([a-z]{2})$/);
  if (!m) return null;
  const cc = m[1]!.toUpperCase();
  // generic-ish ccTLDs used as vanity domains: do not treat as a country signal
  if (['IO', 'GG', 'TV', 'ME', 'CC', 'CO', 'AI', 'FM', 'TO', 'LY', 'SH', 'IM', 'MC', 'PW', 'WS', 'NU', 'TK', 'ML', 'GA', 'CF', 'GQ', 'ST', 'SU', 'EU', 'LA', 'RS', 'AC', 'AM', 'AS', 'BZ', 'DJ', 'MS', 'TF', 'XYZ'].includes(cc)) return null;
  return cc;
}

/**
 * How long to wait before re-pinging a failing server, so dead hosts do not eat the sweep budget.
 * Thresholds are wall-clock windows converted to sweep counts, so the tiers stay the same when PING_INTERVAL_MINUTES changes.
 */
export function backoffSeconds(consecutiveFailures: number, everOnline: boolean, intervalMinutes = config.pingIntervalMinutes): number {
  const sweeps = (minutes: number) => Math.max(1, Math.round(minutes / intervalMinutes));
  if (consecutiveFailures < sweeps(60)) return 0; // first hour: every sweep
  if (everOnline) {
    if (consecutiveFailures < sweeps(6 * 60)) return 0; // keep full cadence for 6h after a known-good server drops
    if (consecutiveFailures < sweeps(6 * 60) + 36) return 30 * 60; // then 30 min for ~18h
    return 60 * 60;
  }
  if (consecutiveFailures < sweeps(60) + 18) return 60 * 60; // never-online: hourly for ~18h
  return 6 * 60 * 60;
}

export interface DeleteCounts {
  servers: number;
  pings: number;
  snapshots: number;
  probes: number;
}
export interface PruneOptions {
  /** Also delete bare IP hosts. */
  ipHosts: boolean;
  neverOnlineMinPings: number;
  neverOnlineMinAgeSec?: number;
  /** Deny-list the never-online addresses so seeds and scrapes do not re-add them. */
  deny?: boolean;
}
export interface PruneCandidate {
  id: number;
  host: string;
  port: number;
  total_pings: number;
  last_error: string | null;
}
export interface PruneCounts extends DeleteCounts {
  /** Never-online addresses put on the deny list (0 unless `deny`). */
  denied: number;
}

/** What recordPing reads back from the servers row before writing it. */
interface ServerWriteState {
  endpoints_json: string | null;
  dns_targets_json: string | null;
  last_status_hash: string | null;
  last_snapshot_id: number | null;
  snapshot_pending: number;
  last_online_at: number | null;
  favicon_hash: string | null;
}

/** Every ip:port and DNS name a hostname resolved to in the last 24h (round-robin DNS shows a subset each time). */
function mergeEndpoints(
  row: Pick<ServerWriteState, 'endpoints_json' | 'dns_targets_json'> | undefined,
  resolved: { endpoints: string[]; dnsTargets: string[] },
  ts: number,
): { endpoints: string; dnsTargets: string | null } {
  let eps: Record<string, number> = {};
  try {
    eps = row?.endpoints_json ? (JSON.parse(row.endpoints_json) as Record<string, number>) : {};
  } catch {
    eps = {};
  }
  for (const [k, seen] of Object.entries(eps)) if (seen < ts - 86400) delete eps[k];
  for (const e of resolved.endpoints) eps[e] = ts;
  let dns: string[] = [];
  try {
    dns = row?.dns_targets_json ? (JSON.parse(row.dns_targets_json) as string[]) : [];
  } catch {
    dns = [];
  }
  const merged = [...new Set([...resolved.dnsTargets, ...dns])].slice(0, 12);
  return { endpoints: JSON.stringify(eps), dnsTargets: merged.length ? JSON.stringify(merged) : null };
}

/** The status JSON as stored in status_snapshots.raw_json (favicon already stripped by the ping), capped at 64 KB. */
function rawStatusJson(r: PingSuccess): string {
  let raw: string;
  try {
    raw = JSON.stringify(r.rawJson) ?? '{}';
  } catch {
    raw = '{}';
  }
  return raw.length > 64 * 1024 ? raw.slice(0, 64 * 1024) : raw;
}

/** Where the collector keeps its database unless a path is given. */
export function defaultDbFile(): string {
  return path.join(config.dataDir, 'census.db');
}

/**
 * `compact`, part 2: run at start, before anything opens the database, when `requestCompaction()` asked for it. Writes a
 * copy without free pages with VACUUM INTO (one read + one write; a plain VACUUM builds a temporary copy of the whole
 * database, in RAM with temp_store = MEMORY, then writes it back through the WAL), checks it with quick_check and swaps
 * it in atomically. The previous file stays as `<file>.pre-compact` (a hard link, so nothing is copied) until the
 * operator deletes it; the space is only freed then. Runs at most once per request, even if it fails.
 */
export function compactIfRequested(file = defaultDbFile()): { before: number; after: number; backup: string } | null {
  if (!fs.existsSync(file)) return null;
  const tmp = `${file}.compact`;
  const before = fs.statSync(file).size;
  const db = new DatabaseSync(file, { timeout: 10_000 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) return null;
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'compact_on_start'").get()) return null;
    db.exec("DELETE FROM meta WHERE key = 'compact_on_start'");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const fsStat = fs.statfsSync(path.dirname(file));
    if (fsStat.bavail * fsStat.bsize < before) {
      log.warn(`compact skipped: ${Math.round(before / 1048576)} MB free needed next to ${file}`);
      return null;
    }
    log.info(`compacting ${file} (${Math.round(before / 1048576)} MB); the collector and dashboard start when it is done`);
    fs.rmSync(tmp, { force: true });
    db.prepare('VACUUM INTO ?').run(tmp);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(tmp, { readOnly: true });
  const check = (copy.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
  copy.close();
  if (check !== 'ok') {
    log.error(`compact aborted, the copy failed quick_check (${check}); ${file} is unchanged`);
    fs.rmSync(tmp, { force: true });
    return null;
  }
  const backup = `${file}.pre-compact`;
  for (const f of [backup, `${backup}-wal`, `${backup}-shm`]) fs.rmSync(f, { force: true });
  fs.linkSync(file, backup);
  // A WAL left behind by another connection belongs to the old file: it moves with the backup.
  if (fs.existsSync(`${file}-wal`)) fs.renameSync(`${file}-wal`, `${backup}-wal`);
  fs.rmSync(`${file}-shm`, { force: true });
  fs.renameSync(tmp, file);
  const after = fs.statSync(file).size;
  log.info(`compacted ${file}: ${Math.round(before / 1048576)} MB -> ${Math.round(after / 1048576)} MB; previous file kept as ${backup} (delete it to free the space)`);
  return { before, after, backup };
}

export class Db {
  readonly db: DatabaseSync;
  readonly file: string;
  private stmts = new Map<string, StatementSync>();

  /**
   * `readOnly` opens a second connection for the API reader (api/reader.ts): no schema work, no writes; the collector's
   * connection must have opened (and migrated) the file first.
   */
  constructor(file?: string, opts: { readOnly?: boolean } = {}) {
    this.file = file ?? defaultDbFile();
    if (opts.readOnly) {
      this.db = new DatabaseSync(this.file, { readOnly: true, timeout: 10_000 });
      this.db.exec('PRAGMA temp_store = MEMORY');
      this.db.exec('PRAGMA cache_size = -16000');
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file, { timeout: 10_000 });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA temp_store = MEMORY');
    this.db.exec('PRAGMA cache_size = -32000');
    this.db.exec(SCHEMA);
    this.migrate();
    const existing = this.getMeta('schema_version');
    if (existing && existing !== String(SCHEMA_VERSION)) {
      throw new Error(`${this.file} has schema v${existing}, this build expects v${SCHEMA_VERSION}; delete the database and start again`);
    }
    this.setMeta('schema_version', String(SCHEMA_VERSION));
    if (!this.getMeta('created_at')) this.setMeta('created_at', String(nowSec()));
    log.info(`opened ${this.file}`);
    this.backfillSweepCountries();
    if (this.getMeta('country_rule') !== COUNTRY_RULE) {
      const n = this.reaggregateSweeps();
      this.setMeta('country_rule', COUNTRY_RULE);
      log.info(`country rule v${COUNTRY_RULE}: re-aggregated ${n} sweeps`);
    }
  }

  /** Additive column changes for databases created by older builds (CREATE TABLE IF NOT EXISTS leaves them alone). */
  private migrate(): void {
    const columns = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    const cols = columns('servers');
    if (!cols.has('country_override')) this.db.exec('ALTER TABLE servers ADD COLUMN country_override TEXT');
    for (const c of ['merge_with', 'merge_never']) if (cols.has(c)) this.db.exec(`ALTER TABLE servers DROP COLUMN ${c}`);
    if (!cols.has('last_snapshot_id')) this.db.exec('ALTER TABLE servers ADD COLUMN last_snapshot_id INTEGER');
    if (!cols.has('snapshot_pending')) this.db.exec('ALTER TABLE servers ADD COLUMN snapshot_pending INTEGER NOT NULL DEFAULT 0');
    if (cols.has('favicon')) {
      this.transaction(() => {
        this.db.exec('INSERT OR IGNORE INTO favicons(hash, data) SELECT favicon_hash, favicon FROM servers WHERE favicon IS NOT NULL AND favicon_hash IS NOT NULL');
        this.db.exec('ALTER TABLE servers DROP COLUMN favicon');
      });
      log.info('moved favicons out of the servers table');
    }
    if (!columns('pings').has('snapshot_id')) this.db.exec('ALTER TABLE pings ADD COLUMN snapshot_id INTEGER');
    // Superseded by idx_pings_sweep_server; the (server_id, ts) and (ts) indexes cost a random page write per ping
    // (~40% of the write-ahead log of a sweep) and 180 MB a week. Their pages go to the freelist and are reused.
    for (const ix of ['idx_pings_sweep', 'idx_pings_server_ts', 'idx_pings_ts']) {
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(ix)) {
        this.db.exec(`DROP INDEX ${ix}`);
        log.info(`dropped index ${ix}`);
      }
    }
    if (!this.getMeta('probe_latest')) {
      this.transaction(() => {
        this.db.exec(
          `INSERT OR REPLACE INTO probe_latest(server_id, protocol_sent, probe_id, ts, ok, supported)
           SELECT v.server_id, v.protocol_sent, v.id, v.ts, v.ok, v.supported
           FROM (SELECT MAX(id) AS id FROM version_probes GROUP BY server_id, protocol_sent) l JOIN version_probes v ON v.id = l.id`,
        );
        this.setMeta('probe_latest', '1');
      });
    }
  }

  /** Fill sweep_countries for sweeps finished before the table existed (or before the last regroup). Idempotent. */
  private backfillSweepCountries(): void {
    const done = Number(this.getMeta('sweep_countries_through') ?? 0);
    const ids = (this.prep('SELECT id FROM sweeps WHERE finished_at IS NOT NULL AND id > ? ORDER BY id').all(done) as { id: number }[]).map((r) => r.id);
    if (!ids.length) return;
    this.transaction(() => {
      for (const id of ids) this.aggregateSweepCountries(id);
      this.setMeta('sweep_countries_through', String(ids.at(-1)));
    });
    log.info(`sweep_countries: backfilled ${ids.length} sweeps`);
  }

  prep(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.prep('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.prep('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- servers -----------------------------------------------------------

  /**
   * Insert if new. Returns true when a row was added. IP literals are skipped unless TRACK_IP_HOSTS is set; addresses
   * on the deny list (`removeServer`) are always skipped.
   */
  addServer(host: string, port: number, source: string): boolean {
    if (!config.trackIpHosts && net.isIP(host)) return false;
    if (this.prep('SELECT 1 FROM denied_servers WHERE host = ? AND port = ?').get(host, port)) return false;
    const r = this.prep(
      'INSERT OR IGNORE INTO servers(host, port, source, added_at, tld_country) VALUES (?, ?, ?, ?, ?)',
    ).run(host, port, source, nowSec(), tldCountry(host));
    return Number(r.changes) > 0;
  }

  addServers(list: { host: string; port: number; source: string }[]): number {
    let added = 0;
    this.transaction(() => {
      for (const s of list) if (this.addServer(s.host, s.port, s.source)) added++;
    });
    return added;
  }

  /** True when the address is tracked or on the deny list (i.e. nothing to review in a discovery run). */
  isKnownAddress(host: string, port: number): boolean {
    return (
      this.prep('SELECT 1 FROM servers WHERE host = ? AND port = ? UNION ALL SELECT 1 FROM denied_servers WHERE host = ? AND port = ? LIMIT 1').get(host, port, host, port) != null
    );
  }

  getServer(id: number): ServerRow | undefined {
    return this.prep('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | undefined;
  }
  getServerByAddress(host: string, port: number): ServerRow | undefined {
    return this.prep('SELECT * FROM servers WHERE host = ? AND port = ?').get(host, port) as ServerRow | undefined;
  }

  countServers(): { total: number; enabled: number } {
    return this.prep('SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM servers').get() as { total: number; enabled: number };
  }

  /** Servers due for a ping in this sweep. */
  dueServers(now: number): ServerLite[] {
    return this.prep(
      'SELECT id, host, port, tld_country, country, consecutive_failures, first_online_at, last_online_at FROM servers WHERE enabled = 1 AND next_ping_at <= ? ORDER BY id',
    ).all(now) as ServerLite[];
  }

  /** Servers seen online in the last N seconds (candidates for version probing / geo lookup). */
  recentlyOnlineServers(withinSec: number): ServerLite[] {
    return this.prep(
      'SELECT id, host, port, tld_country, country, consecutive_failures, first_online_at, last_online_at FROM servers WHERE enabled = 1 AND last_online_at >= ? ORDER BY last_players_online DESC',
    ).all(nowSec() - withinSec) as ServerLite[];
  }

  /** Servers whose geo data is missing or older than `maxAgeSec`, most recently online first. */
  serversNeedingGeo(limit: number, maxAgeSec: number): { id: number; resolved_ip: string }[] {
    return this.prep(
      `SELECT id, resolved_ip FROM servers WHERE resolved_ip IS NOT NULL AND (geo_checked_at IS NULL OR geo_checked_at < ?) ORDER BY last_online_at DESC NULLS LAST LIMIT ?`,
    ).all(nowSec() - maxAgeSec, limit) as { id: number; resolved_ip: string }[];
  }

  setGeo(
    id: number,
    g: { country: string | null; region: string | null; city: string | null; isp: string | null; org: string | null; asn: string | null },
  ): void {
    this.prep(
      'UPDATE servers SET country = ?, region = ?, city = ?, isp = ?, org = ?, asn = ?, geo_checked_at = ? WHERE id = ?',
    ).run(g.country, g.region, g.city, g.isp, g.org, g.asn, nowSec(), id);
  }

  // ---- sweeps & pings ------------------------------------------------------

  startSweep(serversTotal: number, attempted: number): number {
    const r = this.prep('INSERT INTO sweeps(started_at, servers_total, servers_attempted) VALUES (?, ?, ?)').run(nowSec(), serversTotal, attempted);
    return Number(r.lastInsertRowid);
  }

  /**
   * Record one ping. Called inside a transaction by the sweep runner.
   * Player totals per sweep are computed at sweep end (see finishSweep) so duplicates by IP:port can be collapsed.
   * Costs one read and one write of the servers row; the status snapshot row is only written when the payload changes
   * or every SNAPSHOT_FLUSH_PINGS sightings, and the favicon only when a new image shows up.
   */
  recordPing(sweepId: number, server: ServerLite, r: PingResult, ts: number): void {
    const cur =
      r.ok || r.resolved
        ? (this.prep(
            'SELECT endpoints_json, dns_targets_json, last_status_hash, last_snapshot_id, snapshot_pending, last_online_at, favicon_hash FROM servers WHERE id = ?',
          ).get(server.id) as ServerWriteState | undefined)
        : undefined;
    if (r.ok) {
      const sampleJson = r.sample.length ? JSON.stringify(r.sample) : null;
      const keys = sampleKeys(r.sample);
      const sampleUuids = keys.length ? keys.join(',') : null;
      const hash = statusHash(r);
      let snapshotId: number;
      let pending = 0;
      if (cur?.last_snapshot_id != null && cur.last_status_hash === hash) {
        snapshotId = cur.last_snapshot_id;
        pending = cur.snapshot_pending + 1;
        if (pending >= SNAPSHOT_FLUSH_PINGS) {
          this.flushSnapshot(snapshotId, pending, ts, r);
          pending = 0;
        }
      } else {
        // The payload changed: settle the previous snapshot (last seen = the server's previous answer), then count this one.
        if (cur?.last_snapshot_id != null && cur.snapshot_pending > 0) this.flushSnapshot(cur.last_snapshot_id, cur.snapshot_pending, cur.last_online_at ?? ts, null);
        snapshotId = this.upsertSnapshot(server.id, hash, r, ts);
      }
      this.prep(
        `INSERT INTO pings(sweep_id, server_id, ts, ok, method, latency_ms, players_online, players_max, sample_count, protocol, sample_uuids, snapshot_id)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(sweepId, server.id, ts, r.method, r.latencyMs, r.playersOnline, r.playersMax, r.sample.length, r.protocol, sampleUuids, snapshotId);

      const faviconHash = r.favicon ? sha1(r.favicon) : null;
      if (faviconHash && faviconHash !== cur?.favicon_hash) this.prep('INSERT OR IGNORE INTO favicons(hash, data) VALUES (?, ?)').run(faviconHash, r.favicon);
      const eps = mergeEndpoints(cur, r.resolved, ts);
      this.prep(
        `UPDATE servers SET
           resolved_ip = ?, resolved_port = ?, srv_target = ?, dns_error = NULL, dns_checked_at = ?, endpoints_json = ?, dns_targets_json = ?,
           first_online_at = COALESCE(first_online_at, ?), last_online_at = ?, last_ping_at = ?, last_ok = 1, last_error = NULL,
           consecutive_failures = 0, next_ping_at = 0, total_pings = total_pings + 1, ok_pings = ok_pings + 1,
           last_method = ?, last_latency_ms = ?, last_players_online = ?, last_players_max = ?, last_sample_json = ?,
           last_version_name = ?, last_protocol = ?, last_software = ?, last_motd = ?, last_status_hash = ?,
           last_snapshot_id = ?, snapshot_pending = ?,
           mod_count = ?, enforces_secure_chat = ?, prevents_chat_reports = ?,
           favicon_hash = COALESCE(?, favicon_hash),
           peak_players = CASE WHEN ? > COALESCE(peak_players, -1) THEN ? ELSE peak_players END,
           peak_at = CASE WHEN ? > COALESCE(peak_players, -1) THEN ? ELSE peak_at END
         WHERE id = ?`,
      ).run(
        r.resolved.ip,
        r.resolved.port,
        r.resolved.srvTarget,
        ts,
        eps.endpoints,
        eps.dnsTargets,
        ts,
        ts,
        ts,
        r.method,
        r.latencyMs,
        r.playersOnline,
        r.playersMax,
        sampleJson,
        r.versionName,
        r.protocol,
        r.software,
        r.motd,
        hash,
        snapshotId,
        pending,
        r.modInfo?.modCount ?? null,
        r.enforcesSecureChat == null ? null : r.enforcesSecureChat ? 1 : 0,
        r.preventsChatReports == null ? null : r.preventsChatReports ? 1 : 0,
        faviconHash,
        r.playersOnline ?? -1,
        r.playersOnline,
        r.playersOnline ?? -1,
        ts,
        server.id,
      );
    } else {
      this.prep(
        `INSERT INTO pings(sweep_id, server_id, ts, ok, error_code, error) VALUES (?, ?, ?, 0, ?, ?)`,
      ).run(sweepId, server.id, ts, r.code, r.error);
      const failures = server.consecutive_failures + 1;
      const everOnline = server.first_online_at != null;
      const backoff = backoffSeconds(failures, everOnline);
      const eps = r.resolved ? mergeEndpoints(cur, r.resolved, ts) : null;
      this.prep(
        `UPDATE servers SET
           last_ping_at = ?, last_ok = 0, last_error = ?, consecutive_failures = ?, next_ping_at = ?,
           total_pings = total_pings + 1,
           resolved_ip = COALESCE(?, resolved_ip), resolved_port = COALESCE(?, resolved_port), srv_target = COALESCE(?, srv_target),
           endpoints_json = COALESCE(?, endpoints_json), dns_targets_json = COALESCE(?, dns_targets_json),
           dns_error = ?, dns_checked_at = ?
         WHERE id = ?`,
      ).run(
        ts,
        `${r.code}: ${r.error}`,
        failures,
        backoff ? ts + backoff : 0,
        r.resolved?.ip ?? null,
        r.resolved?.port ?? null,
        r.resolved?.srvTarget ?? null,
        eps?.endpoints ?? null,
        eps?.dnsTargets ?? null,
        r.code === 'DNS' ? r.error : null,
        ts,
        server.id,
      );
    }
  }

  /** The snapshot row for `hash` (one more sighting), inserted when the server never sent this payload before. */
  private upsertSnapshot(serverId: number, hash: string, r: PingSuccess, ts: number): number {
    const hit = this.prep('UPDATE status_snapshots SET last_seen = ?, seen_count = seen_count + 1 WHERE server_id = ? AND hash = ? RETURNING id').get(ts, serverId, hash) as
      | { id: number }
      | undefined;
    if (hit) return hit.id;
    const ins = this.prep(
      `INSERT INTO status_snapshots(server_id, hash, first_seen, last_seen, version_name, protocol, software, players_max, motd,
         mod_kind, mod_count, mods_json, enforces_secure_chat, previews_chat, prevents_chat_reports, extra_keys, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      serverId,
      hash,
      ts,
      ts,
      r.versionName,
      r.protocol,
      r.software,
      r.playersMax,
      r.motd,
      r.modInfo?.kind ?? null,
      r.modInfo?.modCount ?? null,
      r.modInfo ? JSON.stringify(r.modInfo.mods) : null,
      r.enforcesSecureChat == null ? null : r.enforcesSecureChat ? 1 : 0,
      r.previewsChat == null ? null : r.previewsChat ? 1 : 0,
      r.preventsChatReports == null ? null : r.preventsChatReports ? 1 : 0,
      r.extraKeys.length ? JSON.stringify(r.extraKeys) : null,
      rawStatusJson(r),
    );
    return Number(ins.lastInsertRowid);
  }

  /** Add pending sightings to a snapshot; with `latest`, also refresh the parts the hash ignores (MOTD digits, max players). */
  private flushSnapshot(id: number, sightings: number, lastSeen: number, latest: PingSuccess | null): void {
    if (latest) {
      this.prep('UPDATE status_snapshots SET seen_count = seen_count + ?, last_seen = MAX(last_seen, ?), motd = ?, players_max = ?, raw_json = ? WHERE id = ?').run(
        sightings,
        lastSeen,
        latest.motd,
        latest.playersMax,
        rawStatusJson(latest),
        id,
      );
    } else {
      this.prep('UPDATE status_snapshots SET seen_count = seen_count + ?, last_seen = MAX(last_seen, ?) WHERE id = ?').run(sightings, lastSeen, id);
    }
  }

  /** Group duplicates, compute per-sweep aggregates, close the sweep row and roll up any hour this sweep completed. */
  finishSweep(sweepId: number, durationMs: number, errors: Record<string, number>): void {
    this.groupSweep(sweepId);
    this.prep('UPDATE sweeps SET finished_at = ?, duration_ms = ?, errors_json = ? WHERE id = ?').run(nowSec(), durationMs, JSON.stringify(errors), sweepId);
    this.setMeta('sweep_countries_through', String(sweepId));
    try {
      this.rollupHours(2);
    } catch (err) {
      log.warn('rollup deferred to the next sweep', err); // catch-up work: the sweep itself is recorded
    }
  }

  /** Start of the last hour in server_hours, or null when nothing is rolled up yet (see rollupHours). */
  rollupThrough(): number | null {
    const v = this.getMeta('server_hours_through');
    return v == null ? null : Number(v);
  }

  /**
   * Write server_hours for up to `maxHours` complete hours, oldest first; returns how many were written. An hour is
   * complete once a sweep that started after it has finished (sweeps run one at a time). finishSweep keeps up with the
   * hour that just ended; the one-time backfill of older history runs in rollup-worker.ts. Each hour is one
   * transaction that re-reads the progress marker, so both can run at once without writing an hour twice.
   */
  rollupHours(maxHours: number): number {
    let written = 0;
    while (written < maxHours && this.transaction(() => this.rollupNextHour())) written++;
    return written;
  }

  private rollupNextHour(): boolean {
    const latest = this.prep('SELECT started_at FROM sweeps WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() as { started_at: number } | undefined;
    if (!latest) return false;
    const through = this.rollupThrough();
    // The next hour that has sweeps (downtime is skipped in one step).
    const next = this.prep('SELECT MIN(started_at) AS t FROM sweeps WHERE started_at >= ?').get(through == null ? 0 : through + 3600) as { t: number | null };
    if (next.t == null) return false;
    const hour = Math.floor(next.t / 3600) * 3600;
    if (hour >= Math.floor(latest.started_at / 3600) * 3600) return false;
    this.prep(
      `INSERT OR REPLACE INTO server_hours(server_id, hour, pings, ok, players_sum, players_n, players_max, latency_sum, latency_n)
       SELECT p.server_id, ?, COUNT(*), SUM(p.ok),
              COALESCE(SUM(CASE WHEN p.ok = 1 THEN p.players_online END), 0), COUNT(CASE WHEN p.ok = 1 THEN p.players_online END),
              MAX(CASE WHEN p.ok = 1 THEN p.players_online END),
              COALESCE(SUM(CASE WHEN p.ok = 1 THEN p.latency_ms END), 0), COUNT(CASE WHEN p.ok = 1 THEN p.latency_ms END)
       FROM pings p WHERE p.sweep_id IN (SELECT id FROM sweeps WHERE started_at >= ? AND started_at < ?)
       GROUP BY p.server_id`,
    ).run(hour, hour, hour + 3600);
    this.setMeta('server_hours_through', String(hour));
    return true;
  }

  /**
   * Inputs for dedup.ts: every server that answered in this sweep, with what it looked like *in this sweep* where we have
   * it. The MOTD is the exact last one for the server's latest answer, else its snapshot's (pings written before
   * snapshot_id existed find it by status_hash).
   */
  private sweepDedupInputs(sweepId: number): DedupInput[] {
    const rows = this.prep(
      `SELECT p.server_id AS id, s.host, p.players_online AS players, p.players_max AS players_max, p.sample_uuids,
              s.favicon_hash, COALESCE(CASE WHEN p.ts = s.last_online_at THEN s.last_motd END, n.motd, h.motd, s.last_motd) AS motd,
              s.endpoints_json, s.dns_targets_json, s.resolved_ip, s.resolved_port
       FROM pings p
       JOIN servers s ON s.id = p.server_id
       LEFT JOIN status_snapshots n ON n.id = p.snapshot_id
       LEFT JOIN status_snapshots h ON p.snapshot_id IS NULL AND h.server_id = p.server_id AND h.hash = p.status_hash
       WHERE p.sweep_id = ? AND p.ok = 1`,
    ).all(sweepId) as {
      id: number;
      host: string;
      players: number | null;
      players_max: number | null;
      sample_uuids: string | null;
      favicon_hash: string | null;
      motd: string | null;
      endpoints_json: string | null;
      dns_targets_json: string | null;
      resolved_ip: string | null;
      resolved_port: number | null;
    }[];
    return rows.map((r) => {
      let endpoints: string[] = [];
      try {
        endpoints = r.endpoints_json ? Object.keys(JSON.parse(r.endpoints_json) as Record<string, number>) : [];
      } catch {
        endpoints = [];
      }
      if (!endpoints.length && r.resolved_ip) endpoints = [`${r.resolved_ip}:${r.resolved_port ?? 25565}`];
      let dnsTargets: string[] = [];
      try {
        dnsTargets = r.dns_targets_json ? (JSON.parse(r.dns_targets_json) as string[]) : [];
      } catch {
        dnsTargets = [];
      }
      return {
        id: r.id,
        host: r.host,
        players: r.players,
        playersMax: r.players_max,
        faviconHash: r.favicon_hash,
        motd: normalizeMotd(r.motd),
        endpoints,
        dnsTargets,
        sampleKeys: r.sample_uuids ? r.sample_uuids.split(',') : [],
      };
    });
  }

  /**
   * (Re)compute duplicate groups for one sweep, write them to pings (history) and servers (current view),
   * and refresh the sweep's player totals. Safe to run again after the rules change.
   */
  groupSweep(sweepId: number): { servers: number; groups: number } {
    const inputs = this.sweepDedupInputs(sweepId);
    const assignment = computeGroups(inputs, { tolerancePct: config.dedupTolerancePct });
    const size = new Map<number, number>();
    for (const a of assignment.values()) size.set(a.rep, (size.get(a.rep) ?? 0) + 1);
    // "Current" = no newer *finished* sweep exists. Newer unfinished rows (a sweep aborted by a restart) must not
    // block the servers-table update, or the dashboard keeps showing stale/empty groups until another sweep completes.
    const current = sweepId >= this.latestFinishedSweepId();
    this.transaction(() => {
      const upPing = this.prep('UPDATE pings SET group_rep = ?, group_reason = ? WHERE sweep_id = ? AND server_id = ?');
      // Rows whose group did not change are left alone: rewriting ~5k servers rows every sweep is most of this write.
      const upServer = this.prep(
        'UPDATE servers SET group_rep = ?1, group_reason = ?2, group_size = ?3 WHERE id = ?4 AND (group_rep IS NOT ?1 OR group_reason IS NOT ?2 OR group_size IS NOT ?3)',
      );
      for (const [id, a] of assignment) {
        upPing.run(a.rep, a.reason, sweepId, id);
        if (current) upServer.run(a.rep, a.reason, size.get(a.rep) ?? 1, id);
      }
      if (current) {
        this.prep(
          'UPDATE servers SET group_rep = NULL, group_reason = NULL, group_size = NULL WHERE last_ok IS NOT 1 AND (group_rep IS NOT NULL OR group_reason IS NOT NULL OR group_size IS NOT NULL)',
        ).run();
      }
      this.aggregateSweep(sweepId);
    });
    return { servers: inputs.length, groups: size.size };
  }

  private latestFinishedSweepId(): number {
    return ((this.prep('SELECT MAX(id) AS id FROM sweeps WHERE finished_at IS NOT NULL').get() as { id: number | null }).id ?? 0);
  }

  /** Sweep totals: hostnames online as-is, players summed once per duplicate group (MAX inside the group). */
  private aggregateSweep(sweepId: number): void {
    const agg = this.prep(
      `WITH ok_pings AS MATERIALIZED (
         SELECT p.server_id, p.players_online, COALESCE(p.group_rep, p.server_id) AS grp,
                CASE WHEN ${COUNTRY_SQL} = 'BR' THEN 1 ELSE 0 END AS br
         FROM pings p JOIN servers s ON s.id = p.server_id
         WHERE p.sweep_id = ? AND p.ok = 1
       ),
       dedup AS (
         SELECT grp, MAX(players_online) AS players, MAX(br) AS br FROM ok_pings GROUP BY grp
       )
       SELECT
         (SELECT COUNT(*) FROM ok_pings) AS servers_online,
         (SELECT COUNT(*) FROM ok_pings WHERE br = 1) AS servers_online_br,
         (SELECT COUNT(*) FROM dedup) AS groups_online,
         (SELECT COUNT(*) FROM dedup WHERE br = 1) AS groups_online_br,
         (SELECT COALESCE(SUM(players), 0) FROM dedup) AS players_online,
         (SELECT COALESCE(SUM(players_online), 0) FROM ok_pings) AS players_online_raw,
         (SELECT COALESCE(SUM(players), 0) FROM dedup WHERE br = 1) AS players_online_br,
         (SELECT COALESCE(SUM(players_online), 0) FROM ok_pings WHERE br = 1) AS players_online_br_raw`,
    ).get(sweepId) as {
      servers_online: number;
      servers_online_br: number;
      groups_online: number;
      groups_online_br: number;
      players_online: number;
      players_online_raw: number;
      players_online_br: number;
      players_online_br_raw: number;
    };
    this.prep(
      `UPDATE sweeps SET servers_online = ?, servers_online_br = ?, groups_online = ?, groups_online_br = ?,
         players_online = ?, players_online_raw = ?, players_online_br = ?, players_online_br_raw = ?
       WHERE id = ?`,
    ).run(
      agg.servers_online,
      agg.servers_online_br,
      agg.groups_online,
      agg.groups_online_br,
      agg.players_online,
      agg.players_online_raw,
      agg.players_online_br,
      agg.players_online_br_raw,
      sweepId,
    );
    this.aggregateSweepCountries(sweepId);
  }

  /** Same totals as aggregateSweep, one row per country (see the sweep_countries table comment). */
  private aggregateSweepCountries(sweepId: number): void {
    this.prep('DELETE FROM sweep_countries WHERE sweep_id = ?').run(sweepId);
    this.prep(
      `INSERT INTO sweep_countries(sweep_id, country, servers_online, groups_online, players_online, players_online_raw)
       WITH ok_pings AS MATERIALIZED (
         SELECT p.server_id, p.players_online, COALESCE(p.group_rep, p.server_id) AS grp,
                ${COUNTRY_SQL} AS country
         FROM pings p JOIN servers s ON s.id = p.server_id
         WHERE p.sweep_id = ? AND p.ok = 1
       ),
       dedup AS (SELECT grp, MAX(players_online) AS players FROM ok_pings GROUP BY grp),
       grp_countries AS (SELECT DISTINCT grp, country FROM ok_pings WHERE country IS NOT NULL),
       per_group AS (
         SELECT gc.country, COUNT(*) AS groups_online, COALESCE(SUM(d.players), 0) AS players
         FROM grp_countries gc JOIN dedup d ON d.grp = gc.grp GROUP BY gc.country
       ),
       per_host AS (
         SELECT country, COUNT(*) AS servers_online, COALESCE(SUM(players_online), 0) AS players_raw
         FROM ok_pings WHERE country IS NOT NULL GROUP BY country
       )
       SELECT ?, h.country, h.servers_online, g.groups_online, g.players, h.players_raw
       FROM per_host h JOIN per_group g ON g.country = h.country`,
    ).run(sweepId, sweepId);
  }

  /** Operator country override (ISO 3166-1 alpha-2, or null to fall back to ccTLD/GeoIP); false when the server does not exist. */
  setCountryOverride(id: number, code: string | null): boolean {
    if (!this.getServer(id)) return false;
    this.prep('UPDATE servers SET country_override = ? WHERE id = ?').run(code, id);
    return true;
  }

  /**
   * Recompute the totals (sweeps.* and sweep_countries) of every finished sweep with the current country rule and
   * overrides; returns the count. One transaction per sweep, so a CLI run against the live database only holds the
   * write lock for ~100 ms at a time and the collector's ping writes interleave instead of timing out.
   */
  reaggregateSweeps(): number {
    const ids = this.finishedSweepIds();
    for (const id of ids) this.transaction(() => this.aggregateSweep(id));
    return ids.length;
  }

  finishedSweepIds(sinceId = 0): number[] {
    return (this.prep('SELECT id FROM sweeps WHERE finished_at IS NOT NULL AND id >= ? ORDER BY id').all(sinceId) as { id: number }[]).map((r) => r.id);
  }

  // ---- probes ----------------------------------------------------------------

  /** One server's probe results (every protocol) in one transaction instead of one commit per handshake. */
  recordProbes(serverId: number, results: { protocol: number; r: PingResult; ts: number }[]): void {
    this.transaction(() => {
      for (const x of results) this.recordProbe(serverId, x.protocol, x.r, x.ts);
    });
  }

  recordProbe(serverId: number, protocolSent: number, r: PingResult, ts: number): void {
    const supported = r.ok ? (r.protocol != null && r.protocol === protocolSent ? 1 : 0) : null;
    const ins = r.ok
      ? this.prep(
          'INSERT INTO version_probes(server_id, ts, protocol_sent, ok, protocol_received, version_name, supported, latency_ms) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
        ).run(serverId, ts, protocolSent, r.protocol, r.versionName, supported, r.latencyMs)
      : this.prep('INSERT INTO version_probes(server_id, ts, protocol_sent, ok, error) VALUES (?, ?, ?, 0, ?)').run(serverId, ts, protocolSent, `${r.code}: ${r.error}`);
    this.prep('INSERT OR REPLACE INTO probe_latest(server_id, protocol_sent, probe_id, ts, ok, supported) VALUES (?, ?, ?, ?, ?, ?)').run(
      serverId,
      protocolSent,
      Number(ins.lastInsertRowid),
      ts,
      r.ok ? 1 : 0,
      supported,
    );
  }

  /** A server's favicon as the data URL it sent, or null. */
  faviconOf(serverId: number): string | null {
    const row = this.prep('SELECT f.data FROM servers s JOIN favicons f ON f.hash = s.favicon_hash WHERE s.id = ?').get(serverId) as { data: string } | undefined;
    return row?.data ?? null;
  }

  // ---- blocklist -------------------------------------------------------------

  loadBlocklist(): Set<string> {
    return new Set((this.prep('SELECT hash FROM blocklist').all() as { hash: string }[]).map((r) => r.hash));
  }

  replaceBlocklist(hashes: ReadonlySet<string>): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM blocklist');
      const ins = this.prep('INSERT OR IGNORE INTO blocklist(hash) VALUES (?)');
      for (const h of hashes) ins.run(h);
      this.setMeta('blocklist_fetched_at', String(nowSec()));
    });
  }

  /** Re-evaluate every server against the blocklist; `match` returns the pattern that hit or null. */
  applyBlocklist(match: (s: { id: number; host: string; srv_target: string | null; resolved_ip: string | null }) => { pattern: string; via: string } | null): {
    blocked: number;
    changed: number;
  } {
    const rows = this.prep('SELECT id, host, srv_target, resolved_ip FROM servers').all() as { id: number; host: string; srv_target: string | null; resolved_ip: string | null }[];
    const ts = nowSec();
    let blocked = 0;
    let changed = 0;
    this.transaction(() => {
      const current = new Map(
        (this.prep('SELECT server_id, pattern, via FROM blocked_servers').all() as { server_id: number; pattern: string; via: string }[]).map((r) => [r.server_id, r]),
      );
      const upsert = this.prep(
        `INSERT INTO blocked_servers(server_id, pattern, via, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET pattern = excluded.pattern, via = excluded.via, last_seen = excluded.last_seen`,
      );
      const del = this.prep('DELETE FROM blocked_servers WHERE server_id = ?');
      for (const s of rows) {
        const m = match(s);
        const was = current.get(s.id);
        if (m) {
          blocked++;
          if (!was || was.pattern !== m.pattern || was.via !== m.via) changed++;
          upsert.run(s.id, m.pattern, m.via, ts, ts);
        } else if (was) {
          changed++;
          del.run(s.id);
        }
      }
      // Servers deleted by prune leave no row behind either.
      this.db.exec('DELETE FROM blocked_servers WHERE server_id NOT IN (SELECT id FROM servers)');
    });
    return { blocked, changed };
  }

  // ---- maintenance ----------------------------------------------------------

  /**
   * Delete servers (with their pings, snapshots and probes) that are not worth tracking: bare IP hosts, and hostnames
   * that never answered after `neverOnlineMinPings` attempts spread over at least
   * `neverOnlineMinAgeSec` since they were added (so a freshly added server gets a full backoff cycle before it is judged).
   * With `deny`, the never-online addresses go on the deny list so seed files and `discover` runs do not bring them back;
   * `npm run add` lifts the entry. Sweep totals stay as recorded (never-online servers never counted).
   * Ping rows left behind by a sweep that was in flight while servers were deleted are removed as well.
   * `candidates` (from `pruneCandidates`) fixes the never-online set to what a live re-check saw, so servers that fail
   * their first ping while the re-check runs are not swept up untested; `spare` skips the ones that answered it.
   */
  pruneServers(opts: PruneOptions & { candidates?: PruneCandidate[]; spare?: ReadonlySet<number> }): PruneCounts {
    const now = nowSec();
    const neverOnline = (opts.candidates ?? this.pruneCandidates(opts, now)).filter((r) => !opts.spare?.has(r.id));
    const doomed = new Set<number>(neverOnline.map((r) => r.id));
    if (opts.ipHosts) {
      const rows = this.prep('SELECT id, host FROM servers').all() as { id: number; host: string }[];
      for (const r of rows) if (net.isIP(r.host)) doomed.add(r.id);
    }
    let denied = 0;
    if (opts.deny) {
      this.transaction(() => {
        const ins = this.prep('INSERT OR IGNORE INTO denied_servers(host, port, reason, added_at) VALUES (?, ?, ?, ?)');
        for (const r of neverOnline) denied += Number(ins.run(r.host, r.port, `prune: never online after ${r.total_pings} pings`, now).changes);
      });
    }
    const out = this.deleteServers([...doomed]);
    out.pings += this.deleteOrphanPings();
    return { ...out, denied };
  }

  /** Never-online servers `pruneServers` would delete: `neverOnlineMinPings` failed pings and added at least `neverOnlineMinAgeSec` ago. */
  pruneCandidates(opts: Pick<PruneOptions, 'neverOnlineMinPings' | 'neverOnlineMinAgeSec'>, now = nowSec()): PruneCandidate[] {
    return this.prep(
      'SELECT id, host, port, total_pings, last_error FROM servers WHERE first_online_at IS NULL AND total_pings >= ? AND added_at <= ? ORDER BY id',
    ).all(opts.neverOnlineMinPings, now - (opts.neverOnlineMinAgeSec ?? 0)) as unknown as PruneCandidate[];
  }

  /** Put servers back at the front of the sweep queue (after a live re-check answered while they were in failure backoff). */
  wakeServers(ids: Iterable<number>): void {
    this.transaction(() => {
      const upd = this.prep('UPDATE servers SET next_ping_at = 0, consecutive_failures = 0 WHERE id = ?');
      for (const id of ids) upd.run(id);
    });
  }

  /**
   * Delete one address and every row that references it (pings, snapshots, probes, blocklist match, pins) and put it
   * on the deny list so seeds and scrapes do not bring it back. Sweep totals are not recomputed here: run `regroup`.
   * Returns null when the address is not tracked (the deny entry is still written).
   */
  removeServer(host: string, port: number, reason: string | null): (DeleteCounts & { sweepIds: number[] }) | null {
    this.prep('INSERT OR REPLACE INTO denied_servers(host, port, reason, added_at) VALUES (?, ?, ?, ?)').run(host, port, reason, nowSec());
    const row = this.getServerByAddress(host, port);
    if (!row) return null;
    const sweepIds = this.sweepsWithPings(row.id);
    return { ...this.deleteServers([row.id]), sweepIds };
  }

  /**
   * Sweeps holding a ping of this server, found without a server index on pings: every sweep of an hour server_hours
   * saw it in, plus every sweep not rolled up yet, probed with (sweep_id, server_id) seeks.
   */
  sweepsWithPings(serverId: number): number[] {
    const through = this.rollupThrough();
    return (
      this.prep(
        `SELECT DISTINCT p.sweep_id FROM pings p
         WHERE p.server_id = ? AND p.sweep_id IN (
           SELECT id FROM sweeps WHERE started_at >= ?
           UNION SELECT w.id FROM server_hours h JOIN sweeps w ON w.started_at >= h.hour AND w.started_at < h.hour + 3600 WHERE h.server_id = ?
         )
         ORDER BY p.sweep_id`,
      ).all(serverId, through == null ? 0 : through + 3600, serverId) as { sweep_id: number }[]
    ).map((r) => r.sweep_id);
  }

  /** Every server that answered its last ping, in the shape `suspectReport` wants. */
  suspectRows(): SuspectRow[] {
    const rows = this.prep(
      'SELECT host, port, source, last_players_online AS online, last_players_max AS max, favicon_hash, last_motd, last_sample_json FROM servers WHERE enabled = 1 AND last_ok = 1 AND last_players_online IS NOT NULL',
    ).all() as { host: string; port: number; source: string | null; online: number; max: number | null; favicon_hash: string | null; last_motd: string | null; last_sample_json: string | null }[];
    return rows.map((r) => {
      let sampleSize = 0;
      try {
        sampleSize = r.last_sample_json ? (JSON.parse(r.last_sample_json) as unknown[]).length : 0;
      } catch {
        /* not JSON */
      }
      return { host: r.host, port: r.port, source: r.source, online: r.online, max: r.max ?? 0, faviconHash: r.favicon_hash, motd: r.last_motd, sampleSize };
    });
  }

  /**
   * Ping rows whose server is gone: written by a sweep that was in flight while servers were deleted, so only the last
   * few sweeps are looked at (a full scan of pings takes minutes on the production volume).
   */
  deleteOrphanPings(): number {
    const last = (this.prep('SELECT MAX(id) AS id FROM sweeps').get() as { id: number | null }).id ?? 0;
    return Number(this.prep('DELETE FROM pings WHERE sweep_id >= ? AND server_id NOT IN (SELECT id FROM servers)').run(last - 2).changes);
  }

  /** Lift a `removeServer` deny entry. Returns true when there was one. */
  allowServer(host: string, port: number): boolean {
    return Number(this.prep('DELETE FROM denied_servers WHERE host = ? AND port = ?').run(host, port).changes) > 0;
  }

  /** Delete servers by id together with everything that references them. */
  private deleteServers(ids: number[]): DeleteCounts {
    const out: DeleteCounts = { servers: 0, pings: 0, snapshots: 0, probes: 0 };
    if (!ids.length) return out;
    // Located before the write transaction: reads do not hold the lock the collector needs.
    const sweepsOf = new Map(ids.map((id) => [id, this.sweepsWithPings(id)]));
    this.transaction(() => {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS doomed(id INTEGER PRIMARY KEY)');
      this.db.exec('DELETE FROM doomed');
      const ins = this.prep('INSERT INTO doomed(id) VALUES (?)');
      for (const id of ids) ins.run(id);
      const delPing = this.prep('DELETE FROM pings WHERE sweep_id = ? AND server_id = ?');
      for (const [id, sweeps] of sweepsOf) for (const sweepId of sweeps) out.pings += Number(delPing.run(sweepId, id).changes);
      out.snapshots = Number(this.db.prepare('DELETE FROM status_snapshots WHERE server_id IN (SELECT id FROM doomed)').run().changes);
      out.probes = Number(this.db.prepare('DELETE FROM version_probes WHERE server_id IN (SELECT id FROM doomed)').run().changes);
      this.db.exec('DELETE FROM probe_latest WHERE server_id IN (SELECT id FROM doomed)');
      this.db.exec('DELETE FROM server_hours WHERE server_id IN (SELECT id FROM doomed)');
      this.db.exec('DELETE FROM blocked_servers WHERE server_id IN (SELECT id FROM doomed)');
      out.servers = Number(this.db.prepare('DELETE FROM servers WHERE id IN (SELECT id FROM doomed)').run().changes);
      this.db.exec('DELETE FROM favicons WHERE hash NOT IN (SELECT favicon_hash FROM servers WHERE favicon_hash IS NOT NULL)');
      this.db.exec('DELETE FROM doomed');
    });
    return out;
  }

  /**
   * RETENTION_DAYS: drop raw pings of sweeps older than the window, oldest sweep first, one transaction per sweep and at
   * most `maxSweeps` per call. Hours not rolled up into server_hours yet are kept, so long histories stay intact.
   */
  /**
   * `compact`, part 1 (safe while the collector runs): rewrite ping rows with id in (afterId, throughId] that were written
   * before snapshot_id existed, linking their snapshot and dropping status_hash/version_name (~40% of such a row).
   * One transaction per call; progress is kept in meta so an interrupted run resumes. Returns the rows rewritten.
   */
  slimPings(afterId: number, throughId: number): number {
    return this.transaction(() => {
      const n = Number(
        this.prep(
          `UPDATE pings SET snapshot_id = COALESCE(snapshot_id, (SELECT n.id FROM status_snapshots n WHERE n.server_id = pings.server_id AND n.hash = pings.status_hash)),
             status_hash = NULL, version_name = NULL
           WHERE id > ? AND id <= ? AND (status_hash IS NOT NULL OR version_name IS NOT NULL)`,
        ).run(afterId, throughId).changes,
      );
      this.setMeta('slim_pings_through', String(throughId));
      return n;
    });
  }

  /**
   * `thin`: finished sweeps started before `before` that are not the first sweep of their `slotSec` clock slot (UTC), i.e.
   * the sweeps a `slotSec` interval would not have run. Oldest first.
   */
  thinCandidates(before: number, slotSec: number): number[] {
    return (
      this.prep(
        `SELECT id FROM sweeps WHERE finished_at IS NOT NULL AND started_at < ? AND id NOT IN (
           SELECT MIN(id) FROM sweeps WHERE started_at < ? GROUP BY started_at / CAST(? AS INTEGER))
         ORDER BY id`,
      ).all(before, before, slotSec) as { id: number }[]
    ).map((r) => r.id);
  }

  /**
   * `thin`: delete one sweep with its pings and per-country totals, as if it never ran (a sweep row without pings would
   * be a hole in the per-server charts). server_hours keeps what was already rolled up. Returns the pings deleted.
   */
  dropSweep(id: number): number {
    return this.transaction(() => {
      const n = Number(this.prep('DELETE FROM pings WHERE sweep_id = ?').run(id).changes);
      this.prep('DELETE FROM sweep_countries WHERE sweep_id = ?').run(id);
      this.prep('DELETE FROM sweeps WHERE id = ?').run(id);
      return n;
    });
  }

  /** `compact`, part 2 is done by the next start (compactIfRequested), when nothing else has the file open. */
  requestCompaction(): void {
    this.setMeta('compact_on_start', String(nowSec()));
  }

  pruneOldPings(retentionDays: number, maxSweeps = 24): number {
    if (retentionDays <= 0) return 0;
    const through = this.rollupThrough();
    if (through == null) return 0;
    const cutoff = Math.min(nowSec() - retentionDays * 86400, through + 3600);
    const first = (this.prep('SELECT MIN(sweep_id) AS id FROM pings').get() as { id: number | null }).id;
    if (first == null) return 0;
    const ids = (this.prep('SELECT id FROM sweeps WHERE id >= ? AND started_at < ? ORDER BY id LIMIT ?').all(first, cutoff, maxSweeps) as { id: number }[]).map((r) => r.id);
    let deleted = 0;
    for (const id of ids) deleted += this.transaction(() => Number(this.prep('DELETE FROM pings WHERE sweep_id = ?').run(id).changes));
    return deleted;
  }
}
