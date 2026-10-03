import { config } from './config.js';
import { PING_BATCH, type Db, type ServerLite } from './db.js';
import { logger } from './log.js';
import { pingServer, type PingResult } from './protocol/ping.js';
import { state } from './state.js';
import { shutdownSignal } from './shutdown.js';
import { nowSec, runPool, sleep } from './util.js';

const log = logger('sweep');

const FLUSH_RETRY_MS = 15_000;

export interface SweepSummary {
  sweepId: number;
  attempted: number;
  ok: number;
  durationMs: number;
  errors: Record<string, number>;
}

/**
 * Ping every due server once, writing results in batches inside transactions.
 * Returns when all pings are recorded and the sweep row is finalised.
 */
export async function runSweep(db: Db, opts: { concurrency?: number; timeoutMs?: number; onlyIds?: number[] } = {}): Promise<SweepSummary> {
  const started = Date.now();
  const ts0 = nowSec();
  const counts = db.countServers();
  let due = db.dueServers(ts0);
  if (opts.onlyIds) {
    const set = new Set(opts.onlyIds);
    due = due.filter((s) => set.has(s.id));
  }
  const sweepId = db.startSweep(counts.enabled ?? 0, due.length);
  state.sweep = { ...state.sweep, running: true, sweepId, startedAt: ts0, total: due.length, done: 0, ok: 0 };
  log.info(`sweep #${sweepId}: ${due.length} due of ${counts.enabled} enabled servers`);

  const errors: Record<string, number> = {};
  let ok = 0;
  let pending: { server: ServerLite; result: PingResult; ts: number }[] = [];

  /**
   * Write the buffered results in one transaction (sorted by id, so neighbouring servers rows share page writes).
   * When another process holds the write lock (a CLI command) for more than a second, the batch stays buffered and is
   * retried FLUSH_RETRY_MS later instead of being lost; waiting the connection's full 10 s here would stall the event
   * loop and time out the pings in flight. Returns false when it could not write.
   */
  let retryAt = 0;
  const flush = (): boolean => {
    if (!pending.length) return true;
    const batch = pending.sort((a, b) => a.server.id - b.server.id);
    pending = [];
    try {
      db.db.exec('PRAGMA busy_timeout = 1000');
      db.transaction(() => {
        for (const item of batch) {
          try {
            db.recordPing(sweepId, item.server, item.result, item.ts);
          } catch (err) {
            log.error(`recordPing failed for ${item.server.host}:${item.server.port}`, err);
          }
        }
      });
      return true;
    } catch (err) {
      pending = batch.concat(pending);
      retryAt = Date.now() + FLUSH_RETRY_MS;
      log.warn(`could not write ${batch.length} pings yet, will retry: ${(err as Error).message}`);
      return false;
    } finally {
      db.db.exec('PRAGMA busy_timeout = 10000');
    }
  };

  await runPool(
    due,
    opts.concurrency ?? config.pingConcurrency,
    async (server) => {
      const result = await pingServer(server.host, server.port, { timeoutMs: opts.timeoutMs ?? config.pingTimeoutMs });
      if (result.ok) ok++;
      else errors[result.code] = (errors[result.code] ?? 0) + 1;
      pending.push({ server, result, ts: nowSec() });
      state.sweep.done++;
      state.sweep.ok = ok;
      if (pending.length >= PING_BATCH && Date.now() >= retryAt) flush();
    },
    (err, server) => {
      log.error(`unexpected error pinging ${server.host}:${server.port}`, err);
      errors.INTERNAL = (errors.INTERNAL ?? 0) + 1;
      state.sweep.done++;
    },
    shutdownSignal,
  );
  await untilWritten('write the last pings', flush);

  const durationMs = Date.now() - started;
  await untilWritten('finish the sweep', () => {
    db.finishSweep(sweepId, durationMs, errors);
    return true;
  });
  state.sweep = { ...state.sweep, running: false, lastFinishedAt: nowSec(), lastDurationMs: durationMs };
  log.info(`sweep #${sweepId} done: ${ok}/${due.length} online in ${(durationMs / 1000).toFixed(1)}s`, errors);
  return { sweepId, attempted: due.length, ok, durationMs, errors };
}

/** Retry a write while the database is locked by another process (the CLI over ssh), for up to ~2 minutes. */
async function untilWritten(what: string, write: () => boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let ok = false;
    try {
      ok = write();
    } catch (err) {
      if (attempt >= 6 || !/locked|busy/i.test((err as Error).message)) throw err;
      log.warn(`could not ${what} (attempt ${attempt}): ${(err as Error).message}`);
    }
    if (ok) return;
    if (attempt >= 6) throw new Error(`could not ${what}: database busy`);
    await sleep(10_000);
  }
}
