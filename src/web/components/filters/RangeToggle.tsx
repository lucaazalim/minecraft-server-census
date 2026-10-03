import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { RANGES, type Range } from '@/hooks/use-dashboard-params';

export function RangeToggle({ value, onChange, exclude = [], size = 'sm' }: { value: Range; onChange: (r: Range) => void; exclude?: Range[]; size?: 'sm' | 'default' }) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(v) => {
        const next = (v as Range[])[0];
        if (next) onChange(next);
      }}
      variant="outline"
      size={size}
      spacing={0}
      aria-label="Time range"
    >
      {RANGES.filter((r) => !exclude.includes(r.value)).map((r) => (
        <ToggleGroupItem key={r.value} value={r.value} aria-label={r.label} className="px-3">
          {r.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
