import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import { MoonIcon, SunIcon } from 'lucide-react';

export function ThemeToggle() {
  const { isDark, setTheme } = useTheme();
  return (
    <Button variant="ghost" size="icon-sm" aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'} title={isDark ? 'Light theme' : 'Dark theme'} onClick={() => setTheme(isDark ? 'light' : 'dark')}>
      {isDark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
