import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseScope, serverPage, timeseries, topServers } from '../src/server/api/queries.js';
import { Db } from '../src/server/db.js';

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-')), 'census.db');
}

const HOUR = 3600;
const NOW = Math.floor(Date.now() / 1000);
/** Start of the hour two days ago: every sweep below lands inside a 7-day window. */
const T0 = NOW - (NOW % HOUR) - 48 * HOUR;

/**
 * 48 hours of sweeps every 20 minutes (plus a 6-hour outage from hour 10 to 16). Servers:
 *  1 solo.example   players = hour * 10 + minute / 20, answers every sweep but the 2nd of each hour
 *  2 big.example    1000 players, merged with 3 by a shared sampled player
 *  3 alias.example  990 players
 */
function seed(db: Db): { sweeps: { id: number; ts: number }[]; expectSolo: Map<number, number[]> } {
  const ins = db.prep("INSERT INTO servers(host, port, added_at, country, last_ok) VALUES (?, 25565, 0, 'DE', 1)");
  for (const h of ['solo.example', 'big.example', 'alias.example']) ins.run(h);
  const ok = db.prep('INSERT INTO pings(sweep_id, server_id, ts, ok, players_online, latency_ms, sample_uuids) VALUES (?, ?, ?, 1, ?, ?, ?)');
  const down = db.prep('INSERT INTO pings(sweep_id, server_id, ts, ok) VALUES (?, ?, ?, 0)');
  const shared = '069a79f4-44e9-4726-a5be-fca90e38aaf5|notch';
  const sweeps: { id: number; ts: number }[] = [];
  const expectSolo = new Map<number, number[]>();
  for (let h = 0; h < 48; h++) {
    if (h >= 10 && h < 16) continue;
    for (let k = 0; k < 3; k++) {
      const ts = T0 + h * HOUR + k * 1200;
      const id = db.startSweep(3, 3);
      db.prep('UPDATE sweeps SET started_at = ? WHERE id = ?').run(ts, id);
      if (k === 1) down.run(id, 1, ts + 5);
      else {
        ok.run(id, 1, ts + 5, h * 10 + k, 50, null);
        expectSolo.set(T0 + h * HOUR, [...(expectSolo.get(T0 + h * HOUR) ?? []), h * 10 + k]);
      }
      ok.run(id, 2, ts + 5, 1000, 40, shared);
      ok.run(id, 3, ts + 5, 990, 60, shared);
      db.finishSweep(id, 1, {});
      sweeps.push({ id, ts });
    }
  }
  return { sweeps, expectSolo };
}

test('rollupHours: complete hours only, outages skipped, safe to run from two connections', () => {
  const file = tempFile();
  const db = new Db(file);
  seed(db);
  // finishSweep kept up: every hour but the last one (its sweeps could still be running) is rolled up.
  assert.equal(db.rollupThrough(), T0 + 46 * HOUR);
  const hours = (db.prep('SELECT DISTINCT hour FROM server_hours ORDER BY hour').all() as { hour: number }[]).map((r) => (r.hour - T0) / HOUR);
  assert.deepEqual(hours, [...Array(10).keys(), ...Array.from({ length: 31 }, (_, i) => 16 + i)]);
  const row = db.prep('SELECT * FROM server_hours WHERE server_id = 1 AND hour = ?').get(T0 + 5 * HOUR) as Record<string, number>;
  assert.deepEqual({ ...row }, { server_id: 1, hour: T0 + 5 * HOUR, pings: 3, ok: 2, players_sum: 50 + 52, players_n: 2, players_max: 52, latency_sum: 100, latency_n: 2 });

  // Rebuild from scratch with two connections interleaving (the backfill worker + finishSweep): same rows, no gaps.
  db.db.exec("DELETE FROM server_hours; DELETE FROM meta WHERE key = 'server_hours_through'");
  const other = new Db(file);
  for (let turn = 0; db.rollupHours(1) + other.rollupHours(2) > 0; turn++) assert.ok(turn < 100);
  assert.equal(db.rollupThrough(), T0 + 46 * HOUR);
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM server_hours').get() as { n: number }).n, 41 * 3);
  other.close();
  db.close();
});

test('serverPage: ranges past 72h come from server_hours plus the raw tail and match the ping-by-ping averages', () => {
  const db = new Db(tempFile());
  const { expectSolo } = seed(db);
  const page = serverPage(db, 'solo.example', 25565, 168)!;
  assert.equal(page.bucketSec, HOUR);
  // One point per hour with sweeps, including the last hour that only exists as raw pings.
  assert.deepEqual(
    page.history.map((p) => p.t),
    [...expectSolo.keys()],
  );
  for (const p of page.history) {
    const v = expectSolo.get(p.t)!;
    assert.deepEqual(p, { t: p.t, ok: 1, players: Math.round(v.reduce((a, b) => a + b, 0) / v.length), players_peak: Math.max(...v), latency: 50, samples: 3 });
  }
  const all = [...expectSolo.values()].flat();
  assert.equal(page.stats.pings, 42 * 3);
  assert.equal(page.stats.ok, all.length);
  assert.equal(page.stats.max_players, Math.max(...all));
  assert.equal(page.stats.avg_players, all.reduce((a, b) => a + b, 0) / all.length);
  // Ping by ping for short ranges: every ping at or after now - 24 h (the window starts mid-hour).
  const day = serverPage(db, 'solo.example', 25565, 24)!;
  const since = Math.floor(Date.now() / 1000) - 24 * HOUR;
  const inDay = (db.prep('SELECT COUNT(*) AS n FROM pings WHERE server_id = 1 AND ts >= ?').get(since) as { n: number }).n;
  assert.ok(inDay > 60);
  assert.equal(day.bucketSec, 0);
  assert.equal(day.history.length, inDay);
  assert.equal(day.stats.pings, inDay);
  db.close();
});

test('timeseries: hourly buckets really bucket (JS numbers are bound as REAL)', () => {
  const db = new Db(tempFile());
  seed(db);
  const r = timeseries(db, parseScope('all'), 168);
  assert.equal(r.bucketSec, HOUR);
  assert.equal(r.points.length, 42);
  assert.ok(r.points.every((p) => p.t % HOUR === 0));
  // big + alias are one group (1000); solo averages its answered sweeps.
  assert.equal(r.points[0]!.players, Math.round((1000 + 0 + 1000 + 1000 + 2) / 3));
  db.close();
});

test('topServers: bucketed series read server_hours and equal the per-sweep means', () => {
  const db = new Db(tempFile());
  const { expectSolo } = seed(db);
  const r = topServers(db, parseScope('all'), 168);
  assert.equal(r.bucketSec, HOUR);
  assert.deepEqual(
    r.servers.map((s) => s.host),
    ['big.example', 'solo.example'],
  );
  assert.equal(r.points.length, 42);
  for (const p of r.points) {
    const v = expectSolo.get(p.t)!;
    // The merged group: the busier hostname's hourly mean (both answer every sweep).
    assert.deepEqual(p.values, [1000, Math.round(v.reduce((a, b) => a + b, 0) / v.length)]);
  }
  db.close();
});
