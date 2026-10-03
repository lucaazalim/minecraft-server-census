import { useMemo } from 'react';
import { Link } from 'react-router';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/common/ChartCard';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { useTopServers } from '@/lib/api';
import { fmtInt } from '@/lib/format';
import type { TopServer } from '@/lib/types';
import { AXIS, compactTick, timeTick, timeTitle, TooltipFrame } from './chart-common';

const seriesKey = (i: number) => `s${i}`;
/** Colour follows the rank slot (1st busiest is always --chart-1), so the palette order stays stable across filters. */
const seriesColor = (i: number) => `var(--chart-${i + 1})`;

type Row = Record<string, number | null>;

export function TopServersChart({ scope, hours, search }: { scope: string; hours: number; search: string }) {
  const q = useTopServers(scope, hours);
  const servers = q.data?.servers ?? [];
  const points = q.data?.points ?? [];
  const bucket = q.data?.bucketSec ?? 0;
  const span = points.length ? points[points.length - 1]!.t - points[0]!.t : 0;
  const tick = timeTick(hours, span);

  // Recharts wants one flat key per series; the API sends `values[i]` aligned with `servers[i]`.
  const rows = useMemo<Row[]>(() => points.map((p) => ({ t: p.t, ...Object.fromEntries(p.values.map((v, i) => [seriesKey(i), v])) })), [points]);
  const config = useMemo<ChartConfig>(
    () => Object.fromEntries(servers.map((s, i) => [seriesKey(i), { label: <ServerLabel server={s} search={search} />, color: seriesColor(i) }])),
    [servers, search],
  );

  return (
    <ChartCard
      title="Top servers"
      description={`Players online on the ${servers.length || 5} busiest servers of this range${bucket > 0 ? ' · averages' : ''} · gaps mean the server did not answer`}
      loading={q.isLoading}
      fetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      empty={!q.isLoading && (points.length < 2 || !servers.length) ? 'Not enough sweeps yet for this range.' : undefined}
      contentClassName="h-[340px]"
    >
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <LineChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tick} minTickGap={48} {...AXIS} />
          <YAxis tickFormatter={compactTick} width={44} {...AXIS} />
          <ChartTooltip
            cursor={{ stroke: 'var(--border)' }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as Row | undefined;
              if (!active || !p) return null;
              return <TooltipFrame title={timeTitle(p.t ?? 0)} rows={servers.map((s, i) => ({ label: s.address, value: fmtInt(p[seriesKey(i)]), color: seriesColor(i) }))} />;
            }}
          />
          <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
          {servers.map((s, i) => (
            <Line key={s.id} dataKey={seriesKey(i)} type="monotone" stroke={`var(--color-${seriesKey(i)})`} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--background)' }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ChartContainer>
    </ChartCard>
  );
}

/** Legend entry: the hostname, linking to the server page (keeps the dashboard filters in the URL). */
function ServerLabel({ server, search }: { server: TopServer; search: string }) {
  return (
    <Link to={`/server/${encodeURIComponent(server.address)}${search}`} className="max-w-48 truncate text-foreground hover:underline">
      {server.address}
    </Link>
  );
}
