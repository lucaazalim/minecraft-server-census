import { createHash } from 'node:crypto';

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function sha1(s: string | Buffer): string {
  return createHash('sha1').update(s).digest('hex');
}

/** Resolves after `ms`, or immediately once `signal` aborts (never rejects). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      r();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      r();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run `fn` over `items` with at most `concurrency` in flight. Never rejects; per-item errors go to onError. */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  onError?: (err: unknown, item: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      try {
        await fn(item, i);
      } catch (err) {
        onError?.(err, item);
      }
    }
  });
  await Promise.all(workers);
}

export interface ParsedAddress {
  host: string;
  port: number;
}

/** Normalise "Host:Port", "host", "[::1]:25565", "http://host/", trailing dots, etc. Returns null when invalid. */
export function parseAddress(input: string): ParsedAddress | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[\/?#].*$/, '');
  s = s.replace(/^minecraft:\/\//, '');
  let host = s;
  let port = 25565;
  const v6 = s.match(/^\[([0-9a-f:]+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1]!;
    if (v6[2]) port = Number.parseInt(v6[2], 10);
  } else {
    const idx = s.lastIndexOf(':');
    if (idx !== -1 && s.indexOf(':') === idx) {
      host = s.slice(0, idx);
      const p = s.slice(idx + 1);
      if (!/^\d{1,5}$/.test(p)) return null;
      port = Number.parseInt(p, 10);
    }
  }
  host = host.replace(/\.+$/, '').replace(/^\.+/, '');
  if (!host || host.length > 253) return null;
  if (!(port >= 1 && port <= 65535)) return null;
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
  const isIpv6 = /^[0-9a-f:]+$/.test(host) && host.includes(':');
  if (isIpv4) {
    if (host.split('.').some((o) => Number.parseInt(o, 10) > 255)) return null;
    if (/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return null;
  } else if (!isIpv6) {
    if (!/^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) return null;
    if (host === 'localhost') return null;
  }
  return { host, port };
}

export function formatAddress(host: string, port: number): string {
  return port === 25565 ? host : `${host}:${port}`;
}
