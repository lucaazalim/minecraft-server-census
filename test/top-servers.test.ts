import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/server/db.js';
import { parseScope, topServers } from '../src/server/api/queries.js';

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-'));
  return new Db(path.join(dir, 'census.db'));
}

const NOW = Math.floor(Date.now() / 1000);

/**
 * Three sweeps, 5 minutes apart, ending now. Servers (ids in order):
 *  1 big.example (US)       1000 players every sweep
 *  2 alias.big.example (US) 990, merged into 1 by hand
 *  3 mush.com.br (BR)       500, 600, 700
 *  4 spiky.example (DE)     5000 in the first sweep only, then offline
 *  5..10 small-N.example    N players (in DE)
 */
function seed(db: Db) {
  const ins = db.prep('INSERT INTO servers(host, port, added_at, country, tld_country, last_ok, last_players_online) VALUES (?, 25565, ?, ?, ?, 1, ?)');
  ins.run('big.example', NOW, 'US', null, 1000);
  ins.run('alias.big.example', NOW, 'US', null, 990);
  ins.run('mush.com.br', NOW, 'BR', 'BR', 700);
  ins.run('spiky.example', NOW, 'DE', null, 0);
  for (let n = 1; n <= 6; n++) ins.run(`small-${n}.example`, NOW, 'DE', null, n);
  const ping = db.prep('INSERT INTO pings(sweep_id, server_id, ts, ok, players_online, players_max, sample_uuids) VALUES (?, ?, ?, 1, ?, 100, ?)');
  // big.example and its alias share a sampled player, so the "sample" rule folds them into one group.
  const shared = '069a79f4-44e9-4726-a5be-fca90e38aaf5|Notch';
  const down = db.prep('INSERT INTO pings(sweep_id, server_id, ts, ok) VALUES (?, ?, ?, 0)');
  const starts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const ts = NOW - (2 - i) * 300;
    starts.push(ts);
    const id = db.startSweep(10, 10);
    db.prep('UPDATE sweeps SET started_at = ? WHERE id = ?').run(ts, id);
    ping.run(id, 1, ts, 1000, shared);
    ping.run(id, 2, ts, 990, shared);
    ping.run(id, 3, ts, 500 + 100 * i, null);
    if (i === 0) ping.run(id, 4, ts, 5000, null);
    else down.run(id, 4, ts);
    for (let n = 1; n <= 6; n++) ping.run(id, 4 + n, ts, n, null);
    db.finishSweep(id, 100, {});
  }
  return starts;
}

test('topServers: top 5 by players over the range, de-duplicated, one point per sweep', () => {
  const db = tempDb();
  const starts = seed(db);
  const r = topServers(db, parseScope('all'), 24);
  assert.equal(r.bucketSec, 0);
  // Ranked by the sum over sweeps: spiky (5000) > big (3000, the alias is folded in) > mush (1800) > small-6 (18) > small-5 (15).
  assert.deepEqual(
    r.servers.map((s) => [s.host, s.rank]),
    [
      ['spiky.example', 0],
      ['big.example', 1],
      ['mush.com.br', 2],
      ['small-6.example', 3],
      ['small-5.example', 4],
    ],
  );
  assert.equal(r.servers[1]!.address, 'big.example');
  assert.equal(r.servers[2]!.country, 'BR');
  assert.deepEqual(
    r.points.map((p) => p.t),
    starts,
  );
  assert.deepEqual(r.points[0], { t: starts[0], values: [5000, 1000, 500, 6, 5] });
  // Sweep 3: spiky did not answer -> null (a gap), not 0.
  assert.deepEqual(r.points[2], { t: starts[2], values: [null, 1000, 700, 6, 5] });
  db.close();
});

test('topServers: scope restricts the candidates; limit caps the series', () => {
  const db = tempDb();
  seed(db);
  const r = topServers(db, parseScope('BR'), 24);
  assert.deepEqual(
    r.servers.map((s) => s.host),
    ['mush.com.br'],
  );
  assert.deepEqual(
    r.points.map((p) => p.values),
    [[500], [600], [700]],
  );
  const two = topServers(db, parseScope('DE'), 24, 2);
  assert.deepEqual(
    two.servers.map((s) => s.host),
    ['spiky.example', 'small-6.example'],
  );
  assert.deepEqual(two.points[0], { t: two.points[0]!.t, values: [5000, 6] });
  db.close();
});

test('topServers: buckets average each series like timeseries; empty scope yields no series', () => {
  const db = tempDb();
  const starts = seed(db);
  const r = topServers(db, parseScope('all'), 0); // "all history" of a 10-minute span -> raw points
  assert.equal(r.points.length, 3);
  // A 7-day window buckets hourly: the three sweeps collapse to one averaged point unless they straddle an hour boundary.
  const weekly = topServers(db, parseScope('all'), 168);
  assert.equal(weekly.bucketSec, 3600);
  if (weekly.points.length === 1) {
    // spiky = mean of the one sweep it answered; mush = mean(500, 600, 700).
    assert.deepEqual(weekly.points[0], { t: Math.floor(starts[0]! / 3600) * 3600, values: [5000, 1000, 600, 6, 5] });
  } else {
    assert.equal(weekly.points.length, 2);
    assert.ok(weekly.points.every((p) => p.t % 3600 === 0));
  }
  const none = topServers(db, parseScope('FR'), 24);
  assert.deepEqual(none.servers, []);
  assert.deepEqual(none.points, []);
  db.close();
});
