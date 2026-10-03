import { cn } from 'cn';

/** Server icon from the API, or a neutral placeholder when the server sent none. Sized inline so preflight's `img { height: auto }` cannot stretch it. */
export function Favicon({ id, has, size = 20, className }: { id: number; has: boolean; size?: number; className?: string }) {
  const cls = cn('shrink-0 self-start rounded-sm bg-muted', className);
  const style = { width: size, height: size };
  if (!has) return <span aria-hidden className={cls} style={style} />;
  return <img src={`/api/servers/${id}/favicon`} alt="" width={size} height={size} style={style} loading="lazy" decoding="async" className={cn(cls, 'object-cover [image-rendering:pixelated]')} />;
}
