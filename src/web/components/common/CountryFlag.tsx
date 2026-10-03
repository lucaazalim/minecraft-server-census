import { countryName, flagEmoji } from '@/lib/countries';
import { cn } from 'cn';

export function CountryFlag({ code, withName = false, className }: { code: string | null | undefined; withName?: boolean; className?: string }) {
  const flag = flagEmoji(code);
  const name = countryName(code);
  if (!flag && !withName) return null;
  return (
    <span className={cn('inline-flex items-center gap-1', className)} title={name}>
      {flag ? <span aria-hidden className="text-base leading-none">{flag}</span> : null}
      {withName ? <span>{name}</span> : <span className="sr-only">{name}</span>}
    </span>
  );
}
