export type PingErrorCode =
  | 'DNS'
  | 'TIMEOUT'
  | 'REFUSED'
  | 'UNREACHABLE'
  | 'RESET'
  | 'PROTOCOL'
  | 'TOO_LARGE'
  | 'CLOSED'
  | 'OTHER';

export class PingError extends Error {
  code: PingErrorCode;
  /** True when a TCP connection was established before the failure (used to decide on the legacy fallback). */
  connected: boolean;
  constructor(code: PingErrorCode, message: string, connected = false) {
    super(message);
    this.name = 'PingError';
    this.code = code;
    this.connected = connected;
  }
}

export function classifySocketError(err: unknown, connected: boolean): PingError {
  if (err instanceof PingError) return err;
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? '';
  const msg = e?.message ?? String(err);
  switch (code) {
    case 'ECONNREFUSED':
      return new PingError('REFUSED', msg, connected);
    case 'ETIMEDOUT':
      return new PingError('TIMEOUT', msg, connected);
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
      return new PingError('UNREACHABLE', msg, connected);
    case 'ECONNRESET':
    case 'EPIPE':
      return new PingError('RESET', msg, connected);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ESERVFAIL':
    case 'ENODATA':
    case 'EREFUSED':
      return new PingError('DNS', msg, connected);
    default:
      return new PingError('OTHER', msg, connected);
  }
}
