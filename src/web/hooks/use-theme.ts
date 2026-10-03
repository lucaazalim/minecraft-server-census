import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'theme';
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}
export function resolvedDark(theme: Theme): boolean {
  return theme === 'dark' || (theme === 'system' && systemDark());
}
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', resolvedDark(theme));
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', cb);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener('change', cb);
  };
}

export function useTheme(): { theme: Theme; isDark: boolean; setTheme: (t: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, read, () => 'system' as Theme);
  const isDark = useSyncExternalStore(subscribe, () => resolvedDark(read()), () => false);
  useEffect(() => applyTheme(theme), [theme, isDark]);
  const setTheme = useCallback((t: Theme) => {
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* private mode */
    }
    applyTheme(t);
    for (const l of listeners) l();
  }, []);
  return { theme, isDark, setTheme };
}
