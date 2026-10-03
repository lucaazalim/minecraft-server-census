import { Link } from 'react-router';
import { SITE_NAME } from '@/lib/site';

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t">
      <div className="mx-auto max-w-7xl px-4 py-8 text-xs leading-relaxed text-muted-foreground sm:px-6">
        <p className="max-w-3xl">
          {SITE_NAME} pings every tracked Minecraft Java Edition server every few minutes using the same status request the game client sends. Player counts are
          self-reported by each server and may be inflated or hidden; hostnames that resolve to the same server are merged by a rule-based de-duplication and counted
          once. Nothing here is affiliated with Mojang or Microsoft. See the <Link to="/#collector" className="underline underline-offset-2 hover:text-foreground">collector status</Link> for
          how and how often data is gathered.
        </p>
      </div>
    </footer>
  );
}
