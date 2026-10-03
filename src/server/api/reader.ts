/**
 * API reader thread: answers the JSON routes (routes.ts) on its own read-only SQLite connection. node:sqlite is
 * synchronous, so on the main thread a slow query stalled everything: health checks failed and the sweep's socket
 * timeouts fired before replies that had already arrived were read. Here it only delays other API requests.
 * The reply is serialized, gzipped and tagged once, so the main thread can cache and send it as bytes.
 */
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';
import { Db } from '../db.js';
import { logger } from '../log.js';
import { loadProtocolTable } from '../protocol/versions.js';
import { state, type RuntimeState } from '../state.js';
import { handleApi } from './routes.js';

export interface ReaderRequest {
  id: number;
  path: string;
  /** The collector's live state (the overview shows it); this thread has its own copy of the module. */
  state: RuntimeState;
}
export interface ReaderReply {
  id: number;
  status: number;
  cacheable: boolean;
  body: Uint8Array;
  gzip: Uint8Array | null;
  etag: string;
}

const log = logger('reader');

if (parentPort) {
  const port = parentPort;
  loadProtocolTable();
  const db = new Db((workerData as { file: string }).file, { readOnly: true });
  const encoder = new TextEncoder();
  port.on('message', (msg: ReaderRequest) => {
    let status = 500;
    let cacheable = false;
    let text: string;
    try {
      Object.assign(state, msg.state);
      const r = handleApi(db, msg.path);
      status = r.status;
      cacheable = r.cacheable;
      text = JSON.stringify(r.body);
    } catch (err) {
      log.error(`GET ${msg.path} failed`, err);
      text = JSON.stringify({ error: 'internal error' });
    }
    const body = encoder.encode(text);
    const gzip = body.length > 1024 ? new Uint8Array(zlib.gzipSync(body, { level: 6 })) : null;
    const etag = createHash('sha1').update(body).digest('hex').slice(0, 20);
    port.postMessage({ id: msg.id, status, cacheable, body, gzip, etag } satisfies ReaderReply);
  });
}
