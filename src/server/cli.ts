/**
 * Developer CLI:
 *   tsx src/cli.ts ping <host[:port]> [--protocol N] [--timeout MS] [--raw]
 *   tsx src/cli.ts sweep            # one sweep against the local database
 *   tsx src/cli.ts discover [--out data/discovered.txt] [--countries BR,US]   # scrape list sites, write untracked addresses to a txt for review
 *   tsx src/cli.ts probe [host[:port]]
 *   tsx src/cli.ts stats [--scope XX]
 *   tsx src/cli.ts add <host[:port]> [...]      # track more servers (the dashboard is read-only)
 *   tsx src/cli.ts country <host[:port]> [...] --set XX | --clear
 *                                               # pin a server's country (ISO 3166-1 alpha-2) over ccTLD/GeoIP; every sweep's totals are recomputed
 *   tsx src/cli.ts regroup [--since SWEEP_ID]   # recompute duplicate groups + sweep totals (after rule changes)
 *   tsx src/cli.ts groups [--scope XX]          # print the duplicate groups of the latest sweep
 *   tsx src/cli.ts suspects [--min-spread 3] [--min-online 300] [--json]   # servers that look like they inflate their player count
 *   tsx src/cli.ts remove <addr...> [--reason "..."]   # delete a server + all its data; deny-listed until `add`
 *   tsx src/cli.ts prune [--min-pings 3] [--min-age-hours 24] [--recheck N] [--no-deny] [--keep-ips]
 *                                               # delete IP hosts + never-online servers and their history;
 *                                               # never-online addresses are deny-listed so discovery does not re-add them;
 *                                               # --recheck N pings each candidate up to N times first and spares any that answer
 *   tsx src/cli.ts blocklist [host]             # re-download Mojang's blocklist and list flagged servers, or test one address
 *   tsx src/cli.ts compact                      # slim old ping rows now (safe while the collector runs), then shrink the
 *                                               # file on the next start of the server (VACUUM INTO + swap; minutes of downtime)
 *   tsx src/cli.ts thin [--minutes 10] [--before UNIX_SECONDS] [--dry-run]
 *                                               # keep one sweep per N-minute UTC slot (the first) and delete the others with
 *                                               # their pings, as if the collector had always run every N minutes; resumable,
 *                                               # safe while the collector runs; then requests a compaction like `compact`
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { blocklistHash, blocklistPatterns, fetchBlocklist, findBlockMatch, runBlocklistCheck } from './blocklist.js';
import { config, PROJECT_ROOT } from './config.js';
import { Db, type PruneCandidate } from './db.js';
import { discoverCandidates, formatCandidates } from './discovery/index.js';
import { importSeedFiles, parseSeedText } from './discovery/seeds.js';
import { pingServer } from './protocol/ping.js';
import { loadProtocolTable, protocolLabel } from './protocol/versions.js';
import { runVersionProbe } from './probe.js';
import { groups, overview, parseScope, serverCountry } from './api/queries.js';
import { suspectReport } from './suspects.js';
import { runSweep } from './sweep.js';
import { formatAddress, parseAddress, runPool, sleep } from './util.js';

loadProtocolTable();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    protocol: { type: 'string' },
    timeout: { type: 'string' },
    raw: { type: 'boolean', default: false },
    out: { type: 'string' },
    countries: { type: 'string' },
    since: { type: 'string' },
    scope: { type: 'string' },
    'min-pings': { type: 'string' },
    'min-age-hours': { type: 'string' },
    'no-deny': { type: 'boolean', default: false },
    recheck: { type: 'string' },
    'keep-ips': { type: 'boolean', default: false },
    set: { type: 'string' },
    clear: { type: 'boolean', default: false },
    reason: { type: 'string' },
    'min-spread': { type: 'string' },
    'min-online': { type: 'string' },
    json: { type: 'boolean', default: false },
    minutes: { type: 'string' },
    before: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const cmd = positionals[0];

async function main(): Promise<void> {
  switch (cmd) {
    case 'ping': {
      const addr = parseAddress(positionals[1] ?? '');
      if (!addr) throw new Error('usage: ping <host[:port]>');
      const started = Date.now();
      const r = await pingServer(addr.host, addr.port, {
        protocol: values.protocol ? Number.parseInt(values.protocol, 10) : undefined,
        timeoutMs: values.timeout ? Number.parseInt(values.timeout, 10) : undefined,
      });
      if (!r.ok) {
        console.log(`FAIL ${addr.host}:${addr.port} [${r.code}] ${r.error} (connected=${r.connected}, ${Date.now() - started}ms)`);
        if (r.resolved) console.log(`  resolved: ${r.resolved.ip}:${r.resolved.port} srv=${r.resolved.srvTarget ?? '-'}`);
        process.exitCode = 1;
        return;
      }
      console.log(`OK   ${addr.host}:${addr.port} via ${r.method}${r.handshakeProtocol != null && r.handshakeProtocol !== -1 ? ` (handshake protocol ${r.handshakeProtocol})` : ''} in ${r.latencyMs}ms (resolved ${r.resolved.ip}:${r.resolved.port}${r.resolved.srvTarget ? `, SRV ${r.resolved.srvTarget}` : ''})`);
      console.log(`  version : ${r.versionName} (protocol ${r.protocol} = ${protocolLabel(r.protocol)})  software: ${r.software}`);
      console.log(`  players : ${r.playersOnline} / ${r.playersMax}  sample=${r.sample.map((s) => s.name).join(', ') || '-'}`);
      console.log(`  motd    : ${r.motd.replace(/\n/g, ' | ')}`);
      console.log(`  flags   : secureChat=${r.enforcesSecureChat} previewsChat=${r.previewsChat} preventsChatReports=${r.preventsChatReports} favicon=${r.favicon ? 'yes' : 'no'} mods=${r.modInfo ? `${r.modInfo.kind}:${r.modInfo.modCount}` : '-'} extraKeys=${r.extraKeys.join(',') || '-'} bytes=${r.bytes}`);
      if (values.raw) console.log(JSON.stringify(r.rawJson, null, 2));
      return;
    }
    case 'sweep': {
      const db = new Db();
      importSeedFiles(db);
      const s = await runSweep(db);
      console.log(JSON.stringify(s));
      db.close();
      return;
    }
    case 'discover': {
      // Read-only: the scrape never touches the servers table. Review the file, then put the keepers in data/seeds/.
      const db = new Db();
      const countries = values.countries ? values.countries.toUpperCase().split(/[,\s]+/).filter(Boolean) : undefined;
      const results = await discoverCandidates(db, {
        countries,
        onSource: (s) => console.log(`${s.id}: ${s.found} listed, ${s.fresh.length} new (${s.pages} pages)${s.error ? ` — ${s.error}` : ''}`),
      });
      db.close();
      const out = values.out ?? path.join(PROJECT_ROOT, 'data', 'discovered.txt');
      fs.writeFileSync(out, formatCandidates(results));
      console.log(`${results.reduce((a, s) => a + s.fresh.length, 0)} untracked addresses written to ${out}`);
      return;
    }
    case 'probe': {
      const target = positionals[1] ? parseAddress(positionals[1]) : null;
      if (target) {
        for (const protocol of config.probeProtocols) {
          const r = await pingServer(target.host, target.port, { protocol, legacyFallback: false });
          if (r.ok) console.log(`${String(protocol).padStart(5)} (${protocolLabel(protocol).padEnd(12)}) -> ${String(r.protocol).padStart(5)} ${r.protocol === protocol ? 'SUPPORTED' : 'native   '} "${r.versionName}"`);
          else console.log(`${String(protocol).padStart(5)} (${protocolLabel(protocol).padEnd(12)}) -> FAIL ${r.code} ${r.error}`);
        }
        return;
      }
      const db = new Db();
      await runVersionProbe(db);
      db.close();
      return;
    }
    case 'regroup': {
      const db = new Db();
      const since = values.since ? Number.parseInt(values.since, 10) : 0;
      const ids = db.finishedSweepIds(since);
      for (const id of ids) {
        const r = db.groupSweep(id);
        const sw = db.prep('SELECT players_online, players_online_raw, players_online_br, players_online_br_raw FROM sweeps WHERE id = ?').get(id) as Record<string, number>;
        console.log(`sweep #${id}: ${r.servers} online -> ${r.groups} distinct; players ${sw.players_online} (raw ${sw.players_online_raw}), BR ${sw.players_online_br} (raw ${sw.players_online_br_raw})`);
      }
      console.log(`regrouped ${ids.length} sweeps`);
      db.close();
      break;
    }
    case 'groups': {
      const db = new Db();
      const g = groups(db, parseScope(values.scope), { limit: 2000 });
      if (!g.summary) {
        console.log('no finished sweep yet');
      } else {
        console.log(`${g.summary.servers_online} hostnames online -> ${g.summary.groups_online} distinct servers; players ${g.summary.players} (raw ${g.summary.players_raw}); merges by rule:`, g.summary.reasons);
        for (const grp of g.groups) {
          console.log(`\n# ${grp.host}${grp.port !== 25565 ? `:${grp.port}` : ''}  x${grp.size}  counted ${grp.players_counted} of raw ${grp.players_raw}`);
          for (const m of grp.members) console.log(`   ${String(m.players ?? '-').padStart(6)}  ${(m.endpoint ?? '-').padEnd(22)} ${(m.favicon_hash ?? '-').padEnd(8)} ${(m.host + (m.port !== 25565 ? `:${m.port}` : '')).padEnd(36)} ${m.reason ?? '(representative)'}`);
        }
      }
      db.close();
      break;
    }
    case 'prune': {
      const db = new Db();
      const before = db.countServers();
      const opts = {
        ipHosts: !values['keep-ips'],
        neverOnlineMinPings: Number.parseInt(values['min-pings'] ?? '3', 10),
        neverOnlineMinAgeSec: Number.parseFloat(values['min-age-hours'] ?? '24') * 3600,
        deny: !values['no-deny'],
      };
      const attempts = values.recheck ? Number.parseInt(values.recheck, 10) : 0;
      const spare = new Set<number>();
      let candidates: PruneCandidate[] | undefined;
      if (attempts > 0) {
        // Give every candidate a live chance before deleting it: a server that answers now goes back to the front of the
        // sweep queue (it may be hours into failure backoff) and is left alone.
        const list = (candidates = db.pruneCandidates(opts));
        console.log(`re-checking ${list.length} never-online servers, up to ${attempts} pings each (concurrency ${config.pingConcurrency}, timeout ${config.pingTimeoutMs}ms)...`);
        let done = 0;
        await runPool(list, config.pingConcurrency, async (c) => {
          for (let i = 0; i < attempts; i++) {
            const r = await pingServer(c.host, c.port);
            if (r.ok) {
              spare.add(c.id);
              console.log(`  ${formatAddress(c.host, c.port)}: answered on attempt ${i + 1} (${r.playersOnline}/${r.playersMax}, ${r.versionName}) — kept`);
              break;
            }
          }
          if (++done % 250 === 0) console.log(`  ${done}/${list.length} checked, ${spare.size} answered`);
        });
        db.wakeServers(spare);
        console.log(`re-check done: ${spare.size} of ${list.length} answered and are kept`);
      }
      const r = db.pruneServers({ ...opts, candidates, spare });
      console.log(`pruned ${r.servers} of ${before.total} servers (${r.pings} pings, ${r.snapshots} snapshots, ${r.probes} probes), ${r.denied} deny-listed; ${db.countServers().total} remain`);
      // No VACUUM here: with temp_store = MEMORY it copies the whole database into RAM. Freed pages are reused by new
      // rows; `compact` shrinks the file.
      console.log('freed pages are reused by new rows; run `compact` to shrink the file');
      db.close();
      break;
    }
    case 'blocklist': {
      const target = positionals[1] ? parseAddress(positionals[1]) : null;
      if (target) {
        // Check one address the way the client would, without touching the database (SRV/IP are looked up live).
        const hashes = await fetchBlocklist();
        const r = await pingServer(target.host, target.port, { legacyFallback: false });
        const resolved = r.ok ? r.resolved : r.resolved ?? null;
        const m = findBlockMatch(hashes, { host: target.host, srvTarget: resolved?.srvTarget, ip: resolved?.ip });
        console.log(`${target.host}: ${m ? `BLOCKED (SHA-1 of "${m.pattern}" is on the list, via ${m.via})` : 'not on the blocklist'}  [${hashes.size} hashes]`);
        for (const [via, v] of [['host', target.host], ['srv', resolved?.srvTarget], ['ip', resolved?.ip]] as const) {
          if (!v) continue;
          for (const pat of blocklistPatterns(v)) console.log(`  ${via.padEnd(4)} ${hashes.has(blocklistHash(pat)) ? 'HIT ' : '    '} ${pat.padEnd(40)} ${blocklistHash(pat)}`);
        }
        return;
      }
      const db = new Db();
      const r = await runBlocklistCheck(db, { force: true });
      console.log(`${r.hashes} hashes; ${r.blocked} tracked servers on the blocklist (${r.changed} changed)`);
      const rows = db
        .prep('SELECT s.host, s.port, s.last_ok, s.last_players_online, b.pattern, b.via, b.first_seen FROM blocked_servers b JOIN servers s ON s.id = b.server_id ORDER BY s.last_players_online DESC NULLS LAST, s.host')
        .all() as { host: string; port: number; last_ok: number | null; last_players_online: number | null; pattern: string; via: string; first_seen: number }[];
      for (const b of rows) console.log(`  ${String(b.last_ok === 1 ? b.last_players_online ?? '-' : 'off').padStart(6)}  ${formatAddress(b.host, b.port).padEnd(40)} ${b.pattern.padEnd(32)} via ${b.via}  since ${new Date(b.first_seen * 1000).toISOString().slice(0, 16)}`);
      db.close();
      return;
    }
    case 'stats': {
      const db = new Db();
      console.log(JSON.stringify(overview(db, parseScope(values.scope)), null, 2));
      db.close();
      return;
    }
    case 'suspects': {
      const db = new Db();
      const report = suspectReport(db.suspectRows(), {
        minSpread: values['min-spread'] ? Number.parseFloat(values['min-spread']) : undefined,
        minOnline: values['min-online'] ? Number.parseInt(values['min-online'], 10) : undefined,
      });
      db.close();
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      const fmt = (r: { host: string; port: number; online: number; max: number; sampleSize: number; source: string | null; signals: string[] }) =>
        `${formatAddress(r.host, r.port).padEnd(36)} ${String(r.online).padStart(7)} / ${String(r.max).padEnd(7)} sample=${r.sampleSize}  ${(r.source ?? '?').padEnd(30)} ${r.signals.join(',')}`;
      console.log(`${report.groups.length} fingerprint groups whose hostnames disagree (same favicon + MOTD, largest count > ${values['min-spread'] ?? 3}x the smallest):\n`);
      for (const g of report.groups) {
        console.log(`x${g.spread.toFixed(1)}  honest: ${g.honest.join(', ')}`);
        for (const m of g.members) console.log(`    ${fmt(m)}`);
        console.log();
      }
      console.log(`${report.singles.length} servers flagged on their own:\n`);
      for (const r of report.singles) console.log(`    ${fmt(r)}`);
      console.log('\nsignals: over-capacity = more players than slots; auto-max = max is online+1; list-hostname = label is a list-site code (ms, sm, mp, buzz, best, ...)');
      console.log('Review, then: npm run remove -- <host...> --reason "..."   (keeps the honest hostname; the removed ones are deny-listed)');
      return;
    }
    case 'add': {
      const entries = parseSeedText(positionals.slice(1).join('\n'), 'manual');
      if (!entries.length) throw new Error('usage: add <host[:port]> [...]');
      const db = new Db();
      for (const e of entries) if (db.allowServer(e.host, e.port)) console.log(`${formatAddress(e.host, e.port)}: removed from the deny list`);
      const added = db.addServers(entries);
      console.log(`${entries.length} valid addresses, ${added} new: ${entries.map((e) => formatAddress(e.host, e.port)).join(', ')}`);
      db.close();
      return;
    }
    case 'remove': {
      const entries = parseSeedText(positionals.slice(1).join('\n'), 'manual');
      if (!entries.length) throw new Error('usage: remove <host[:port]> [...] [--reason "..."]');
      const db = new Db();
      const sweeps = new Set<number>();
      for (const e of entries) {
        const r = db.removeServer(e.host, e.port, values.reason ?? null);
        if (!r) console.log(`${formatAddress(e.host, e.port)}: not tracked; deny-listed`);
        else {
          for (const id of r.sweepIds) sweeps.add(id);
          console.log(`${formatAddress(e.host, e.port)}: deleted (${r.pings} pings, ${r.snapshots} snapshots, ${r.probes} probes); deny-listed`);
        }
      }
      if (sweeps.size) console.log(`recomputing totals of ${sweeps.size} affected sweeps...`);
      for (const id of [...sweeps].sort((a, b) => a - b)) {
        const g = db.groupSweep(id);
        const sw = db.prep('SELECT players_online FROM sweeps WHERE id = ?').get(id) as { players_online: number };
        console.log(`  sweep #${id}: ${g.servers} online -> ${g.groups} distinct; players ${sw.players_online}`);
      }
      const orphans = db.deleteOrphanPings();
      if (orphans) console.log(`deleted ${orphans} pings written by an in-flight sweep after the removal`);
      db.close();
      return;
    }
    case 'country': {
      const entries = parseSeedText(positionals.slice(1).join('\n'), 'manual');
      const code = values.set?.trim().toUpperCase();
      if (!entries.length || (!code && !values.clear) || (code && values.clear)) throw new Error('usage: country <host[:port]> [...] --set XX | --clear');
      if (code && !/^[A-Z]{2}$/.test(code)) throw new Error(`not an ISO 3166-1 alpha-2 code: ${values.set}`);
      const db = new Db();
      for (const e of entries) {
        const server = db.getServerByAddress(e.host, e.port);
        if (!server) throw new Error(`unknown server: ${formatAddress(e.host, e.port)}`);
        db.setCountryOverride(server.id, code ?? null);
        const after = db.getServer(server.id)!;
        console.log(`${formatAddress(server.host, server.port)}: country ${serverCountry(after) ?? '-'} (override=${after.country_override ?? '-'} tld=${after.tld_country ?? '-'} geo=${after.country ?? '-'})`);
      }
      console.log(`recomputed the totals of ${db.reaggregateSweeps()} sweeps`);
      db.close();
      return;
    }
    case 'compact': {
      const db = new Db();
      const end = (db.prep('SELECT MAX(id) AS id FROM pings').get() as { id: number | null }).id ?? 0;
      let from = Number(db.getMeta('slim_pings_through') ?? 0);
      console.log(from ? `resuming after ping #${from} of ${end}` : `slimming ping rows written before snapshot_id existed (up to #${end})`);
      let rows = 0;
      const started = Date.now();
      // Small transactions with a pause in between: the collector's batched writes get the lock in the gaps.
      for (let n = 0; from < end; n++) {
        const to = Math.min(from + 10_000, end);
        rows += db.slimPings(from, to);
        from = to;
        if (n % 100 === 99) console.log(`  ${from} / ${end} (${rows} rows rewritten, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
        await sleep(20);
      }
      db.requestCompaction();
      const free = (db.prep('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
      console.log(`${rows} rows rewritten in ${((Date.now() - started) / 1000).toFixed(0)}s; ${Math.round((free * 4096) / 1048576)} MB of free pages so far`);
      console.log(`restart the server to shrink ${db.file}: it runs VACUUM INTO before the collector and the dashboard start`);
      console.log(`(on Fly: fly machine restart; a temporary --vm-size performance-1x triples the volume bandwidth)`);
      db.close();
      return;
    }
    case 'thin': {
      const minutes = Number.parseInt(values.minutes ?? '10', 10);
      const before = values.before ? Number.parseInt(values.before, 10) : Math.floor(Date.now() / 1000);
      if (!(minutes > 0) || !(before > 0)) throw new Error('usage: thin [--minutes N] [--before UNIX_SECONDS] [--dry-run]');
      const db = new Db();
      const ids = db.thinCandidates(before, minutes * 60);
      const total = (db.prep('SELECT COUNT(*) AS n FROM sweeps').get() as { n: number }).n;
      console.log(`${ids.length} of ${total} sweeps started before ${new Date(before * 1000).toISOString()} are not the first of their ${minutes}-minute slot`);
      if (values['dry-run'] || !ids.length) {
        db.close();
        return;
      }
      let pings = 0;
      const started = Date.now();
      // One sweep per transaction with a pause in between: the collector's batched writes get the lock in the gaps.
      for (const [i, id] of ids.entries()) {
        pings += db.dropSweep(id);
        if (i % 100 === 99) console.log(`  ${i + 1} / ${ids.length} sweeps (${pings} pings, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
        await sleep(20);
      }
      db.requestCompaction();
      const free = (db.prep('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
      console.log(`deleted ${ids.length} sweeps and ${pings} pings in ${((Date.now() - started) / 1000).toFixed(0)}s; ${Math.round((free * 4096) / 1048576)} MB of free pages`);
      console.log(`restart the server to shrink ${db.file}: it runs VACUUM INTO before the collector and the dashboard start`);
      db.close();
      return;
    }
    default:
      console.log('commands: ping <addr> | sweep | discover | probe [addr] | stats | add <addr...> | remove <addr...> | country <addr...> | suspects | regroup | groups | prune | blocklist [addr] | compact | thin');
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
