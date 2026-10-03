import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { loadStaticDir, lookup, serveStatic } from '../src/server/api/static.js';

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-static-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>' + 'a'.repeat(1000));
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1);' + '/* pad */'.repeat(100));
  fs.writeFileSync(path.join(dir, 'favicon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return loadStaticDir(dir);
}

function fakeRes() {
  const res = new EventEmitter() as http.ServerResponse & { status: number; headers: Record<string, unknown>; body: Buffer | null };
  res.status = 0;
  res.headers = {};
  res.body = null;
  (res as unknown as { writeHead: unknown }).writeHead = (status: number, headers: Record<string, unknown>) => {
    res.status = status;
    res.headers = headers;
    return res;
  };
  (res as unknown as { end: unknown }).end = (body?: Buffer) => {
    res.body = body ?? null;
    return res;
  };
  return res;
}
function serve(s: ReturnType<typeof site>, url: string, method = 'GET', headers: Record<string, string> = {}) {
  const req = { method, headers } as unknown as http.IncomingMessage;
  const res = fakeRes();
  const handled = serveStatic(s, req, res, new URL(url, 'http://localhost'));
  return { handled, res };
}

test('lookup: exact files, SPA fallback, traversal and unknown assets', () => {
  const s = site();
  assert.equal(lookup(s, '/')?.key, '/index.html');
  assert.equal(lookup(s, '/index.html')?.key, '/index.html');
  assert.equal(lookup(s, '/assets/app-abc123.js')?.key, '/assets/app-abc123.js');
  assert.equal(lookup(s, '/server/mc.mush.com.br')?.key, '/index.html'); // no extension -> SPA route
  assert.equal(lookup(s, '/server/foo')?.key, '/index.html');
  assert.equal(lookup(s, '/server/foo.js')?.key, '/index.html');
  assert.equal(lookup(s, '/wp-admin'), null); // not a SPA route
  assert.equal(lookup(s, '/etc/passwd'), null);
  assert.equal(lookup(s, '/assets/missing.js'), null);
  assert.equal(lookup(s, '/%2e%2e/etc/passwd'), null);
  assert.equal(lookup(s, '/../etc/passwd'), null);
  assert.equal(lookup(s, '/%ZZ'), null); // malformed escape
});

test('serveStatic: headers, gzip negotiation, HEAD', () => {
  const s = site();
  const a = serve(s, '/assets/app-abc123.js');
  assert.equal(a.handled, true);
  assert.equal(a.res.status, 200);
  assert.equal(a.res.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(a.res.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(a.res.headers['content-encoding'], undefined);
  assert.ok(a.res.body!.toString().startsWith('console.log(1);'));

  const g = serve(s, '/assets/app-abc123.js', 'GET', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(g.res.headers['content-encoding'], 'gzip');
  assert.equal(g.res.headers['content-length'], g.res.body!.length);
  assert.ok(zlib.gunzipSync(g.res.body!).toString().startsWith('console.log(1);'));

  const h = serve(s, '/server/foo', 'HEAD');
  assert.equal(h.res.status, 200);
  assert.equal(h.res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(h.res.headers['cache-control'], 'no-cache');
  assert.equal(h.res.body, null);

  const png = serve(s, '/favicon.png', 'GET', { 'accept-encoding': 'gzip' });
  assert.equal(png.res.headers['content-type'], 'image/png');
  assert.equal(png.res.headers['content-encoding'], undefined); // binaries are not gzipped

  assert.equal(serve(s, '/assets/missing.js').handled, false);
  assert.equal(serve(s, '/%2e%2e/%2e%2e/etc/passwd').handled, false);
  assert.equal(serve(s, '/', 'POST').handled, false);
});

test('serveStatic: unbuilt site answers 503 for page routes only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-static-empty-'));
  const s = loadStaticDir(dir);
  assert.equal(s.index, null);
  const r = serve(s, '/');
  assert.equal(r.handled, true);
  assert.equal(r.res.status, 503);
  assert.equal(serve(s, '/assets/app.js').handled, false);
});
