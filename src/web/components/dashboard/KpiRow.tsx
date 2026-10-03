import { StatTile } from '@/components/common/StatTile';
import type { Overview } from '@/lib/types';
import { fmtDateTime, fmtInt } from '@/lib/format';
import { cn } from 'cn';

function Delta({ value, avg }: { value: number; avg: number | null }) {
  if (avg == null || avg <= 0) return null;
  const pct = ((value - avg) / avg) * 100;
  const up = pct >= 0;
  return (
    <span className={cn('font-medium', up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}% <span className="font-normal text-muted-foreground">vs 24h average</span>
    </span>
  );
}

export function KpiRow({ data, loading }: { data: Overview | undefined; loading: boolean }) {
  const k = data?.kpis;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatTile
        label="Players online"
        hero
        loading={loading}
        value={fmtInt(k?.players_online)}
        sub={k ? <Delta value={k.players_online} avg={k.players_avg_24h} /> : null}
        title={k ? `Before de-duplication: ${fmtInt(k.players_online_raw)}` : undefined}
      />
      <StatTile label="Servers online" loading={loading} value={fmtInt(k?.groups_online)} sub={k ? `${fmtInt(k.servers_online)} hostnames` : null} />
      <StatTile label="Peak players" loading={loading} value={fmtInt(k?.peak?.value)} sub={k?.peak ? fmtDateTime(k.peak.at) : 'No sweep yet'} />
      <StatTile label="Tracked servers" loading={loading} value={fmtInt(k?.servers_tracked)} sub={k ? `${fmtInt(k.servers_ever_online)} ever online` : null} />
    </div>
  );
}
