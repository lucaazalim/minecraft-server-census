import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseScope, probes, serverPage } from '../src/server/api/queries.js';
import { Db, SNAPSHOT_FLUSH_PINGS, statusHash, type ServerLite } from '../src/server/db.js';
import type { PingResult, PingSuccess } from '../src/server/protocol/ping.js';

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-')), 'census.db');
}

const FAVICON = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;

function status(over: Partial<PingSuccess> = {}): PingSuccess {
  return {
    ok: true,
    method: 'modern',
    latencyMs: 40,
    connectMs: 10,
    handshakeProtocol: -1,
    resolved: { ip: '10.0.0.1', port: 25565, handshakeHost: 'a.example', handshakePort: 25565, srvTarget: null, endpoints: ['10.0.0.1:25565'], dnsTargets: [], fromCache: false },
    versionName: 'Paper 1.21.4',
    protocol: 769,
    playersOnline: 100,
    playersMax: 101,
    sample: [],
    motd: 'Example | 1403735 servers created',
    descriptionRaw: { text: 'Example | 1403735 servers created' },
    favicon: FAVICON,
    software: 'Paper',
    modInfo: null,
    enforcesSecureChat: true,
    previewsChat: null,
    preventsChatReports: null,
    extraKeys: [],
    rawJson: { version: { name: 'Paper 1.21.4', protocol: 769 }, description: { text: 'Example | 1403735 servers created' } },
    bytes: 200,
    ...over,
  };
}

function lite(db: Db, id: number): ServerLite {
  return db.prep('SELECT id, host, port, tld_country, country, consecutive_failures, first_online_at, last_online_at FROM servers WHERE id = ?').get(id) as unknown as ServerLite;
}

/** One sweep per entry in `results`, 5 minutes apart starting at `t0`, each recording one ping of server 1. */
function recordSweeps(db: Db, results: PingResult[], t0: number): number[] {
  const ids: number[] = [];
  results.forEach((r, i) => {
    const ts = t0 + i * 300;
    const sweepId = db.startSweep(1, 1);
    db.prep('UPDATE sweeps SET started_at = ? WHERE id = ?').run(ts, sweepId);
    db.transaction(() => db.recordPing(sweepId, lite(db, 1), r, ts));
    db.finishSweep(sweepId, 1, {});
    ids.push(sweepId);
  });
  return ids;
}

test('recordPing: counters in the MOTD and max = online + 1 reuse one snapshot; sightings flush every SNAPSHOT_FLUSH_PINGS pings', () => {
  const db = new Db(tempFile());
  db.addServer('a.example', 25565, 'test');
  const t0 = 1_700_000_000;
  const n = SNAPSHOT_FLUSH_PINGS + 3;
  const results = Array.from({ length: n }, (_, i) =>
    status({ playersOnline: 100 + i, playersMax: 101 + i, motd: `Example | ${1403735 + i} servers created`, descriptionRaw: { text: `Example | ${1403735 + i} servers created` } }),
  );
  recordSweeps(db, results, t0);
  const snaps = db.prep('SELECT id, seen_count, first_seen, last_seen, motd FROM status_snapshots').all() as { id: number; seen_count: number; first_seen: number; last_seen: number; motd: string }[];
  assert.equal(snaps.length, 1, 'digits and player counts are not part of the snapshot identity');
  // Inserted by ping 1, flushed at ping SNAPSHOT_FLUSH_PINGS + 1 (with the MOTD of that ping); 2 sightings still pending.
  assert.equal(snaps[0]!.seen_count, 1 + SNAPSHOT_FLUSH_PINGS);
  assert.equal(snaps[0]!.motd, `Example | ${1403735 + SNAPSHOT_FLUSH_PINGS} servers created`);
  const s = db.getServer(1)!;
  assert.equal(s.last_snapshot_id, snaps[0]!.id);
  assert.equal(s.snapshot_pending, n - 1 - SNAPSHOT_FLUSH_PINGS);
  assert.equal(s.last_motd, results.at(-1)!.motd, 'the servers row always has the exact latest MOTD');
  // The server page adds the pending sightings back.
  const page = serverPage(db, 'a.example', 25565, 24)!;
  assert.equal(page.snapshots[0]!.seen_count, n);
  assert.equal(page.snapshots[0]!.last_seen, t0 + (n - 1) * 300);
  // Narrow ping rows: the snapshot id instead of the 40-char hash and the version name.
  const ping = db.prep('SELECT status_hash, version_name, snapshot_id FROM pings ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  assert.deepEqual({ ...ping }, { status_hash: null, version_name: null, snapshot_id: snaps[0]!.id });
  db.close();
});

test('recordPing: a real payload change settles the old snapshot and starts a new one; flipping back reuses the old row', () => {
  const db = new Db(tempFile());
  db.addServer('a.example', 25565, 'test');
  const t0 = 1_700_000_000;
  const v1 = status();
  const v2 = status({ versionName: 'Paper 1.21.5', protocol: 770 });
  recordSweeps(db, [v1, v1, v1, v2, v2, v1], t0);
  const snaps = db.prep('SELECT version_name, seen_count, first_seen, last_seen FROM status_snapshots ORDER BY id').all() as Record<string, unknown>[];
  assert.deepEqual(
    snaps.map((r) => ({ ...r })),
    [
      // v1: 3 sightings settled when v2 arrived (last seen = its third ping), then +1 when it came back.
      { version_name: 'Paper 1.21.4', seen_count: 4, first_seen: t0, last_seen: t0 + 5 * 300 },
      { version_name: 'Paper 1.21.5', seen_count: 2, first_seen: t0 + 3 * 300, last_seen: t0 + 4 * 300 },
    ],
  );
  assert.equal(statusHash(v1) === statusHash(v2), false);
  db.close();
});

test('recordPing: favicons are stored once by content hash and served from the favicons table', () => {
  const db = new Db(tempFile());
  db.addServer('a.example', 25565, 'test');
  db.addServer('b.example', 25565, 'test');
  const t0 = 1_700_000_000;
  const sweepId = db.startSweep(2, 2);
  db.transaction(() => {
    db.recordPing(sweepId, lite(db, 1), status(), t0);
    db.recordPing(sweepId, lite(db, 2), status(), t0);
    db.recordPing(sweepId, lite(db, 1), status({ favicon: null }), t0 + 1); // no favicon this time: keep the last one
  });
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM favicons').get() as { n: number }).n, 1);
  assert.equal(db.faviconOf(1), FAVICON);
  assert.equal(db.faviconOf(2), FAVICON);
  assert.equal(db.faviconOf(3), null);
  db.close();
});

test('migrate: an older database gets favicons moved out, the per-server ping indexes dropped and probe_latest filled', () => {
  const file = tempFile();
  const db = new Db(file);
  db.addServer('a.example', 25565, 'test');
  const t0 = 1_700_000_000;
  recordSweeps(db, [status(), status()], t0);
  db.recordProbe(1, 47, status({ protocol: 47 }), t0);
  db.recordProbe(1, 47, { ok: false, code: 'TIMEOUT', error: 'x', connected: true, resolved: null }, t0 + 60);
  db.recordProbe(1, 769, status(), t0);
  // Rewind to the previous layout.
  db.db.exec(`
    ALTER TABLE servers ADD COLUMN favicon TEXT;
    UPDATE servers SET favicon = '${FAVICON}';
    DELETE FROM favicons;
    ALTER TABLE servers DROP COLUMN last_snapshot_id;
    ALTER TABLE servers DROP COLUMN snapshot_pending;
    CREATE INDEX idx_pings_server_ts ON pings(server_id, ts);
    CREATE INDEX idx_pings_ts ON pings(ts);
    DELETE FROM probe_latest;
    DELETE FROM meta WHERE key = 'probe_latest';
  `);
  db.close();

  const reopened = new Db(file);
  const cols = (reopened.prep('PRAGMA table_info(servers)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.includes('favicon') && cols.includes('last_snapshot_id') && cols.includes('snapshot_pending'));
  assert.equal(reopened.faviconOf(1), FAVICON);
  const indexes = (reopened.prep("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pings'").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(indexes, ['idx_pings_sweep_server']);
  const latest = (reopened.prep('SELECT protocol_sent, ok FROM probe_latest ORDER BY protocol_sent').all() as Record<string, number>[]).map((r) => ({ ...r }));
  assert.deepEqual(latest, [
    { protocol_sent: 47, ok: 0 },
    { protocol_sent: 769, ok: 1 },
  ]);
  reopened.close();
});

test('probes: the summary reads probe_latest, which recordProbes keeps current', () => {
  const db = new Db(tempFile());
  const ins = db.prep("INSERT INTO servers(host, port, added_at, tld_country, last_ok) VALUES (?, 25565, 0, 'BR', 1)");
  ins.run('a.com.br');
  ins.run('b.com.br');
  const ts = 1_700_000_000;
  db.recordProbes(1, [
    { protocol: 47, r: status({ protocol: 769 }), ts }, // answered with its native version: not supported
    { protocol: 769, r: status({ protocol: 769 }), ts },
  ]);
  db.recordProbes(2, [{ protocol: 47, r: status({ protocol: 47 }), ts }]);
  db.recordProbes(1, [{ protocol: 47, r: status({ protocol: 47 }), ts: ts + 86400 }]); // next day: 1.8 now supported
  const r = probes(db, parseScope('BR'));
  assert.deepEqual(
    r.rows.map((x) => [x.protocol, x.probed, x.responded, x.supported]),
    [
      [47, 2, 2, 2],
      [769, 1, 1, 1],
    ],
  );
  assert.deepEqual({ ...r.lastRun }, { ts: ts + 86400, servers: 2 });
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM version_probes').get() as { n: number }).n, 4, 'history is kept');
  db.close();
});

test('removeServer: finds the pings through server_hours + the not-yet-rolled-up sweeps and deletes every trace', () => {
  const db = new Db(tempFile());
  db.addServer('a.example', 25565, 'test');
  db.addServer('b.example', 25565, 'test');
  const t0 = 1_700_000_000 - (1_700_000_000 % 3600);
  // Six hours of sweeps, both servers answering; the first five hours get rolled up by finishSweep.
  for (let h = 0; h < 6; h++) {
    for (let k = 0; k < 2; k++) {
      const ts = t0 + h * 3600 + k * 300;
      const sweepId = db.startSweep(2, 2);
      db.prep('UPDATE sweeps SET started_at = ? WHERE id = ?').run(ts, sweepId);
      db.transaction(() => {
        db.recordPing(sweepId, lite(db, 1), status(), ts);
        db.recordPing(sweepId, lite(db, 2), status({ favicon: null }), ts);
      });
      db.finishSweep(sweepId, 1, {});
    }
  }
  assert.equal(db.rollupThrough(), t0 + 4 * 3600);
  const r = db.removeServer('a.example', 25565, 'test')!;
  assert.equal(r.pings, 12);
  assert.equal(r.sweepIds.length, 12);
  for (const table of ['pings', 'server_hours', 'status_snapshots', 'probe_latest']) {
    assert.equal((db.prep(`SELECT COUNT(*) AS n FROM ${table} WHERE server_id = 1`).get() as { n: number }).n, 0, table);
  }
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM favicons').get() as { n: number }).n, 0, 'the favicon only server 1 used is gone');
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM pings WHERE server_id = 2').get() as { n: number }).n, 12);
  db.close();
});

test('pruneOldPings: drops raw pings past the retention window, never hours that are not rolled up yet', () => {
  const db = new Db(tempFile());
  db.addServer('a.example', 25565, 'test');
  const now = Math.floor(Date.now() / 1000);
  const t0 = now - (now % 3600) - 3 * 86400;
  // One sweep an hour for three days.
  for (let h = 0; h < 72; h++) {
    const ts = t0 + h * 3600;
    const sweepId = db.startSweep(1, 1);
    db.prep('UPDATE sweeps SET started_at = ? WHERE id = ?').run(ts, sweepId);
    db.transaction(() => db.recordPing(sweepId, lite(db, 1), status(), ts));
    db.finishSweep(sweepId, 1, {});
  }
  const before = (db.prep('SELECT COUNT(*) AS n FROM server_hours').get() as { n: number }).n;
  let deleted = 0;
  for (let n; (n = db.pruneOldPings(1, 10)); ) deleted += n;
  const left = db.prep('SELECT MIN(ts) AS t, COUNT(*) AS n FROM pings').get() as { t: number; n: number };
  assert.ok(left.t >= now - 86400 - 3600, 'nothing older than the window survives');
  assert.equal(deleted + left.n, 72);
  assert.equal((db.prep('SELECT COUNT(*) AS n FROM server_hours').get() as { n: number }).n, before, 'the rollup keeps the history');
  db.close();
});
