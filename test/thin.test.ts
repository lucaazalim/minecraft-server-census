import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/server/db.js';

test('thin: keep the first sweep of each slot, drop the others with their pings and country totals', () => {
  const db = new Db(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-')), 'census.db'));
  db.prep("INSERT INTO servers(host, port, added_at) VALUES ('a.example', 25565, 0), ('b.example', 25565, 0)").run();
  const t0 = 1_800_000_000 - (1_800_000_000 % 600); // a 10-minute boundary
  // Sweeps every 5 minutes, offset by 2 minutes, plus a restart that started one extra sweep at +23 min and one still running.
  const starts = [t0 + 120, t0 + 420, t0 + 720, t0 + 1020, t0 + 1380, t0 + 1500, t0 + 1800];
  const ids: number[] = [];
  for (const [i, ts] of starts.entries()) {
    const id = db.startSweep(2, 2);
    db.prep('UPDATE sweeps SET started_at = ? WHERE id = ?').run(ts, id);
    for (const server of [1, 2]) db.prep('INSERT INTO pings(sweep_id, server_id, ts, ok, players_online) VALUES (?, ?, ?, 1, 3)').run(id, server, ts + 5);
    db.prep("INSERT INTO sweep_countries(sweep_id, country, servers_online, groups_online, players_online, players_online_raw) VALUES (?, 'BR', 2, 2, 6, 6)").run(id);
    if (i < starts.length - 1) db.prep('UPDATE sweeps SET finished_at = ? WHERE id = ?').run(ts + 60, id);
    ids.push(id);
  }
  const count = (table: string) => (db.prep(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  // Slots: [0,600) -> 120, 420; [600,1200) -> 720, 1020; [1200,1800) -> 1380, 1500; [1800,..) -> 1800 (unfinished).
  assert.deepEqual(db.thinCandidates(t0 + 1500, 600), [ids[1], ids[3]], 'sweeps from `before` on are left alone');
  const drop = db.thinCandidates(t0 + 3600, 600);
  assert.deepEqual(drop, [ids[1], ids[3], ids[5]]);
  for (const id of drop) assert.equal(db.dropSweep(id), 2);

  assert.deepEqual((db.prep('SELECT id FROM sweeps ORDER BY id').all() as { id: number }[]).map((r) => r.id), [ids[0], ids[2], ids[4], ids[6]]);
  assert.equal(count('pings'), 8);
  assert.equal(count('sweep_countries'), 4);
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM pings WHERE sweep_id NOT IN (SELECT id FROM sweeps)').get() as { n: number }).n, 0);
  assert.deepEqual(db.thinCandidates(t0 + 3600, 600), [], 'a second run finds nothing');
  db.close();
});
