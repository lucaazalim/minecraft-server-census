/**
 * Parse a Minecraft server `description` (legacy §-coded string, chat component object, or array) into styled runs.
 * Pure TypeScript with no React or path aliases so the root test runner can import it directly.
 */
export interface Run {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
}

export const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  dark_blue: '#0000AA',
  dark_green: '#00AA00',
  dark_aqua: '#00AAAA',
  dark_red: '#AA0000',
  dark_purple: '#AA00AA',
  gold: '#FFAA00',
  gray: '#AAAAAA',
  dark_gray: '#555555',
  blue: '#5555FF',
  green: '#55FF55',
  aqua: '#55FFFF',
  red: '#FF5555',
  light_purple: '#FF55FF',
  yellow: '#FFFF55',
  white: '#FFFFFF',
};

const CODE_COLORS: Record<string, string> = {
  '0': NAMED_COLORS.black!,
  '1': NAMED_COLORS.dark_blue!,
  '2': NAMED_COLORS.dark_green!,
  '3': NAMED_COLORS.dark_aqua!,
  '4': NAMED_COLORS.dark_red!,
  '5': NAMED_COLORS.dark_purple!,
  '6': NAMED_COLORS.gold!,
  '7': NAMED_COLORS.gray!,
  '8': NAMED_COLORS.dark_gray!,
  '9': NAMED_COLORS.blue!,
  a: NAMED_COLORS.green!,
  b: NAMED_COLORS.aqua!,
  c: NAMED_COLORS.red!,
  d: NAMED_COLORS.light_purple!,
  e: NAMED_COLORS.yellow!,
  f: NAMED_COLORS.white!,
};

type Style = Omit<Run, 'text'>;
const MAX_DEPTH = 32;

function colorOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const c = v.toLowerCase();
  if (c === 'reset') return undefined;
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  return NAMED_COLORS[c];
}

function flag(v: unknown, inherited: boolean | undefined): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return inherited;
}

/** Apply § codes inside one text leaf. `base` is the component's own style (what §r returns to). */
function legacy(text: string, base: Style, out: Run[]): void {
  let style: Style = { ...base };
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, ...style });
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '§' && i + 1 < text.length) {
      const code = text[i + 1]!.toLowerCase();
      // §x§R§R§G§G§B§B hex colour (Bungee/Spigot extension)
      if (code === 'x' && i + 13 < text.length + 1) {
        const hex = text.slice(i + 2, i + 14);
        const m = hex.match(/^§([0-9a-f])§([0-9a-f])§([0-9a-f])§([0-9a-f])§([0-9a-f])§([0-9a-f])$/i);
        if (m) {
          flush();
          style = { ...base, color: `#${m.slice(1, 7).join('').toLowerCase()}` };
          i += 13;
          continue;
        }
      }
      if (CODE_COLORS[code]) {
        flush();
        style = { ...base, color: CODE_COLORS[code], bold: undefined, italic: undefined, underlined: undefined, strikethrough: undefined, obfuscated: undefined };
        i++;
        continue;
      }
      if (code === 'r') {
        flush();
        style = { ...base };
        i++;
        continue;
      }
      const flags: Record<string, keyof Style> = { k: 'obfuscated', l: 'bold', m: 'strikethrough', n: 'underlined', o: 'italic' };
      const f = flags[code];
      if (f) {
        flush();
        style = { ...style, [f]: true };
        i++;
        continue;
      }
      // unknown code: drop the marker, keep going
      i++;
      continue;
    }
    if (ch === '\r') continue;
    buf += ch;
  }
  flush();
}

function walk(component: unknown, inherited: Style, out: Run[], depth: number): void {
  if (component == null || depth > MAX_DEPTH) return;
  if (typeof component === 'string') return legacy(component, inherited, out);
  if (typeof component === 'number' || typeof component === 'boolean') return legacy(String(component), inherited, out);
  if (Array.isArray(component)) {
    // The first element's style is inherited by its siblings, as in the game.
    let first: Style = inherited;
    component.forEach((c, i) => {
      if (i === 0 && c && typeof c === 'object' && !Array.isArray(c)) first = styleOf(c as Record<string, unknown>, inherited);
      walk(c, i === 0 ? inherited : first, out, depth + 1);
    });
    return;
  }
  if (typeof component === 'object') {
    const obj = component as Record<string, unknown>;
    const style = styleOf(obj, inherited);
    let text = '';
    if (typeof obj.text === 'string') text = obj.text;
    else if (typeof obj.text === 'number') text = String(obj.text);
    else if (typeof obj.translate === 'string') {
      const args = Array.isArray(obj.with) ? obj.with.map((w) => runsToText(parseMotd(w))).join(' ') : '';
      text = args || obj.translate;
    }
    if (text) legacy(text, style, out);
    if (Array.isArray(obj.extra)) for (const e of obj.extra) walk(e, style, out, depth + 1);
  }
}

function styleOf(obj: Record<string, unknown>, inherited: Style): Style {
  const color = 'color' in obj ? colorOf(obj.color) : inherited.color;
  return {
    color,
    bold: flag(obj.bold, inherited.bold),
    italic: flag(obj.italic, inherited.italic),
    underlined: flag(obj.underlined, inherited.underlined),
    strikethrough: flag(obj.strikethrough, inherited.strikethrough),
    obfuscated: flag(obj.obfuscated, inherited.obfuscated),
  };
}

function sameStyle(a: Run, b: Run): boolean {
  return a.color === b.color && !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underlined === !!b.underlined && !!a.strikethrough === !!b.strikethrough && !!a.obfuscated === !!b.obfuscated;
}

export function parseMotd(description: unknown): Run[] {
  const raw: Run[] = [];
  walk(description, {}, raw, 0);
  const out: Run[] = [];
  for (const r of raw) {
    if (!r.text) continue;
    const clean: Run = { text: r.text };
    if (r.color) clean.color = r.color;
    if (r.bold) clean.bold = true;
    if (r.italic) clean.italic = true;
    if (r.underlined) clean.underlined = true;
    if (r.strikethrough) clean.strikethrough = true;
    if (r.obfuscated) clean.obfuscated = true;
    const last = out[out.length - 1];
    if (last && sameStyle(last, clean)) last.text += clean.text;
    else out.push(clean);
  }
  return out;
}

export function runsToText(runs: Run[]): string {
  return runs.map((r) => r.text).join('');
}
