/** JSON shapes of the read-only API (src/server/queries.ts). Keep in sync by hand. */

export type ScopeKey = string; // 'all' | ISO 3166-1 alpha-2

export interface RuntimeState {
  startedAt: number;
  sweep: { running: boolean; sweepId: number | null; startedAt: number | null; total: number; done: number; ok: number; lastFinishedAt: number | null; lastDurationMs: number | null; nextAt: number | null };
  probe: { running: boolean; startedAt: number | null; total: number; done: number; lastFinishedAt: number | null; nextAt: number | null };
  geo: { pending: number; lastRunAt: number | null; lastError: string | null };
  blocklist: { hashes: number; fetchedAt: number | null; checkedAt: number | null; blocked: number; lastError: string | null };
}

export interface Overview {
  generatedAt: number;
  scope: ScopeKey;
  kpis: {
    players_online: number;
    players_online_raw: number;
    players_avg_24h: number | null;
    groups_online: number;
    servers_online: number;
    servers_tracked: number;
    servers_ever_online: number;
    peak: { value: number; at: number } | null;
  };
  lastSweep: { id: number; started_at: number; finished_at: number; duration_ms: number; servers_attempted: number; servers_online: number } | null;
  collector: {
    state: RuntimeState;
    config: {
      pingIntervalMinutes: number;
      probeIntervalHours: number;
      probeProtocols: number[];
      geoEnabled: boolean;
      blocklistEnabled: boolean;
      blocklistIntervalHours: number;
      dedupTolerancePct: number;
    };
    totals: { pings: number; sweeps: number; snapshots: number; probes: number; first_sweep_at: number | null; servers_total: number; geo_done: number };
    blocklist: { hashes: number; fetchedAt: number | null; checkedAt: number | null; lastError: string | null; blocked_total: number; blocked_online: number };
    sources: { source: string; servers: number; ever_online: number }[];
  };
}

export interface TimeseriesPoint {
  t: number;
  players: number;
  players_peak: number;
  players_raw: number;
  servers_online: number;
  groups_online: number;
}
export interface Timeseries {
  scope: ScopeKey;
  hours: number;
  bucketSec: number;
  points: TimeseriesPoint[];
}

export interface TopServer {
  id: number;
  host: string;
  port: number;
  address: string;
  country: string | null;
  rank: number;
}
export interface TopServersPoint {
  t: number;
  /** One entry per `servers[i]`; mean inside a bucket; null when the server was not counted (no answer / not pinged). */
  values: (number | null)[];
}
export interface TopServers {
  scope: ScopeKey;
  hours: number;
  bucketSec: number;
  servers: TopServer[];
  points: TopServersPoint[];
}

export interface ProfilePoint {
  weekday: number; // UTC, 0 = Sunday
  hour: number; // UTC
  avg_players: number;
  max_players: number;
  samples: number;
}
export interface Profile {
  scope: ScopeKey;
  days: number;
  points: ProfilePoint[];
}

export interface Versions {
  scope: ScopeKey;
  byProtocol: { protocol: number | null; servers: number; players: number; label: string; family: string | null }[];
  byFamily: { family: string; servers: number; players: number }[];
  byName: { name: string | null; protocol: number | null; servers: number; players: number }[];
}

export interface Software {
  scope: ScopeKey;
  rows: { software: string; servers: number; players: number }[];
  flags: {
    modded: number | null;
    enforces_secure_chat: number | null;
    prevents_chat_reports: number | null;
    legacy_protocol: number | null;
    uses_srv: number | null;
    has_favicon: number | null;
    proxies: number | null;
    online: number;
  };
}

export interface Countries {
  rows: { country: string | null; servers: number; online: number; groups_online: number; players: number }[];
  /** Fixed country groups (Latin America, Europe, ...) with the same totals summed; only regions with tracked servers. `countries` = member codes present. */
  regions: { code: string; label: string; countries: string[]; servers: number; online: number; groups_online: number; players: number }[];
}

export interface Probes {
  scope: ScopeKey;
  rows: { protocol: number; probed: number; responded: number; supported: number; label: string; pct: number | null }[];
  lastRun: { ts: number | null; servers: number };
}

export interface ServerListRow {
  id: number;
  host: string;
  port: number;
  address: string;
  country: string | null;
  last_ok: number | null;
  last_online_at: number | null;
  first_online_at: number | null;
  last_players_online: number | null;
  last_players_max: number | null;
  peak_players: number | null;
  last_version_name: string | null;
  last_protocol: number | null;
  protocol_label: string;
  last_software: string | null;
  last_latency_ms: number | null;
  ok_pings: number;
  total_pings: number;
  motd: string | null;
  has_favicon: boolean;
  group_size: number | null;
  group_reason: MergeReason | null;
  group_rep_host: string | null;
  blocked: boolean;
}
export interface ServerList {
  total: number;
  page: number;
  limit: number;
  rows: ServerListRow[];
}
export interface ServerListParams {
  q?: string;
  scope?: ScopeKey;
  status?: 'online' | 'offline' | 'all';
  sort?: 'players' | 'peak' | 'host' | 'latency' | 'uptime';
  dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export type MergeReason = 'sample' | 'endpoint' | 'dns' | 'fingerprint';

export interface ServerInfo {
  id: number;
  host: string;
  port: number;
  address: string;
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
  /** Effective country: operator override, else the hostname's ccTLD, else GeoIP. */
  country: string | null;
  /** Raw GeoIP country of resolved_ip (where the server is hosted). */
  geo_country: string | null;
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
  total_pings: number;
  ok_pings: number;
  last_method: string | null;
  last_latency_ms: number | null;
  last_players_online: number | null;
  last_players_max: number | null;
  last_version_name: string | null;
  last_protocol: number | null;
  protocol_label: string;
  last_software: string | null;
  last_motd: string | null;
  last_status_hash: string | null;
  mod_count: number | null;
  enforces_secure_chat: number | null;
  prevents_chat_reports: number | null;
  favicon_hash: string | null;
  has_favicon: boolean;
  peak_players: number | null;
  peak_at: number | null;
  group_rep: number | null;
  group_reason: MergeReason | null;
  group_size: number | null;
  last_sample: { name: string; id: string | null }[];
  endpoints: string[];
  dns_targets: string[];
  is_proxy: boolean;
  uptime_pct: number | null;
  motd_raw: unknown;
}

export interface HistoryPoint {
  t: number;
  ok: number;
  players: number | null;
  players_peak: number | null;
  latency: number | null;
  samples: number;
}

export interface ProbeRow {
  protocol_sent: number;
  label_sent: string;
  ok: number;
  protocol_received: number | null;
  label_received: string;
  version_name: string | null;
  supported: boolean;
  latency_ms: number | null;
  error: string | null;
  ts: number;
}

export interface Snapshot {
  id: number;
  hash: string;
  first_seen: number;
  last_seen: number;
  seen_count: number;
  version_name: string | null;
  protocol: number | null;
  software: string | null;
  players_max: number | null;
  motd: string | null;
  mod_kind: string | null;
  mod_count: number | null;
  mods: string[] | null;
  enforces_secure_chat: number | null;
  previews_chat: number | null;
  prevents_chat_reports: number | null;
  extra_keys: string | null;
}

export interface Evidence {
  shared_endpoints: string[];
  shared_dns_targets: string[];
  same_favicon: boolean;
  same_motd: boolean;
  same_domain: boolean;
  players_delta_pct: number | null;
  players_agree: boolean;
}

export interface GroupMember {
  id: number;
  host: string;
  port: number;
  address: string;
  players: number | null;
  players_max: number | null;
  reason: MergeReason | null;
  is_representative: boolean;
  endpoint: string | null;
  srv_target: string | null;
  endpoints: string[];
  dns_targets: string[];
  favicon_hash8: string | null;
  has_favicon: boolean;
  motd: string;
  version_name: string | null;
  country: string | null;
  evidence: Evidence | null;
}

export interface ServerPage {
  server: ServerInfo;
  blocked: { pattern: string; via: string; first_seen: number; last_seen: number } | null;
  hours: number;
  bucketSec: number;
  stats: { pings: number; ok: number; avg_players: number | null; max_players: number | null; avg_latency: number | null };
  history: HistoryPoint[];
  probes: ProbeRow[];
  snapshots: Snapshot[];
  group: {
    rep: { id: number; host: string; port: number; address: string };
    is_representative: boolean;
    tolerance_pct: number;
    players_counted: number;
    players_raw: number;
    members: GroupMember[];
  };
  neighbors: { id: number; host: string; port: number; address: string; last_ok: number | null; last_players_online: number | null; motd: string; in_group: boolean }[];
}
