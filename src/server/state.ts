/** In-memory runtime status shown on the dashboard. */
export interface RuntimeState {
  startedAt: number;
  sweep: {
    running: boolean;
    sweepId: number | null;
    startedAt: number | null;
    total: number;
    done: number;
    ok: number;
    lastFinishedAt: number | null;
    lastDurationMs: number | null;
    nextAt: number | null;
  };
  probe: { running: boolean; startedAt: number | null; total: number; done: number; lastFinishedAt: number | null; nextAt: number | null };
  geo: { pending: number; lastRunAt: number | null; lastError: string | null };
  blocklist: { hashes: number; fetchedAt: number | null; checkedAt: number | null; blocked: number; lastError: string | null };
}

export const state: RuntimeState = {
  startedAt: Math.floor(Date.now() / 1000),
  sweep: { running: false, sweepId: null, startedAt: null, total: 0, done: 0, ok: 0, lastFinishedAt: null, lastDurationMs: null, nextAt: null },
  probe: { running: false, startedAt: null, total: 0, done: 0, lastFinishedAt: null, nextAt: null },
  geo: { pending: 0, lastRunAt: null, lastError: null },
  blocklist: { hashes: 0, fetchedAt: null, checkedAt: null, blocked: 0, lastError: null },
};
