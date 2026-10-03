import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/common/ChartCard';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { useProfile } from '@/lib/api';
import { fmtInt, localTimezone } from '@/lib/format';
import { hourlyProfile, weekdayProfile, WEEKDAYS } from '@/lib/profile';
import { AXIS, compactTick, TooltipFrame } from './chart-common';

const config = { avg: { label: 'Average players', color: 'var(--chart-1)' } } satisfies ChartConfig;

const hourLabel = (h: number) => `${h.toString().padStart(2, '0')}:00`;

export function HourlyChart({ scope, days }: { scope: string; days: number }) {
  const q = useProfile(scope, days);
  const rows = useMemo(() => hourlyProfile(q.data?.points ?? []), [q.data]);
  const hasData = rows.some((r) => r.samples > 0);
  return (
    <ChartCard
      title="Players by hour of day"
      description={`Average players per local hour · ${localTimezone()}`}
      loading={q.isLoading}
      fetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      empty={!q.isLoading && !hasData ? 'No sweeps in this range yet.' : undefined}
      contentClassName="h-[260px]"
    >
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <BarChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="hour" tickFormatter={(h: number) => (h % 6 === 0 ? hourLabel(h) : '')} interval={0} {...AXIS} />
          <YAxis tickFormatter={compactTick} width={40} {...AXIS} />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)' }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
              if (!active || !p) return null;
              return <TooltipFrame title={`${hourLabel(p.hour)} – ${hourLabel((p.hour + 1) % 24)}`} rows={[{ label: 'Average players', value: fmtInt(p.avg) }, { label: 'Sweeps', value: fmtInt(p.samples) }]} />;
            }}
          />
          <Bar dataKey="avg" fill="var(--color-avg)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

export function WeekdayChart({ scope, days }: { scope: string; days: number }) {
  const q = useProfile(scope, days);
  const rows = useMemo(() => weekdayProfile(q.data?.points ?? []).map((r) => ({ ...r, label: WEEKDAYS[r.weekday]! })), [q.data]);
  const hasData = rows.some((r) => r.samples > 0);
  return (
    <ChartCard
      title="Players by weekday"
      description={`Average players per local weekday · ${localTimezone()}`}
      loading={q.isLoading}
      fetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      empty={!q.isLoading && !hasData ? 'No sweeps in this range yet.' : undefined}
      contentClassName="h-[260px]"
    >
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <BarChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} barCategoryGap={8}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" interval={0} {...AXIS} />
          <YAxis tickFormatter={compactTick} width={40} {...AXIS} />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)' }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
              if (!active || !p) return null;
              return <TooltipFrame title={p.label} rows={[{ label: 'Average players', value: fmtInt(p.avg) }, { label: 'Sweeps', value: fmtInt(p.samples) }]} />;
            }}
          />
          <Bar dataKey="avg" fill="var(--color-avg)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}
