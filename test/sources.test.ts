import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSources, COUNTRIES, countrySources, GLOBAL_SOURCES } from '../src/server/discovery/sources.js';

test('buildSources: global sources + eight per known country, unknown codes reported', () => {
  const { sources, unknown } = buildSources(['BR', 'US', 'XX']);
  assert.deepEqual(unknown, ['XX']);
  assert.equal(sources.length, GLOBAL_SOURCES.length + 2 * countrySources(COUNTRIES[0]!).length);
  assert.equal(new Set(sources.map((s) => s.id)).size, sources.length, 'ids are unique');
  assert.ok(sources.some((s) => s.id === 'minecraft-mp-br'));
  assert.ok(sources.some((s) => s.id === 'topg-us'));
});

test('country slugs: overrides and derived defaults land in the URLs', () => {
  const us = Object.fromEntries(countrySources(COUNTRIES.find((c) => c.code === 'US')!).map((s) => [s.id, s.pageUrl(1)]));
  assert.equal(us['minecraft-mp-us'], 'https://minecraft-mp.com/country/united-states-of-america/');
  assert.equal(us['minecraftservers-org-us'], 'https://minecraftservers.org/search/united%20states');
  assert.equal(us['minerank-us'], 'https://www.minerank.com/countries/united-states');
  assert.equal(us['minecraft-buzz-us'], 'https://minecraft.buzz/country/us');
  assert.equal(us['minecraftlist-org-us'], 'https://minecraftlist.org/servers?filter_country=US&page=1');
  assert.equal(us['topg-us'], 'https://topg.org/minecraft-servers/country/United-States/');
  assert.equal(us['minecraftiplist-us'], 'https://www.minecraftiplist.com/server-tags/USA');
  assert.equal(us['best-minecraft-servers-us'], 'https://best-minecraft-servers.co/country/us');
});

test('pagination: page 2 URLs and single-page sources stop', () => {
  const br = Object.fromEntries(countrySources(COUNTRIES.find((c) => c.code === 'BR')!).map((s) => [s.id, s.pageUrl(2)]));
  assert.equal(br['minecraft-mp-br'], 'https://minecraft-mp.com/country/brazil/2/');
  assert.equal(br['minecraftservers-org-br'], 'https://minecraftservers.org/search/brazil/2');
  assert.equal(br['minerank-br'], 'https://www.minerank.com/countries/brazil?page=2');
  assert.equal(br['topg-br'], null);
  assert.equal(br['best-minecraft-servers-br'], null);
});
