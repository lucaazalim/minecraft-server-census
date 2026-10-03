import { config } from './config.js';
import type { Db } from './db.js';
import { logger } from './log.js';
import { isShuttingDown, shutdownSignal } from './shutdown.js';
import { state } from './state.js';
import { nowSec, sleep } from './util.js';

const log = logger('geo');

interface IpApiRow {
  status: 'success' | 'fail';
  message?: string;
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  isp?: string;
  org?: string;
  as?: string;
  query: string;
}

/**
 * Geolocate resolved IPs with ip-api.com's batch endpoint (free for non-commercial use, HTTP only; quota and batch
 * size in config.ts). Results are cached on the servers table for GEOIP_CACHE_DAYS.
 */
export async function runGeoLookup(db: Db, maxBatches = config.geoIpBatchesPerSweep): Promise<void> {
  if (!config.geoIpEnabled) return;
  for (let i = 0; i < maxBatches && !isShuttingDown(); i++) {
    const rows = db.serversNeedingGeo(config.geoIpBatchSize, config.geoIpCacheDays * 86400);
    state.geo.pending = rows.length;
    if (!rows.length) return;
    const ips = [...new Set(rows.map((r) => r.resolved_ip))];
    let data: IpApiRow[];
    try {
      const res = await fetch('http://ip-api.com/batch?fields=status,message,countryCode,regionName,city,isp,org,as,query', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'mc-server-census/0.1' },
        body: JSON.stringify(ips),
        signal: AbortSignal.any([AbortSignal.timeout(15_000), shutdownSignal]),
      });
      if (res.status === 429) {
        const ttl = Number.parseInt(res.headers.get('x-ttl') ?? '60', 10);
        log.warn(`rate limited, sleeping ${ttl}s`);
        await sleep((ttl + 1) * 1000, shutdownSignal);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = (await res.json()) as IpApiRow[];
      const remaining = Number.parseInt(res.headers.get('x-rl') ?? '15', 10);
      const ttl = Number.parseInt(res.headers.get('x-ttl') ?? '60', 10);
      state.geo.lastRunAt = nowSec();
      state.geo.lastError = null;
      const byIp = new Map(data.map((d) => [d.query, d]));
      db.transaction(() => {
        for (const row of rows) {
          const g = byIp.get(row.resolved_ip);
          if (!g) continue;
          if (g.status === 'success') {
            db.setGeo(row.id, {
              country: g.countryCode ?? null,
              region: g.regionName ?? null,
              city: g.city ?? null,
              isp: g.isp ?? null,
              org: g.org ?? null,
              asn: g.as ?? null,
            });
          } else {
            db.setGeo(row.id, { country: null, region: null, city: null, isp: null, org: null, asn: g.message ?? 'fail' });
          }
        }
      });
      log.info(`geolocated ${ips.length} IPs (${remaining} requests left in window)`);
      if (remaining <= 1) await sleep((ttl + 1) * 1000, shutdownSignal);
      else await sleep(config.geoIpBatchDelayMs, shutdownSignal);
    } catch (err) {
      state.geo.lastError = (err as Error).message;
      log.warn('lookup failed', err);
      return;
    }
  }
}
