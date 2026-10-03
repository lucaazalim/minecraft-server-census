import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMotd, runsToText } from '../src/web/lib/motd-parse.js';

test('legacy § codes: colour, bold, reset', () => {
  assert.deepEqual(parseMotd('§a§lHello §rworld'), [
    { text: 'Hello ', color: '#55FF55', bold: true },
    { text: 'world' },
  ]);
});

test('JSON component with named colour and extra', () => {
  const runs = parseMotd({ text: 'Welcome ', color: 'gold', extra: [{ text: 'to the server', bold: true }, { text: '!', color: 'reset' }] });
  assert.deepEqual(runs, [
    { text: 'Welcome ', color: '#FFAA00' },
    { text: 'to the server', color: '#FFAA00', bold: true },
    { text: '!' },
  ]);
});

test('hex colour passthrough and §x hex codes', () => {
  assert.deepEqual(parseMotd({ text: 'Neon', color: '#33A7FF' }), [{ text: 'Neon', color: '#33a7ff' }]);
  assert.deepEqual(parseMotd('§x§f§f§0§0§a§aPink'), [{ text: 'Pink', color: '#ff00aa' }]);
});

test('§ codes embedded inside JSON text fields still apply', () => {
  const runs = parseMotd({ extra: [{ text: '§b§lMUSH §fnetwork' }], text: '' });
  assert.deepEqual(runs, [
    { text: 'MUSH ', color: '#55FFFF', bold: true },
    { text: 'network', color: '#FFFFFF' },
  ]);
});

test('newlines are kept, arrays concatenate, adjacent same-style runs merge', () => {
  const runs = parseMotd(['line one', '\n', { text: 'line two' }]);
  assert.deepEqual(runs, [{ text: 'line one\nline two' }]);
  assert.equal(runsToText(runs), 'line one\nline two');
});

test('translate components and depth cap do not throw', () => {
  assert.deepEqual(parseMotd({ translate: 'chat.type.text', with: ['Steve', 'hi'] }), [{ text: 'Steve hi' }]);
  let deep: unknown = { text: 'x' };
  for (let i = 0; i < 60; i++) deep = { extra: [deep] };
  assert.doesNotThrow(() => parseMotd(deep));
  assert.deepEqual(parseMotd(null), []);
});
