import { useNow } from '@/hooks/use-now';
import { fmtDateTime, fmtRelative } from '@/lib/format';

export function RelativeTime({ at, className }: { at: number | null | undefined; className?: string }) {
  const now = useNow();
  if (at == null) return <span className={className}>–</span>;
  return (
    <time dateTime={new Date(at * 1000).toISOString()} title={fmtDateTime(at)} className={className}>
      {fmtRelative(at, now)}
    </time>
  );
}
