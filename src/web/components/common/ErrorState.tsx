import { Button } from '@/components/ui/button';
import { RefreshCwIcon } from 'lucide-react';

export function ErrorState({ error, onRetry, compact = false }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className={compact ? 'flex flex-wrap items-center gap-3 text-sm text-muted-foreground' : 'flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground'}>
      <span>Could not load: {message}</span>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon data-icon="inline-start" /> Retry
        </Button>
      ) : null}
    </div>
  );
}
