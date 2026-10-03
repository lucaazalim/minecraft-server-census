import { Link } from 'react-router';
import { CountryFlag } from '@/components/common/CountryFlag';
import { Favicon } from '@/components/common/Favicon';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { MERGE_REASON_LABEL } from '@/lib/dedup';
import { countryName } from '@/lib/countries';
import type { ServerPage } from '@/lib/types';
import { InfoIcon } from 'lucide-react';

export function ServerHeader({ data, search }: { data: ServerPage; search: string }) {
  const s = data.server;
  const online = s.last_ok === 1;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <Favicon id={s.id} has={s.has_favicon} size={64} className="rounded-lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {s.host}
            {s.port !== 25565 ? <span className="text-muted-foreground">:{s.port}</span> : null}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant={online ? 'default' : 'outline'} className={online ? 'bg-emerald-600 text-white dark:bg-emerald-500' : 'text-muted-foreground'}>
              {online ? 'Online' : 'Offline'}
            </Badge>
            {s.last_protocol != null ? <Badge variant="secondary">{s.protocol_label}</Badge> : null}
            {s.last_software ? <Badge variant="secondary">{s.last_software}{s.is_proxy ? ' · proxy' : ''}</Badge> : null}
            {data.blocked ? <Badge variant="destructive">Blocked</Badge> : null}
            {s.country ? (
              <Badge variant="outline">
                <CountryFlag code={s.country} /> {countryName(s.country)}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
      {!data.group.is_representative ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>Counted as part of {data.group.rep.address}</AlertTitle>
          <AlertDescription>
            This hostname was merged into <Link to={`/server/${encodeURIComponent(data.group.rep.address)}${search}`} className="font-medium underline underline-offset-2">{data.group.rep.address}</Link>
            {s.group_reason ? ` (rule: ${MERGE_REASON_LABEL[s.group_reason]})` : ''}; its players are not added to the totals twice.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
