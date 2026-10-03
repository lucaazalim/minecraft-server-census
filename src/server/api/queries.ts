import { COUNTRY_SQL, RAW_HISTORY_HOURS, type Db, type ServerRow } from '../db.js';
import { config } from '../config.js';
import { normalizeMotd, playersAgree, registrableDomain, type MergeReason } from '../dedup.js';
import { isProxy, protocolLabel, protocolTable, type Software } from '../protocol/versions.js';
import { REGIONS, regionByCode } from '../regions.js';
import { state } from '../state.js';
import { formatAddress, nowSec } from '../util.js';

// ---- scope -------------------------------------------------------------------

/**
 * Which servers a dashboard query covers: everything, one country (operator override, else the hostname's ccTLD,
 * else GeoIP; see COUNTRY_SQL in db.ts) or a region (a fixed set of countries, see regions.ts).
 */
export type Scope = { kind: 'all' } | { kind: 'country'; code: string } | { kind: 'region'; code: string; countries: readonly string[] };

/** SQL expression for a server's country; requires the alias `s` for `servers`. */
export const COUNTRY_EXPR = COUNTRY_SQL;
/** The same precedence as COUNTRY_EXPR, on a loaded row. */
export const serverCountry = (s: Pick<ServerRow, 'country_override' | 'tld_country' | 'country'>): string | null =>
  s.country_override ?? s.tld_country ?? s.country;

export function parseScope(v: string | null | undefined): Scope {
  if (!v || v === 'all') return { kind: 'all' };
  if (v === 'br') return { kind: 'country', code: 'BR' }; // legacy alias
  if (/^[a-z]{2}$/i.test(v)) return { kind: 'country', code: v.toUpperCase() };
  const region = regionByCode(v);
  return region ? { kind: 'region', code: region.code, countries: region.countries } : { kind: 'all' };
}

export function scopeKey(scope: Scope): string {
  return scope.kind === 'all' ? 'all' : scope.code;
}

/** Country codes a scope covers; null for "all". */
export function scopeCountries(scope: Scope): readonly string[] | null {
  if (scope.kind === 'all') return null;
  return scope.kind === 'country' ? [scope.code] : scope.countries;
}

/** SQL + params to append to a WHERE clause on `servers s`. Codes are always bound, never interpolated. */
export function scopeFilter(scope: Scope): { sql: string; params: string[] } {
  const codes = scopeCountries(scope);
  if (!codes) return { sql: '', params: [] };
  if (codes.length === 1) return { sql: ` AND ${COUNTRY_EXPR} = ?`, params: [codes[0]!] };
  return { sql: ` AND ${COUNTRY_EXPR} IN (${codes.map(() => '?').join(', ')})`, params: [...codes] };
}

/** 0 = one point per sweep (read from pings); else bucket width in seconds (read from the server_hours rollup). */
export function bucketSeconds(hours: number): number {
  if (hours > 0 && hours <= RAW_HISTORY_HOURS) return 0;
  if (hours > 0 && hours <= 24 * 31) return 3600;
  return 6 * 3600;
}

/**
 * Per-sweep totals for a scope: the `sweeps` row itself, or the matching `sweep_countries` rows (summed for a region)
 * with zeros when nothing was online there in that sweep (so charts show 0 instead of a missing point).
 * Columns: id, started_at, players_online, players_online_raw, servers_online, groups_online.
 * Region totals are sums of per-country totals, so a duplicate group whose hostnames sit in two countries of the same
 * region is counted once per country; that is rare enough to accept instead of regrouping every sweep on the fly.
 */
function sweepSource(scope: Scope, since: number): { sql: string; params: (string | number)[] } {
  const codes = scopeCountries(scope);
  if (!codes) {
    return {
      sql: `SELECT id, started_at, players_online, players_online_raw, servers_online, groups_online
            FROM sweeps WHERE finished_at IS NOT NULL AND started_at >= ?`,
      params: [since],
    };
  }
  return {
    sql: `SELECT w.id, w.started_at, COALESCE(SUM(c.players_online), 0) AS players_online, COALESCE(SUM(c.players_online_raw), 0) AS players_online_raw,
                 COALESCE(SUM(c.servers_online), 0) AS servers_online, COALESCE(SUM(c.groups_online), 0) AS groups_online
          FROM sweeps w LEFT JOIN sweep_countries c ON c.sweep_id = w.id AND c.country IN (${codes.map(() => '?').join(', ')})
          WHERE w.finished_at IS NOT NULL AND w.started_at >= ?
          GROUP BY w.id, w.started_at`,
    params: [...codes, since],
  };
}

/** "1.21.4" -> "1.21"; "1.8.x" -> "1.8"; unknown -> null */
export function protocolFamily(protocol: number | null): string | null {
  if (protocol == null) return null;
  const names = protocolTable()[protocol];
  if (!names?.length) return null;
  const parts = names[0]!.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : names[0]!;
}

// ---- overview ----------------------------------------------------------------

type SweepTotals = {
  players_online: number;
  players_online_raw: number;
  servers_online: number;
  groups_online: number;
};

export function overview(db: Db, scope: Scope) {
  const now = nowSec();
  const sf = scopeFilter(scope);
  const lastSweep = db
    .prep('SELECT id, started_at, finished_at, duration_ms, servers_attempted, servers_online FROM sweeps WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get() as { id: number; started_at: number; finished_at: number; duration_ms: number; servers_attempted: number; servers_online: number } | undefined;

  const zero: SweepTotals = { players_online: 0, players_online_raw: 0, servers_online: 0, groups_online: 0 };
  let current: SweepTotals = zero;
  let peak: { value: number; at: number } | null = null;
  let avg24: number | null = null;
  if (lastSweep) {
    if (scope.kind === 'all') {
      current =
        (db.prep('SELECT players_online, players_online_raw, servers_online, groups_online FROM sweeps WHERE id = ?').get(lastSweep.id) as SweepTotals | undefined) ?? zero;
      peak =
        (db.prep('SELECT players_online AS value, started_at AS at FROM sweeps WHERE finished_at IS NOT NULL ORDER BY players_online DESC LIMIT 1').get() as
          | { value: number; at: number }
          | undefined) ?? null;
      avg24 = (db.prep('SELECT AVG(players_online) AS v FROM sweeps WHERE finished_at IS NOT NULL AND started_at >= ?').get(now - 86400) as { v: number | null }).v;
    } else {
      const all = sweepSource(scope, 0);
      current =
        (db.prep(`SELECT players_online, players_online_raw, servers_online, groups_online FROM (${all.sql}) WHERE id = ?`).get(...all.params, lastSweep.id) as
          | SweepTotals
          | undefined) ?? zero;
      peak =
        (db.prep(`SELECT players_online AS value, started_at AS at FROM (${all.sql}) ORDER BY players_online DESC LIMIT 1`).get(...all.params) as
          | { value: number; at: number }
          | undefined) ?? null;
      // AVG over every finished sweep (missing country rows count as 0, like the timeseries).
      const src = sweepSource(scope, now - 86400);
      avg24 = (db.prep(`SELECT AVG(players_online) AS v FROM (${src.sql})`).get(...src.params) as { v: number | null }).v;
    }
  }

  const counts = db
    .prep(
      `SELECT COUNT(*) AS servers_tracked,
              SUM(CASE WHEN first_online_at IS NOT NULL THEN 1 ELSE 0 END) AS servers_ever_online
       FROM servers s WHERE 1 = 1${sf.sql}`,
    )
    .get(...sf.params) as { servers_tracked: number; servers_ever_online: number | null };

  const totals = db
    .prep(
      // Pings of the sweeps kept: COUNT(*) on pings reads a 100 MB index per call, and MAX(id) still counts the sweeps
      // `thin` deleted. Off by the pings of deleted servers (<1%).
      `SELECT (SELECT SUM(servers_attempted) FROM sweeps WHERE finished_at IS NOT NULL) AS pings,
              (SELECT COUNT(*) FROM sweeps WHERE finished_at IS NOT NULL) AS sweeps,
              (SELECT MAX(id) FROM status_snapshots) AS snapshots,
              (SELECT MAX(id) FROM version_probes) AS probes,
              (SELECT MIN(started_at) FROM sweeps) AS first_sweep_at,
              (SELECT COUNT(*) FROM servers) AS servers_total,
              (SELECT COUNT(*) FROM servers WHERE geo_checked_at IS NOT NULL) AS geo_done`,
    )
    .get() as { pings: number | null; sweeps: number; snapshots: number | null; probes: number | null; first_sweep_at: number | null; servers_total: number; geo_done: number };
  const sources = db
    .prep(
      `SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS servers, SUM(CASE WHEN first_online_at IS NOT NULL THEN 1 ELSE 0 END) AS ever_online
       FROM servers GROUP BY source ORDER BY servers DESC`,
    )
    .all() as { source: string; servers: number; ever_online: number }[];
  const blocked = db
    .prep(
      `SELECT COUNT(*) AS blocked_total, SUM(CASE WHEN s.last_ok = 1 THEN 1 ELSE 0 END) AS blocked_online
       FROM blocked_servers b JOIN servers s ON s.id = b.server_id`,
    )
    .get() as { blocked_total: number; blocked_online: number | null };

  return {
    generatedAt: now,
    scope: scopeKey(scope),
    kpis: {
      players_online: current.players_online,
      players_online_raw: current.players_online_raw,
      players_avg_24h: avg24 == null ? null : Math.round(avg24 * 10) / 10,
      groups_online: current.groups_online,
      servers_online: current.servers_online,
      servers_tracked: counts.servers_tracked,
      servers_ever_online: counts.servers_ever_online ?? 0,
      peak,
    },
    lastSweep: lastSweep ?? null,
    collector: {
      state,
      config: {
        pingIntervalMinutes: config.pingIntervalMinutes,
        probeIntervalHours: config.probeIntervalHours,
        probeProtocols: config.probeProtocols,
        geoEnabled: config.geoIpEnabled,
        blocklistEnabled: config.blocklistEnabled,
        blocklistIntervalHours: config.blocklistIntervalHours,
        dedupTolerancePct: config.dedupTolerancePct,
      },
      totals: { ...totals, pings: totals.pings ?? 0, snapshots: totals.snapshots ?? 0, probes: totals.probes ?? 0 },
      blocklist: {
        hashes: state.blocklist.hashes,
        fetchedAt: state.blocklist.fetchedAt,
        checkedAt: state.blocklist.checkedAt,
        lastError: state.blocklist.lastError,
        blocked_total: blocked.blocked_total,
        blocked_online: blocked.blocked_online ?? 0,
      },
      sources,
    },
  };
}

// ---- time series -------------------------------------------------------------

/** `since` (0 = everything) and bucket width for a dashboard range; `hours <= 0` means "all history" and buckets by the span actually stored. */
function rangeWindow(db: Db, hours: number): { since: number; bucketSec: number } {
  const now = nowSec();
  let span = hours;
  if (span <= 0) {
    const first = (db.prep('SELECT MIN(started_at) AS t FROM sweeps WHERE finished_at IS NOT NULL').get() as { t: number | null }).t;
    span = first == null ? 0 : Math.max(1, Math.ceil((now - first) / 3600));
  }
  return { since: hours > 0 ? now - hours * 3600 : 0, bucketSec: bucketSeconds(span) };
}

export function timeseries(db: Db, scope: Scope, hours: number) {
  const { since, bucketSec } = rangeWindow(db, hours);
  const src = sweepSource(scope, since);
  const points =
    bucketSec === 0
      ? (db
          .prep(
            `SELECT started_at AS t, players_online AS players, players_online AS players_peak, players_online_raw AS players_raw, servers_online, groups_online
             FROM (${src.sql}) ORDER BY started_at`,
          )
          .all(...src.params) as TimeseriesPoint[])
      : (db
          .prep(
            // node:sqlite binds JS numbers as REAL: without the CASTs this was float division and nothing was bucketed
            // (a 30-day chart sent all 8,640 sweeps).
            `SELECT (started_at / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS t,
                    CAST(ROUND(AVG(players_online)) AS INTEGER) AS players, MAX(players_online) AS players_peak,
                    CAST(ROUND(AVG(players_online_raw)) AS INTEGER) AS players_raw,
                    CAST(ROUND(AVG(servers_online)) AS INTEGER) AS servers_online, CAST(ROUND(AVG(groups_online)) AS INTEGER) AS groups_online
             FROM (${src.sql}) GROUP BY started_at / CAST(? AS INTEGER) ORDER BY t`,
          )
          .all(bucketSec, bucketSec, ...src.params, bucketSec) as TimeseriesPoint[]);
  return { scope: scopeKey(scope), hours, bucketSec, points };
}
type TimeseriesPoint = {
  t: number;
  players: number;
  players_peak: number;
  players_raw: number;
  servers_online: number;
  groups_online: number;
};

/** Ranking is estimated on at most this many evenly spaced sweeps of the range (scanning every ping of a 30-day range would take seconds). */
const TOP_SERVERS_SAMPLE = 48;
export const TOP_SERVERS_LIMIT = 5;

type TopServersPoint = { t: number; values: (number | null)[] };

/**
 * Players online on the busiest servers of a range (de-duplicated groups, identified by their representative).
 * Ranking: sum of dedup players over a sample of sweeps, so a server that peaked in one sweep does not outrank one that
 * is busy all day. Series: MAX over the pings of every hostname seen in that group during the sample (dedup semantics),
 * null where the group did not answer (or was not pinged: partial sweeps). Raw ranges read those pings sweep by sweep;
 * bucketed ranges read server_hours, where a multi-hostname group is the busiest member's hourly mean (exact for
 * single-hostname groups, and duplicates report the same count within DEDUP_TOLERANCE_PCT anyway).
 * A group whose representative changed mid-range is split across identities; that is accepted instead of regrouping
 * history.
 */
export function topServers(db: Db, scope: Scope, hours: number, limit = TOP_SERVERS_LIMIT) {
  const { since, bucketSec } = rangeWindow(db, hours);
  const src = sweepSource(scope, since);
  const sweeps = db.prep(`SELECT id, started_at FROM (${src.sql}) ORDER BY started_at`).all(...src.params) as { id: number; started_at: number }[];
  const empty = { scope: scopeKey(scope), hours, bucketSec, servers: [] as TopServer[], points: [] as TopServersPoint[] };
  if (!sweeps.length) return empty;

  // Sweeps whose raw pings were dropped by RETENTION_DAYS cannot vote.
  const firstWithPings = (db.prep('SELECT MIN(sweep_id) AS id FROM pings').get() as { id: number | null }).id ?? Infinity;
  const voters = sweeps.filter((w) => w.id >= firstWithPings);
  const step = Math.max(1, Math.ceil(voters.length / TOP_SERVERS_SAMPLE));
  const sample = voters.filter((_, i) => i % step === 0).map((w) => w.id);
  if (!sample.length) return empty;
  const marks = sample.map(() => '?').join(', ');
  const sf = scopeFilter(scope);
  const top = db
    .prep(
      // MATERIALIZED + members of the winners only: a correlated subquery per group re-scanned the whole sample once per
      // group (~3,500 groups), which took 50-90 s on the production machine. Empty servers cannot score, and the join
      // is only needed for a country filter (3x cheaper without both).
      `WITH ok AS MATERIALIZED (
         SELECT p.sweep_id, p.server_id, COALESCE(p.group_rep, p.server_id) AS grp, p.players_online
         FROM pings p${sf.sql ? ' JOIN servers s ON s.id = p.server_id' : ''}
         WHERE p.sweep_id IN (${marks}) AND p.ok = 1 AND p.players_online > 0${sf.sql}
       ),
       dedup AS (SELECT sweep_id, grp, MAX(players_online) AS players FROM ok GROUP BY sweep_id, grp),
       top AS (SELECT grp, SUM(players) AS score FROM dedup GROUP BY grp ORDER BY score DESC, grp LIMIT ?)
       SELECT t.grp, t.score, (SELECT json_group_array(DISTINCT server_id) FROM ok o WHERE o.grp = t.grp) AS members
       FROM top t ORDER BY t.score DESC, t.grp`,
    )
    .all(...sample, ...sf.params, limit) as { grp: number; score: number; members: string }[];
  if (!top.length) return empty;

  const servers: TopServer[] = top.map((r, rank) => {
    const s = db.getServer(r.grp);
    const host = s?.host ?? `#${r.grp}`;
    const port = s?.port ?? 25565;
    return { id: r.grp, host, port, address: formatAddress(host, port), country: s ? serverCountry(s) : null, rank };
  });
  const members: [number, number][] = [];
  top.forEach((r, i) => {
    for (const id of new Set([r.grp, ...parseJsonArray(r.members).map(Number)])) members.push([i, id]);
  });
  // One point per sweep, or the mean of each series inside a bucket (like `timeseries`; a series averages only the sweeps it answered).
  const buckets = new Map<number, { sum: number[]; samples: number[] }>();
  const bucketOf = (t: number) => {
    let b = buckets.get(t);
    if (!b) buckets.set(t, (b = { sum: new Array<number>(top.length).fill(0), samples: new Array<number>(top.length).fill(0) }));
    return b;
  };
  for (const w of sweeps) bucketOf(bucketSec === 0 ? w.started_at : Math.floor(w.started_at / bucketSec) * bucketSec);
  const valuesCte = `m(idx, server_id) AS (VALUES ${members.map(() => '(?, ?)').join(', ')})`;
  if (bucketSec === 0) {
    const rows = db
      .prep(
        // CROSS JOIN pins the order sweeps -> members -> one (sweep_id, server_id) seek; left to itself the planner read
        // every ping of each sweep and filtered on the members afterwards (400x slower).
        `WITH ${valuesCte}, w AS (SELECT id FROM sweeps WHERE started_at >= ?)
         SELECT p.sweep_id, m.idx, MAX(p.players_online) AS players
         FROM w CROSS JOIN m CROSS JOIN pings p
         WHERE p.sweep_id = w.id AND p.server_id = m.server_id AND p.ok = 1
         GROUP BY p.sweep_id, m.idx`,
      )
      .all(...members.flat(), since) as { sweep_id: number; idx: number; players: number | null }[];
    const startOf = new Map(sweeps.map((w) => [w.id, w.started_at]));
    for (const r of rows) {
      const t = startOf.get(r.sweep_id);
      if (t == null || r.players == null) continue;
      const b = bucketOf(t);
      b.sum[r.idx]! += r.players;
      b.samples[r.idx]!++;
    }
  } else {
    // Per group and hour: the busiest member's mean, weighted by its answered pings.
    const hourly = new Map<string, { idx: number; hour: number; mean: number; n: number }>();
    for (const r of hourlyRows(db, members.map(([, id]) => id), since)) {
      if (!r.players_n) continue;
      for (const [idx, id] of members) {
        if (id !== r.server_id) continue;
        const key = `${idx}:${r.hour}`;
        const mean = r.players_sum / r.players_n;
        const cur = hourly.get(key);
        if (!cur || mean > cur.mean) hourly.set(key, { idx, hour: r.hour, mean, n: Math.max(r.players_n, cur?.n ?? 0) });
        else cur.n = Math.max(cur.n, r.players_n);
      }
    }
    for (const h of hourly.values()) {
      const b = bucketOf(Math.floor(h.hour / bucketSec) * bucketSec);
      b.sum[h.idx]! += h.mean * h.n;
      b.samples[h.idx]! += h.n;
    }
  }
  const points: TopServersPoint[] = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, b]) => ({
    t,
    values: b.sum.map((v, i) => (b.samples[i]! ? Math.round(v / b.samples[i]!) : null)),
  }));
  return { scope: scopeKey(scope), hours, bucketSec, servers, points };
}
type TopServer = { id: number; host: string; port: number; address: string; country: string | null; rank: number };

type HourRow = {
  server_id: number;
  hour: number;
  pings: number;
  ok: number;
  players_sum: number;
  players_n: number;
  players_max: number | null;
  latency_sum: number;
  latency_n: number;
};

/**
 * Hourly aggregates of these servers since `since` (from the start of that hour): server_hours for the hours already
 * rolled up, the same aggregate over raw pings for the rest (sweeps of the last hour or two, or everything while the
 * startup backfill runs). Keyed by the hour the sweep started, like the rollup.
 */
function hourlyRows(db: Db, serverIds: number[], since: number): HourRow[] {
  if (!serverIds.length) return [];
  const sinceHour = Math.floor(since / 3600) * 3600;
  const through = db.rollupThrough();
  const ids = [...new Set(serverIds)];
  const marks = ids.map(() => '?').join(', ');
  const rolled =
    through == null
      ? []
      : (db
          .prep(`SELECT * FROM server_hours WHERE server_id IN (${marks}) AND hour >= ? AND hour <= ? ORDER BY server_id, hour`)
          .all(...ids, sinceHour, through) as HourRow[]);
  const tail = db
    .prep(
      `WITH m(server_id) AS (VALUES ${ids.map(() => '(?)').join(', ')})
       SELECT p.server_id, (w.started_at / 3600) * 3600 AS hour, COUNT(*) AS pings, SUM(p.ok) AS ok,
              COALESCE(SUM(CASE WHEN p.ok = 1 THEN p.players_online END), 0) AS players_sum, COUNT(CASE WHEN p.ok = 1 THEN p.players_online END) AS players_n,
              MAX(CASE WHEN p.ok = 1 THEN p.players_online END) AS players_max,
              COALESCE(SUM(CASE WHEN p.ok = 1 THEN p.latency_ms END), 0) AS latency_sum, COUNT(CASE WHEN p.ok = 1 THEN p.latency_ms END) AS latency_n
       FROM sweeps w CROSS JOIN m CROSS JOIN pings p
       WHERE w.started_at >= ? AND p.sweep_id = w.id AND p.server_id = m.server_id
       GROUP BY p.server_id, hour`,
    )
    .all(...ids, Math.max(sinceHour, through == null ? 0 : through + 3600)) as HourRow[];
  return rolled.concat(tail);
}

/** Average / max players per (UTC weekday, UTC hour); the client shifts the buckets into its own timezone. */
export function profile(db: Db, scope: Scope, days: number) {
  const since = days > 0 ? nowSec() - days * 86400 : 0;
  const src = sweepSource(scope, since);
  const points = db
    .prep(
      `SELECT CAST(strftime('%w', started_at, 'unixepoch') AS INTEGER) AS weekday, (started_at % 86400) / 3600 AS hour,
              AVG(players_online) AS avg_players, MAX(players_online) AS max_players, COUNT(*) AS samples
       FROM (${src.sql}) GROUP BY weekday, hour ORDER BY weekday, hour`,
    )
    .all(...src.params);
  return { scope: scopeKey(scope), days, points };
}

// ---- breakdowns (distinct servers online in the latest sweep) ------------------

/** WHERE fragment: online, de-duplicated (one row per group) and in scope. */
function onlineDistinct(scope: Scope): { sql: string; params: string[] } {
  const sf = scopeFilter(scope);
  return { sql: `s.last_ok = 1 AND s.group_reason IS NULL${sf.sql}`, params: sf.params };
}

export function versions(db: Db, scope: Scope) {
  const w = onlineDistinct(scope);
  const byProtocol = (
    db
      .prep(
        `SELECT last_protocol AS protocol, COUNT(*) AS servers, SUM(COALESCE(last_players_online, 0)) AS players
         FROM servers s WHERE ${w.sql} GROUP BY last_protocol ORDER BY servers DESC`,
      )
      .all(...w.params) as { protocol: number | null; servers: number; players: number }[]
  ).map((r) => ({ ...r, label: protocolLabel(r.protocol), family: protocolFamily(r.protocol) }));

  const families = new Map<string, { family: string; servers: number; players: number }>();
  for (const r of byProtocol) {
    const key = r.family ?? (r.protocol == null ? 'unknown' : `protocol ${r.protocol}`);
    const f = families.get(key) ?? { family: key, servers: 0, players: 0 };
    f.servers += r.servers;
    f.players += r.players;
    families.set(key, f);
  }
  const byFamily = [...families.values()].sort((a, b) => b.servers - a.servers);

  const byName = db
    .prep(
      `SELECT last_version_name AS name, last_protocol AS protocol, COUNT(*) AS servers, SUM(COALESCE(last_players_online, 0)) AS players
       FROM servers s WHERE ${w.sql} GROUP BY last_version_name, last_protocol ORDER BY servers DESC LIMIT 25`,
    )
    .all(...w.params);
  return { scope: scopeKey(scope), byProtocol, byFamily, byName };
}

export function software(db: Db, scope: Scope) {
  const w = onlineDistinct(scope);
  const rows = db
    .prep(
      `SELECT COALESCE(last_software, 'unknown') AS software, COUNT(*) AS servers, SUM(COALESCE(last_players_online, 0)) AS players
       FROM servers s WHERE ${w.sql} GROUP BY last_software ORDER BY servers DESC`,
    )
    .all(...w.params);
  const flags = db
    .prep(
      `SELECT SUM(CASE WHEN mod_count IS NOT NULL THEN 1 ELSE 0 END) AS modded,
              SUM(CASE WHEN enforces_secure_chat = 1 THEN 1 ELSE 0 END) AS enforces_secure_chat,
              SUM(CASE WHEN prevents_chat_reports = 1 THEN 1 ELSE 0 END) AS prevents_chat_reports,
              SUM(CASE WHEN last_method = 'legacy' THEN 1 ELSE 0 END) AS legacy_protocol,
              SUM(CASE WHEN srv_target IS NOT NULL THEN 1 ELSE 0 END) AS uses_srv,
              SUM(CASE WHEN favicon_hash IS NOT NULL THEN 1 ELSE 0 END) AS has_favicon,
              SUM(CASE WHEN last_software IN ('Velocity', 'BungeeCord', 'Waterfall', 'FlameCord', 'Gate') THEN 1 ELSE 0 END) AS proxies,
              COUNT(*) AS online
       FROM servers s WHERE ${w.sql}`,
    )
    .get(...w.params);
  return { scope: scopeKey(scope), rows, flags };
}

type CountryRow = { country: string | null; servers: number; online: number; groups_online: number; players: number };

/** Per-country totals of the current state, plus the same totals summed per region (regions with nothing tracked are omitted). */
export function countries(db: Db) {
  const rows = db
    .prep(
      `SELECT ${COUNTRY_EXPR} AS country,
              COUNT(*) AS servers,
              SUM(CASE WHEN last_ok = 1 THEN 1 ELSE 0 END) AS online,
              COUNT(DISTINCT CASE WHEN last_ok = 1 THEN COALESCE(group_rep, id) END) AS groups_online,
              SUM(CASE WHEN last_ok = 1 AND group_reason IS NULL THEN COALESCE(last_players_online, 0) ELSE 0 END) AS players
       FROM servers s GROUP BY 1 ORDER BY players DESC, servers DESC`,
    )
    .all() as CountryRow[];
  const byCountry = new Map(rows.filter((r) => r.country).map((r) => [r.country!, r]));
  const regions = REGIONS.map((region) => {
    const sum = { code: region.code, label: region.label, countries: [] as string[], servers: 0, online: 0, groups_online: 0, players: 0 };
    for (const c of region.countries) {
      const r = byCountry.get(c);
      if (!r) continue;
      sum.countries.push(c);
      sum.servers += r.servers;
      sum.online += r.online;
      sum.groups_online += r.groups_online;
      sum.players += r.players;
    }
    return sum;
  })
    .filter((r) => r.servers > 0)
    .sort((a, b) => b.players - a.players || b.servers - a.servers);
  return { rows, regions };
}

export function probes(db: Db, scope: Scope) {
  const w = onlineDistinct(scope);
  const rows = (
    db
      .prep(
        `SELECT p.protocol_sent AS protocol, COUNT(*) AS probed, SUM(p.ok) AS responded, SUM(COALESCE(p.supported, 0)) AS supported
         FROM servers s JOIN probe_latest p ON p.server_id = s.id
         WHERE ${w.sql} GROUP BY p.protocol_sent ORDER BY p.protocol_sent`,
      )
      .all(...w.params) as { protocol: number; probed: number; responded: number; supported: number }[]
  ).map((r) => ({ ...r, label: protocolLabel(r.protocol), pct: r.responded ? Math.round((1000 * r.supported) / r.responded) / 10 : null }));
  const lastRun = db.prep('SELECT MAX(ts) AS ts, COUNT(DISTINCT server_id) AS servers FROM probe_latest').get() as { ts: number | null; servers: number };
  return { scope: scopeKey(scope), rows, lastRun };
}

// ---- servers list ------------------------------------------------------------

export interface ServerListParams {
  q?: string;
  scope?: Scope;
  status?: 'online' | 'offline' | 'all';
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

const SORTS: Record<string, string> = {
  players: 'last_players_online',
  peak: 'peak_players',
  host: 'host',
  latency: 'last_latency_ms',
  uptime: '(CAST(ok_pings AS REAL) / NULLIF(total_pings, 0))',
};

/**
 * One row per distinct server (aliases merged into another server are hidden) unless `q` is set, in which case
 * aliases are listed too so a search for a known hostname always finds it (the row then carries `group_rep_host`).
 */
export function listServers(db: Db, p: ServerListParams) {
  const where: string[] = ['1 = 1'];
  const params: (string | number)[] = [];
  const q = (p.q ?? '').trim();
  if (q) {
    where.push('(host LIKE ? OR last_motd LIKE ? OR last_version_name LIKE ? OR resolved_ip LIKE ?)');
    const like = `%${q.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like);
  } else {
    where.push('group_reason IS NULL');
  }
  if (p.scope) {
    const sf = scopeFilter(p.scope);
    if (sf.sql) {
      where.push(sf.sql.replace(/^ AND /, ''));
      params.push(...sf.params);
    }
  }
  switch (p.status) {
    case 'online':
      where.push('last_ok = 1');
      break;
    case 'offline':
      where.push('(last_ok IS NOT 1 AND first_online_at IS NOT NULL)');
      break;
    default:
      break;
  }
  const sortCol = SORTS[p.sort ?? 'players'] ?? 'last_players_online';
  const dir = p.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 100);
  const page = Math.max(p.page ?? 1, 1);
  const whereSql = where.join(' AND ');
  const from = 'FROM servers s LEFT JOIN blocked_servers b ON b.server_id = s.id';
  const total = (db.prep(`SELECT COUNT(*) AS n ${from} WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const rows = db
    .prep(
      `SELECT s.id, s.host, s.port, ${COUNTRY_EXPR} AS country, s.last_ok, s.last_online_at, s.first_online_at, s.last_players_online, s.last_players_max, s.peak_players,
              s.last_version_name, s.last_protocol, s.last_software, s.last_latency_ms, s.ok_pings, s.total_pings, substr(s.last_motd, 1, 160) AS motd,
              s.favicon_hash IS NOT NULL AS has_favicon, s.group_size, s.group_reason,
              (SELECT host FROM servers r WHERE r.id = s.group_rep) AS group_rep_host,
              b.server_id IS NOT NULL AS blocked
       ${from} WHERE ${whereSql} ORDER BY ${sortCol} ${dir} NULLS LAST, s.id ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, (page - 1) * limit) as (Record<string, unknown> & { host: string; port: number; last_protocol: number | null; has_favicon: number; blocked: number })[];
  return {
    total,
    page,
    limit,
    rows: rows.map((r) => ({
      ...r,
      address: formatAddress(r.host, r.port),
      protocol_label: protocolLabel(r.last_protocol),
      has_favicon: r.has_favicon === 1,
      blocked: r.blocked === 1,
    })),
  };
}

// ---- server page ---------------------------------------------------------------

type MemberRow = {
  id: number;
  host: string;
  port: number;
  players: number | null;
  players_max: number | null;
  reason: MergeReason | null;
  resolved_ip: string | null;
  resolved_port: number | null;
  srv_target: string | null;
  favicon_hash: string | null;
  motd: string | null;
  version_name: string | null;
  country: string | null;
  endpoints_json: string | null;
  dns_targets_json: string | null;
};

type HistoryPoint = {
  t: number;
  ok: number;
  players: number | null;
  players_peak: number | null;
  latency: number | null;
  samples: number;
};

export function serverPage(db: Db, host: string, port: number, hours = 168) {
  const server = db.getServerByAddress(host, port);
  if (!server) return null;
  const id = server.id;
  const since = nowSec() - hours * 3600;
  const bucketSec = bucketSeconds(hours);
  let history: HistoryPoint[];
  let stats: { pings: number; ok: number; avg_players: number | null; max_players: number | null; avg_latency: number | null };
  if (bucketSec === 0) {
    // Ping by ping: one (sweep_id, server_id) seek per sweep of the window (pings has no per-server index).
    const inWindow = `sweep_id IN (SELECT id FROM sweeps WHERE started_at >= ?) AND server_id = ? AND ts >= ?`;
    const params = [since - 3600, id, since];
    history = db
      .prep(
        `SELECT ts AS t, ok, CASE WHEN ok = 1 THEN players_online END AS players, CASE WHEN ok = 1 THEN players_online END AS players_peak,
                CASE WHEN ok = 1 THEN latency_ms END AS latency, 1 AS samples
         FROM pings WHERE ${inWindow} ORDER BY ts`,
      )
      .all(...params) as HistoryPoint[];
    stats = db
      .prep(
        `SELECT COUNT(*) AS pings, COALESCE(SUM(ok), 0) AS ok, AVG(CASE WHEN ok = 1 THEN players_online END) AS avg_players, MAX(players_online) AS max_players,
                AVG(CASE WHEN ok = 1 THEN latency_ms END) AS avg_latency
         FROM pings WHERE ${inWindow}`,
      )
      .get(...params) as typeof stats;
  } else {
    const rows = hourlyRows(db, [id], since);
    const buckets = new Map<number, HourRow[]>();
    for (const r of rows) {
      const t = Math.floor(r.hour / bucketSec) * bucketSec;
      const b = buckets.get(t);
      if (b) b.push(r);
      else buckets.set(t, [r]);
    }
    history = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, rs]) => {
        const sum = sumHours(rs);
        return {
          t,
          ok: sum.ok > 0 ? 1 : 0,
          players: sum.players_n ? Math.round(sum.players_sum / sum.players_n) : null,
          players_peak: sum.players_max,
          latency: sum.latency_n ? Math.round(sum.latency_sum / sum.latency_n) : null,
          samples: sum.pings,
        };
      });
    const all = sumHours(rows);
    stats = {
      pings: all.pings,
      ok: all.ok,
      avg_players: all.players_n ? all.players_sum / all.players_n : null,
      max_players: all.players_max,
      avg_latency: all.latency_n ? all.latency_sum / all.latency_n : null,
    };
  }
  const probesLatest = (
    db
      .prep(
        `WITH latest AS (SELECT protocol_sent, MAX(id) AS id FROM version_probes WHERE server_id = ? GROUP BY protocol_sent)
         SELECT p.protocol_sent, p.ok, p.protocol_received, p.version_name, p.supported, p.latency_ms, p.error, p.ts
         FROM latest l JOIN version_probes p ON p.id = l.id ORDER BY p.protocol_sent`,
      )
      .all(id) as { protocol_sent: number; protocol_received: number | null; supported: number | null }[]
  ).map((r) => ({ ...r, label_sent: protocolLabel(r.protocol_sent), label_received: protocolLabel(r.protocol_received), supported: r.supported === 1 }));
  const snapshots = (
    db
      .prep(
        `SELECT id, hash, first_seen, last_seen, seen_count, version_name, protocol, software, players_max, motd, mod_kind, mod_count, mods_json,
                enforces_secure_chat, previews_chat, prevents_chat_reports, extra_keys
         FROM status_snapshots WHERE server_id = ? ORDER BY last_seen DESC LIMIT 30`,
      )
      .all(id) as (Record<string, unknown> & { id: number; last_seen: number; seen_count: number; mods_json: string | null })[]
  )
    .map(({ mods_json, ...r }) =>
      // The current snapshot's latest sightings are still counted on the servers row (see servers.snapshot_pending).
      r.id === server.last_snapshot_id
        ? { ...r, seen_count: r.seen_count + server.snapshot_pending, last_seen: Math.max(r.last_seen, server.last_online_at ?? 0), mods: mods_json ? parseJsonArray(mods_json) : null }
        : { ...r, mods: mods_json ? parseJsonArray(mods_json) : null },
    )
    .sort((a, b) => b.last_seen - a.last_seen);

  // MOTD as the server sent it (for colour rendering): the snapshot behind the last status, else the newest one.
  const rawRow =
    (server.last_snapshot_id != null
      ? db.prep('SELECT raw_json FROM status_snapshots WHERE id = ?').get(server.last_snapshot_id)
      : server.last_status_hash
        ? db.prep('SELECT raw_json FROM status_snapshots WHERE server_id = ? AND hash = ?').get(id, server.last_status_hash)
        : undefined) ?? db.prep('SELECT raw_json FROM status_snapshots WHERE server_id = ? ORDER BY last_seen DESC LIMIT 1').get(id);
  const motdRaw = descriptionFromRaw((rawRow as { raw_json: string } | undefined)?.raw_json);

  const blocked = db.prep('SELECT pattern, via, first_seen, last_seen FROM blocked_servers WHERE server_id = ?').get(id) as
    | { pattern: string; via: string; first_seen: number; last_seen: number }
    | undefined;

  // Duplicate group of the latest sweep (only meaningful while the server is online: group_rep is cleared otherwise).
  const repId = server.last_ok === 1 ? (server.group_rep ?? server.id) : server.id;
  const memberRows = db
    .prep(
      `SELECT s.id, s.host, s.port, s.last_players_online AS players, s.last_players_max AS players_max, s.group_reason AS reason,
              s.resolved_ip, s.resolved_port, s.srv_target, s.favicon_hash, s.last_motd AS motd, s.last_version_name AS version_name,
              ${COUNTRY_EXPR} AS country, s.endpoints_json, s.dns_targets_json
       FROM servers s WHERE s.last_ok = 1 AND (s.group_rep = ? OR s.id = ?) ORDER BY s.group_reason IS NULL DESC, s.host`,
    )
    .all(repId, repId) as MemberRow[];
  const repRow = memberRows.find((m) => m.id === repId) ?? null;
  const repServer = repRow ? null : (db.getServer(repId) ?? server);
  const rep = { id: repId, host: repRow?.host ?? repServer!.host, port: repRow?.port ?? repServer!.port };
  const repInput = repRow ? memberInput(repRow) : null;
  const members = memberRows.map((m) => {
    const input = memberInput(m);
    const evidence =
      m.id === repId || !repInput
        ? null
        : {
            shared_endpoints: input.endpoints.filter((e) => repInput.endpoints.includes(e)),
            shared_dns_targets: input.dnsTargets.filter((d) => repInput.dnsTargets.includes(d)),
            same_favicon: m.favicon_hash != null && m.favicon_hash === repRow!.favicon_hash,
            same_motd: input.motd != null && input.motd === repInput.motd,
            same_domain: registrableDomain(m.host) != null && registrableDomain(m.host) === registrableDomain(repRow!.host),
            players_delta_pct: playersDeltaPct(m.players, repRow!.players),
            players_agree: playersAgree({ players: m.players }, { players: repRow!.players }, config.dedupTolerancePct),
          };
    return {
      id: m.id,
      host: m.host,
      port: m.port,
      address: formatAddress(m.host, m.port),
      players: m.players,
      players_max: m.players_max,
      reason: m.reason,
      is_representative: m.id === repId,
      endpoint: m.resolved_ip ? `${m.resolved_ip}:${m.resolved_port ?? 25565}` : null,
      srv_target: m.srv_target,
      endpoints: input.endpoints,
      dns_targets: input.dnsTargets,
      favicon_hash8: m.favicon_hash ? m.favicon_hash.slice(0, 8) : null,
      has_favicon: m.favicon_hash != null,
      motd: (m.motd ?? '').replace(/\s+/g, ' ').trim(),
      version_name: m.version_name,
      country: m.country,
      evidence,
    };
  });
  const playersRaw = members.reduce((a, m) => a + (m.players ?? 0), 0);
  const playersCounted = members.length ? Math.max(...members.map((m) => m.players ?? 0)) : 0;

  const neighbors = server.resolved_ip
    ? (
        db
          .prep(
            `SELECT id, host, port, last_ok, last_players_online, substr(last_motd, 1, 120) AS motd, group_rep
             FROM servers WHERE resolved_ip = ? AND resolved_port = ? AND id != ? ORDER BY last_ok DESC, last_players_online DESC NULLS LAST LIMIT 40`,
          )
          .all(server.resolved_ip, server.resolved_port ?? 25565, id) as { id: number; host: string; port: number; last_ok: number | null; last_players_online: number | null; motd: string | null; group_rep: number | null }[]
      ).map(({ group_rep, motd, ...n }) => ({
        ...n,
        address: formatAddress(n.host, n.port),
        motd: (motd ?? '').replace(/\s+/g, ' ').trim(),
        in_group: n.last_ok === 1 && (group_rep ?? n.id) === repId,
      }))
    : [];

  const { last_sample_json, endpoints_json, dns_targets_json, notes: _n, last_snapshot_id: _s, snapshot_pending: _p, ...pub } = server;
  return {
    server: {
      ...pub,
      address: formatAddress(server.host, server.port),
      // `country` is the effective one everywhere in the API; the raw GeoIP country stays available for the hosting location.
      country: serverCountry(server),
      geo_country: server.country,
      protocol_label: protocolLabel(server.last_protocol),
      has_favicon: server.favicon_hash != null,
      last_sample: parseSample(last_sample_json),
      endpoints: parseEndpoints(endpoints_json),
      dns_targets: parseJsonArray(dns_targets_json),
      is_proxy: server.last_software != null && isProxy(server.last_software as Software),
      uptime_pct: server.total_pings > 0 ? Math.round((1000 * server.ok_pings) / server.total_pings) / 10 : null,
      motd_raw: motdRaw,
    },
    blocked: blocked ?? null,
    hours,
    bucketSec,
    stats,
    history,
    probes: probesLatest,
    snapshots,
    group: {
      rep: { ...rep, address: formatAddress(rep.host, rep.port) },
      is_representative: repId === server.id,
      tolerance_pct: config.dedupTolerancePct,
      players_counted: playersCounted,
      players_raw: playersRaw,
      members,
    },
    neighbors,
  };
}

function sumHours(rows: HourRow[]): Omit<HourRow, 'server_id' | 'hour'> {
  const out = { pings: 0, ok: 0, players_sum: 0, players_n: 0, players_max: null as number | null, latency_sum: 0, latency_n: 0 };
  for (const r of rows) {
    out.pings += r.pings;
    out.ok += r.ok;
    out.players_sum += r.players_sum;
    out.players_n += r.players_n;
    out.latency_sum += r.latency_sum;
    out.latency_n += r.latency_n;
    if (r.players_max != null && (out.players_max == null || r.players_max > out.players_max)) out.players_max = r.players_max;
  }
  return out;
}

function memberInput(m: MemberRow): { endpoints: string[]; dnsTargets: string[]; motd: string | null } {
  let endpoints = parseEndpoints(m.endpoints_json);
  if (!endpoints.length && m.resolved_ip) endpoints = [`${m.resolved_ip}:${m.resolved_port ?? 25565}`];
  return { endpoints, dnsTargets: parseJsonArray(m.dns_targets_json), motd: normalizeMotd(m.motd) };
}

function playersDeltaPct(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  const hi = Math.max(a, b);
  if (hi === 0) return 0;
  return Math.round((1000 * Math.abs(a - b)) / hi) / 10;
}

/**
 * The `description` component of a stored status payload, for the colour renderer. Modern pings store the whole
 * status object; legacy pings store {"legacy": "§1\0<proto>\0<version>\0<motd>\0<online>\0<max>"}.
 */
export function descriptionFromRaw(rawJson: string | undefined): unknown {
  if (!rawJson) return null;
  try {
    const raw = JSON.parse(rawJson) as Record<string, unknown>;
    if (raw && typeof raw === 'object') {
      if (typeof raw.legacy === 'string') return raw.legacy.split('\0')[3] ?? null;
      return raw.description ?? null;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function parseSample(json: string | null): { name: string; id: string | null }[] {
  try {
    const arr = json ? (JSON.parse(json) as { name?: unknown; id?: unknown }[]) : [];
    return Array.isArray(arr) ? arr.map((p) => ({ name: String(p.name ?? ''), id: typeof p.id === 'string' ? p.id : null })) : [];
  } catch {
    return [];
  }
}
function parseEndpoints(json: string | null): string[] {
  try {
    return json ? Object.keys(JSON.parse(json) as Record<string, number>).sort() : [];
  } catch {
    return [];
  }
}
function parseJsonArray(json: string | null): string[] {
  try {
    const v = json ? (JSON.parse(json) as unknown) : [];
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Duplicate groups of the latest sweep, most players removed first (CLI `groups`).
 * Only groups with 2+ members are listed; `summary` covers everything online.
 */
export function groups(db: Db, scope: Scope, opts: { q?: string; limit?: number; reason?: string }) {
  const sweep = db.prep('SELECT id, started_at FROM sweeps WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() as { id: number; started_at: number } | undefined;
  if (!sweep) return { sweep: null, summary: null, total: 0, groups: [] };
  const members = db
    .prep(
      `SELECT p.server_id AS id, s.host, s.port, p.players_online AS players, p.group_rep AS rep, p.group_reason AS reason,
              s.resolved_ip, s.resolved_port, s.srv_target, s.favicon_hash, substr(s.last_motd, 1, 120) AS motd, s.last_players_max AS players_max,
              s.last_version_name AS version_name, s.endpoints_json, s.dns_targets_json, ${COUNTRY_EXPR} AS country
       FROM pings p JOIN servers s ON s.id = p.server_id
       WHERE p.sweep_id = ? AND p.ok = 1 AND p.group_rep IN (SELECT group_rep FROM pings WHERE sweep_id = ? AND ok = 1 GROUP BY group_rep HAVING COUNT(*) > 1)
       ORDER BY p.group_rep, p.group_reason IS NULL DESC, s.host`,
    )
    .all(sweep.id, sweep.id) as {
    id: number;
    host: string;
    port: number;
    players: number | null;
    rep: number;
    reason: string | null;
    resolved_ip: string | null;
    resolved_port: number | null;
    srv_target: string | null;
    favicon_hash: string | null;
    motd: string | null;
    players_max: number | null;
    version_name: string | null;
    endpoints_json: string | null;
    dns_targets_json: string | null;
    country: string | null;
  }[];
  const byRep = new Map<number, typeof members>();
  for (const m of members) {
    const g = byRep.get(m.rep);
    if (g) g.push(m);
    else byRep.set(m.rep, [m]);
  }
  const q = opts.q?.toLowerCase();
  const out = [...byRep.entries()]
    .map(([rep, ms]) => {
      const raw = ms.reduce((a, m) => a + (m.players ?? 0), 0);
      const counted = Math.max(...ms.map((m) => m.players ?? 0));
      const repRow = ms.find((m) => m.id === rep) ?? ms[0]!;
      return {
        rep,
        host: repRow.host,
        port: repRow.port,
        countries: [...new Set(ms.map((m) => m.country).filter(Boolean))] as string[],
        size: ms.length,
        players_counted: counted,
        players_raw: raw,
        players_removed: raw - counted,
        reasons: [...new Set(ms.map((m) => m.reason).filter(Boolean))] as string[],
        members: ms.map((m) => ({
          id: m.id,
          host: m.host,
          port: m.port,
          players: m.players,
          reason: m.reason,
          endpoint: m.resolved_ip ? `${m.resolved_ip}:${m.resolved_port ?? 25565}` : null,
          srv_target: m.srv_target,
          favicon_hash: m.favicon_hash ? m.favicon_hash.slice(0, 8) : null,
          has_favicon: m.favicon_hash != null,
          motd: (m.motd ?? '').replace(/\s+/g, ' ').trim(),
          players_max: m.players_max,
          version_name: m.version_name,
          endpoints: parseEndpoints(m.endpoints_json),
          dns_targets: parseJsonArray(m.dns_targets_json),
          country: m.country,
        })),
      };
    })
    .filter((g) => {
      const codes = scopeCountries(scope);
      return codes ? g.countries.some((c) => codes.includes(c)) : true;
    })
    .filter((g) => !opts.reason || g.reasons.includes(opts.reason))
    .filter((g) => !q || g.members.some((m) => m.host.includes(q) || (m.endpoint ?? '').includes(q) || m.motd.toLowerCase().includes(q)))
    .sort((a, b) => b.players_removed - a.players_removed || b.players_counted - a.players_counted || b.size - a.size);
  const src = sweepSource(scope, 0);
  const sw = db.prep(`SELECT servers_online, groups_online, players_online, players_online_raw FROM (${src.sql}) WHERE id = ?`).get(...src.params, sweep.id) as
    | { servers_online: number; groups_online: number; players_online: number; players_online_raw: number }
    | undefined;
  const sf = scopeFilter(scope);
  const reasonCounts = db
    .prep(`SELECT p.group_reason AS reason, COUNT(*) AS n FROM pings p JOIN servers s ON s.id = p.server_id WHERE p.sweep_id = ? AND p.ok = 1 AND p.group_reason IS NOT NULL${sf.sql} GROUP BY p.group_reason`)
    .all(sweep.id, ...sf.params) as { reason: string; n: number }[];
  return {
    sweep,
    summary: {
      servers_online: sw?.servers_online ?? 0,
      groups_online: sw?.groups_online ?? 0,
      players: sw?.players_online ?? 0,
      players_raw: sw?.players_online_raw ?? 0,
      groups_with_duplicates: out.length,
      reasons: Object.fromEntries(reasonCounts.map((r) => [r.reason, r.n])),
      tolerance_pct: config.dedupTolerancePct,
    },
    total: out.length,
    groups: out.slice(0, opts.limit ?? 200),
  };
}


export type ServerPage = NonNullable<ReturnType<typeof serverPage>>;
export type PublicServer = Omit<ServerRow, 'last_sample_json' | 'endpoints_json' | 'dns_targets_json' | 'notes' | 'last_snapshot_id' | 'snapshot_pending'>;
