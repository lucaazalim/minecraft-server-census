import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compactIfRequested, Db } from '../src/server/db.js';

test('compact: slim old ping rows online, then VACUUM INTO + swap on the next start, keeping the old file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-')), 'census.db');
  const db = new Db(file);
  db.prep("INSERT INTO servers(host, port, added_at) VALUES ('a.example', 25565, 0)").run();
  db.prep("INSERT INTO status_snapshots(server_id, hash, first_seen, last_seen, motd) VALUES (1, 'h1', 0, 0, 'hello')").run();
  // Rows in the layout written before snapshot_id existed, plus a big table that is dropped to leave free pages.
  const sweepId = db.startSweep(1, 1);
  const old = db.prep("INSERT INTO pings(sweep_id, server_id, ts, ok, players_online, version_name, status_hash) VALUES (?, 1, ?, 1, 5, 'Paper 1.21.4', ?)");
  db.transaction(() => {
    for (let i = 0; i < 3000; i++) old.run(sweepId, i, i % 2 ? 'h1' : 'gone');
  });
  db.db.exec("CREATE TABLE filler(x); WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 20000) INSERT INTO filler SELECT randomblob(200) FROM c; DROP TABLE filler;");
  db.finishSweep(sweepId, 1, {});

  // Part 1, in chunks and resumable.
  assert.equal(db.slimPings(0, 1000), 1000);
  assert.equal(db.getMeta('slim_pings_through'), '1000');
  assert.equal(db.slimPings(1000, 3000), 2000);
  assert.equal(db.slimPings(0, 3000), 0, 'nothing left to rewrite');
  const rows = db.prep('SELECT COUNT(*) AS n, COUNT(status_hash) AS hashes, COUNT(version_name) AS versions, COUNT(snapshot_id) AS linked FROM pings').get() as Record<string, number>;
  assert.deepEqual({ ...rows }, { n: 3000, hashes: 0, versions: 0, linked: 1500 }, 'rows whose snapshot is gone keep a NULL link');

  // Part 2 only runs when requested.
  db.close();
  assert.equal(compactIfRequested(file), null);
  const again = new Db(file);
  again.requestCompaction();
  again.close();
  const r = compactIfRequested(file)!;
  assert.ok(r.after < r.before * 0.6, `${r.before} -> ${r.after}`);
  assert.equal(fs.statSync(file).size, r.after);
  assert.equal(fs.statSync(r.backup).size, r.before);
  assert.ok(!fs.existsSync(`${file}.compact`));
  assert.equal(compactIfRequested(file), null, 'one run per request');

  const reopened = new Db(file);
  assert.equal((reopened.prep('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal((reopened.prep('SELECT COUNT(*) AS n FROM pings').get() as { n: number }).n, 3000);
  assert.equal((reopened.prep('SELECT players_online FROM sweeps WHERE id = ?').get(sweepId) as { players_online: number }).players_online, 5);
  assert.equal(reopened.getMeta('compact_on_start'), null);
  reopened.close();
});
