import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { ResponseCache, type CachedReply } from '../src/server/api/cache.js';
import { sendReply } from '../src/server/api/http.js';
import { ApiReader } from '../src/server/api/reader-client.js';
import { Db } from '../src/server/db.js';

const reply = (text: string, status = 200): CachedReply => ({ status, body: new TextEncoder().encode(text), gzip: null, etag: text });

test('ResponseCache: one compute per data version, stale-while-revalidate for one version, LRU by bytes', async () => {
  const cache = new ResponseCache(1000);
  let calls = 0;
  const compute = (text: string, store = true) => async () => {
    calls++;
    return { ...reply(text), store };
  };
  assert.equal((await cache.get('/a', compute('a1'))).etag, 'a1');
  assert.equal((await cache.get('/a', compute('a2'))).etag, 'a1', 'same version: cached');
  assert.equal(calls, 1);

  // Concurrent misses share one compute.
  const [x, y] = await Promise.all([cache.get('/b', compute('b1')), cache.get('/b', compute('b2'))]);
  assert.equal(x.etag, 'b1');
  assert.equal(y.etag, 'b1');
  assert.equal(calls, 2);

  // One version behind: the old reply now, the new one computed in the background for the next caller.
  cache.invalidate();
  assert.equal((await cache.get('/a', compute('a3'))).etag, 'a1');
  await new Promise((r) => setImmediate(r));
  assert.equal((await cache.get('/a', compute('a4'))).etag, 'a3');
  // Two versions behind: recomputed before answering.
  cache.invalidate();
  cache.invalidate();
  assert.equal((await cache.get('/a', compute('a5'))).etag, 'a5');

  // Uncacheable replies (the overview) and errors pass through.
  assert.equal((await cache.get('/o', compute('o1', false))).etag, 'o1');
  assert.equal((await cache.get('/o', compute('o2', false))).etag, 'o2');
  assert.equal((await cache.get('/e', async () => ({ ...reply('e1', 404), store: true }))).etag, 'e1');
  assert.equal((await cache.get('/e', async () => ({ ...reply('e2', 404), store: true }))).etag, 'e2');

  // Over the byte budget: least recently used entries go first.
  const big = 'x'.repeat(400);
  await cache.get('/big1', compute(big));
  await cache.get('/a', compute('a6')); // touch /a
  await cache.get('/big2', compute(big));
  await cache.get('/big3', compute(big));
  assert.ok(cache.size.bytes <= 1000);
  const before = calls;
  await cache.get('/a', compute('a7'));
  assert.equal(calls, before, '/a survived: recently used');
  await cache.get('/big1', compute(big));
  assert.equal(calls, before + 1, '/big1 was evicted');
});

function fakeRes() {
  const res = new EventEmitter() as http.ServerResponse & { status: number; headers: Record<string, unknown>; body: Uint8Array | undefined };
  (res as unknown as { writeHead: unknown }).writeHead = (status: number, headers: Record<string, unknown>) => {
    res.status = status;
    res.headers = headers ?? {};
    return res;
  };
  (res as unknown as { end: unknown }).end = (body?: Uint8Array) => {
    res.body = body;
    return res;
  };
  return res;
}
const fakeReq = (headers: Record<string, string> = {}, method = 'GET') => ({ method, headers }) as unknown as http.IncomingMessage;

test('sendReply: ETag revalidation (weak tags too) and gzip negotiation', () => {
  const text = JSON.stringify({ points: 'y'.repeat(2000) });
  const body = new TextEncoder().encode(text);
  const r: CachedReply = { status: 200, body, gzip: new Uint8Array(zlib.gzipSync(body)), etag: 'abc' };

  let res = fakeRes();
  sendReply(fakeReq({ 'accept-encoding': 'gzip, br' }), res, r);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers.etag, '"abc"');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(zlib.gunzipSync(res.body!).toString(), text);

  res = fakeRes();
  sendReply(fakeReq(), res, r);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(Buffer.from(res.body!).toString(), text);

  for (const inm of ['"abc"', 'W/"abc"', '"zzz", W/"abc"']) {
    res = fakeRes();
    sendReply(fakeReq({ 'if-none-match': inm }), res, r);
    assert.equal(res.status, 304, inm);
    assert.equal(res.body, undefined);
  }
  res = fakeRes();
  sendReply(fakeReq({ 'if-none-match': '"old"' }), res, r);
  assert.equal(res.status, 200);

  res = fakeRes();
  sendReply(fakeReq(), res, { status: 404, body: new TextEncoder().encode('{"error":"not found"}'), gzip: null, etag: 'x' });
  assert.equal(res.status, 404);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.etag, undefined);
});

test('ApiReader: routes run on the reader thread over a read-only connection', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-')), 'census.db');
  const db = new Db(file);
  db.prep("INSERT INTO servers(host, port, added_at, tld_country, last_ok, last_players_online, last_protocol, last_version_name) VALUES ('a.com.br', 25565, 0, 'BR', 1, 42, 769, 'Paper 1.21.4')").run();
  const reader = new ApiReader(file);
  try {
    const r = await reader.request('/api/versions?scope=BR');
    assert.equal(r.status, 200);
    assert.equal(r.cacheable, true);
    const body = JSON.parse(new TextDecoder().decode(r.body)) as { scope: string; byName: { name: string; players: number }[] };
    assert.equal(body.scope, 'BR');
    assert.deepEqual(body.byName.map((v) => [v.name, v.players]), [['Paper 1.21.4', 42]]);
    assert.match(r.etag, /^[0-9a-f]{20}$/);

    const overview = await reader.request('/api/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.cacheable, false, 'carries live collector state');

    assert.equal((await reader.request('/api/server/nope.example')).status, 404);
    assert.equal((await reader.request('/api/server/%20')).status, 400);
    assert.equal((await reader.request('/api/nothing')).status, 404);

    // Written by the collector's connection after the reader opened: visible on the next request.
    db.prep("UPDATE servers SET last_players_online = 43 WHERE host = 'a.com.br'").run();
    const again = JSON.parse(new TextDecoder().decode((await reader.request('/api/versions?scope=BR')).body)) as { byName: { players: number }[] };
    assert.equal(again.byName[0]!.players, 43);
  } finally {
    await reader.close();
    db.close();
  }
});

test('ResponseCache: warm() recomputes stale keys once, skips current ones; onInvalidate hooks run and unsubscribe', async () => {
  const cache = new ResponseCache(10_000);
  let calls = 0;
  const compute = (text: string) => async () => {
    calls++;
    return { ...reply(text), store: true };
  };
  await cache.warm('/w', compute('w1'));
  assert.equal(calls, 1, 'missing key: computed');
  await cache.warm('/w', compute('w2'));
  assert.equal(calls, 1, 'current key: left alone');
  assert.equal((await cache.get('/w', compute('w3'))).etag, 'w1');

  let hooks = 0;
  let warming: Promise<unknown> = Promise.resolve();
  const stop = cache.onInvalidate(() => {
    hooks++;
    warming = cache.warm('/w', compute('w4'));
  });
  cache.invalidate();
  assert.equal(hooks, 1);
  await warming;
  assert.equal((await cache.get('/w', compute('w5'))).etag, 'w4', 'the hook refreshed it before the next request');
  assert.equal(calls, 2);
  stop();
  cache.invalidate();
  assert.equal(hooks, 1, 'unsubscribed');
});
