import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CountryFlag } from '@/components/common/CountryFlag';
import { ErrorState } from '@/components/common/ErrorState';
import { Favicon } from '@/components/common/Favicon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDebounced } from '@/hooks/use-debounced';
import { useServers } from '@/lib/api';
import { fmtInt, fmtLatency, fmtPct } from '@/lib/format';
import type { ServerListParams } from '@/lib/types';
import { cn } from 'cn';
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon } from 'lucide-react';

type Sort = NonNullable<ServerListParams['sort']>;
type Status = NonNullable<ServerListParams['status']>;
const STATUS: { value: Status; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'all', label: 'All' },
];
const LIMIT = 50;

function SortHead({ col, label, sort, dir, onSort, className }: { col: Sort; label: string; sort: Sort; dir: 'asc' | 'desc'; onSort: (c: Sort) => void; className?: string }) {
  const active = sort === col;
  return (
    <TableHead className={className}>
      <button type="button" onClick={() => onSort(col)} className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground')} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        {label}
        {active ? dir === 'asc' ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" /> : null}
      </button>
    </TableHead>
  );
}

export function ServersTable({ scope, search }: { scope: string; search: string }) {
  const [qText, setQText] = useState('');
  const q = useDebounced(qText.trim(), 300);
  const [status, setStatus] = useState<Status>('online');
  const [sort, setSort] = useState<Sort>('players');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [q, status, scope, sort, dir]);

  const list = useServers({ q, scope, status, sort, dir, page, limit: LIMIT });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const onSort = (c: Sort) => {
    if (c === sort) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(c);
      setDir(c === 'host' ? 'asc' : 'desc');
    }
  };

  return (
    <Card className="gap-4">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Servers</CardTitle>
            <CardDescription className="mt-0.5 text-xs">{list.data ? `${fmtInt(total)} ${status === 'online' ? 'online' : status === 'offline' ? 'offline' : ''} servers${q ? ' matching your search (aliases included)' : ''}` : 'Every tracked server, one row per distinct server'}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Search host, MOTD, IP…" className="w-56 pl-8" aria-label="Search servers" />
            </div>
            <Select value={status} onValueChange={(v) => setStatus((v as Status) ?? 'online')} items={STATUS}>
              <SelectTrigger aria-label="Status filter" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn('px-0 transition-opacity', list.isFetching && !list.isLoading && 'opacity-60')}>
        {list.error ? (
          <div className="px-6">
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="text-sm">
              <TableHeader>
                <TableRow className="text-xs">
                  <SortHead col="host" label="Server" sort={sort} dir={dir} onSort={onSort} className="pl-6" />
                  <SortHead col="players" label="Players" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                  <SortHead col="peak" label="Peak" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                  <TableHead>Version</TableHead>
                  <TableHead>Software</TableHead>
                  <SortHead col="latency" label="Latency" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                  <SortHead col="uptime" label="Uptime" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                  <TableHead className="pr-6">MOTD</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.isLoading
                  ? Array.from({ length: 8 }, (_, i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={8} className="px-6">
                          <Skeleton className="h-5 w-full" />
                        </TableCell>
                      </TableRow>
                    ))
                  : list.data?.rows.map((r) => (
                      <TableRow key={r.id} className="group relative cursor-pointer">
                        <TableCell className="pl-6">
                          <div className="flex items-center gap-2">
                            <Favicon id={r.id} has={r.has_favicon} />
                            <Link to={`/server/${encodeURIComponent(r.address)}${search}`} className="font-medium after:absolute after:inset-0 after:content-['']">
                              {r.host}
                              {r.port !== 25565 ? <span className="text-muted-foreground">:{r.port}</span> : null}
                            </Link>
                            <CountryFlag code={r.country} />
                            {r.last_ok !== 1 ? (
                              <Badge variant="outline" className="text-muted-foreground">
                                offline
                              </Badge>
                            ) : null}
                            {r.blocked ? (
                              <Tooltip>
                                <TooltipTrigger render={<Badge variant="destructive" className="relative z-10" />}>Blocked</TooltipTrigger>
                                <TooltipContent>On Mojang's server blocklist: the vanilla client refuses to connect.</TooltipContent>
                              </Tooltip>
                            ) : null}
                            {r.group_reason && r.group_rep_host ? (
                              <Badge variant="secondary">alias of {r.group_rep_host}</Badge>
                            ) : r.group_size && r.group_size > 1 ? (
                              <Badge variant="secondary">+{r.group_size - 1} aliases</Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.last_ok === 1 ? (
                            <>
                              {fmtInt(r.last_players_online)} <span className="text-muted-foreground">/ {fmtInt(r.last_players_max)}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">–</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtInt(r.peak_players)}</TableCell>
                        <TableCell>
                          <div className="leading-tight">
                            <div>{r.protocol_label}</div>
                            {r.last_version_name ? <div className="max-w-40 truncate text-xs text-muted-foreground">{r.last_version_name}</div> : null}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{r.last_software ?? '–'}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtLatency(r.last_latency_ms)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.total_pings ? fmtPct((100 * r.ok_pings) / r.total_pings, 0) : '–'}</TableCell>
                        <TableCell className="pr-6">
                          <div className="max-w-[28rem] truncate text-muted-foreground">{(r.motd ?? '').replace(/\s+/g, ' ').trim()}</div>
                        </TableCell>
                      </TableRow>
                    ))}
                {!list.isLoading && list.data && !list.data.rows.length ? (
                  <TableRow>
                    <TableCell colSpan={8} className="px-6 py-10 text-center text-muted-foreground">
                      No servers match.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        )}
        {pages > 1 ? (
          <div className="flex items-center justify-between gap-3 px-6 pt-4 text-xs text-muted-foreground">
            <span>
              Page {page} of {fmtInt(pages)}
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <ChevronLeftIcon data-icon="inline-start" /> Prev
              </Button>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next <ChevronRightIcon data-icon="inline-end" />
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
