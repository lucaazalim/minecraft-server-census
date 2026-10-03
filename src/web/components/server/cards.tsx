import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Favicon } from '@/components/common/Favicon';
import { Motd } from '@/components/common/Motd';
import { RelativeTime } from '@/components/common/RelativeTime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { countryName, flagEmoji } from '@/lib/countries';
import { BLOCKLIST_VIA, MERGE_REASON_LABEL, MERGE_REASON_TEXT, sourceLabel } from '@/lib/dedup';
import { fmtDateTime, fmtInt, fmtLatency, fmtPct } from '@/lib/format';
import type { GroupMember, ServerPage } from '@/lib/types';
import { cn } from 'cn';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';

// ---- small building blocks -----------------------------------------------------

function SectionCard({ title, description, children, id, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <Card id={id} className={cn('gap-4', className)}>
      <CardHeader className="gap-1">
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  );
}

function Rows({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[7.5rem_1fr] gap-3 py-1.5">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="min-w-0 break-words">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const yesNo = (v: number | null | undefined) => (v == null ? '–' : v ? 'Yes' : 'No');
const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-xs">{children}</span>;

// ---- Current status ---------------------------------------------------------------

export function StatusCard({ data }: { data: ServerPage }) {
  const s = data.server;
  const sample = s.last_sample.slice(0, 12);
  return (
    <SectionCard title="Current status" description={s.last_online_at ? <>As reported <RelativeTime at={s.last_online_at} /></> : 'Never seen online'}>
      <Motd description={s.motd_raw} fallback={s.last_motd} className="mb-4" />
      <Rows
        rows={[
          {
            label: 'Players',
            value: (
              <>
                {fmtInt(s.last_players_online)} <span className="text-muted-foreground">/ {fmtInt(s.last_players_max)}</span>
              </>
            ),
          },
          { label: 'Version', value: s.last_version_name ? `${s.last_version_name} · protocol ${s.last_protocol} (${s.protocol_label})` : '–' },
          { label: 'Software', value: s.last_software ? `${s.last_software}${s.is_proxy ? ' (proxy)' : ''}` : '–' },
          { label: 'Ping method', value: s.last_method ? (s.last_method === 'legacy' ? 'legacy (pre-1.7 status)' : 'modern status') : '–' },
          { label: 'Latency', value: fmtLatency(s.last_latency_ms) },
          { label: 'Secure chat', value: `enforced: ${yesNo(s.enforces_secure_chat)} · reports prevented: ${yesNo(s.prevents_chat_reports)}` },
          { label: 'Mods', value: s.mod_count != null ? `${fmtInt(s.mod_count)} mods reported` : 'none reported' },
          {
            label: 'Player sample',
            value: sample.length ? (
              <div className="flex flex-wrap gap-1">
                {sample.map((p, i) => (
                  <Badge key={`${p.id}-${i}`} variant="secondary" title={p.id ?? undefined}>
                    {p.name.replace(/§./g, '') || '(unnamed)'}
                  </Badge>
                ))}
                {s.last_sample.length > 12 ? <span className="text-xs text-muted-foreground">+{s.last_sample.length - 12} more</span> : null}
              </div>
            ) : (
              <span className="text-muted-foreground">none</span>
            ),
          },
        ]}
      />
    </SectionCard>
  );
}

// ---- Client versions accepted -------------------------------------------------------

export function ProbesCard({ data }: { data: ServerPage }) {
  const rows = [...data.probes].sort((a, b) => b.protocol_sent - a.protocol_sent);
  return (
    <SectionCard title="Client versions accepted" description="Probed once a day; a version counts as accepted when the server echoes the protocol back.">
      {rows.length ? (
        <div className="flex flex-wrap gap-1.5">
          {rows.map((p) => (
            <Tooltip key={p.protocol_sent}>
              <TooltipTrigger
                render={
                  <Badge variant={p.supported ? 'secondary' : 'outline'} className={cn('h-6 gap-1 px-2 text-xs', p.supported ? 'text-foreground' : 'text-muted-foreground')} />
                }
              >
                {p.supported ? <CheckIcon className="text-emerald-600 dark:text-emerald-400" /> : <XIcon />}
                {p.label_sent} <span className="opacity-60">({p.protocol_sent})</span>
              </TooltipTrigger>
              <TooltipContent>
                {p.ok ? `Answered "${p.version_name ?? '?'}" (protocol ${p.protocol_received ?? '?'} = ${p.label_received})` : `No answer: ${p.error ?? 'error'}`} · {fmtDateTime(p.ts)}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : (
        <span className="text-muted-foreground">Not probed yet.</span>
      )}
    </SectionCard>
  );
}

// ---- Status history -----------------------------------------------------------------

export function SnapshotsCard({ data }: { data: ServerPage }) {
  return (
    <SectionCard title="Status history" description="Every distinct status payload seen (MOTD, version, max players, mods); player counts are ignored when comparing." className="overflow-hidden">
      {data.snapshots.length ? (
        <div className="-mx-6 overflow-x-auto">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">First seen</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="text-right">Seen</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Max</TableHead>
                <TableHead>MOTD</TableHead>
                <TableHead className="pr-6">Mods</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.snapshots.map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="pl-6 whitespace-nowrap">{fmtDateTime(n.first_seen)}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtDateTime(n.last_seen)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtInt(n.seen_count)}×</TableCell>
                  <TableCell className="max-w-32 truncate" title={n.version_name ?? ''}>
                    {n.version_name ?? '–'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtInt(n.players_max)}</TableCell>
                  <TableCell className="max-w-56 truncate text-muted-foreground" title={n.motd ?? ''}>
                    {(n.motd ?? '').replace(/\s+/g, ' ').trim()}
                  </TableCell>
                  <TableCell className="pr-6 whitespace-nowrap">{n.mod_count != null ? `${fmtInt(n.mod_count)} (${n.mod_kind ?? '?'})` : '–'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <span className="text-muted-foreground">No status payload recorded yet.</span>
      )}
    </SectionCard>
  );
}

// ---- Details ---------------------------------------------------------------------------

export function DetailsCard({ data }: { data: ServerPage }) {
  const s = data.server;
  const location = [s.city, s.region, s.geo_country ? countryName(s.geo_country) : null].filter(Boolean).join(', ');
  const countryVia = s.country_override ? 'set by the operator' : s.tld_country ? 'from the domain' : s.geo_country ? 'from GeoIP' : null;
  const network = [s.org, s.isp && s.isp !== s.org ? s.isp : null, s.asn].filter(Boolean).join(' · ');
  const otherEndpoints = s.endpoints.filter((e) => e !== `${s.resolved_ip}:${s.resolved_port ?? 25565}`);
  return (
    <SectionCard title="Details">
      <Rows
        rows={[
          { label: 'Address', value: <Mono>{s.address}</Mono> },
          ...(s.srv_target ? [{ label: 'SRV target', value: <Mono>{s.srv_target}</Mono> }] : []),
          { label: 'Resolves to', value: s.resolved_ip ? <Mono>{s.resolved_ip}:{s.resolved_port ?? 25565}</Mono> : s.dns_error ? <span className="text-muted-foreground">DNS error: {s.dns_error}</span> : '–' },
          ...(otherEndpoints.length ? [{ label: 'Also seen at', value: <Mono>{otherEndpoints.join(', ')}</Mono> }] : []),
          ...(s.dns_targets.length ? [{ label: 'DNS chain', value: <Mono>{s.dns_targets.join(' → ')}</Mono> }] : []),
          { label: 'Country', value: s.country ? `${flagEmoji(s.country)} ${countryName(s.country)} (${countryVia})` : 'Unknown' },
          { label: 'Hosted in', value: location ? `${flagEmoji(s.geo_country)} ${location}`.trim() : 'Unknown (GeoIP pending)' },
          ...(network ? [{ label: 'Network', value: network }] : []),
          { label: 'First tracked', value: fmtDateTime(s.added_at) },
          { label: 'First online', value: fmtDateTime(s.first_online_at) },
          { label: 'Last online', value: fmtDateTime(s.last_online_at) },
          { label: 'Last checked', value: <RelativeTime at={s.last_ping_at} /> },
          { label: 'Uptime', value: s.uptime_pct != null ? `${fmtPct(s.uptime_pct)} of ${fmtInt(s.total_pings)} pings` : '–' },
          { label: 'Peak players', value: s.peak_players != null ? `${fmtInt(s.peak_players)} · ${fmtDateTime(s.peak_at)}` : '–' },
          { label: 'Discovered via', value: s.source ? sourceLabel(s.source) : '–' },
        ]}
      />
    </SectionCard>
  );
}

// ---- Blocklist ---------------------------------------------------------------------------

export function BlocklistCard({ data, checkedAt }: { data: ServerPage; checkedAt?: number | null }) {
  const b = data.blocked;
  return (
    <SectionCard title="Mojang blocklist" description="Servers whose address hash appears on Mojang's blockedservers list cannot be joined from the vanilla client.">
      {b ? (
        <Rows
          rows={[
            { label: 'Listed', value: <Badge variant="destructive">Blocked</Badge> },
            { label: 'Pattern', value: <Mono>{b.pattern}</Mono> },
            { label: 'Matched via', value: BLOCKLIST_VIA[b.via] ?? b.via },
            { label: 'Since', value: fmtDateTime(b.first_seen) },
          ]}
        />
      ) : (
        <span className="text-muted-foreground">
          Not on the list{checkedAt ? <> (checked <RelativeTime at={checkedAt} />)</> : null}.
        </span>
      )}
    </SectionCard>
  );
}

// ---- De-duplication ---------------------------------------------------------------------

function evidenceLine(m: GroupMember): string {
  const e = m.evidence;
  if (!e) return '';
  const parts: string[] = [];
  if (e.shared_endpoints.length) parts.push(`shares ${e.shared_endpoints.slice(0, 2).join(', ')}${e.shared_endpoints.length > 2 ? ` +${e.shared_endpoints.length - 2}` : ''}`);
  if (e.shared_dns_targets.length) parts.push(`same DNS target ${e.shared_dns_targets[0]}`);
  if (e.same_favicon) parts.push('same favicon');
  if (e.same_motd) parts.push('same MOTD');
  if (e.same_domain) parts.push('same domain');
  if (e.players_delta_pct != null) parts.push(`counts ${e.players_agree ? 'within' : 'differ by'} ${e.players_delta_pct}%`);
  return parts.join(' · ');
}

export function DedupCard({ data, search }: { data: ServerPage; search: string }) {
  const g = data.group;
  const offline = data.server.last_ok !== 1;
  return (
    <SectionCard title="De-duplication" description={`Hostnames judged to be the same server are counted once; totals use the group's highest player count (counts within ${g.tolerance_pct}% are treated as the same pool).`}>
      {offline ? (
        <span className="text-muted-foreground">Offline in the last sweep; de-duplication is only evaluated for servers that answered.</span>
      ) : g.members.length <= 1 ? (
        <span className="text-muted-foreground">No other hostname was merged into this server.</span>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span>
              <span className="text-muted-foreground">Counted</span> <span className="font-medium tabular-nums">{fmtInt(g.players_counted)}</span>
            </span>
            <span>
              <span className="text-muted-foreground">Sum of hostnames</span> <span className="font-medium tabular-nums">{fmtInt(g.players_raw)}</span>
            </span>
            <span>
              <span className="text-muted-foreground">Hostnames</span> <span className="font-medium tabular-nums">{g.members.length}</span>
            </span>
          </div>
          <ul className="divide-y">
            {g.members.map((m) => (
              <li key={m.id} className="flex gap-3 py-2">
                <Favicon id={m.id} has={m.has_favicon} size={24} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {m.id === data.server.id ? <span className="font-medium">{m.address}</span> : <Link to={`/server/${encodeURIComponent(m.address)}${search}`} className="font-medium underline-offset-2 hover:underline">{m.address}</Link>}
                    <span className="tabular-nums text-muted-foreground">{fmtInt(m.players)} players</span>
                    {m.is_representative ? (
                      <Badge variant="outline">representative</Badge>
                    ) : m.reason ? (
                      <Tooltip>
                        <TooltipTrigger render={<Badge variant="secondary" />}>{MERGE_REASON_LABEL[m.reason]}</TooltipTrigger>
                        <TooltipContent>{MERGE_REASON_TEXT[m.reason]}</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                  {m.evidence ? <div className="mt-0.5 text-xs text-muted-foreground">{evidenceLine(m) || 'linked through another member of the group'}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}

// ---- Neighbours -----------------------------------------------------------------------------

export function NeighborsCard({ data, search }: { data: ServerPage; search: string }) {
  const others = data.neighbors.filter((n) => !n.in_group);
  if (!others.length) return null;
  const ep = `${data.server.resolved_ip}:${data.server.resolved_port ?? 25565}`;
  return (
    <SectionCard title="Same address, not merged" description={`${others.length} other hostname${others.length === 1 ? '' : 's'} answer on ${ep} but differ in players, MOTD or favicon, so they are counted separately (typical of shared hosting and proxies).`}>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" />}>
          <ChevronDownIcon data-icon="inline-start" className="transition-transform group-aria-expanded/button:rotate-180" /> Show hostnames
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 divide-y text-xs">
            {others.map((n) => (
              <li key={n.id} className="flex items-center gap-2 py-1.5">
                <span className={cn('size-2 shrink-0 rounded-full', n.last_ok === 1 ? 'bg-emerald-500' : 'bg-muted-foreground/40')} aria-label={n.last_ok === 1 ? 'online' : 'offline'} />
                <Link to={`/server/${encodeURIComponent(n.address)}${search}`} className="truncate font-medium underline-offset-2 hover:underline">
                  {n.address}
                </Link>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{n.last_ok === 1 ? `${fmtInt(n.last_players_online)} players` : 'offline'}</span>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </SectionCard>
  );
}
