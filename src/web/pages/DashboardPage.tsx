import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { ErrorState } from '@/components/common/ErrorState';
import { CountriesChart, ProbesChart, SoftwareChart, VersionsChart } from '@/components/dashboard/BreakdownCharts';
import { CollectorCard } from '@/components/dashboard/CollectorCard';
import { KpiRow } from '@/components/dashboard/KpiRow';
import { PlayersChart } from '@/components/dashboard/PlayersChart';
import { HourlyChart, WeekdayChart } from '@/components/dashboard/ProfileCharts';
import { ServersChart } from '@/components/dashboard/ServersChart';
import { ServersTable } from '@/components/dashboard/ServersTable';
import { TopServersChart } from '@/components/dashboard/TopServersChart';
import { RangeToggle } from '@/components/filters/RangeToggle';
import { ScopeSelect } from '@/components/filters/ScopeSelect';
import { PageContainer } from '@/components/layout/PageShell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboardParams } from '@/hooks/use-dashboard-params';
import { useOverview } from '@/lib/api';
import { SITE_TAGLINE } from '@/lib/site';

export function DashboardPage() {
  const { scope, range, hours, days, setScope, setRange, search } = useDashboardParams();
  const overview = useOverview(scope);
  const firstRun = overview.data && !overview.data.lastSweep;
  const location = useLocation();
  const hasData = overview.data != null;

  // The collector card only exists once the overview has loaded, so the browser cannot honour `/#collector` on its own
  // (and client-side navigation from another page never scrolls to a hash). `location.key` re-triggers for repeat clicks.
  useEffect(() => {
    if (!hasData || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hasData, location.hash, location.key]);

  return (
    <>
      <div className="sr-only">
        <h1>{SITE_TAGLINE}</h1>
      </div>
      <div className="sticky top-14 z-10 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/60">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6">
          <ScopeSelect value={scope} onChange={setScope} />
          <RangeToggle value={range} onChange={setRange} size="default" />
        </div>
      </div>
      <PageContainer>
        <div className="flex flex-col gap-6">
          {overview.error ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : null}

          {firstRun ? (
            <Card>
              <CardHeader>
                <CardTitle>First sweep in progress</CardTitle>
                <CardDescription>Data appears in a few minutes, once every tracked server has been pinged for the first time.</CardDescription>
              </CardHeader>
              <CardContent>{overview.data ? <CollectorCard data={overview.data} /> : null}</CardContent>
            </Card>
          ) : (
            <>
              <KpiRow data={overview.data} loading={overview.isLoading} />
              <PlayersChart scope={scope} hours={hours} />
              <TopServersChart scope={scope} hours={hours} search={search} />
              <div className="grid gap-6 md:grid-cols-2">
                <ServersChart scope={scope} hours={hours} />
                <HourlyChart scope={scope} days={days} />
                <WeekdayChart scope={scope} days={days} />
                <VersionsChart scope={scope} />
                <ProbesChart scope={scope} />
                <SoftwareChart scope={scope} />
                <CountriesChart scope={scope} />
              </div>
              <ServersTable scope={scope} search={search} />
              {overview.data ? <CollectorCard data={overview.data} /> : null}
            </>
          )}
        </div>
      </PageContainer>
    </>
  );
}
