import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { serverCountry } from '../src/server/api/queries.js';
import { Db } from '../src/server/db.js';

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-')), 'census.db');
}

function seed(db: Db): number {
  const ts = 1_700_000_000;
  const ins = db.prep('INSERT INTO servers(host, port, added_at, country, tld_country, last_ok, last_players_online) VALUES (?, 25565, ?, ?, ?, 1, ?)');
  ins.run('sharkcraft.com.br', ts, 'US', 'BR', 40); // id 1: Brazilian community on a US host
  ins.run('jogarbrasilcraft.com', ts, 'US', null, 70); // id 2: same, generic TLD
  ins.run('play.example.com', ts, 'DE', null, 5); // id 3
  const sweepId = db.startSweep(3, 3);
  const ping = db.prep('INSERT INTO pings(sweep_id, server_id, ts, ok, players_online, players_max) VALUES (?, ?, ?, 1, ?, 100)');
  ping.run(sweepId, 1, ts, 40);
  ping.run(sweepId, 2, ts, 70);
  ping.run(sweepId, 3, ts, 5);
  db.finishSweep(sweepId, 100, {});
  return sweepId;
}

const perCountry = (db: Db, sweepId: number) =>
  Object.fromEntries((db.prep('SELECT country, players_online FROM sweep_countries WHERE sweep_id = ?').all(sweepId) as { country: string; players_online: number }[]).map((r) => [r.country, r.players_online]));

test('country: the ccTLD beats GeoIP, the operator override beats both, and overrides re-aggregate history', () => {
  const db = new Db(tempFile());
  const sweepId = seed(db);
  assert.equal(serverCountry(db.getServer(1)!), 'BR');
  assert.equal(serverCountry(db.getServer(2)!), 'US');
  assert.deepEqual(perCountry(db, sweepId), { BR: 40, US: 70, DE: 5 });
  assert.equal((db.prep('SELECT players_online_br AS n FROM sweeps WHERE id = ?').get(sweepId) as { n: number }).n, 40);

  assert.equal(db.setCountryOverride(2, 'BR'), true);
  assert.equal(db.setCountryOverride(999, 'BR'), false);
  assert.equal(serverCountry(db.getServer(2)!), 'BR');
  assert.equal(db.reaggregateSweeps(), 1);
  assert.deepEqual(perCountry(db, sweepId), { BR: 110, DE: 5 });
  assert.equal((db.prep('SELECT players_online_br AS n FROM sweeps WHERE id = ?').get(sweepId) as { n: number }).n, 110);

  db.setCountryOverride(2, null);
  db.reaggregateSweeps();
  assert.deepEqual(perCountry(db, sweepId), { BR: 40, US: 70, DE: 5 });
  db.close();
});

test('country: a database from an older build gets country_override added, merge_* dropped and its sweeps re-aggregated', () => {
  const file = tempFile();
  const db = new Db(file);
  const sweepId = seed(db);
  // Rewind to the previous schema and rule: no override column, the old merge columns, totals computed GeoIP-first.
  db.db.exec('ALTER TABLE servers DROP COLUMN country_override');
  db.db.exec('ALTER TABLE servers ADD COLUMN merge_with INTEGER');
  db.db.exec('ALTER TABLE servers ADD COLUMN merge_never INTEGER NOT NULL DEFAULT 0');
  db.db.exec("DELETE FROM sweep_countries; UPDATE sweeps SET players_online_br = 0; DELETE FROM meta WHERE key = 'country_rule'");
  db.close();

  const reopened = new Db(file);
  const cols = (reopened.db.prepare('PRAGMA table_info(servers)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('country_override'));
  assert.ok(!cols.includes('merge_with') && !cols.includes('merge_never'));
  assert.deepEqual(perCountry(reopened, sweepId), { BR: 40, US: 70, DE: 5 });
  assert.equal((reopened.prep('SELECT players_online_br AS n FROM sweeps WHERE id = ?').get(sweepId) as { n: number }).n, 40);
  assert.equal(reopened.getMeta('country_rule'), '2');
  reopened.close();
});
