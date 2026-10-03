import { config } from '../config.js';
import { regexAll, type ScrapeSource } from './scrape.js';

/**
 * Countries the list sites can be scraped for, with the slug each site uses in its URL. Sites not listed for a
 * country use the derived default (lowercase ISO code or the hyphenated name). Which of these are actually scraped
 * is DISCOVERY_COUNTRIES (default: the ten countries with the most Java servers on the list sites).
 */
export interface Country {
  code: string;
  name: string;
  /** minecraft-mp.com /country/<slug>/ */
  mmp?: string;
  /** minecraftservers.org /search/<term> */
  msorg?: string;
  /** minerank.com /countries/<slug> */
  minerank?: string;
  /** topg.org /minecraft-servers/country/<Name-With-Hyphens>/ */
  topg?: string;
  /** minecraftiplist.com /server-tags/<Name> */
  mcip?: string;
}

export const COUNTRIES: Country[] = [
  { code: 'US', name: 'United States', mmp: 'united-states-of-america', mcip: 'USA' },
  { code: 'BR', name: 'Brazil' },
  { code: 'DE', name: 'Germany' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'FR', name: 'France' },
  { code: 'RU', name: 'Russia', mmp: 'russian-federation' },
  { code: 'PL', name: 'Poland' },
  { code: 'ES', name: 'Spain' },
  { code: 'CA', name: 'Canada' },
  { code: 'TR', name: 'Turkey' },
  { code: 'AR', name: 'Argentina' },
  { code: 'MX', name: 'Mexico' },
  { code: 'PT', name: 'Portugal' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'IT', name: 'Italy' },
  { code: 'AU', name: 'Australia' },
];

const hyphen = (name: string) => name.toLowerCase().replace(/\s+/g, '-');

/** Every scrape source for one country. Page URLs/markup verified 2026-09-19..20. */
export function countrySources(c: Country): ScrapeSource[] {
  const cc = c.code.toLowerCase();
  const suffix = `-${cc}`;
  return [
    {
      id: `minecraft-mp${suffix}`,
      pageUrl: (p) => `https://minecraft-mp.com/country/${c.mmp ?? hyphen(c.name)}/${p === 1 ? '' : `${p}/`}`,
      maxPages: 40,
      extract: (html) => regexAll(/data-clipboard-text="([^"]+)"/g, html),
    },
    {
      id: `minecraftservers-org${suffix}`,
      // No country pages; the search matches the country field (verified against server pages).
      pageUrl: (p) => `https://minecraftservers.org/search/${encodeURIComponent(c.msorg ?? c.name.toLowerCase())}${p === 1 ? '' : `/${p}`}`,
      maxPages: 60,
      extract: (html) => regexAll(/<div class="url">([^<]+)<\/div>/g, html),
    },
    {
      id: `minerank${suffix}`,
      pageUrl: (p) => `https://www.minerank.com/countries/${c.minerank ?? hyphen(c.name)}${p === 1 ? '' : `?page=${p}`}`,
      maxPages: 60,
      extract: (html) => [...regexAll(/\\"ip\\":\\"([^\\"]+)\\"/g, html), ...regexAll(/"ip":"([^"]+)"/g, html)],
    },
    {
      id: `minecraft-buzz${suffix}`,
      pageUrl: (p) => `https://minecraft.buzz/country/${cc}${p === 1 ? '' : `/${p}`}`,
      maxPages: 30,
      extract: (html) => regexAll(/<data value="([^"]+)" class="ip-block"/g, html),
    },
    {
      id: `minecraftlist-org${suffix}`,
      pageUrl: (p) => `https://minecraftlist.org/servers?filter_country=${c.code}&page=${p}`,
      maxPages: 20,
      extract: (html) => regexAll(/<input class="server-address" id="server\d+" value="([^"]+)"/g, html.replace(/<!--[\s\S]*?-->/g, '')),
    },
    {
      id: `topg${suffix}`,
      // Country pages are not paginated (top 20 or so).
      pageUrl: (p) => (p === 1 ? `https://topg.org/minecraft-servers/country/${c.topg ?? c.name.replace(/\s+/g, '-')}/` : null),
      maxPages: 1,
      extract: (html) => regexAll(/class="copy-ip copy-span" data-text="([^"]+)"/g, html.replace(/<li class="ad-server">[\s\S]*?<\/li>/g, '')),
    },
    {
      id: `minecraftiplist${suffix}`,
      pageUrl: (p) => `https://www.minecraftiplist.com/server-tags/${encodeURIComponent(c.mcip ?? c.name)}${p === 1 ? '' : `/${p}`}`,
      maxPages: 20,
      extract: (html) => regexAll(/server-tile-cell-ip"><span class="sr-only-google">([^<]+)<\/span>/g, html),
    },
    {
      id: `best-minecraft-servers${suffix}`,
      pageUrl: (p) => (p === 1 ? `https://best-minecraft-servers.co/country/${cc}` : null),
      maxPages: 1,
      // Only rows firing `ip_hold` belong to the country list; `sponsor_ip_hold` rows are global sponsors.
      extract: (html) =>
        regexAll(/ip-block ip_hold"\s+data-clipboard-text="([^"]+)"\s+data-port="(?:25565)"/g, html).concat(
          regexAll(/ip-block ip_hold"\s+data-clipboard-text="([^"]+:\d+)"/g, html),
        ),
    },
  ];
}

/** Sources that are not country-scoped. */
export const GLOBAL_SOURCES: ScrapeSource[] = [
  {
    id: 'minecraft-mp-top',
    // "Most played" global ranking: context for the per-country numbers.
    pageUrl: (p) => (p === 1 ? 'https://minecraft-mp.com/servers/players/' : `https://minecraft-mp.com/servers/players/${p}/`),
    maxPages: 8,
    extract: (html) => regexAll(/data-clipboard-text="([^"]+)"/g, html),
  },
];

/**
 * Server-list websites scraped at startup and every DISCOVERY_INTERVAL_HOURS: the global sources plus every country
 * source for each code in DISCOVERY_COUNTRIES. Unknown codes are logged by the caller and skipped.
 * Each extractor is a tolerant regex over the raw HTML; results are validated/deduplicated afterwards.
 * If a site changes its markup the source simply yields 0 addresses (logged) and the seed files still apply.
 */
export function buildSources(codes: string[] = config.discoveryCountries): { sources: ScrapeSource[]; unknown: string[] } {
  const sources = [...GLOBAL_SOURCES];
  const unknown: string[] = [];
  for (const code of codes) {
    const c = COUNTRIES.find((x) => x.code === code);
    if (c) sources.push(...countrySources(c));
    else unknown.push(code);
  }
  return { sources, unknown };
}

export { regexAll };
