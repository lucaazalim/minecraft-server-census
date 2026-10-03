/** Main-thread side of the API reader thread (reader.ts): one worker, requests answered in order, restarted if it dies. */
import { Worker } from 'node:worker_threads';
import { logger } from '../log.js';
import { state } from '../state.js';
import type { ReaderReply, ReaderRequest } from './reader.js';

const log = logger('reader');

/** reader.ts next to this file: .ts under tsx (dev, tests), .js once compiled. */
const WORKER_URL = new URL(`./reader${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);

export class ApiReader {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: ReaderReply) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(private readonly file: string) {
    this.spawn();
  }

  private spawn(): void {
    const w = new Worker(WORKER_URL, { workerData: { file: this.file } });
    w.on('message', (r: ReaderReply) => {
      const p = this.pending.get(r.id);
      this.pending.delete(r.id);
      p?.resolve(r);
    });
    w.on('error', (err) => log.error('reader thread crashed', err));
    w.on('exit', (code) => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const p of this.pending.values()) p.reject(new Error(`reader thread exited (${code})`));
      this.pending.clear();
      if (!this.closed) {
        log.warn(`reader thread exited with code ${code}; restarting`);
        setTimeout(() => !this.closed && !this.worker && this.spawn(), 1000).unref();
      }
    });
    this.worker = w;
  }

  /** Run one API route ("/api/...?..."); rejects if the thread dies or is not running. */
  request(path: string): Promise<ReaderReply> {
    const w = this.worker;
    if (!w) return Promise.reject(new Error('reader thread not running'));
    const id = this.nextId++;
    return new Promise<ReaderReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, path, state } satisfies ReaderRequest);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('reader closed'));
    this.pending.clear();
    if (w) await w.terminate();
  }
}
