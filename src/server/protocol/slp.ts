/**
 * Modern Server List Ping (Minecraft Java 1.7+).
 * Handshake(next_state=1) -> Status Request -> Status Response (JSON) -> Ping -> Pong.
 */
import net from 'node:net';
import { framePacket, readVarInt, writeInt64BE, writeString, writeUInt16BE, writeVarInt } from './varint.js';
import { PingError, classifySocketError } from './errors.js';

export interface SlpOptions {
  /** IP or hostname to open the TCP connection to. */
  connectHost: string;
  connectPort: number;
  /** Hostname/port placed in the handshake (what a vanilla client would send: the SRV target if any). */
  handshakeHost: string;
  handshakePort: number;
  protocol: number;
  timeoutMs: number;
  /** Maximum status JSON size we are willing to buffer. */
  maxBytes?: number;
}

export interface SlpRawResult {
  /** Parsed status JSON as sent by the server (may be any shape). */
  json: unknown;
  /** Round-trip time of the ping/pong exchange, or of the status request if the server never answered the ping. */
  latencyMs: number;
  /** Time from socket open to status JSON received. */
  statusMs: number;
  connectMs: number;
  bytes: number;
}

const MAX_BYTES_DEFAULT = 2 * 1024 * 1024;

export function modernPing(opts: SlpOptions): Promise<SlpRawResult> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES_DEFAULT;
  return new Promise<SlpRawResult>((resolve, reject) => {
    const started = process.hrtime.bigint();
    let connectedAt: bigint | null = null;
    let statusAt: bigint | null = null;
    let pingSentAt: bigint | null = null;
    let connected = false;
    let settled = false;
    let json: unknown = undefined;
    let chunks: Buffer[] = [];
    let buffered = 0;
    let stage: 'status' | 'pong' = 'status';
    let pongTimer: NodeJS.Timeout | null = null;

    const socket = new net.Socket();
    socket.setNoDelay(true);

    const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;

    const finish = (err: PingError | null, result?: SlpRawResult) => {
      if (settled) return;
      settled = true;
      if (pongTimer) clearTimeout(pongTimer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result as SlpRawResult);
    };

    const resolveWithStatus = (latencyMs: number) => {
      const now = process.hrtime.bigint();
      finish(null, {
        json,
        latencyMs: Math.round(latencyMs),
        statusMs: Math.round(ms(started, statusAt ?? now)),
        connectMs: Math.round(ms(started, connectedAt ?? now)),
        bytes: buffered,
      });
    };

    socket.setTimeout(opts.timeoutMs, () => {
      if (stage === 'pong' && json !== undefined) {
        // Server answered the status request but not the ping: still a success.
        resolveWithStatus(ms(connectedAt ?? started, statusAt ?? process.hrtime.bigint()));
        return;
      }
      finish(new PingError('TIMEOUT', connected ? 'timed out waiting for status response' : 'connect timeout', connected));
    });

    socket.once('error', (err) => finish(classifySocketError(err, connected)));
    socket.once('close', () => {
      if (settled) return;
      if (json !== undefined) {
        resolveWithStatus(ms(connectedAt ?? started, statusAt ?? process.hrtime.bigint()));
      } else {
        finish(new PingError('CLOSED', 'connection closed before status response', connected));
      }
    });

    socket.connect(opts.connectPort, opts.connectHost, () => {
      connected = true;
      connectedAt = process.hrtime.bigint();
      const handshake = framePacket(
        0x00,
        Buffer.concat([
          writeVarInt(opts.protocol),
          writeString(opts.handshakeHost),
          writeUInt16BE(opts.handshakePort),
          writeVarInt(1),
        ]),
      );
      const statusRequest = framePacket(0x00, Buffer.alloc(0));
      socket.write(Buffer.concat([handshake, statusRequest]));
    });

    socket.on('data', (data: Buffer) => {
      if (settled) return;
      chunks.push(data);
      buffered += data.length;
      if (buffered > maxBytes) {
        finish(new PingError('TOO_LARGE', `response exceeded ${maxBytes} bytes`, true));
        return;
      }
      const buf = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
      chunks = [buf];

      try {
        // Parse as many complete packets as available.
        let offset = 0;
        for (;;) {
          const len = readVarInt(buf, offset);
          if (!len) break;
          if (len.value < 0 || len.value > maxBytes) throw new PingError('PROTOCOL', `bad packet length ${len.value}`, true);
          const start = offset + len.size;
          const end = start + len.value;
          if (buf.length < end) break; // wait for more
          const idRead = readVarInt(buf, start);
          if (!idRead) throw new PingError('PROTOCOL', 'missing packet id', true);
          const packetId = idRead.value;
          const payload = buf.subarray(start + idRead.size, end);

          if (stage === 'status') {
            if (packetId !== 0x00) throw new PingError('PROTOCOL', `unexpected packet id 0x${packetId.toString(16)} in status stage`, true);
            const strLen = readVarInt(payload, 0);
            if (!strLen) throw new PingError('PROTOCOL', 'missing string length', true);
            const text = payload.subarray(strLen.size, strLen.size + strLen.value).toString('utf8');
            try {
              json = JSON.parse(text);
            } catch {
              throw new PingError('PROTOCOL', `status response is not JSON (${text.slice(0, 40)})`, true);
            }
            statusAt = process.hrtime.bigint();
            stage = 'pong';
            pingSentAt = process.hrtime.bigint();
            socket.write(framePacket(0x01, writeInt64BE(BigInt(Date.now()))));
            // Do not wait forever for a pong: some servers never send it.
            pongTimer = setTimeout(() => {
              if (!settled) resolveWithStatus(ms(connectedAt ?? started, statusAt ?? process.hrtime.bigint()));
            }, Math.min(opts.timeoutMs, 3000));
          } else if (stage === 'pong') {
            if (packetId === 0x01) {
              const now = process.hrtime.bigint();
              resolveWithStatus(ms(pingSentAt ?? now, now));
              return;
            }
            // Ignore anything else after the status.
          }
          offset = end;
        }
        if (offset > 0) {
          chunks = [buf.subarray(offset)];
        }
      } catch (err) {
        finish(err instanceof PingError ? err : new PingError('PROTOCOL', (err as Error).message, true));
      }
    });
  });
}
