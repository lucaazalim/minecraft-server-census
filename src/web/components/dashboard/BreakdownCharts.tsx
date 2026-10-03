import { useMemo } from 'react';
import { ChartCard } from '@/components/common/ChartCard';
import { useCountries, useProbes, useSoftware, useVersions } from '@/lib/api';
import { countryName } from '@/lib/countries';
import { fmtDateTime, fmtInt, fmtPct } from '@/lib/format';
import { HBarChart, type HBarRow } from './chart-common';

function topN<T>(rows: T[], n: number, value: (r: T) => number, label: (r: T) => string, extra?: (r: T) => HBarRow['extra']): HBarRow[] {
  const sorted = [...rows].sort((a, b) => value(b) - value(a));
  const head = sorted.slice(0, n).map((r) => ({ label: label(r), value: value(r), extra: extra?.(r) }));
  const rest = sorted.slice(n);
  if (rest.length) head.push({ label: `Other (${rest.length})`, value: rest.reduce((a, r) => a + value(r), 0), extra: undefined });
  return head;
}

export function VersionsChart({ scope }: { scope: string }) {
  const q = useVersions(scope);
  const rows = useMemo(
    () =>
      topN(
        q.data?.byFamily ?? [],
        12,
        (r) => r.servers,
        (r) => r.family,
        (r) => [{ label: 'Players', value: fmtInt(r.players) }],
      ),
    [q.data],
  );
  return (
    <ChartCard title="Versions" description="Distinct servers online by reported protocol family" loading={q.isLoading} fetching={q.isFetching} error={q.error} onRetry={() => void q.refetch()} empty={!q.isLoading && !rows.length ? 'No servers online.' : undefined}>
      <HBarChart rows={rows} unit="Servers" height={Math.max(180, rows.length * 22 + 20)} />
    </ChartCard>
  );
}

export function SoftwareChart({ scope }: { scope: string }) {
  const q = useSoftware(scope);
  const rows = useMemo(
    () =>
      topN(
        q.data?.rows ?? [],
        10,
        (r) => r.servers,
        (r) => r.software,
        (r) => [{ label: 'Players', value: fmtInt(r.players) }],
      ),
    [q.data],
  );
  const f = q.data?.flags;
  const desc = f
    ? `${fmtInt(f.online)} distinct servers online · ${fmtInt(f.modded ?? 0)} modded · ${fmtInt(f.proxies ?? 0)} behind a proxy · ${fmtInt(f.enforces_secure_chat ?? 0)} enforce secure chat`
    : 'Server software as reported in the status response';
  return (
    <ChartCard title="Software" description={desc} loading={q.isLoading} fetching={q.isFetching} error={q.error} onRetry={() => void q.refetch()} empty={!q.isLoading && !rows.length ? 'No servers online.' : undefined}>
      <HBarChart rows={rows} unit="Servers" height={Math.max(180, rows.length * 22 + 20)} />
    </ChartCard>
  );
}

export function ProbesChart({ scope }: { scope: string }) {
  const q = useProbes(scope);
  const rows = useMemo<HBarRow[]>(
    () =>
      (q.data?.rows ?? [])
        .filter((r) => r.pct != null)
        .sort((a, b) => b.protocol - a.protocol)
        .map((r) => ({ label: `${r.label} (${r.protocol})`, value: r.pct ?? 0, extra: [{ label: 'Accepted by', value: `${fmtInt(r.supported)} of ${fmtInt(r.responded)}` }] })),
    [q.data],
  );
  const last = q.data?.lastRun.ts;
  return (
    <ChartCard
      title="Client versions accepted"
      description={last ? `Share of distinct servers that accept each client version · last probed ${fmtDateTime(last)}` : 'Share of distinct servers that accept each client version'}
      loading={q.isLoading}
      fetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      empty={!q.isLoading && !rows.length ? 'No version probe has run yet.' : undefined}
    >
      <HBarChart rows={rows} unit="Accepting" valueFormatter={(v) => fmtPct(v)} height={Math.max(180, rows.length * 22 + 20)} />
    </ChartCard>
  );
}

export function CountriesChart({ scope }: { scope: string }) {
  const q = useCountries();
  const rows = useMemo<HBarRow[]>(() => {
    const all = (q.data?.rows ?? []).filter((r) => r.players > 0 || r.online > 0);
    const out = topN(
      all,
      12,
      (r) => r.players,
      (r) => (r.country ? countryName(r.country) : 'Unknown'),
      (r) => [
        { label: 'Distinct servers online', value: fmtInt(r.groups_online) },
        { label: 'Tracked', value: fmtInt(r.servers) },
      ],
    );
    // A country scope highlights its bar; a region scope highlights every member country.
    const region = q.data?.regions.find((r) => r.code === scope);
    const selected = new Set(region ? region.countries.map(countryName) : scope !== 'all' ? [countryName(scope)] : []);
    return out.map((r) => ({ ...r, highlight: selected.has(r.label) }));
  }, [q.data, scope]);
  return (
    <ChartCard className="md:col-span-2" title="Players by country" description="Players online per country (all tracked servers, latest sweep)" loading={q.isLoading} fetching={q.isFetching} error={q.error} onRetry={() => void q.refetch()} empty={!q.isLoading && !rows.length ? 'No servers online.' : undefined}>
      <HBarChart rows={rows} unit="Players" height={Math.max(180, rows.length * 22 + 20)} />
    </ChartCard>
  );
}
