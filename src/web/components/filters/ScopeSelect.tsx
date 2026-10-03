import { useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@/components/ui/combobox';
import { useCountries } from '@/lib/api';
import { countryName, flagEmoji, isRegionCode, regionEmoji } from '@/lib/countries';
import { fmtInt } from '@/lib/format';
import { GlobeIcon } from 'lucide-react';

interface ScopeItem {
  code: string;
  label: string;
  online: number;
}
interface ScopeGroup {
  value: string;
  items: ScopeItem[];
}

const ALL: ScopeItem = { code: 'all', label: 'All tracked', online: 0 };

function scopeLabel(code: string, regionLabel?: string): string {
  if (code === 'all') return ALL.label;
  return isRegionCode(code) ? (regionLabel ?? code) : countryName(code);
}

function ScopeIcon({ code }: { code: string }) {
  if (code === 'all') return <GlobeIcon className="inline size-4 text-muted-foreground" />;
  return <span aria-hidden>{isRegionCode(code) ? regionEmoji(code) : flagEmoji(code)}</span>;
}

/** Scope picker: everything, one region (Latin America, Europe, ...) or one country, grouped in that order. */
export function ScopeSelect({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { data } = useCountries();
  const groups = useMemo<ScopeGroup[]>(() => {
    const regions = (data?.regions ?? []).map((r) => ({ code: r.code, label: r.label, online: r.online }));
    const countries = (data?.rows ?? [])
      .filter((r) => r.country != null)
      .sort((a, b) => b.players - a.players || b.online - a.online)
      .map((r) => ({ code: r.country!, label: countryName(r.country), online: r.online }));
    return [
      { value: '', items: [ALL] },
      { value: 'Regions', items: regions },
      { value: 'Countries', items: countries },
    ].filter((g) => g.items.length);
  }, [data]);
  const selected = groups.flatMap((g) => g.items).find((i) => i.code === value) ?? { code: value, label: scopeLabel(value), online: 0 };

  return (
    <Combobox<ScopeItem>
      items={groups}
      value={selected}
      onValueChange={(item) => onChange(item?.code ?? 'all')}
      itemToStringLabel={(item) => item.label}
      itemToStringValue={(item) => item.code}
      isItemEqualToValue={(a, b) => a.code === b.code}
    >
      <ComboboxTrigger render={<Button variant="outline" className="min-w-44 justify-between" />} aria-label="Country or region filter">
        <ComboboxValue>
          {(item: ScopeItem | null) => (
            <span className="flex items-center gap-2 truncate">
              {item && item.code !== 'all' ? <ScopeIcon code={item.code} /> : <GlobeIcon className="size-4 text-muted-foreground" />}
              <span className="truncate">{item?.label ?? ALL.label}</span>
            </span>
          )}
        </ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent className="w-72" initialFocus={() => inputRef.current}>
        <ComboboxInput ref={inputRef} placeholder="Search countries and regions" showTrigger={false} />
        <ComboboxEmpty>No country or region matches.</ComboboxEmpty>
        <ComboboxList>
          {(group: ScopeGroup) => (
            <ComboboxGroup key={group.value || 'all'} items={group.items}>
              {group.value ? <ComboboxLabel>{group.value}</ComboboxLabel> : null}
              <ComboboxCollection>
                {(item: ScopeItem) => (
                  <ComboboxItem key={item.code} value={item}>
                    <span className="w-5 text-center" aria-hidden>
                      <ScopeIcon code={item.code} />
                    </span>
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.code !== 'all' ? <span className="text-xs text-muted-foreground">{fmtInt(item.online)} online</span> : null}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
