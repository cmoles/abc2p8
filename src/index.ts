import { parseAbc } from './abc/parse.js';
import { abcToScore, type ChordStrategy } from './abc/toIR.js';
import { Diagnostics, type Diagnostic } from './ir/diagnostics.js';
import { DEFAULT_INSTRUMENT, DEFAULT_VOLUME } from './pico8/constraints.js';
import { emit } from './pico8/emit.js';
import { extractVoiceInstruments } from './abc/instrumentDirective.js';
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

export interface VoiceConvertOptions {
  // Pico-8 waveform 0–7. Indexed by source ABC voice (V1 → 0, V2 → 1, …);
  // chord-expand siblings inherit their parent voice's waveform. Falls back to
  // `defaultInstrument` when undefined.
  instrument?: number;
}

export interface ConvertOptions {
  defaultInstrument?: number;
  defaultVolume?: number;
  // 'auto' (default): expand if chord arities sum to ≤ 4 channels, else arp.
  // 'expand': each chord pitch becomes a sibling channel (errors if > 4 total).
  // 'arp': each chord stays on a single channel using Pico-8's arp effect.
  chordStrategy?: ChordStrategy;
  // Arp internal cycle speed. 'fast' = effect 6 (~speed-4 cycle),
  // 'slow' = effect 7 (~speed-8 cycle). Default: 'fast'.
  arpSpeed?: 'fast' | 'slow';
  // Per-source-voice options. `voices[i]` configures ABC voice V(i+1). Wins
  // over any `%%pico8 instrument` directive in the ABC text.
  voices?: VoiceConvertOptions[];
}

export type { ChordStrategy } from './abc/toIR.js';

export interface ConvertResult {
  p8: string;
  diagnostics: readonly Diagnostic[];
}

export function abcToPico8(abc: string, opts: ConvertOptions = {}): ConvertResult {
  const diagnostics = new Diagnostics();

  const directive = extractVoiceInstruments(abc, diagnostics);
  const instruments = mergeVoiceInstruments(directive.instruments, opts.voices, diagnostics);
  if (diagnostics.hasErrors()) return { p8: '', diagnostics: diagnostics.list() };

  const parsed = parseAbc(directive.cleanedAbc, diagnostics);
  if (!parsed) return { p8: '', diagnostics: diagnostics.list() };

  const score = abcToScore(parsed.tune, diagnostics, {
    chordStrategy: opts.chordStrategy ?? 'auto',
  });
  if (!score || diagnostics.hasErrors()) {
    return { p8: '', diagnostics: diagnostics.list() };
  }

  for (const voice of score.voices) {
    const sourceIdx = sourceVoiceIndex(voice.id);
    const wave = sourceIdx !== null ? instruments.get(sourceIdx) : undefined;
    if (wave !== undefined) voice.instrument = wave;
  }

  const quantized = quantize(score, diagnostics);
  if (!quantized || diagnostics.hasErrors()) {
    return { p8: '', diagnostics: diagnostics.list() };
  }

  const p8 = emit(quantized, diagnostics, {
    defaultInstrument: opts.defaultInstrument ?? DEFAULT_INSTRUMENT,
    defaultVolume: opts.defaultVolume ?? DEFAULT_VOLUME,
    arpSpeed: opts.arpSpeed ?? 'fast',
  });
  if (p8 === null || diagnostics.hasErrors()) {
    return { p8: '', diagnostics: diagnostics.list() };
  }
  return { p8, diagnostics: diagnostics.list() };
}

function sourceVoiceIndex(voiceId: string): number | null {
  const head = voiceId.split('.')[0]!;
  const m = /^V(\d+)$/.exec(head);
  if (!m) return null;
  return Number(m[1]) - 1;
}

function mergeVoiceInstruments(
  fromDirective: Map<number, number>,
  fromOpts: VoiceConvertOptions[] | undefined,
  diagnostics: Diagnostics,
): Map<number, number> {
  const merged = new Map(fromDirective);
  if (fromOpts) {
    for (let i = 0; i < fromOpts.length; i += 1) {
      const w = fromOpts[i]?.instrument;
      if (w === undefined) continue;
      if (!Number.isInteger(w) || w < 0 || w > 7) {
        diagnostics.error(
          'toIR',
          'INSTRUMENT_OUT_OF_RANGE',
          `voices[${i}].instrument is ${w}; must be an integer in [0, 7].`,
        );
        continue;
      }
      merged.set(i, w);
    }
  }
  return merged;
}
