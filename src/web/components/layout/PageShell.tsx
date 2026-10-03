import type React from 'react';
import { Outlet, useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

export function PageShell() {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />
      <main className="flex flex-1 flex-col">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

/** Centered content column shared by every page. Pages that need full-bleed sections (e.g. the dashboard filter bar) render it themselves. */
export function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-7xl px-4 pt-6 sm:px-6">{children}</div>;
}

export function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />
      <main className="flex flex-1 flex-col">
        <PageContainer>
          <Card className="mx-auto max-w-md">
            <CardHeader>
              <CardTitle>Something went wrong</CardTitle>
              <CardDescription>{message}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => location.reload()}>Reload</Button>
            </CardContent>
          </Card>
        </PageContainer>
      </main>
      <SiteFooter />
    </div>
  );
}
