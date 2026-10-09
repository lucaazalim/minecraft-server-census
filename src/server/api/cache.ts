/**
 * API response cache. The dashboard polls every minute but the data only changes when a sweep (every 10 minutes) or a
 * probe run finishes, so each distinct URL is computed at most once per data version, however many tabs are open.
 * A reply one version old is served immediately while the new one is computed (stale-while-revalidate), so the first
 * viewer after a sweep does not wait either; anything older is recomputed before answering. `onInvalidate` hooks run
 * after each version bump (http.ts uses one to recompute the default dashboard, so it is warm even after a quiet hour).
 */
export interface CachedReply {
  status: number;
  body: Uint8Array;
  gzip: Uint8Array | null;
  etag: string;
}

interface Entry {
  version: number;
  reply: CachedReply;
  bytes: number;
}

export class ResponseCache {
  private version = 0;
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<CachedReply>>();
  private bytes = 0;
  private listeners: (() => void)[] = [];

  constructor(private readonly maxBytes: number) {}

  /** The data changed: every entry becomes stale (still served once while it refreshes). */
  invalidate(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Run `fn` after every invalidate(); returns the unsubscribe function. */
  onInvalidate(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Recompute `key` now unless its reply is already current (no-op while a compute for it is in flight). */
  warm(key: string, compute: () => Promise<CachedReply & { store: boolean }>): Promise<unknown> {
    if (this.entries.get(key)?.version === this.version) return Promise.resolve();
    return this.refresh(key, compute);
  }

  get size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }

  /**
   * The reply for `key`, from cache when current (or one version old, refreshing it in the background); otherwise from
   * `compute`, which is shared by concurrent callers. Replies with `store: false` are passed through uncached.
   */
  async get(key: string, compute: () => Promise<CachedReply & { store: boolean }>): Promise<CachedReply> {
    const hit = this.entries.get(key);
    if (hit && hit.version === this.version) {
      this.touch(key, hit);
      return hit.reply;
    }
    if (hit && hit.version === this.version - 1) {
      this.touch(key, hit);
      this.refresh(key, compute).catch(() => {
        /* the stale reply stays until the next request retries */
      });
      return hit.reply;
    }
    return this.refresh(key, compute);
  }

  private refresh(key: string, compute: () => Promise<CachedReply & { store: boolean }>): Promise<CachedReply> {
    const running = this.inflight.get(key);
    if (running) return running;
    const version = this.version;
    const p = compute()
      .then(({ store, ...reply }) => {
        if (store && reply.status === 200) this.put(key, version, reply);
        return reply;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private put(key: string, version: number, reply: CachedReply): void {
    const old = this.entries.get(key);
    if (old) {
      if (old.version > version) return;
      this.bytes -= old.bytes;
      this.entries.delete(key);
    }
    const bytes = reply.body.length + (reply.gzip?.length ?? 0) + key.length;
    this.entries.set(key, { version, reply, bytes });
    this.bytes += bytes;
    // Least recently used first (Map keeps insertion order; hits re-insert).
    for (const [k, e] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(k);
      this.bytes -= e.bytes;
    }
  }

  private touch(key: string, e: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, e);
  }
}

export const apiCache = new ResponseCache(32 * 1024 * 1024);
