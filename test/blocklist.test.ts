import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocklistHash, blocklistPatterns, findBlockMatch, parseBlocklist } from '../src/server/blocklist.js';

test('domain patterns: exact, then one wildcard per level', () => {
  assert.deepEqual(blocklistPatterns('Mc.Example.COM.'), ['mc.example.com', '*.example.com', '*.com']);
  assert.deepEqual(blocklistPatterns('example.com'), ['example.com', '*.com']);
  assert.deepEqual(blocklistPatterns('localhost'), ['localhost']);
  assert.deepEqual(blocklistPatterns('srv.example.com:3838'), ['srv.example.com', '*.example.com', '*.com']);
  assert.deepEqual(blocklistPatterns('2001:db8::1'), ['2001:db8::1']);
  assert.deepEqual(blocklistPatterns(''), []);
});

test('IPv4 patterns: wildcards from the right', () => {
  assert.deepEqual(blocklistPatterns('192.168.0.1'), ['192.168.0.1', '192.168.0.*', '192.168.*', '192.*']);
});

test('hash is SHA-1 of the ISO-8859-1 bytes, lowercase hex', () => {
  assert.equal(blocklistHash('example.com'), '0caaf24ab1a0c33440c06afe99df986365b0781f');
});

test('parseBlocklist keeps only 40-hex lines', () => {
  const set = parseBlocklist('0CAAF24AB1A0C33440C06AFE99DF986365B0781F\n\nnot-a-hash\n  \n');
  assert.deepEqual([...set], ['0caaf24ab1a0c33440c06afe99df986365b0781f']);
});

test('findBlockMatch checks hostname, then SRV target, then IP', () => {
  const hashes = new Set(['*.blocked.net', '10.0.0.*', 'srv.blocked.org'].map(blocklistHash));
  assert.deepEqual(findBlockMatch(hashes, { host: 'play.blocked.net' }), { pattern: '*.blocked.net', via: 'host' });
  assert.deepEqual(findBlockMatch(hashes, { host: 'fine.example', srvTarget: 'srv.blocked.org.', ip: '1.2.3.4' }), { pattern: 'srv.blocked.org', via: 'srv' });
  assert.deepEqual(findBlockMatch(hashes, { host: 'fine.example', srvTarget: null, ip: '10.0.0.7' }), { pattern: '10.0.0.*', via: 'ip' });
  assert.equal(findBlockMatch(hashes, { host: 'fine.example', ip: '10.0.1.7' }), null);
  assert.equal(findBlockMatch(new Set(), { host: 'play.blocked.net' }), null);
});
