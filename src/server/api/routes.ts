/**
 * The read-only JSON routes, run by the API reader thread (reader.ts) against its own read-only connection so a slow
 * query never blocks the collector's event loop. /api/health and the favicon route stay on the main thread (http.ts).
 */
import type { Db } from '../db.js';
import { parseAddress } from '../util.js';
import * as q from './queries.js';

export interface ApiResult {
  status: number;
  body: unknown;
  /** Safe to serve from the response cache until the data changes (a sweep or probe run finishes). */
  cacheable: boolean;
}

type Handler = (db: Db, url: URL, params: Record<string, string>) => ApiResult;
interface Route {
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];
function route(pathPattern: string, handler: Handler): void {
  const keys: string[] = [];
  const src = pathPattern.replace(/:(\w+)/g, (_, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  routes.push({ pattern: new RegExp(`^${src}/?$`), keys, handler });
}

const ok = (body: unknown, cacheable = true): ApiResult => ({ status: 200, body, cacheable });
const fail = (status: number, error: string): ApiResult => ({ status, body: { error }, cacheable: false });

function intParam(url: URL, name: string, def: number, min: number, max: number): number {
  const v = url.searchParams.get(name);
  if (v == null || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}
const scopeOf = (url: URL) => q.parseScope(url.searchParams.get('scope'));

// The overview carries the live collector state (sweep progress), so it is recomputed on every request; it is cheap.
route('/api/overview', (db, url) => ok(q.overview(db, scopeOf(url)), false));
route('/api/timeseries', (db, url) => ok(q.timeseries(db, scopeOf(url), intParam(url, 'hours', 24, 0, 24 * 90))));
route('/api/top-servers', (db, url) => ok(q.topServers(db, scopeOf(url), intParam(url, 'hours', 24, 0, 24 * 90))));
route('/api/profile', (db, url) => ok(q.profile(db, scopeOf(url), intParam(url, 'days', 0, 0, 90))));
route('/api/versions', (db, url) => ok(q.versions(db, scopeOf(url))));
route('/api/software', (db, url) => ok(q.software(db, scopeOf(url))));
route('/api/countries', (db) => ok(q.countries(db)));
route('/api/probes', (db, url) => ok(q.probes(db, scopeOf(url))));

route('/api/servers', (db, url) => {
  const status = url.searchParams.get('status') ?? 'online';
  return ok(
    q.listServers(db, {
      q: url.searchParams.get('q') ?? undefined,
      scope: scopeOf(url),
      status: status === 'offline' || status === 'all' ? status : 'online',
      sort: url.searchParams.get('sort') ?? 'players',
      dir: url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc',
      page: intParam(url, 'page', 1, 1, 100000),
      limit: intParam(url, 'limit', 50, 1, 100),
    }),
  );
});

route('/api/server/:address', (db, url, params) => {
  const addr = parseAddress(params.address ?? '');
  if (!addr) return fail(400, 'invalid address');
  const d = q.serverPage(db, addr.host, addr.port, intParam(url, 'hours', 168, 1, 24 * 90));
  return d ? ok(d) : fail(404, 'not found');
});

/** Run the route for `pathAndQuery` (e.g. "/api/versions?scope=BR"); 404 when no route matches. */
export function handleApi(db: Db, pathAndQuery: string): ApiResult {
  const url = new URL(pathAndQuery, 'http://localhost');
  for (const r of routes) {
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
    return r.handler(db, url, params);
  }
  return fail(404, 'not found');
}
