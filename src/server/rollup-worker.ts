/**
 * One-time backfill of server_hours for the ping history that predates it (or piled up while the process was down).
 * It reads the whole pings table once, which is minutes of I/O on the production volume, so it runs on its own thread
 * and connection: the sweep's event loop never waits on it. Each hour is its own short transaction, with a pause in
 * between so the collector's batched writes get the lock.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { Db } from './db.js';
import { sleep } from './util.js';

if (parentPort) {
  const port = parentPort;
  const db = new Db((workerData as { file: string }).file);
  const started = Date.now();
  let hours = 0;
  for (;;) {
    let n = 0;
    try {
      n = db.rollupHours(1);
    } catch (err) {
      // Busy (a long CLI transaction): try again shortly.
      if (!/locked|busy/i.test((err as Error).message)) throw err;
      await sleep(5000);
      continue;
    }
    if (!n) break;
    hours += n;
    await sleep(50);
  }
  db.db.close();
  port.postMessage({ hours, ms: Date.now() - started });
}
