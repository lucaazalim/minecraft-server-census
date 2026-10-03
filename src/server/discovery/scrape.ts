import { config } from '../config.js';
import { logger } from '../log.js';
import { parseAddress, sleep } from '../util.js';

const log = logger('scrape');

export interface ScrapeSource {
  /** Short id, stored as servers.source = "list:<id>". */
  id: string;
  /** Page URL for page number n (1-based). Return null to stop. */
  pageUrl: (page: number) => string | null;
  /** Upper bound on pages to fetch. */
  maxPages: number;
  /** Extract candidate address strings from a page's HTML. */
  extract: (html: string) => string[];
  /** Politeness delay between pages (default: DISCOVERY_PAGE_DELAY_MS). */
  delayMs?: number;
  enabled?: boolean;
}

export interface ScrapeResult {
  addresses: { host: string; port: number }[];
  pagesFetched: number;
  error: string | null;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// Hosts that show up in list-site HTML but are never Minecraft servers.
const JUNK_HOST = /(^|\.)(googleapis|gstatic|google|googletagmanager|doubleclick|cloudflare|cloudflareinsights|jsdelivr|cdnjs|bootstrapcdn|jquery|fontawesome|facebook|twitter|x|youtube|youtu|discord|discordapp|instagram|tiktok|w3|schema|mojang|minecraft|curseforge|planetminecraft|reddit|github|imgur|amazonaws|akamaihd|gravatar|wp|wordpress|paypal|patreon|namemc|mcsrvstat|mcstatus)\.(com|net|org|io|be|gg|me|co|ru|xyz)$/i;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|ico|css|js|json|xml|html?|php|woff2?|ttf|mp4|webm)$/i;

export function normalizeCandidates(cands: string[], selfHost?: string): { host: string; port: number }[] {
  const seen = new Set<string>();
  const out: { host: string; port: number }[] = [];
  for (const c of cands) {
    const decoded = c.replace(/&#58;|&colon;/g, ':').replace(/&amp;/g, '&').trim();
    const p = parseAddress(decoded);
    if (!p) continue;
    if (p.port === 19132) continue;
    if (MEDIA_EXT.test(p.host)) continue;
    if (JUNK_HOST.test(p.host)) continue;
    if (selfHost && (p.host === selfHost || p.host.endsWith(`.${selfHost}`))) continue;
    const key = `${p.host}:${p.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export async function fetchHtml(url: string, timeoutMs = 20_000): Promise<{ status: number; html: string }> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await res.text();
  return { status: res.status, html };
}

export async function scrapeSource(src: ScrapeSource): Promise<ScrapeResult> {
  const found = new Map<string, { host: string; port: number }>();
  let pagesFetched = 0;
  let error: string | null = null;
  let emptyStreak = 0;
  for (let page = 1; page <= src.maxPages; page++) {
    const url = src.pageUrl(page);
    if (!url) break;
    let selfHost: string | undefined;
    try {
      selfHost = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* ignore */
    }
    try {
      const { status, html } = await fetchHtml(url);
      pagesFetched++;
      if (status === 404) break;
      if (status === 403 || status === 429 || status === 503) {
        error = `HTTP ${status} on page ${page}`;
        log.warn(`${src.id}: ${error}`);
        break;
      }
      if (status >= 400) {
        error = `HTTP ${status} on page ${page}`;
        break;
      }
      const before = found.size;
      for (const a of normalizeCandidates(src.extract(html), selfHost)) found.set(`${a.host}:${a.port}`, a);
      const gained = found.size - before;
      log.debug(`${src.id} page ${page}: +${gained} (total ${found.size})`);
      if (gained === 0) {
        emptyStreak++;
        if (emptyStreak >= 2) break;
      } else {
        emptyStreak = 0;
      }
    } catch (err) {
      error = `${(err as Error).message} on page ${page}`;
      log.warn(`${src.id}: ${error}`);
      break;
    }
    await sleep(src.delayMs ?? config.discoveryPageDelayMs);
  }
  return { addresses: [...found.values()], pagesFetched, error };
}

/** Helper for sources: run a regex with one capture group over the HTML and return all captures. */
export function regexAll(re: RegExp, html: string): string[] {
  const out: string[] = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(html)) !== null) {
    if (m[1]) out.push(m[1]);
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return out;
}
