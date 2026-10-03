import { config } from '../config.js';
import { PingError, type PingErrorCode } from './errors.js';
import { legacyPing } from './legacy.js';
import { motdText } from './motd.js';
import { resolveServer, type Resolved } from './resolve.js';
import { modernPing } from './slp.js';
import { inferSoftware, latestKnownProtocol, type Software } from './versions.js';

export interface PlayerSample {
  name: string;
  id: string | null;
}

export interface ModInfo {
  /** "FML" (1.12-), "forgeData" (1.13+), or other. */
  kind: string;
  modCount: number | null;
  /** First mod ids (capped) for later analysis. */
  mods: string[];
  truncated: boolean;
}

export interface PingSuccess {
  ok: true;
  method: 'modern' | 'legacy';
  latencyMs: number;
  connectMs: number | null;
  /** Protocol sent in the handshake that produced this status (null for legacy). */
  handshakeProtocol: number | null;
  resolved: Resolved;
  versionName: string | null;
  protocol: number | null;
  playersOnline: number | null;
  playersMax: number | null;
  sample: PlayerSample[];
  motd: string;
  descriptionRaw: unknown;
  favicon: string | null;
  software: Software;
  modInfo: ModInfo | null;
  enforcesSecureChat: boolean | null;
  previewsChat: boolean | null;
  preventsChatReports: boolean | null;
  /** Top-level keys in the status JSON that we did not model (stored for later analysis). */
  extraKeys: string[];
  /** Status JSON without the favicon (favicon is stored separately). */
  rawJson: unknown;
  bytes: number;
}

export interface PingFailure {
  ok: false;
  code: PingErrorCode;
  error: string;
  connected: boolean;
  resolved: Resolved | null;
}

export type PingResult = PingSuccess | PingFailure;

export interface PingOptions {
  protocol?: number;
  timeoutMs?: number;
  /** Try the pre-1.7 ping when the modern one fails after a TCP connection. Default true. */
  legacyFallback?: boolean;
}

const KNOWN_KEYS = new Set([
  'version',
  'players',
  'description',
  'favicon',
  'modinfo',
  'forgeData',
  'enforcesSecureChat',
  'previewsChat',
  'preventsChatReports',
]);

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number.parseInt(v, 10);
  return null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function parseModInfo(raw: Record<string, unknown>): ModInfo | null {
  const cap = 60;
  const fd = raw.forgeData as Record<string, unknown> | undefined;
  if (fd && typeof fd === 'object') {
    const mods = Array.isArray(fd.mods) ? fd.mods : [];
    const ids = mods
      .map((m) => (m && typeof m === 'object' ? String((m as Record<string, unknown>).modId ?? (m as Record<string, unknown>).modid ?? '') : ''))
      .filter(Boolean);
    // 1.18+: mods may be packed into the "d" field; then the list is empty but it's still Forge.
    return { kind: 'forgeData', modCount: ids.length || (typeof fd.d === 'string' ? null : 0), mods: ids.slice(0, cap), truncated: ids.length > cap };
  }
  const mi = raw.modinfo as Record<string, unknown> | undefined;
  if (mi && typeof mi === 'object') {
    const list = Array.isArray(mi.modList) ? mi.modList : [];
    const ids = list
      .map((m) => (m && typeof m === 'object' ? String((m as Record<string, unknown>).modid ?? '') : ''))
      .filter(Boolean);
    return { kind: String(mi.type ?? 'FML'), modCount: ids.length, mods: ids.slice(0, cap), truncated: ids.length > cap };
  }
  return null;
}

function normalizeModern(json: unknown, resolved: Resolved, handshakeProtocol: number, latencyMs: number, connectMs: number, bytes: number): PingSuccess {
  const raw = (json && typeof json === 'object' && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const version = (raw.version && typeof raw.version === 'object' ? raw.version : {}) as Record<string, unknown>;
  const players = (raw.players && typeof raw.players === 'object' ? raw.players : {}) as Record<string, unknown>;
  const sampleRaw = Array.isArray(players.sample) ? players.sample : [];
  const sample: PlayerSample[] = sampleRaw
    .slice(0, 50)
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const o = s as Record<string, unknown>;
      return { name: String(o.name ?? ''), id: o.id != null ? String(o.id) : null };
    })
    .filter((s): s is PlayerSample => s !== null);

  const favicon = typeof raw.favicon === 'string' && raw.favicon.startsWith('data:image') ? raw.favicon : null;
  const { favicon: _omit, ...withoutFavicon } = raw;
  const versionName = typeof version.name === 'string' ? version.name : version.name != null ? String(version.name) : null;

  return {
    ok: true,
    method: 'modern',
    latencyMs,
    connectMs,
    handshakeProtocol,
    resolved,
    versionName,
    protocol: num(version.protocol),
    playersOnline: num(players.online),
    playersMax: num(players.max),
    sample,
    motd: motdText(raw.description).slice(0, 512),
    descriptionRaw: raw.description ?? null,
    favicon,
    software: inferSoftware(versionName, raw),
    modInfo: parseModInfo(raw),
    enforcesSecureChat: bool(raw.enforcesSecureChat),
    previewsChat: bool(raw.previewsChat),
    preventsChatReports: bool(raw.preventsChatReports),
    extraKeys: Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k)),
    rawJson: withoutFavicon,
    bytes,
  };
}

/**
 * A status with no usable player count. Servers that gate by client version (anti-VPN and "outdated client"
 * plugins, some Forge and proxy setups) answer the `-1` handshake with a placeholder such as
 * `players: {online: 0, max: 0}` that hides a real population; hosting-provider "OFFLINE" placeholders look the same.
 */
export function hidesPlayers(r: PingSuccess): boolean {
  return r.playersOnline == null || (r.playersOnline === 0 && r.playersMax === 0);
}

async function modernAttempt(resolved: Resolved, protocol: number, timeoutMs: number): Promise<PingSuccess> {
  const r = await modernPing({
    connectHost: resolved.ip,
    connectPort: resolved.port,
    handshakeHost: resolved.handshakeHost,
    handshakePort: resolved.handshakePort,
    protocol,
    timeoutMs,
  });
  return normalizeModern(r.json, resolved, protocol, r.latencyMs, r.connectMs, r.bytes);
}

/**
 * Ping with `opts.protocol` (default `config.pingProtocol`, normally -1 so the server reports its native version).
 * When the -1 handshake gets a status without a player count, the ping is repeated once with the newest known
 * protocol, as a current vanilla client would send, and that status is returned if it carries a count.
 */
export async function pingServer(host: string, port: number, opts: PingOptions = {}): Promise<PingResult> {
  const timeoutMs = opts.timeoutMs ?? config.pingTimeoutMs;
  const protocol = opts.protocol ?? config.pingProtocol;
  let resolved: Resolved;
  try {
    resolved = await resolveServer(host, port);
  } catch (err) {
    const e = err instanceof PingError ? err : new PingError('DNS', String(err));
    return { ok: false, code: e.code, error: e.message.slice(0, 200), connected: false, resolved: null };
  }

  try {
    const r = await modernAttempt(resolved, protocol, timeoutMs);
    if (protocol !== -1 || !hidesPlayers(r)) return r;
    try {
      const retry = await modernAttempt(resolved, latestKnownProtocol(), timeoutMs);
      if (!hidesPlayers(retry)) return retry;
    } catch {
      // The -1 status is still a valid answer (typically a hosting placeholder); keep it.
    }
    return r;
  } catch (err) {
    const e = err instanceof PingError ? err : new PingError('OTHER', String(err));
    const tryLegacy = (opts.legacyFallback ?? true) && e.connected && e.code !== 'TOO_LARGE';
    if (!tryLegacy) {
      return { ok: false, code: e.code, error: e.message.slice(0, 200), connected: e.connected, resolved };
    }
    try {
      const l = await legacyPing({
        connectHost: resolved.ip,
        connectPort: resolved.port,
        handshakeHost: resolved.handshakeHost,
        handshakePort: resolved.handshakePort,
        timeoutMs,
      });
      const versionName = l.versionName;
      return {
        ok: true,
        method: 'legacy',
        latencyMs: l.latencyMs,
        connectMs: null,
        handshakeProtocol: null,
        resolved,
        versionName,
        protocol: l.protocol,
        playersOnline: l.online,
        playersMax: l.max,
        sample: [],
        motd: motdText(l.motd).slice(0, 512),
        descriptionRaw: l.motd,
        favicon: null,
        software: 'Other',
        modInfo: null,
        enforcesSecureChat: null,
        previewsChat: null,
        preventsChatReports: null,
        extraKeys: [],
        rawJson: { legacy: l.raw },
        bytes: l.raw.length * 2,
      };
    } catch {
      // Report the original (modern) failure; it is the more informative one.
      return { ok: false, code: e.code, error: e.message.slice(0, 200), connected: e.connected, resolved };
    }
  }
}
