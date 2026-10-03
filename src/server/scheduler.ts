import { Worker } from 'node:worker_threads';
import { apiCache } from './api/cache.js';
import { runBlocklistCheck } from './blocklist.js';
import { config } from './config.js';
import type { Db } from './db.js';
import { runGeoLookup } from './geo.js';
import { logger } from './log.js';
import { runVersionProbe } from './probe.js';
import { isShuttingDown, shutdownSignal } from './shutdown.js';
import { state } from './state.js';
import { runSweep } from './sweep.js';
import { nowSec, sleep } from './util.js';

const log = logger('scheduler');

function sleepUntil(tsSec: number): Promise<void> {
  const ms = Math.max(0, tsSec * 1000 - Date.now());
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    shutdownSignal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

let sweepRequested = false;
let probeRequested = false;
let blocklistRequested = false;

export function requestSweep(): boolean {
  if (state.sweep.running) return false;
  sweepRequested = true;
  return true;
}
export function requestProbe(): boolean {
  if (state.probe.running) return false;
  probeRequested = true;
  return true;
}
/** Re-download Mojang's blocklist at the end of the current wait / sweep instead of waiting for the interval. */
export function requestBlocklist(): boolean {
  blocklistRequested = true;
  return true;
}

async function blocklistCheck(db: Db, force: boolean): Promise<void> {
  blocklistRequested = false;
  try {
    await runBlocklistCheck(db, { force });
  } catch (err) {
    log.warn('blocklist check failed', err);
  }
}

async function sweepLoop(db: Db): Promise<void> {
  const interval = config.pingIntervalMinutes * 60;
  // Servers remembered from a previous run get their blocklist flag before the first sweep finishes.
  await blocklistCheck(db, false);
  while (!isShuttingDown()) {
    const startedAt = nowSec();
    sweepRequested = false;
    try {
      await runSweep(db);
    } catch (err) {
      log.error('sweep crashed', err);
      state.sweep.running = false;
    } finally {
      apiCache.invalidate();
    }
    try {
      await runGeoLookup(db);
    } catch (err) {
      log.warn('geo lookup failed', err);
    }
    // New IPs / SRV targets from this sweep are checked right away; the list itself is re-downloaded when stale.
    await blocklistCheck(db, blocklistRequested);
    if (config.pingRetentionDays > 0) {
      try {
        const n = db.pruneOldPings(config.pingRetentionDays, 24);
        if (n) log.info(`pruned ${n} old pings`);
      } catch (err) {
        log.warn('prune failed', err);
      }
    }
    const nextAt = startedAt + interval;
    state.sweep.nextAt = nextAt;
    if (nextAt <= nowSec()) {
      log.warn(`sweep took longer than the ${config.pingIntervalMinutes}-minute interval; starting next one immediately`);
      continue;
    }
    // Wait for the next slot, but wake early when a manual sweep is requested.
    while (!isShuttingDown() && nowSec() < nextAt && !sweepRequested) {
      await Promise.race([sleepUntil(nextAt), sleep(1000)]);
      if (blocklistRequested) await blocklistCheck(db, true);
    }
  }
}

async function probeLoop(db: Db): Promise<void> {
  if (!config.probeEnabled) return;
  let nextAt = nowSec() + config.probeInitialDelayMinutes * 60;
  state.probe.nextAt = nextAt;
  while (!isShuttingDown()) {
    while (!isShuttingDown() && nowSec() < nextAt && !probeRequested) await Promise.race([sleepUntil(nextAt), sleep(1000)]);
    if (isShuttingDown()) return;
    probeRequested = false;
    try {
      await runVersionProbe(db);
    } catch (err) {
      log.error('probe crashed', err);
      state.probe.running = false;
    } finally {
      apiCache.invalidate();
    }
    nextAt = nowSec() + config.probeIntervalHours * 3600;
    state.probe.nextAt = nextAt;
  }
}

/** Backfill server_hours on a worker thread (rollup-worker.ts); resolves when it is done or has failed. */
function rollupBackfill(db: Db): Promise<void> {
  const url = new URL(`./rollup-worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);
  return new Promise((resolve) => {
    const w = new Worker(url, { workerData: { file: db.file } });
    w.on('message', (m: { hours: number; ms: number }) => {
      if (m.hours) log.info(`server_hours: rolled up ${m.hours} hours of history in ${(m.ms / 1000).toFixed(1)}s`);
    });
    w.on('error', (err) => log.warn('rollup backfill failed; finishSweep keeps rolling up one hour at a time', err));
    w.on('exit', () => resolve());
    shutdownSignal.addEventListener('abort', () => void w.terminate(), { once: true });
  });
}

export function startScheduler(db: Db): { done: Promise<void> } {
  const done = Promise.all([sweepLoop(db), probeLoop(db), rollupBackfill(db)]).then(() => undefined);
  return { done };
}
