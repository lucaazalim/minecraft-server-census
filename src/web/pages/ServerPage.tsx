import { useState } from 'react';
import { useParams } from 'react-router';
import { ErrorState } from '@/components/common/ErrorState';
import { BlocklistCard, DedupCard, DetailsCard, NeighborsCard, ProbesCard, SnapshotsCard, StatusCard } from '@/components/server/cards';
import { ServerHeader } from '@/components/server/ServerHeader';
import { ServerHistoryChart } from '@/components/server/ServerHistoryChart';
import { Skeleton } from '@/components/ui/skeleton';
import { RANGES, useDashboardParams, type Range } from '@/hooks/use-dashboard-params';
import { ApiError, useOverview, useServer } from '@/lib/api';
import { SITE_NAME } from '@/lib/site';
import { NotFoundPage } from './NotFoundPage';
import { useEffect } from 'react';

export function ServerPage() {
  const { address = '' } = useParams();
  const { search } = useDashboardParams();
  const [range, setRange] = useState<Range>('7d');
  const hours = RANGES.find((r) => r.value === range)!.hours || 168;
  const q = useServer(address, hours);
  const overview = useOverview('all');

  useEffect(() => {
    document.title = `${address} · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, [address]);

  if (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400)) return <NotFoundPage address={address} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <Skeleton className="size-16 rounded-lg" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-5 w-40" />
          </div>
        </div>
        <Skeleton className="h-[300px] w-full" />
      </div>
    );
  }
  const data = q.data;
  return (
    <div className="flex flex-col gap-6">
      <ServerHeader data={data} search={search} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <ServerHistoryChart data={data} range={range} onRange={setRange} fetching={q.isFetching} />
          <StatusCard data={data} />
          <ProbesCard data={data} />
          <SnapshotsCard data={data} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <DetailsCard data={data} />
          <DedupCard data={data} search={search} />
          <BlocklistCard data={data} checkedAt={overview.data?.collector.blocklist.checkedAt} />
          <NeighborsCard data={data} search={search} />
        </div>
      </div>
    </div>
  );
}
