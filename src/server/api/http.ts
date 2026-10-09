/**
 * Read-only JSON API + the built dashboard. There are no write endpoints: operators add servers and adjust
 * de-duplication from the CLI (see cli.ts).
 *
 * Only /api/health and favicons are answered here; every other /api route runs on the API reader thread (routes.ts,
 * reader.ts) behind a per-sweep response cache (cache.ts), so the event loop that drives the sweep never waits on a
 * dashboard query.
 */
import http from 'node:http';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { logger } from '../log.js';
import { state } from '../state.js';
import { nowSec } from '../util.js';
import { apiCache, type CachedReply } from './cache.js';
import { ApiReader } from './reader-client.js';
import { loadStaticDir, serveStatic, watchStaticDir, type StaticSite } from './static.js';

const log = logger('http');

/**
 * What the dashboard requests on first load (scope=all, range=24h, servers table defaults), in the exact query order
 * the client builds (src/web/lib/api.ts, use-dashboard-params.ts, ServersTable.tsx). Recomputed after every sweep and
 * probe run so the first viewer after a quiet period is answered from cache instead of waiting for every query.
 */
export const PREWARM_PATHS = [
  '/api/timeseries?scope=all&hours=24',
  '/api/top-servers?scope=all&hours=24',
  '/api/profile?scope=all&days=1',
  '/api/versions?scope=all',
  '/api/software?scope=all',
  '/api/probes?scope=all',
  '/api/countries',
  '/api/servers?scope=all&status=online&sort=players&dir=desc&page=1&limit=50',
];

function json(res: http.ServerResponse, body: unknown, status = 200, cache = 'no-store'): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache });
  res.end(text);
}
function text(res: http.ServerResponse, body: string, status = 200, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

/** Main-thread routes: the health check must answer while the reader thread is busy; favicons are a primary-key read. */
function mainThreadRoute(db: Db, url: URL, res: http.ServerResponse): boolean {
  if (/^\/api\/health\/?$/.test(url.pathname)) {
    json(res, { ok: true, uptimeSec: nowSec() - state.startedAt, sweep: state.sweep, probe: state.probe });
    return true;
  }
  const fav = /^\/api\/servers\/(\d+)\/favicon\/?$/.exec(url.pathname);
  if (fav) {
    const m = db.faviconOf(Number.parseInt(fav[1]!, 10))?.match(/^data:(image\/[a-z+]+);base64,(.+)$/s);
    if (!m) {
      text(res, 'no favicon', 404);
      return true;
    }
    res.writeHead(200, { 'content-type': m[1] as string, 'cache-control': 'public, max-age=86400' });
    res.end(Buffer.from(m[2] as string, 'base64'));
    return true;
  }
  return false;
}

/** Send a reader reply: 304 when the client already has these bytes, gzip when accepted. */
export function sendReply(req: http.IncomingMessage, res: http.ServerResponse, r: CachedReply): void {
  if (r.status !== 200) {
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : r.body);
    return;
  }
  // no-cache: the browser keeps the body and revalidates every poll; an unchanged reply costs a 304 and no body.
  const headers: http.OutgoingHttpHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    etag: `"${r.etag}"`,
    vary: 'accept-encoding',
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === `"${r.etag}"`)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const gzip = r.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  const body = gzip ? r.gzip! : r.body;
  res.writeHead(200, { ...headers, ...(gzip ? { 'content-encoding': 'gzip' } : {}), 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function startHttpServer(db: Db): http.Server {
  let site: StaticSite = loadStaticDir(config.publicDir);
  const stopWatching = watchStaticDir(config.publicDir, (next) => {
    site = next;
  });
  const reader = new ApiReader(db.file);
  const compute = (key: string) => async () => {
    const r = await reader.request(key);
    return { status: r.status, body: r.body, gzip: r.gzip, etag: r.etag, store: r.cacheable };
  };
  const prewarm = () => {
    for (const key of PREWARM_PATHS) apiCache.warm(key, compute(key)).catch((err) => log.warn(`prewarm ${key} failed`, err));
  };
  const stopPrewarm = apiCache.onInvalidate(prewarm);
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      if (url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') {
          res.setHeader('allow', 'GET, HEAD');
          return json(res, { error: 'method not allowed' }, 405);
        }
        if (mainThreadRoute(db, url, res)) return;
        const key = url.pathname + url.search;
        const reply = await apiCache.get(key, compute(key));
        return sendReply(req, res, reply);
      }
      if (serveStatic(site, req, res, url)) return;
      text(res, 'not found', 404);
    } catch (err) {
      log.error(`${req.method} ${req.url} failed`, err);
      if (!res.headersSent) json(res, { error: 'internal error' }, 500);
      else res.end();
    } finally {
      const ms = Date.now() - started;
      if (ms > 2000) log.warn(`${req.method} ${req.url} took ${ms}ms`);
    }
  });
  server.keepAliveTimeout = 65_000;
  server.on('close', () => {
    stopWatching();
    stopPrewarm();
    void reader.close();
  });
  server.listen(config.httpPort, config.httpHost, () => {
    log.info(`dashboard listening on http://${config.httpHost}:${config.httpPort}`);
    prewarm();
  });
  return server;
}
