import abcjs from 'abcjs';
import type { TuneObject } from 'abcjs';
import type { Diagnostics } from '../ir/diagnostics.js';

export interface ParsedAbc {
  tune: TuneObject;
}

export function parseAbc(abc: string, diagnostics: Diagnostics): ParsedAbc | null {
  const tunes = abcjs.parseOnly(abc);
  const tune = tunes[0];
  if (!tune || tune.lines.length === 0) {
    diagnostics.error('parse', 'EMPTY_INPUT', 'No parseable tune content found in ABC input.');
    return null;
  }
  if (tunes.length > 1) {
    diagnostics.warn(
      'parse',
      'MULTIPLE_TUNES',
      `Input contains ${tunes.length} tunes; only the first is converted.`,
    );
  }
  return { tune };
}
