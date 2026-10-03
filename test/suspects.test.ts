import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signalsFor, suspectReport, type SuspectRow } from '../src/server/suspects.js';

const row = (host: string, online: number, max: number, extra: Partial<SuspectRow> = {}): SuspectRow => ({
  host, port: 25565, source: 'seed:test', online, max, faviconHash: 'abc', motd: '§6Example §fNetwork', sampleSize: 0, ...extra,
});

test('signals: over-capacity, auto-max and list-site hostnames', () => {
  assert.deepEqual(signalsFor(row('play.example.com', 9303, 500)), ['over-capacity']);
  assert.deepEqual(signalsFor(row('play.example.com', 1174, 1)), [], 'max=1 is a joke, not evidence');
  assert.deepEqual(signalsFor(row('play.example.com', 2027, 2028)), ['auto-max']);
  assert.deepEqual(signalsFor(row('best.example.com', 24228, 24229)), ['auto-max', 'list-hostname']);
  assert.deepEqual(signalsFor(row('sm.example.com', 100, 1000)), [], 'small counts are not flagged');
});

test('report: hostnames sharing favicon+MOTD but disagreeing on the count form a group', () => {
  const rows = [
    row('one.lemon.net', 6300, 6400),
    row('buzz.lemon.org', 6290, 6390),
    row('mp.lemon.net', 629, 729),
    row('cobblemon.lemon.org', 629, 630),
    row('play.other.net', 500, 1000, { faviconHash: 'zzz', motd: 'Other' }),
    row('alias.other.net', 480, 1000, { faviconHash: 'zzz', motd: 'Other' }),
  ];
  const r = suspectReport(rows);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0]!.members[0]!.host, 'one.lemon.net');
  assert.ok(r.groups[0]!.spread > 9 && r.groups[0]!.spread < 11);
  assert.deepEqual(r.groups[0]!.honest, ['mp.lemon.net', 'cobblemon.lemon.org']);
  assert.equal(r.singles.length, 0, 'the 4% disagreement of the other network is normal');
});

test('report: lone over-capacity server is listed as a single; servers without fingerprint are still checked', () => {
  const r = suspectReport([row('best.flake.net', 9303, 500, { faviconHash: null, motd: null }), row('mc.fine.net', 100, 200)]);
  assert.equal(r.groups.length, 0);
  assert.deepEqual(r.singles.map((s) => s.host), ['best.flake.net']);
});
