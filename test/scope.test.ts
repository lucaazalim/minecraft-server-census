import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketSeconds, parseScope, scopeFilter } from '../src/server/api/queries.js';

test('parseScope: all / empty / legacy br / country / garbage', () => {
  assert.deepEqual(parseScope('all'), { kind: 'all' });
  assert.deepEqual(parseScope(''), { kind: 'all' });
  assert.deepEqual(parseScope(null), { kind: 'all' });
  assert.deepEqual(parseScope(undefined), { kind: 'all' });
  assert.deepEqual(parseScope('br'), { kind: 'country', code: 'BR' });
  assert.deepEqual(parseScope('us'), { kind: 'country', code: 'US' });
  assert.deepEqual(parseScope('De'), { kind: 'country', code: 'DE' });
  assert.deepEqual(parseScope('xyz'), { kind: 'all' });
  assert.deepEqual(parseScope("'; DROP TABLE servers; --"), { kind: 'all' });
  assert.deepEqual(parseScope('B'), { kind: 'all' });
});

test('scopeFilter binds the country instead of interpolating it', () => {
  assert.deepEqual(scopeFilter({ kind: 'all' }), { sql: '', params: [] });
  const f = scopeFilter({ kind: 'country', code: 'BR' });
  assert.equal(f.sql.includes('BR'), false);
  assert.deepEqual(f.params, ['BR']);
  assert.match(f.sql, /^ AND COALESCE\(s\.country_override, s\.tld_country, s\.country\) = \?$/);
});

test('bucketSeconds: raw sweeps up to 72h, hourly up to a month, 6h beyond', () => {
  assert.equal(bucketSeconds(24), 0);
  assert.equal(bucketSeconds(72), 0);
  assert.equal(bucketSeconds(168), 3600);
  assert.equal(bucketSeconds(720), 3600);
  assert.equal(bucketSeconds(24 * 31), 3600);
  assert.equal(bucketSeconds(24 * 60), 6 * 3600);
  assert.equal(bucketSeconds(0), 6 * 3600);
});

test('parseScope: regions by code, case-insensitive; unknown region -> all', () => {
  const latam = parseScope('latam');
  assert.equal(latam.kind, 'region');
  if (latam.kind === 'region') {
    assert.equal(latam.code, 'latam');
    assert.ok(latam.countries.includes('BR') && latam.countries.includes('MX'));
  }
  assert.equal(parseScope('EUROPE').kind, 'region');
  assert.deepEqual(parseScope('antarctica'), { kind: 'all' });
});

test('scopeFilter binds every country of a region', () => {
  const f = scopeFilter({ kind: 'region', code: 'noram', countries: ['US', 'CA', 'GL'] });
  assert.match(f.sql, /^ AND COALESCE\(s\.country_override, s\.tld_country, s\.country\) IN \(\?, \?, \?\)$/);
  assert.deepEqual(f.params, ['US', 'CA', 'GL']);
});

test('regions: valid ISO codes, no country in two regions', async () => {
  const { REGIONS } = await import('../src/server/regions.js');
  const seen = new Map<string, string>();
  for (const r of REGIONS) {
    assert.match(r.code, /^[a-z]{3,}$/, `${r.code} could collide with a country code`);
    for (const c of r.countries) {
      assert.match(c, /^[A-Z]{2}$/, `${r.code}: ${c}`);
      assert.equal(seen.get(c), undefined, `${c} is in both ${seen.get(c)} and ${r.code}`);
      seen.set(c, r.code);
    }
  }
});
