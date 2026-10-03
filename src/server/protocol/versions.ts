import fs from 'node:fs';
import { config } from '../config.js';

/**
 * Built-in protocol -> release names map (Java Edition). data/protocol-versions.json, when present,
 * overrides/extends this so it can be refreshed without touching code.
 */
const BUILTIN: Record<number, string[]> = {
  4: ['1.7.2', '1.7.3', '1.7.4', '1.7.5'],
  5: ['1.7.6', '1.7.7', '1.7.8', '1.7.9', '1.7.10'],
  47: ['1.8', '1.8.1', '1.8.2', '1.8.3', '1.8.4', '1.8.5', '1.8.6', '1.8.7', '1.8.8', '1.8.9'],
  107: ['1.9'],
  108: ['1.9.1'],
  109: ['1.9.2'],
  110: ['1.9.3', '1.9.4'],
  210: ['1.10', '1.10.1', '1.10.2'],
  315: ['1.11'],
  316: ['1.11.1', '1.11.2'],
  335: ['1.12'],
  338: ['1.12.1'],
  340: ['1.12.2'],
  393: ['1.13'],
  401: ['1.13.1'],
  404: ['1.13.2'],
  477: ['1.14'],
  480: ['1.14.1'],
  485: ['1.14.2'],
  490: ['1.14.3'],
  498: ['1.14.4'],
  573: ['1.15'],
  575: ['1.15.1'],
  578: ['1.15.2'],
  735: ['1.16'],
  736: ['1.16.1'],
  751: ['1.16.2'],
  753: ['1.16.3'],
  754: ['1.16.4', '1.16.5'],
  755: ['1.17'],
  756: ['1.17.1'],
  757: ['1.18', '1.18.1'],
  758: ['1.18.2'],
  759: ['1.19'],
  760: ['1.19.1', '1.19.2'],
  761: ['1.19.3'],
  762: ['1.19.4'],
  763: ['1.20', '1.20.1'],
  764: ['1.20.2'],
  765: ['1.20.3', '1.20.4'],
  766: ['1.20.5', '1.20.6'],
  767: ['1.21', '1.21.1'],
  768: ['1.21.2', '1.21.3'],
  769: ['1.21.4'],
  770: ['1.21.5'],
  771: ['1.21.6'],
  772: ['1.21.7', '1.21.8'],
  773: ['1.21.9', '1.21.10'],
  774: ['1.21.11'],
  775: ['26.1', '26.1.1', '26.1.2'],
  776: ['26.2'],
  777: ['26.3'],
};

let table: Record<number, string[]> = { ...BUILTIN };

export function loadProtocolTable(): void {
  try {
    if (fs.existsSync(config.protocolVersionsFile)) {
      const raw = JSON.parse(fs.readFileSync(config.protocolVersionsFile, 'utf8')) as Record<string, string[]>;
      const merged: Record<number, string[]> = { ...BUILTIN };
      for (const [k, v] of Object.entries(raw)) {
        const n = Number.parseInt(k, 10);
        if (Number.isFinite(n) && Array.isArray(v) && v.length) merged[n] = v.map(String);
      }
      table = merged;
    }
  } catch {
    table = { ...BUILTIN };
  }
}

export function protocolTable(): Record<number, string[]> {
  return table;
}

/** Human label for a protocol number, e.g. 47 -> "1.8.x", 340 -> "1.12.2", 763 -> "1.20/1.20.1". */
export function protocolLabel(protocol: number | null | undefined): string {
  if (protocol == null) return 'unknown';
  const names = table[protocol];
  if (!names || !names.length) return `protocol ${protocol}`;
  if (names.length === 1) return names[0]!;
  const first = names[0]!;
  const last = names[names.length - 1]!;
  const fMajor = first.split('.').slice(0, 2).join('.');
  const lMajor = last.split('.').slice(0, 2).join('.');
  if (fMajor === lMajor && names.length > 2) return `${fMajor}.x`;
  return `${first}-${last}`;
}

/** Newest protocol we know a release name for. */
export function latestKnownProtocol(): number {
  return Math.max(...Object.keys(table).map((k) => Number.parseInt(k, 10)).filter((n) => n < 0x40000000));
}

export type Software =
  | 'Vanilla/unbranded'
  | 'Paper'
  | 'Purpur'
  | 'Pufferfish'
  | 'Folia'
  | 'Leaves'
  | 'Leaf'
  | 'Spigot'
  | 'CraftBukkit'
  | 'Velocity'
  | 'BungeeCord'
  | 'Waterfall'
  | 'FlameCord'
  | 'Gate'
  | 'Forge'
  | 'NeoForge'
  | 'Fabric'
  | 'Quilt'
  | 'Sponge'
  | 'Mohist'
  | 'Arclight'
  | 'Magma'
  | 'Cuberite'
  | 'Minestom'
  | 'Multi-version'
  | 'Other';

const PROXIES = new Set<Software>(['Velocity', 'BungeeCord', 'Waterfall', 'FlameCord', 'Gate']);

export function isProxy(sw: Software): boolean {
  return PROXIES.has(sw);
}

export function inferSoftware(versionName: string | null | undefined, raw: unknown): Software {
  const v = (versionName ?? '').toLowerCase();
  const r = (raw ?? {}) as Record<string, unknown>;
  if (v.includes('neoforge')) return 'NeoForge';
  if (r.forgeData || r.modinfo || v.includes('forge') || v.includes('fml')) return 'Forge';
  if (v.includes('velocity')) return 'Velocity';
  if (v.includes('waterfall')) return 'Waterfall';
  if (v.includes('flamecord')) return 'FlameCord';
  if (v.includes('bungeecord') || v.includes('travertine') || v.includes('hexacord')) return 'BungeeCord';
  if (v.includes('gate proxy') || v === 'gate') return 'Gate';
  if (v.includes('purpur')) return 'Purpur';
  if (v.includes('pufferfish')) return 'Pufferfish';
  if (v.includes('folia')) return 'Folia';
  if (v.includes('leaves')) return 'Leaves';
  if (/\bleaf\b/.test(v)) return 'Leaf';
  if (v.includes('paper')) return 'Paper';
  if (v.includes('mohist')) return 'Mohist';
  if (v.includes('arclight')) return 'Arclight';
  if (v.includes('magma')) return 'Magma';
  if (v.includes('sponge')) return 'Sponge';
  if (v.includes('fabric')) return 'Fabric';
  if (v.includes('quilt')) return 'Quilt';
  if (v.includes('spigot')) return 'Spigot';
  if (v.includes('craftbukkit') || v.includes('bukkit')) return 'CraftBukkit';
  if (v.includes('cuberite')) return 'Cuberite';
  if (v.includes('minestom')) return 'Minestom';
  if (/^\d+\.\d+(\.\d+)?$/.test(v.trim())) return 'Vanilla/unbranded';
  // "1.8.x-1.21.x", "1.8 - 1.21", "1.8/1.12/1.16", "1.8+"
  if (/\d+\.\d+.*(?:-|\/|,|\+|to|a|até)\s*\d*\.?\d*/.test(v) && /\d+\.\d+/.test(v)) return 'Multi-version';
  return 'Other';
}
