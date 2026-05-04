import { parseAbc } from './abc/parse.js';
import { abcToScore } from './abc/toIR.js';
import { Diagnostics, type Diagnostic } from './ir/diagnostics.js';
import { DEFAULT_INSTRUMENT, DEFAULT_VOLUME } from './pico8/constraints.js';
import { emit } from './pico8/emit.js';
import { quantize } from './pipeline/quantize.js';

export type {
  Diagnostic,
  DiagnosticLocation,
  DiagnosticParts,
  Severity,
  Stage,
} from './ir/diagnostics.js';
export { formatDiagnosticParts, formatDiagnosticText } from './ir/diagnostics.js';
export type { Note, Voice, Score, ScoreMeta, Effect } from './ir/types.js';
export {
  EMPTY_MUSIC_LINE,
  EMPTY_SFX_LINE,
  SECTION_MUSIC,
  SECTION_SFX,
  extractSection,
} from './pico8/sections.js';

export interface ConvertOptions {
  defaultInstrument?: number;
  defaultVolume?: number;
}

export interface ConvertResult {
  p8: string;
  diagnostics: readonly Diagnostic[];
}

export function abcToPico8(abc: string, opts: ConvertOptions = {}): ConvertResult {
  const diagnostics = new Diagnostics();
  const parsed = parseAbc(abc, diagnostics);
  if (!parsed) return { p8: '', diagnostics: diagnostics.list() };

  const score = abcToScore(parsed.tune, diagnostics);
  if (!score || diagnostics.hasErrors()) {
    return { p8: '', diagnostics: diagnostics.list() };
  }

  const quantized = quantize(score, diagnostics);
  if (!quantized || diagnostics.hasErrors()) {
    return { p8: '', diagnostics: diagnostics.list() };
  }

  const p8 = emit(quantized, diagnostics, {
    defaultInstrument: opts.defaultInstrument ?? DEFAULT_INSTRUMENT,
    defaultVolume: opts.defaultVolume ?? DEFAULT_VOLUME,
  });
  if (p8 === null || diagnostics.hasErrors()) {
    return { p8: '', diagnostics: diagnostics.list() };
  }
  return { p8, diagnostics: diagnostics.list() };
}
