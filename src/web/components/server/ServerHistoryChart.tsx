import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/common/ChartCard';
import { RangeToggle } from '@/components/filters/RangeToggle';
import { AXIS, compactTick, timeTick, timeTitle, TooltipFrame } from '@/components/dashboard/chart-common';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import type { Range } from '@/hooks/use-dashboard-params';
import { fmtInt, fmtLatency, fmtPct } from '@/lib/format';
import type { ServerPage } from '@/lib/types';

const config = { players: { label: 'Players', color: 'var(--chart-1)' } } satisfies ChartConfig;

export function ServerHistoryChart({ data, range, onRange, fetching }: { data: ServerPage; range: Range; onRange: (r: Range) => void; fetching: boolean }) {
  const points = data.history;
  const span = points.length ? points[points.length - 1]!.t - points[0]!.t : 0;
  const tick = timeTick(data.hours, span);
  const st = data.stats;
  const stats = [
    { label: 'Average', value: fmtInt(st.avg_players) },
    { label: 'Max', value: fmtInt(st.max_players) },
    { label: 'Latency', value: fmtLatency(st.avg_latency) },
    { label: 'Reachable', value: st.pings ? fmtPct((100 * st.ok) / st.pings, 0) : '–' },
  ];
  return (
    <ChartCard
      title="Players"
      description={data.bucketSec ? `Hourly average${data.bucketSec > 3600 ? ` (${data.bucketSec / 3600}h)` : ''} · gaps are outages` : 'One point per sweep · gaps are outages'}
      action={<RangeToggle value={range} onChange={onRange} exclude={['all']} />}
      fetching={fetching}
      empty={points.length < 2 ? 'Not enough pings in this range yet.' : undefined}
      contentClassName="h-[300px]"
    >
      <div className="flex h-full flex-col gap-3">
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {stats.map((s) => (
            <div key={s.label} className="flex gap-1.5">
              <dt className="text-muted-foreground">{s.label}</dt>
              <dd className="font-medium tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>
        <ChartContainer config={config} className="aspect-auto min-h-0 w-full flex-1">
          <AreaChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="server-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-players)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--color-players)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tick} minTickGap={48} {...AXIS} />
            <YAxis tickFormatter={compactTick} width={40} {...AXIS} />
            <ChartTooltip
              cursor={{ stroke: 'var(--border)' }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as (typeof points)[number] | undefined;
                if (!active || !p) return null;
                if (p.ok !== 1 || p.players == null) return <TooltipFrame title={timeTitle(p.t)} rows={[{ label: 'Status', value: 'offline' }]} />;
                const rows = [{ label: 'Players', value: fmtInt(p.players), color: 'var(--chart-1)' }];
                if (data.bucketSec > 0) rows.push({ label: 'Peak in bucket', value: fmtInt(p.players_peak), color: '' });
                rows.push({ label: 'Latency', value: fmtLatency(p.latency), color: '' });
                return <TooltipFrame title={timeTitle(p.t)} rows={rows} />;
              }}
            />
            <Area dataKey="players" type="monotone" connectNulls={false} stroke="var(--color-players)" strokeWidth={2} fill="url(#server-fill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--background)' }} isAnimationActive={false} />
          </AreaChart>
        </ChartContainer>
      </div>
    </ChartCard>
  );
}
