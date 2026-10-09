import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { sleep } from '../src/server/util.js';

const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('sleep: leaves no abort listener or timer behind (the scheduler sleeps once a second for days)', async () => {
  const ctrl = new AbortController();
  const before = timers();
  for (let i = 0; i < 200; i++) await sleep(1, ctrl.signal);
  assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
  assert.equal(timers(), before);

  // Aborting wakes a sleeper immediately and clears its timer.
  const started = Date.now();
  const pending = sleep(60_000, ctrl.signal);
  ctrl.abort();
  await pending;
  assert.ok(Date.now() - started < 1000);
  assert.equal(timers(), before);
  assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
});
