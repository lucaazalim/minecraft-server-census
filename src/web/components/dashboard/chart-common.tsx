import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { fmtCompact, fmtDate, fmtDateTime, fmtInt, fmtTime, fmtWeekdayTime } from '@/lib/format';
import type { ReactNode } from 'react';

/** Recessive axes: no axis lines, no tick lines, 11px muted ticks (styled by ChartContainer). */
export const AXIS = { axisLine: false, tickLine: false, tickMargin: 8, fontSize: 11 } as const;
export const GRID = { vertical: false, strokeDasharray: undefined, stroke: 'var(--border)' } as const;

/** Tick formatter for a time axis: format by the span the data actually covers (a 30-day range with one day of history still shows hours). */
export function timeTick(hours: number, spanSec: number): (t: number) => string {
  const span = Math.min(hours > 0 ? hours * 3600 : Infinity, spanSec > 0 ? spanSec : Infinity);
  if (span <= 36 * 3600) return (t) => fmtTime(t);
  if (span <= 8 * 86400) return (t) => fmtWeekdayTime(t);
  return (t) => fmtDate(t);
}

export function TooltipFrame({ title, rows }: { title: ReactNode; rows: { label: string; value: ReactNode; color?: string }[] }) {
  return (
    <div className="min-w-40 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1.5 font-medium">{title}</div>
      <div className="grid gap-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {r.color ? <span className="size-2 rounded-[2px]" style={{ background: r.color }} /> : null}
              {r.label}
            </span>
            <span className="font-medium tabular-nums">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const timeTitle = (t: number) => fmtDateTime(t);

export interface HBarRow {
  label: string;
  value: number;
  /** Extra tooltip lines. */
  extra?: { label: string; value: ReactNode }[];
  highlight?: boolean;
}

/**
 * Horizontal bars for a ranked breakdown: thin marks, rounded data end, value at the tip, tooltip per bar.
 * Text stays in text tokens; only the mark carries the series colour.
 */
export function HBarChart({ rows, unit = '', height = 260, valueFormatter = fmtInt, config }: { rows: HBarRow[]; unit?: string; height?: number; valueFormatter?: (n: number) => string; config?: ChartConfig }) {
  const cfg: ChartConfig = config ?? { value: { label: unit || 'Value', color: 'var(--chart-1)' } };
  const labelWidth = Math.min(160, Math.max(56, ...rows.map((r) => r.label.length * 6.5 + 8)));
  return (
    <ChartContainer config={cfg} className="aspect-auto w-full" style={{ height }}>
      <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 44, top: 4, bottom: 0 }} barCategoryGap={4}>
        <CartesianGrid horizontal={false} vertical stroke="var(--border)" />
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis type="category" dataKey="label" width={labelWidth} {...AXIS} interval={0} />
        <ChartTooltip
          cursor={{ fill: 'var(--muted)' }}
          content={({ active, payload }) => {
            const row = payload?.[0]?.payload as HBarRow | undefined;
            if (!active || !row) return null;
            return <TooltipFrame title={row.label} rows={[{ label: unit || 'Value', value: valueFormatter(row.value) }, ...(row.extra ?? [])]} />;
          }}
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.highlight ? 'var(--chart-2)' : 'var(--color-value)'} />
          ))}
          <LabelList dataKey="value" position="right" offset={6} formatter={(v) => (typeof v === 'number' ? fmtCompact(v) : String(v))} className="fill-muted-foreground" fontSize={11} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

export const compactTick = (v: number) => fmtCompact(v);
