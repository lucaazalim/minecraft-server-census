import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/server/db.js';
import { nowSec } from '../src/server/util.js';

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-'));
  return new Db(path.join(dir, 'census.db'));
}

const DAY = 86_400;

/** Five servers: one live, one dead-for-a-day, one dead-but-fresh, one dead-but-barely-pinged, one never pinged. */
function seed(db: Db) {
  const now = nowSec();
  const ins = db.prep('INSERT INTO servers(host, port, source, added_at, first_online_at, last_online_at, total_pings, ok_pings) VALUES (?, 25565, ?, ?, ?, ?, ?, ?)');
  ins.run('live.example.com', 'seed:test', now - 2 * DAY, now - DAY, now, 40, 38); // id 1
  ins.run('dead-old.example.com', 'list:test', now - 2 * DAY, null, null, 20, 0); // id 2: prunable
  ins.run('dead-new.example.com', 'list:test', now - 3600, null, null, 5, 0); // id 3: enough pings, too young
  ins.run('dead-few.example.com', 'list:test', now - 2 * DAY, null, null, 2, 0); // id 4: old, too few pings
  ins.run('unpinged.example.com', 'list:test', now - 2 * DAY, null, null, 0, 0); // id 5
  const sweepId = db.startSweep(5, 5);
  const ping = db.prep('INSERT INTO pings(sweep_id, server_id, ts, ok, error_code) VALUES (?, ?, ?, ?, ?)');
  ping.run(sweepId, 1, now, 1, null);
  for (let i = 0; i < 3; i++) ping.run(sweepId, 2, now - i, 0, 'TIMEOUT');
  ping.run(sweepId, 3, now, 0, 'DNS');
  ping.run(sweepId, 999, now, 0, 'TIMEOUT'); // orphan left by a sweep racing an earlier delete
  db.finishSweep(sweepId, 100, {});
  return sweepId;
}

test('prune: deletes never-online servers past the age + ping thresholds, deny-lists them, keeps the rest', () => {
  const db = tempDb();
  seed(db);
  const r = db.pruneServers({ ipHosts: true, neverOnlineMinPings: 3, neverOnlineMinAgeSec: DAY, deny: true });
  assert.equal(r.servers, 1);
  assert.equal(r.denied, 1);
  assert.equal(r.pings, 4, '3 pings of the pruned server + 1 orphan');
  const hosts = (db.prep('SELECT host FROM servers ORDER BY id').all() as { host: string }[]).map((h) => h.host);
  assert.deepEqual(hosts, ['live.example.com', 'dead-new.example.com', 'dead-few.example.com', 'unpinged.example.com']);
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM pings WHERE server_id NOT IN (SELECT id FROM servers)').get() as { n: number }).n, 0, 'no orphan pings remain');
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM sweeps').get() as { n: number }).n, 1, 'sweep history untouched');
});

test('prune: pruned addresses are not re-added by seeds until `add` lifts the deny entry', () => {
  const db = tempDb();
  seed(db);
  db.pruneServers({ ipHosts: true, neverOnlineMinPings: 3, neverOnlineMinAgeSec: DAY, deny: true });
  assert.equal(db.addServer('dead-old.example.com', 25565, 'list:test'), false);
  const denied = db.prep('SELECT reason FROM denied_servers WHERE host = ?').get('dead-old.example.com') as { reason: string };
  assert.match(denied.reason, /^prune: never online after 20 pings/);
  assert.equal(db.allowServer('dead-old.example.com', 25565), true);
  assert.equal(db.addServer('dead-old.example.com', 25565, 'manual'), true);
});

test('prune: --no-deny leaves the deny list alone; min-age 0 restores the ping-only rule', () => {
  const db = tempDb();
  seed(db);
  const r = db.pruneServers({ ipHosts: true, neverOnlineMinPings: 3, neverOnlineMinAgeSec: 0, deny: false });
  assert.equal(r.servers, 2, 'dead-old + dead-new');
  assert.equal(r.denied, 0);
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM denied_servers').get() as { n: number }).n, 0);
  assert.equal(db.addServer('dead-old.example.com', 25565, 'list:test'), true);
});

test('prune: candidates honour the thresholds; spared ids survive and are woken for the next sweep', () => {
  const db = tempDb();
  seed(db);
  db.prep('UPDATE servers SET next_ping_at = ?, consecutive_failures = 30 WHERE id = 2').run(nowSec() + 6 * 3600);
  const all = db.pruneCandidates({ neverOnlineMinPings: 1, neverOnlineMinAgeSec: 0 }).map((c) => c.host);
  assert.deepEqual(all, ['dead-old.example.com', 'dead-new.example.com', 'dead-few.example.com']);
  const aged = db.pruneCandidates({ neverOnlineMinPings: 3, neverOnlineMinAgeSec: DAY }).map((c) => c.id);
  assert.deepEqual(aged, [2]);
  db.wakeServers([2]);
  const candidates = db.pruneCandidates({ neverOnlineMinPings: 3, neverOnlineMinAgeSec: DAY });
  // A server that only became eligible after the candidates were taken (first failed ping during a re-check) is not touched.
  db.prep('UPDATE servers SET total_pings = 3, added_at = added_at - ? WHERE id = 3').run(2 * DAY);
  const r = db.pruneServers({ ipHosts: true, neverOnlineMinPings: 3, neverOnlineMinAgeSec: DAY, deny: true, candidates, spare: new Set([2]) });
  assert.equal(r.servers, 0);
  assert.equal(r.denied, 0);
  const row = db.prep('SELECT next_ping_at, consecutive_failures FROM servers WHERE id = 2').get() as { next_ping_at: number; consecutive_failures: number };
  assert.deepEqual({ ...row }, { next_ping_at: 0, consecutive_failures: 0 });
});
