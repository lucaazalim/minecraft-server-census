import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/common/ChartCard';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { useTimeseries } from '@/lib/api';
import { fmtInt } from '@/lib/format';
import { AXIS, compactTick, timeTick, timeTitle, TooltipFrame } from './chart-common';

const config = {
  groups_online: { label: 'Distinct servers', color: 'var(--chart-1)' },
  servers_online: { label: 'Hostnames', color: 'var(--chart-2)' },
} satisfies ChartConfig;

export function ServersChart({ scope, hours }: { scope: string; hours: number }) {
  const q = useTimeseries(scope, hours);
  const points = q.data?.points ?? [];
  const span = points.length ? points[points.length - 1]!.t - points[0]!.t : 0;
  const tick = timeTick(hours, span);
  return (
    <ChartCard
      title="Servers online"
      description="Distinct servers after de-duplication vs hostnames that answered"
      loading={q.isLoading}
      fetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      empty={!q.isLoading && points.length < 2 ? 'Not enough sweeps yet for this range.' : undefined}
      contentClassName="h-[260px]"
    >
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <LineChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tick} minTickGap={48} {...AXIS} />
          <YAxis tickFormatter={compactTick} width={40} {...AXIS} />
          <ChartTooltip
            cursor={{ stroke: 'var(--border)' }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as (typeof points)[number] | undefined;
              if (!active || !p) return null;
              return (
                <TooltipFrame
                  title={timeTitle(p.t)}
                  rows={[
                    { label: 'Distinct servers', value: fmtInt(p.groups_online), color: 'var(--chart-1)' },
                    { label: 'Hostnames', value: fmtInt(p.servers_online), color: 'var(--chart-2)' },
                  ]}
                />
              );
            }}
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Line dataKey="groups_online" type="monotone" stroke="var(--color-groups_online)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--background)' }} isAnimationActive={false} />
          <Line dataKey="servers_online" type="monotone" stroke="var(--color-servers_online)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--background)' }} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
    </ChartCard>
  );
}
