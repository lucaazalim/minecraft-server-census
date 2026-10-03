/**
 * Legacy Server List Ping (Beta 1.8 .. 1.6.4). Sends 0xFE 0x01 0xFA "MC|PingHost".
 * Response: 0xFF, UTF-16BE string length (chars), UTF-16BE string:
 *   1.4-1.6: "§1\0<protocol>\0<version>\0<motd>\0<online>\0<max>"
 *   Beta 1.8-1.3: "<motd>§<online>§<max>"
 */
import net from 'node:net';
import { PingError, classifySocketError } from './errors.js';

export interface LegacyOptions {
  connectHost: string;
  connectPort: number;
  handshakeHost: string;
  handshakePort: number;
  timeoutMs: number;
}

export interface LegacyResult {
  protocol: number | null;
  versionName: string | null;
  motd: string;
  online: number | null;
  max: number | null;
  latencyMs: number;
  raw: string;
}

function utf16be(s: string): Buffer {
  const b = Buffer.from(s, 'utf16le');
  for (let i = 0; i + 1 < b.length; i += 2) {
    const t = b[i] as number;
    b[i] = b[i + 1] as number;
    b[i + 1] = t;
  }
  return b;
}

function buildRequest(host: string, port: number): Buffer {
  const channel = utf16be('MC|PingHost');
  const hostBuf = utf16be(host);
  const rest = Buffer.alloc(7 + hostBuf.length);
  rest.writeUInt8(74, 0); // protocol version (1.6.4)
  rest.writeUInt16BE(host.length, 1);
  hostBuf.copy(rest, 3);
  rest.writeInt32BE(port, 3 + hostBuf.length);
  const head = Buffer.from([0xfe, 0x01, 0xfa]);
  const chanLen = Buffer.alloc(2);
  chanLen.writeUInt16BE('MC|PingHost'.length, 0);
  const restLen = Buffer.alloc(2);
  restLen.writeUInt16BE(rest.length, 0);
  return Buffer.concat([head, chanLen, channel, restLen, rest]);
}

export function legacyPing(opts: LegacyOptions): Promise<LegacyResult> {
  return new Promise<LegacyResult>((resolve, reject) => {
    const started = process.hrtime.bigint();
    let connected = false;
    let settled = false;
    let chunks: Buffer[] = [];
    let size = 0;
    const socket = new net.Socket();

    const finish = (err: PingError | null, result?: LegacyResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(result as LegacyResult);
    };

    const tryParse = (final: boolean) => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 3) return false;
      if (buf[0] !== 0xff) throw new PingError('PROTOCOL', 'legacy response does not start with 0xFF', true);
      const chars = buf.readUInt16BE(1);
      const need = 3 + chars * 2;
      if (buf.length < need) {
        if (!final) return false;
      }
      const strBuf = buf.subarray(3, Math.min(buf.length, need));
      // swap to UTF-16LE for decoding
      const le = Buffer.from(strBuf);
      for (let i = 0; i + 1 < le.length; i += 2) {
        const t = le[i] as number;
        le[i] = le[i + 1] as number;
        le[i + 1] = t;
      }
      const text = le.toString('utf16le');
      const latencyMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      if (text.startsWith('§1\0')) {
        const parts = text.split('\0');
        finish(null, {
          protocol: parts[1] ? Number.parseInt(parts[1], 10) : null,
          versionName: parts[2] ?? null,
          motd: parts[3] ?? '',
          online: parts[4] ? Number.parseInt(parts[4], 10) : null,
          max: parts[5] ? Number.parseInt(parts[5], 10) : null,
          latencyMs,
          raw: text,
        });
      } else {
        const parts = text.split('§');
        finish(null, {
          protocol: null,
          versionName: null,
          motd: parts[0] ?? '',
          online: parts[1] ? Number.parseInt(parts[1], 10) : null,
          max: parts[2] ? Number.parseInt(parts[2], 10) : null,
          latencyMs,
          raw: text,
        });
      }
      return true;
    };

    socket.setTimeout(opts.timeoutMs, () => {
      try {
        if (size > 0 && tryParse(true)) return;
      } catch (e) {
        finish(e as PingError);
        return;
      }
      finish(new PingError('TIMEOUT', connected ? 'timed out waiting for legacy response' : 'connect timeout', connected));
    });
    socket.once('error', (err) => finish(classifySocketError(err, connected)));
    socket.once('close', () => {
      if (settled) return;
      try {
        if (size > 0 && tryParse(true)) return;
      } catch (e) {
        finish(e as PingError);
        return;
      }
      finish(new PingError('CLOSED', 'connection closed before legacy response', connected));
    });
    socket.connect(opts.connectPort, opts.connectHost, () => {
      connected = true;
      socket.write(buildRequest(opts.handshakeHost, opts.handshakePort));
    });
    socket.on('data', (d: Buffer) => {
      chunks.push(d);
      size += d.length;
      if (size > 65536) {
        finish(new PingError('TOO_LARGE', 'legacy response too large', true));
        return;
      }
      try {
        tryParse(false);
      } catch (e) {
        finish(e as PingError);
      }
    });
  });
}
