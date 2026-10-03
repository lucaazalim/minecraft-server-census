import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeGroups, normalizeMotd, registrableDomain, sampleKeys, type DedupInput } from '../src/server/dedup.js';

let nextId = 1;
function server(host: string, over: Partial<DedupInput> = {}): DedupInput {
  return {
    id: nextId++,
    host,
    players: 100,
    playersMax: 1000,
    faviconHash: null,
    motd: null,
    endpoints: [],
    dnsTargets: [],
    sampleKeys: [],
    ...over,
  };
}
const groupsOf = (rows: DedupInput[]) => {
  const a = computeGroups(rows, { tolerancePct: 5 });
  const byRep = new Map<number, string[]>();
  for (const r of rows) {
    const rep = a.get(r.id)!.rep;
    byRep.set(rep, [...(byRep.get(rep) ?? []), r.host]);
  }
  return [...byRep.values()].map((g) => g.sort());
};
const reasonOf = (rows: DedupInput[], host: string) => computeGroups(rows, { tolerancePct: 5 }).get(rows.find((r) => r.host === host)!.id)!.reason;

test('one network spread over several IP:ports collapses (Mush)', () => {
  const eps = ['131.196.198.49:25565', '131.196.198.49:25566', '131.196.199.98:25565', '131.196.199.98:25566'];
  const rows = [
    server('mush.com.br', { players: 2007, faviconHash: 'a', motd: 'mush duels', endpoints: eps }),
    server('bra12.mush.com.br', { players: 2021, faviconHash: 'a', motd: 'mush duels', endpoints: eps.slice(0, 2) }),
    server('jogar.mush.com.br', { players: 2005, faviconHash: 'b', motd: 'mush duels', endpoints: eps.slice(2) }),
    server('jogar.mushmc.com.br', { players: 2007, faviconHash: 'a', motd: 'mush duels', endpoints: [eps[2]!] }),
  ];
  assert.deepEqual(groupsOf(rows), [['bra12.mush.com.br', 'jogar.mush.com.br', 'jogar.mushmc.com.br', 'mush.com.br']]);
  assert.equal(reasonOf(rows, 'jogar.mush.com.br'), 'endpoint');
  assert.equal(reasonOf(rows, 'mush.com.br'), null); // representative
});

test('unrelated networks behind one hostname-routed proxy IP:port stay apart (TCPShield)', () => {
  const ep = ['172.65.228.130:25565'];
  const rows = [
    server('mc.masivo.gg', { players: 90, faviconHash: 'a', motd: 'masivo', endpoints: ep }),
    server('pinkprison.net', { players: 563, faviconHash: 'b', motd: 'pink prison', endpoints: ep }),
    server('mp.foxcraft.net', { players: 91, faviconHash: 'c', motd: 'foxcraft', endpoints: ep }), // counts agree with masivo but nothing else does
  ];
  assert.equal(groupsOf(rows).length, 3);
});

test('same brand with separate player pools is not merged', () => {
  const rows = [
    server('bedwars.example.net', { players: 500, faviconHash: 'a', motd: 'example network', endpoints: ['1.1.1.1:25565'] }),
    server('skywars.example.net', { players: 120, faviconHash: 'a', motd: 'example network', endpoints: ['1.1.1.2:25565'] }),
  ];
  assert.equal(groupsOf(rows).length, 2);
});

test('identical look on disjoint IPs merges (fingerprint) when counts agree', () => {
  const rows = [
    server('play.swatscraft.es', { players: 3868, faviconHash: 'f', motd: 'universocraft', playersMax: 20000, endpoints: ['40.160.64.241:25565'] }),
    server('mc.universocraft.com', { players: 3877, faviconHash: 'f', motd: 'universocraft', playersMax: 20000, endpoints: ['40.160.64.240:25565'] }),
  ];
  assert.equal(groupsOf(rows).length, 1);
  assert.equal(reasonOf(rows, 'mc.universocraft.com'), 'fingerprint');
});

test('tiny servers on a shared hosting CNAME need the full look-alike', () => {
  const rows = [
    server('friendszone.enxada.host', { players: 1, faviconHash: 'a', motd: 'friends', dnsTargets: ['node1.enxada.host'], endpoints: ['10.0.0.1:10009'] }),
    server('starcraftbeta.enxada.host', { players: 0, faviconHash: 'b', motd: 'starcraft', dnsTargets: ['node1.enxada.host'], endpoints: ['10.0.0.1:10006'] }),
  ];
  assert.equal(groupsOf(rows).length, 2);
  // ...but two aliases of the same tiny server (same favicon + MOTD) do merge
  const alias = [
    server('mc.tiny.com.br', { players: 1, faviconHash: 'a', motd: 'tiny', endpoints: ['10.0.0.2:25565'] }),
    server('jogar.tiny.com.br', { players: 1, faviconHash: 'a', motd: 'tiny', endpoints: ['10.0.0.2:25565'] }),
  ];
  assert.equal(groupsOf(alias).length, 1);
});

test('a real player seen in both samples is conclusive', () => {
  const key = '3fa85f64-5717-4562-b3fc-2c963f66afa6|steve';
  const rows = [
    server('a.example', { players: 3, faviconHash: 'x', sampleKeys: [key], endpoints: ['10.0.0.3:25565'] }),
    server('b.example', { players: 3, faviconHash: 'y', sampleKeys: [key], endpoints: ['10.0.0.4:25565'] }),
  ];
  assert.equal(groupsOf(rows).length, 1);
  assert.equal(reasonOf(rows, 'b.example'), 'sample');
});

test('registrableDomain understands ccTLD second levels and hosting parents', () => {
  assert.equal(registrableDomain('jogar.mush.com.br'), 'mush.com.br');
  assert.equal(registrableDomain('mush.com.br'), 'mush.com.br');
  assert.equal(registrableDomain('mc.hypixel.net'), 'hypixel.net');
  assert.equal(registrableDomain('play.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('minliveofc.aternos.me'), 'minliveofc.aternos.me');
  assert.equal(registrableDomain('131.196.197.34'), null);
});

test('sampleKeys keeps only genuine-looking players; normalizeMotd strips formatting', () => {
  assert.deepEqual(
    sampleKeys([
      { name: 'Steve', id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' },
      { name: '§aJoin now!', id: '00000000-0000-0000-0000-000000000000' },
      { name: 'Alex', id: null },
    ]),
    ['3fa85f64-5717-4562-b3fc-2c963f66afa6|steve'],
  );
  assert.equal(normalizeMotd('§6MUSH  §f|  DUELS\n ATUALIZADO! '), 'mush | duels atualizado!');
  assert.equal(normalizeMotd('§a'), null);
});
