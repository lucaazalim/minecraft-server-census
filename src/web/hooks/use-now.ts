import { useEffect, useState } from 'react';

/** Current time in seconds, re-rendering every `everyMs` (for "3 min ago" labels). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
