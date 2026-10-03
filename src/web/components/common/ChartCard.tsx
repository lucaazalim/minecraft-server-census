import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from './ErrorState';
import { cn } from 'cn';
import type { ReactNode } from 'react';

export function ChartCard({
  title,
  description,
  action,
  children,
  loading = false,
  fetching = false,
  error,
  onRetry,
  empty,
  className,
  contentClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  loading?: boolean;
  fetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** When set, shown instead of the chart (e.g. "no data yet"). */
  empty?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={cn('gap-4', className)}>
      <CardHeader className="gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{title}</CardTitle>
            {description ? <CardDescription className="mt-0.5 text-xs">{description}</CardDescription> : null}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className={cn('transition-opacity', fetching && !loading && 'opacity-60', contentClassName)}>
        {error ? <ErrorState error={error} onRetry={onRetry} /> : loading ? <Skeleton className="h-full min-h-40 w-full" /> : empty ? <div className="flex h-full min-h-40 items-center justify-center text-sm text-muted-foreground">{empty}</div> : children}
      </CardContent>
    </Card>
  );
}
