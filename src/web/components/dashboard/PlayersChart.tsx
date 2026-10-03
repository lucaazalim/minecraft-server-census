import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/common/ChartCard';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { useTimeseries } from '@/lib/api';
import { fmtInt } from '@/lib/format';
import { AXIS, compactTick, timeTick, timeTitle, TooltipFrame } from './chart-common';

const config = { players: { label: 'Players online', color: 'var(--chart-1)' } } satisfies ChartConfig;

function bucketLabel(bucketSec: number): string {
  if (bucketSec === 0) return 'one point per sweep';
  if (bucketSec === 3600) return 'hourly average';
  return `${bucketSec / 3600}-hour average`;
}

export function PlayersChart({ scope, hours }: { scope: string; hours: number }) {
  const q = useTimeseries(scope, hours);
  const points = q.data?.points ?? [];
  const bucket = q.data?.bucketSec ?? 0;
  const span = points.length ? points[points.length - 1]!.t - points[0]!.t : 0;
  const tick = timeTick(hours, span);
  return (
    <ChartCard
      title="Players online"
      description={`De-duplicated sum across all responding servers · ${bucketLabel(bucket)}`}
      loading={q.isLoading}
      fetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      empty={!q.isLoading && points.length < 2 ? 'Not enough sweeps yet for this range.' : undefined}
      contentClassName="h-[320px]"
    >
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <AreaChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="players-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-players)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--color-players)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tick} minTickGap={48} {...AXIS} />
          <YAxis tickFormatter={compactTick} width={44} {...AXIS} />
          <ChartTooltip
            cursor={{ stroke: 'var(--border)' }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as (typeof points)[number] | undefined;
              if (!active || !p) return null;
              const rows = [{ label: 'Players', value: fmtInt(p.players), color: 'var(--chart-1)' }];
              if (bucket > 0) rows.push({ label: 'Peak in bucket', value: fmtInt(p.players_peak), color: '' });
              rows.push({ label: 'Servers online', value: fmtInt(p.groups_online), color: '' });
              return <TooltipFrame title={timeTitle(p.t)} rows={rows} />;
            }}
          />
          <Area dataKey="players" type="monotone" stroke="var(--color-players)" strokeWidth={2} fill="url(#players-fill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--background)' }} isAnimationActive={false} />
        </AreaChart>
      </ChartContainer>
    </ChartCard>
  );
}
