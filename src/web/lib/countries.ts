let names: Intl.DisplayNames | null = null;
try {
  names = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  names = null;
}

export function countryName(code: string | null | undefined): string {
  if (!code) return 'Unknown location';
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Regional-indicator flag; empty for unknown. */
export function flagEmoji(code: string | null | undefined): string {
  if (!code || !/^[A-Z]{2}$/i.test(code)) return '';
  const up = code.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + up.charCodeAt(0) - 65, 0x1f1e6 + up.charCodeAt(1) - 65);
}

/** True for a region scope (`latam`, `europe`, ...) as opposed to a 2-letter country code. */
export function isRegionCode(code: string): boolean {
  return /^[a-z]{3,}$/.test(code);
}

/** Globe emoji for a region, in the style of the country flags. */
export function regionEmoji(code: string): string {
  switch (code) {
    case 'latam':
    case 'noram':
      return '🌎';
    case 'asia':
    case 'oceania':
      return '🌏';
    default:
      return '🌍';
  }
}
