import { RelativeTime } from '@/components/common/RelativeTime';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useNow } from '@/hooks/use-now';
import { sourceLabel } from '@/lib/dedup';
import { fmtDateYear, fmtDuration, fmtInt } from '@/lib/format';
import type { Overview } from '@/lib/types';
import type { ReactNode } from 'react';
import { ChevronDownIcon } from 'lucide-react';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-1.5 sm:grid-cols-[9rem_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function nextIn(at: number | null, now: number): string {
  if (at == null) return '';
  const min = Math.max(0, Math.round((at - now) / 60));
  if (min === 0) return ' · next any moment';
  return min >= 90 ? ` · next in ${Math.round(min / 60)}h` : ` · next in ${min} min`;
}

export function CollectorCard({ data }: { data: Overview }) {
  const now = useNow();
  const { state, config, totals, blocklist, sources } = data.collector;
  const s = state.sweep;
  return (
    <Card id="collector" className="gap-4 scroll-mt-20 text-sm">
      <CardHeader className="gap-1">
        <CardTitle className="text-base">Collector</CardTitle>
        <CardDescription className="text-xs">How the data is gathered. Every tracked server is pinged every {config.pingIntervalMinutes} minutes.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-8 md:grid-cols-2">
          <div>
            <Row label="Sweep">
              {s.running ? (
                <span className="inline-flex items-center gap-2">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                    <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                  </span>
                  #{s.sweepId} running · {fmtInt(s.done)}/{fmtInt(s.total)} pinged, {fmtInt(s.ok)} online
                </span>
              ) : s.lastFinishedAt ? (
                <>
                  last finished <RelativeTime at={s.lastFinishedAt} /> in {fmtDuration(s.lastDurationMs)}
                  {nextIn(s.nextAt, now)}
                </>
              ) : data.lastSweep ? (
                <>
                  last finished <RelativeTime at={data.lastSweep.finished_at} /> in {fmtDuration(data.lastSweep.duration_ms)}
                  {nextIn(s.nextAt, now)}
                </>
              ) : (
                'waiting for the first sweep'
              )}
            </Row>
            <Row label="Version probe">
              {state.probe.running ? `running · ${fmtInt(state.probe.done)}/${fmtInt(state.probe.total)}` : state.probe.lastFinishedAt ? <>last run <RelativeTime at={state.probe.lastFinishedAt} /></> : 'not run yet'}
              {!state.probe.running ? nextIn(state.probe.nextAt, now) : ''}
              <span className="text-muted-foreground"> · {config.probeProtocols.length} client versions every {config.probeIntervalHours}h</span>
            </Row>
            <Row label="GeoIP">
              {config.geoEnabled ? (
                <>
                  {fmtInt(totals.geo_done)}/{fmtInt(totals.servers_total)} located{state.geo.pending ? `, ${fmtInt(state.geo.pending)} pending` : ''}
                  {state.geo.lastError ? <span className="text-muted-foreground"> · last error: {state.geo.lastError}</span> : null}
                </>
              ) : (
                'disabled'
              )}
            </Row>
          </div>
          <div>
            <Row label="Mojang blocklist">
              {config.blocklistEnabled ? (
                <>
                  {fmtInt(blocklist.hashes)} hashes{blocklist.fetchedAt ? <>, refreshed <RelativeTime at={blocklist.fetchedAt} /></> : null} · {fmtInt(blocklist.blocked_total)} tracked servers listed ({fmtInt(blocklist.blocked_online)} online)
                  {blocklist.lastError ? <span className="text-muted-foreground"> · last error: {blocklist.lastError}</span> : null}
                </>
              ) : (
                'disabled'
              )}
            </Row>
            <Row label="Data">
              {fmtInt(totals.pings)} pings over {fmtInt(totals.sweeps)} sweeps{totals.first_sweep_at ? ` since ${fmtDateYear(totals.first_sweep_at)}` : ''}
              <div className="text-muted-foreground">
                {fmtInt(totals.snapshots)} distinct status payloads · {fmtInt(totals.probes)} version probes
              </div>
            </Row>
            <Row label="De-duplication">
              rule-based; counts within {config.dedupTolerancePct}% are treated as the same player pool
            </Row>
          </div>
        </dl>
        <Collapsible className="mt-3">
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" />}>
            <ChevronDownIcon data-icon="inline-start" className="transition-transform group-aria-expanded/button:rotate-180" /> Sources ({sources.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
              {sources.map((src) => (
                <li key={src.source} className="flex justify-between gap-3 rounded-md bg-muted/50 px-2.5 py-1.5">
                  <span className="truncate" title={src.source}>
                    {sourceLabel(src.source)}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {fmtInt(src.servers)} · {fmtInt(src.ever_online)} online
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
