import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/server/db.js';

function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-'));
  return new Db(path.join(dir, 'census.db'));
}

const SHARED_PLAYER = '069a79f4-44e9-4726-a5be-fca90e38aaf5|Notch';

/** One finished sweep with plain-SQL ping rows (recordPing needs a full PingSuccess; the aggregate only reads pings + servers). */
function seed(db: Db) {
  const ts = 1_700_000_000;
  const ins = db.prep('INSERT INTO servers(host, port, added_at, country, tld_country, last_ok, last_players_online) VALUES (?, 25565, ?, ?, ?, 1, ?)');
  ins.run('mush.com.br', ts, 'BR', 'BR', 1000); // id 1
  ins.run('jogar.mush.com.br', ts, 'BR', 'BR', 990); // id 2: alias of 1
  ins.run('play.example.com', ts, 'US', null, 50); // id 3
  ins.run('mystery.example', ts, null, null, 7); // id 4: no country at all
  ins.run('geo-pending.com.br', ts, null, 'BR', 12); // id 5: no GeoIP yet, .br TLD
  const sweepId = db.startSweep(5, 5);
  const ping = db.prep('INSERT INTO pings(sweep_id, server_id, ts, ok, players_online, players_max, sample_uuids) VALUES (?, ?, ?, 1, ?, 100, ?)');
  // The alias shares a sampled player with mush.com.br, so the "sample" rule merges them (no endpoints/favicons needed).
  ping.run(sweepId, 1, ts, 1000, SHARED_PLAYER);
  ping.run(sweepId, 2, ts, 990, SHARED_PLAYER);
  ping.run(sweepId, 3, ts, 50, null);
  ping.run(sweepId, 4, ts, 7, null);
  ping.run(sweepId, 5, ts, 12, null);
  db.finishSweep(sweepId, 1234, {});
  return sweepId;
}

test('sweep_countries: per-country totals with de-duplicated players, attributed to every member country', () => {
  const db = tempDb();
  const sweepId = seed(db);
  const rows = (db.prep('SELECT * FROM sweep_countries WHERE sweep_id = ? ORDER BY country').all(sweepId) as Record<string, number | string>[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { sweep_id: sweepId, country: 'BR', servers_online: 3, groups_online: 2, players_online: 1012, players_online_raw: 2002 },
    { sweep_id: sweepId, country: 'US', servers_online: 1, groups_online: 1, players_online: 50, players_online_raw: 50 },
  ]);
  // BR row == legacy *_br columns of the sweep (same predicate: COUNTRY_SQL = 'BR')
  const sw = db.prep('SELECT players_online, players_online_raw, players_online_br, players_online_br_raw, servers_online_br, groups_online_br, servers_online, groups_online FROM sweeps WHERE id = ?').get(sweepId) as Record<string, number>;
  assert.equal(sw.players_online_br, 1012);
  assert.equal(sw.players_online_br_raw, 2002);
  assert.equal(sw.servers_online_br, 3);
  assert.equal(sw.groups_online_br, 2);
  // global totals: the unknown-country host still counts
  assert.equal(sw.players_online, 1000 + 50 + 7 + 12);
  assert.equal(sw.players_online_raw, 2059);
  assert.equal(sw.servers_online, 5);
  assert.equal(sw.groups_online, 4);
  assert.equal(db.getMeta('sweep_countries_through'), String(sweepId));
  db.close();
});

test('sweep_countries: backfill on open is idempotent and regroup rewrites rows', () => {
  const db = tempDb();
  const sweepId = seed(db);
  db.db.exec('DELETE FROM sweep_countries');
  db.setMeta('sweep_countries_through', '0');
  const file = db.file;
  db.close();
  const reopened = new Db(file);
  assert.equal(reopened.prep('SELECT COUNT(*) AS n FROM sweep_countries').get()!.n, 2);
  assert.equal(reopened.getMeta('sweep_countries_through'), String(sweepId));
  // Break the shared-sample link and regroup: BR now has 2 hostnames counted separately.
  reopened.prep('UPDATE pings SET sample_uuids = NULL WHERE server_id = 2').run();
  reopened.groupSweep(sweepId);
  const br = reopened.prep('SELECT * FROM sweep_countries WHERE sweep_id = ? AND country = ?').get(sweepId, 'BR') as Record<string, number>;
  assert.equal(br.groups_online, 3);
  assert.equal(br.players_online, 2002);
  reopened.close();
});
