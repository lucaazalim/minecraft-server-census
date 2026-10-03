/** Flatten a Minecraft chat component (string | object | array) into plain text, stripping § codes. */
export function chatToText(component: unknown, depth = 0): string {
  if (component == null || depth > 32) return '';
  if (typeof component === 'string') return component;
  if (typeof component === 'number' || typeof component === 'boolean') return String(component);
  if (Array.isArray(component)) return component.map((c) => chatToText(c, depth + 1)).join('');
  if (typeof component === 'object') {
    const obj = component as Record<string, unknown>;
    let out = '';
    if (typeof obj.text === 'string') out += obj.text;
    else if (typeof obj.text === 'number') out += String(obj.text);
    if (typeof obj.translate === 'string' && !obj.text) {
      const withArgs = Array.isArray(obj.with) ? obj.with.map((w) => chatToText(w, depth + 1)).join(' ') : '';
      out += withArgs || obj.translate;
    }
    if (Array.isArray(obj.extra)) out += obj.extra.map((c) => chatToText(c, depth + 1)).join('');
    return out;
  }
  return '';
}

export function stripFormatting(s: string): string {
  return s.replace(/§[0-9a-fk-orx]/gi, '').replace(/\r/g, '');
}

export function motdText(description: unknown): string {
  return stripFormatting(chatToText(description)).trim();
}
