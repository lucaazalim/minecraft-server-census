import { config } from './config.js';
import { compactIfRequested, Db } from './db.js';
import { importSeedFiles } from './discovery/seeds.js';
import { logger } from './log.js';
import { loadProtocolTable } from './protocol/versions.js';
import { startScheduler } from './scheduler.js';
import { startHttpServer } from './api/http.js';
import { shutdownController } from './shutdown.js';

const log = logger('main');

async function main(): Promise<void> {
  loadProtocolTable();
  // `npm run compact` leaves a request for this: rewrite the file while nothing has it open (minutes on a large database).
  compactIfRequested();
  const db = new Db();
  // Seed files are cheap and synchronous: import them before the first sweep so it covers everything we know.
  const seeds = importSeedFiles(db);
  const counts = db.countServers();
  log.info(`seed files: ${seeds.files} files, ${seeds.found} addresses, ${seeds.added} new; ${counts.total} servers in database`);
  log.info(
    `config: interval=${config.pingIntervalMinutes}m concurrency=${config.pingConcurrency} timeout=${config.pingTimeoutMs}ms dns=${config.dnsServers.join(',') || 'system'} probe=${config.probeEnabled ? config.probeProtocols.join('/') : 'off'} geo=${config.geoIpEnabled}`,
  );

  const server = startHttpServer(db);
  const sched = startScheduler(db);

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} received, shutting down (waiting for in-flight pings to flush)`);
    shutdownController.abort();
    server.close();
    const timeout = new Promise<void>((r) => setTimeout(r, 25_000));
    Promise.race([sched.done, timeout])
      .then(() => {
        db.close();
        log.info('bye');
        process.exit(0);
      })
      .catch((err) => {
        log.error('shutdown error', err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
  process.on('uncaughtException', (err) => log.error('uncaught exception', err));
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
