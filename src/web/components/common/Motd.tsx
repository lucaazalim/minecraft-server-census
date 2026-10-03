import { Fragment, useMemo, type CSSProperties } from 'react';
import { parseMotd, type Run } from '@/lib/motd-parse';
import { cn } from 'cn';

function styleOf(r: Run): CSSProperties {
  const deco = [r.underlined ? 'underline' : '', r.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ');
  return {
    color: r.color,
    fontWeight: r.bold ? 700 : undefined,
    fontStyle: r.italic ? 'italic' : undefined,
    textDecoration: deco || undefined,
  };
}

/** Colour-rendered MOTD on a dark slab (like the in-game list), falling back to plain text. */
export function Motd({ description, fallback, className }: { description: unknown; fallback?: string | null; className?: string }) {
  const runs = useMemo(() => (description == null ? [] : parseMotd(description)), [description]);
  const text = runs.length ? null : (fallback ?? '').trim();
  return (
    <div className={cn('rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm leading-6 whitespace-pre-wrap text-neutral-100 dark:bg-black', className)}>
      {runs.length
        ? runs.map((r, i) => {
            const lines = r.text.split('\n');
            return (
              <span key={i} style={styleOf(r)} className={r.obfuscated ? 'motd-obfuscated' : undefined}>
                {lines.map((line, j) => (
                  <Fragment key={j}>
                    {j > 0 ? <br /> : null}
                    {line}
                  </Fragment>
                ))}
              </span>
            );
          })
        : text || <span className="text-neutral-500">(empty MOTD)</span>}
    </div>
  );
}
