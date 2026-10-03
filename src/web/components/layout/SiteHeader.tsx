import { Link } from 'react-router';
import { RelativeTime } from '@/components/common/RelativeTime';
import { useOverview } from '@/lib/api';
import { fmtInt } from '@/lib/format';
import { SITE_NAME, SITE_SHORT_NAME } from '@/lib/site';
import { ThemeToggle } from './ThemeToggle';

export function SiteHeader() {
  const { data } = useOverview('all');
  return (
    <header className="sticky top-0 z-10 h-14 border-b bg-background">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span aria-hidden className="grid size-6 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">MC</span>
          <span className="hidden sm:inline">{SITE_NAME}</span>
          <span className="sm:hidden">{SITE_SHORT_NAME}</span>
        </Link>
        <div className="flex items-center gap-3">
          {data ? (
            <span className="hidden text-xs text-muted-foreground md:inline">
              {fmtInt(data.kpis.servers_tracked)} servers tracked
              {data.lastSweep ? (
                <>
                  {' · '}updated <RelativeTime at={data.lastSweep.finished_at} />
                </>
              ) : null}
            </span>
          ) : null}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
