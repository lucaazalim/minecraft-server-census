import { config } from './config.js';
import type { Db } from './db.js';
import { logger } from './log.js';
import { pingServer, type PingResult } from './protocol/ping.js';
import { state } from './state.js';
import { shutdownSignal } from './shutdown.js';
import { nowSec, runPool, sleep } from './util.js';

const log = logger('probe');

/**
 * "Which client versions does this server accept?"
 * Ping each recently-online server once per protocol number. Multi-version servers (ViaVersion, proxies)
 * echo the client's protocol back when they support it; otherwise they answer with their native protocol.
 */
export async function runVersionProbe(db: Db, opts: { protocols?: number[]; concurrency?: number; onlyIds?: number[] } = {}): Promise<void> {
  const protocols = opts.protocols ?? config.probeProtocols;
  let servers = db.recentlyOnlineServers(config.probeOnlineWithinHours * 3600);
  if (opts.onlyIds) {
    const set = new Set(opts.onlyIds);
    servers = servers.filter((s) => set.has(s.id));
  }
  state.probe = { ...state.probe, running: true, startedAt: nowSec(), total: servers.length, done: 0 };
  log.info(`probing ${servers.length} servers x ${protocols.length} protocols`);
  const started = Date.now();

  await runPool(
    servers,
    opts.concurrency ?? config.probeConcurrency,
    async (server) => {
      // Written once per server (one transaction for all protocols), including what was probed before a shutdown.
      const results: { protocol: number; r: PingResult; ts: number }[] = [];
      try {
        for (const protocol of protocols) {
          if (shutdownSignal.aborted) return;
          const r = await pingServer(server.host, server.port, { protocol, timeoutMs: config.probeTimeoutMs, legacyFallback: false });
          results.push({ protocol, r, ts: nowSec() });
          await sleep(config.probeHandshakeDelayMs); // be gentle: one server, many handshakes
        }
      } finally {
        if (results.length) db.recordProbes(server.id, results);
      }
      state.probe.done++;
    },
    (err, server) => log.error(`probe failed for ${server.host}:${server.port}`, err),
    shutdownSignal,
  );

  state.probe = { ...state.probe, running: false, lastFinishedAt: nowSec() };
  log.info(`probe done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
