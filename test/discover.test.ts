import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/server/db.js';
import { formatCandidates } from '../src/server/discovery/index.js';
import { parseSeedText } from '../src/server/discovery/seeds.js';

test('isKnownAddress: tracked and deny-listed addresses are known, everything else is a candidate', () => {
  const db = new Db(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-')), 'census.db'));
  db.addServer('tracked.example.com', 25565, 'seed:test');
  db.removeServer('dead.example.com', 25565, 'prune');
  assert.equal(db.isKnownAddress('tracked.example.com', 25565), true);
  assert.equal(db.isKnownAddress('tracked.example.com', 25566), false);
  assert.equal(db.isKnownAddress('dead.example.com', 25565), true);
  assert.equal(db.isKnownAddress('new.example.com', 25565), false);
});

test('formatCandidates: seed-file format, one block per source, parses back to the same addresses', () => {
  const text = formatCandidates(
    [
      { id: 'minecraft-mp-br', found: 3, pages: 1, error: null, fresh: [{ host: 'a.example.com', port: 25565 }, { host: 'b.example.com', port: 25570 }] },
      { id: 'minerank-br', found: 0, pages: 0, error: 'HTTP 503', fresh: [] },
    ],
    new Date('2026-09-21T03:00:00Z'),
  );
  assert.match(text, /^# 2 addresses found by list-site scraping on 2026-09-21T03:00Z/);
  assert.match(text, /\n# minecraft-mp-br: 3 listed, 2 new\na\.example\.com\nb\.example\.com:25570\n/);
  assert.match(text, /\n# minerank-br: 0 listed, 0 new \(HTTP 503\)\n$/);
  assert.deepEqual(
    parseSeedText(text, 'x').map((e) => `${e.host}:${e.port}`),
    ['a.example.com:25565', 'b.example.com:25570'],
  );
});
