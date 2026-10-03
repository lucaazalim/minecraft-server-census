/** Minecraft protocol VarInt / string / packet framing helpers. */

export function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0; // two's complement: -1 => 0xFFFFFFFF (5 bytes), as the vanilla client sends it
  for (;;) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v);
      break;
    }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(bytes);
}

export interface VarIntRead {
  value: number;
  size: number;
}

/** Returns null when the buffer does not yet hold a complete VarInt. Throws when it is malformed. */
export function readVarInt(buf: Buffer, offset = 0): VarIntRead | null {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++] as number;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('VarInt too big');
  }
  return { value: result | 0, size: pos - offset };
}

export function writeString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

export function writeUInt16BE(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff, 0);
  return b;
}

export function writeInt64BE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(n, 0);
  return b;
}

/** Frame a packet: VarInt(length) + VarInt(id) + payload. */
export function framePacket(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}
