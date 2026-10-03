import type { MergeReason } from './types';

/** One sentence per de-duplication rule, shown as tooltips on the server page (mirrors src/dedup.ts). */
export const MERGE_REASON_TEXT: Record<MergeReason, string> = {
  endpoint: 'Shares an IP:port with the other hostname (all SRV × A records) and the status agrees: player counts within tolerance plus the same favicon, MOTD or domain.',
  dns: 'Shares a CNAME / SRV target with the other hostname and the status agrees (counts within tolerance plus the same favicon or MOTD).',
  fingerprint: 'Identical favicon, MOTD and max players with counts within tolerance, but no shared address (networks spread over several IPs).',
  sample: 'The same real player (UUID + name) appears in both player samples.',
};

export const MERGE_REASON_LABEL: Record<MergeReason, string> = {
  endpoint: 'same endpoint',
  dns: 'same DNS target',
  fingerprint: 'same fingerprint',
  sample: 'shared player',
};

export const BLOCKLIST_VIA: Record<string, string> = { host: 'the hostname', srv: 'the SRV target', ip: 'the resolved IP' };

/** Friendly label for a discovery source id (src/discovery/sources.ts). */
export function sourceLabel(source: string): string {
  const LISTS: Record<string, string> = {
    'minecraft-mp-br': 'minecraft-mp.com (Brazil)',
    'minecraft-mp-top': 'minecraft-mp.com (most played)',
    'minecraftservers-org-br': 'minecraftservers.org (Brazil)',
    'minerank-br': 'minerank.com (Brazil)',
    'minecraft-buzz-br': 'minecraft.buzz (Brazil)',
    'minecraftlist-org-br': 'minecraftlist.org (Brazil)',
    'topg-br': 'topg.org (Brazil)',
    'minecraftiplist-br': 'minecraftiplist.com (Brazil)',
    'best-minecraft-servers-br': 'best-minecraft-servers.co (Brazil)',
  };
  if (source === 'manual') return 'Added manually';
  if (source === 'unknown') return 'Unknown';
  if (source.startsWith('seed:')) return `Seed list · ${source.slice(5)}`;
  if (source.startsWith('url:')) return `URL list · ${source.slice(4)}`;
  if (source.startsWith('list:')) return LISTS[source.slice(5)] ?? source.slice(5);
  return LISTS[source] ?? source;
}
