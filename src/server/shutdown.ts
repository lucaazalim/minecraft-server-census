/** Process-wide abort signal flipped on SIGTERM/SIGINT so long loops stop taking new work. */
export const shutdownController = new AbortController();
export const shutdownSignal = shutdownController.signal;
export function isShuttingDown(): boolean {
  return shutdownSignal.aborted;
}
