import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from 'cn';
import type { ReactNode } from 'react';

export function StatTile({ label, value, sub, hero = false, loading = false, title }: { label: string; value: ReactNode; sub?: ReactNode; hero?: boolean; loading?: boolean; title?: string }) {
  return (
    <Card className="gap-1 px-5 py-4" title={title}>
      <div className="text-sm text-muted-foreground">{label}</div>
      {loading ? (
        <Skeleton className={cn('mt-1 h-8 w-24', hero && 'h-10 w-32')} />
      ) : (
        <div className={cn('font-semibold tracking-tight', hero ? 'text-4xl' : 'text-3xl')}>{value}</div>
      )}
      <div className="min-h-5 text-xs text-muted-foreground">{loading ? null : sub}</div>
    </Card>
  );
}
