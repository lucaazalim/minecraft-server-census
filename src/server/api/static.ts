/**
 * Serves the built dashboard (dist/web) from memory. The whole directory is read once at startup, so request
 * handling is a map lookup: no filesystem access, hence no path-traversal surface, and gzip is computed once.
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { logger } from '../log.js';

const log = logger('static');

interface StaticFile {
  body: Buffer;
  gz: Buffer | null;
  type: string;
}

export interface StaticSite {
  files: Map<string, StaticFile>;
  /** Missing entirely when the site was not built. */
  index: StaticFile | null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt', '.webmanifest', '.map']);

/** Client-side routes of the SPA: these paths get index.html; anything else that is not a file is a 404. */
const SPA_PREFIXES = ['/server/'];

const NOT_BUILT = Buffer.from(
  '<!doctype html><meta charset="utf-8"><title>Minecraft Server Census</title><body style="font-family:system-ui;padding:2rem"><h1>Site not built</h1><p>Run <code>npm run build</code> to build the dashboard, then restart.</p></body>',
);

export function loadStaticDir(dir: string): StaticSite {
  const files = new Map<string, StaticFile>();
  const walk = (abs: string, rel: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, entry.name);
      const r = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(a, r);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const body = fs.readFileSync(a);
        files.set(r, {
          body,
          gz: COMPRESSIBLE.has(ext) && body.length > 512 ? zlib.gzipSync(body, { level: 9 }) : null,
          type: TYPES[ext] ?? 'application/octet-stream',
        });
      }
    }
  };
  try {
    walk(dir, '');
  } catch (err) {
    log.warn(`cannot read ${dir}: ${(err as Error).message}; serving a "site not built" page`);
  }
  const index = files.get('/index.html') ?? null;
  if (!index) log.warn(`${dir}/index.html missing; run "npm run build" (serving a "site not built" page)`);
  else {
    let bytes = 0;
    for (const f of files.values()) bytes += f.body.length;
    log.info(`loaded ${files.size} files (${Math.round(bytes / 1024)} KB) from ${dir}`);
  }
  return { files, index };
}

/**
 * Reload the site whenever the build directory changes (debounced), so `npm run build:web` is picked up by a running
 * process without a restart. Returns a stop function. A missing directory is watched via its parent until it appears.
 */
export function watchStaticDir(dir: string, onReload: (site: StaticSite) => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  const reload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onReload(loadStaticDir(dir));
    }, 300);
  };
  const start = () => {
    try {
      if (fs.existsSync(dir)) {
        watcher = fs.watch(dir, { recursive: true }, reload);
      } else {
        // Wait for the directory to be created (first `npm run build:web`), then watch it properly.
        watcher = fs.watch(path.dirname(dir), (_, name) => {
          if (name === path.basename(dir) && fs.existsSync(dir)) {
            watcher?.close();
            start();
            reload();
          }
        });
      }
      watcher.on('error', (err) => log.warn(`watcher error: ${(err as Error).message}`));
    } catch (err) {
      log.warn(`cannot watch ${dir} for rebuilds: ${(err as Error).message}`);
    }
  };
  start();
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

/** Resolve a request path to a file; the SPA index answers the client-side routes (hostnames contain dots, so no extension sniffing). */
export function lookup(site: StaticSite, pathname: string): { file: StaticFile; key: string } | null {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (p.includes('..') || p.includes('\0') || p.includes('\\')) return null;
  if (p === '/' || p === '') p = '/index.html';
  const hit = site.files.get(p);
  if (hit) return { file: hit, key: p };
  if (site.index && SPA_PREFIXES.some((prefix) => p.startsWith(prefix))) return { file: site.index, key: '/index.html' };
  return null;
}

/** Answer a GET/HEAD for a static file. Returns false when nothing matched (caller sends its own 404). */
export function serveStatic(site: StaticSite, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!site.index) {
    if (url.pathname !== '/' && !SPA_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return false;
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': NOT_BUILT.length });
    res.end(method === 'HEAD' ? undefined : NOT_BUILT);
    return true;
  }
  const hit = lookup(site, url.pathname);
  if (!hit) return false;
  const immutable = hit.key.startsWith('/assets/');
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  const body = acceptsGzip && hit.file.gz ? hit.file.gz : hit.file.body;
  const headers: http.OutgoingHttpHeaders = {
    'content-type': hit.file.type,
    'content-length': body.length,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    vary: 'accept-encoding',
  };
  if (body !== hit.file.body) headers['content-encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(method === 'HEAD' ? undefined : body);
  return true;
}
