import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { logger } from '../log.js';
import { parseAddress } from '../util.js';

const log = logger('seeds');

export interface SeedEntry {
  host: string;
  port: number;
  source: string;
}

/** Parse a newline-separated host list ("host[:port]  # note"). */
export function parseSeedText(text: string, source: string): SeedEntry[] {
  const out: SeedEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const token = line.split(/\s+/)[0] ?? '';
    const parsed = parseAddress(token);
    if (!parsed) continue;
    if (parsed.port === 19132) continue; // Bedrock
    const key = `${parsed.host}:${parsed.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...parsed, source });
  }
  return out;
}

/** Import every *.txt in the seeds dir. Idempotent. */
export function importSeedFiles(db: Db): { files: number; found: number; added: number } {
  let files = 0;
  let found = 0;
  let added = 0;
  if (!fs.existsSync(config.seedsDir)) return { files, found, added };
  for (const name of fs.readdirSync(config.seedsDir).sort()) {
    if (!name.endsWith('.txt')) continue;
    files++;
    const text = fs.readFileSync(path.join(config.seedsDir, name), 'utf8');
    const entries = parseSeedText(text, `seed:${name.replace(/\.txt$/, '')}`);
    found += entries.length;
    const n = db.addServers(entries);
    added += n;
    log.info(`${name}: ${entries.length} addresses, ${n} new`);
  }
  return { files, found, added };
}
