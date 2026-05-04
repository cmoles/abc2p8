// Padding constants for empty cart slots — sized to match the bytes the
// Pico-8 ROM expects at 0x3200 (sfx) and 0x3100 (music) for a silent slot.
export const EMPTY_SFX_LINE = '0'.repeat(168);
export const EMPTY_MUSIC_LINE = '00 40414243';

export const SECTION_SFX = '__sfx__';
export const SECTION_MUSIC = '__music__';

export function extractSection(p8: string, name: string): string[] {
  const lines = p8.split('\n');
  const start = lines.indexOf(name);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('__') && l.endsWith('__')) break;
    if (l !== '') out.push(l);
  }
  return out;
}
