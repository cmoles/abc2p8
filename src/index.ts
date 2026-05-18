import { parseAbc } from './abc/parse.js';
import { abcToScore, type ChordStrategy, type VoiceDrumConfig } from './abc/toIR.js';
import { fromIR } from './abc/fromIR.js';
import { Diagnostics, type Diagnostic } from './ir/diagnostics.js';
import { DEFAULT_INSTRUMENT, DEFAULT_VOLUME, EFFECT_ARP_SLOW } from './pico8/constraints.js';
import { emit } from './pico8/emit.js';
import { extractPico8Directives } from './abc/instrumentDirective.js';
import {
  BUILT_IN_KITS,
  isBuiltInKitName,
  NOISE_KIT,
  validateKit,
  type BuiltInKitName,
  type Kit,
} from './pico8/kits.js';
import {
  dequantize,
  detectSections,
  flagUnknownEffects,
  type SectionInfo,
} from './pipeline/dequantize.js';
import { quantize } from './pipeline/quantize.js';
import { unpackCart } from './pico8/unpack.js';

export type {
  Diagnostic,
  DiagnosticLocation,
  DiagnosticParts,
  Severity,
  Stage,
} from './ir/diagnostics.js';
export { formatDiagnosticParts, formatDiagnosticText } from './ir/diagnostics.js';
export type { Note, Voice, VoiceKind, Score, ScoreMeta, Effect } from './ir/types.js';
export {
  EMPTY_MUSIC_LINE,
  EMPTY_SFX_LINE,
  SECTION_MUSIC,
  SECTION_SFX,
  extractSection,
} from './pico8/sections.js';
export { mergeIntoCart } from './pico8/merge.js';
export type { MergeOptions, MergeResult } from './pico8/merge.js';
export { BUILT_IN_KITS, HYBRID_KIT, NOISE_KIT, TONAL_KIT } from './pico8/kits.js';
export type { BuiltInKitName, DrumName, Kit } from './pico8/kits.js';
export { inspect, renderPianoRoll } from './inspect.js';
export { unpackCart } from './pico8/unpack.js';
export { detectSections } from './pipeline/dequantize.js';
export type { SectionInfo } from './pipeline/dequantize.js';
export type {
  FindingCode,
  InspectionFinding,
  InspectionResult,
  PianoRollOptions,
  PitchRange,
  VoiceInspection,
} from './inspect.js';

export interface VoiceConvertOptions {
  // Pico-8 waveform 0–7. Indexed by source ABC voice (V1 → 0, V2 → 1, …);
  // chord-expand siblings inherit their parent voice's waveform. Falls back to
  // `defaultInstrument` when undefined. Ignored on drum voices, which carry
  // their per-hit waveform on each note via the active kit.
  instrument?: number;
  // Mark this voice as a drum voice. Plain note letters then trigger named
  // drum hits (c→kick, d→snare, e→hat-closed, f→hat-open, g→tom-low,
  // a→tom-mid, b→tom-high) and each hit carries its own SFX shape from the
  // active kit. Octave is ignored.
  drum?: boolean;
  // Kit driving this voice's drum hits. Either a built-in kit name (only
  // 'noise' is shipped today) or a fully populated `Kit` object. Ignored
  // when `drum` is not true. Defaults to 'noise'.
  kit?: BuiltInKitName | Kit;
}

export interface ConvertOptions {
  defaultInstrument?: number;
  defaultVolume?: number;
  // 'auto' (default): expand if chord arities sum to ≤ 4 channels, else arp.
  // 'expand': each chord pitch becomes a sibling channel (errors if > 4 total).
  // 'arp': each chord stays on a single channel using Pico-8's arp effect.
  // Drum voices always use expand semantics regardless of this setting.
  chordStrategy?: ChordStrategy;
  // Arp internal cycle speed. 'fast' = effect 6 (~speed-4 cycle),
  // 'slow' = effect 7 (~speed-8 cycle). Default: 'fast'.
  arpSpeed?: 'fast' | 'slow';
  // Per-source-voice options. `voices[i]` configures ABC voice V(i+1). Wins
  // over any `%%pico8 instrument`/`%%pico8 drum` directive in the ABC text.
  voices?: VoiceConvertOptions[];
}

export type { ChordStrategy } from './abc/toIR.js';

export interface ConvertResult {
  p8: string;
  diagnostics: readonly Diagnostic[];
}

export function abcToPico8(abc: string, opts: ConvertOptions = {}): ConvertResult {
  const diagnostics = new Diagnostics();

  const directive = extractPico8Directives(abc, diagnostics);
  const drumVoices = resolveDrumVoices(directive.drums, opts.voices, diagnostics);
  const instruments = mergeVoiceInstruments(
    directive.instruments,
    opts.voices,
    drumVoices,
    diagnostics,
  );
  if (diagnostics.hasErrors()) return { p8: '', diagnostics: diagnostics.list() };

  const parsed = parseAbc(directive.cleanedAbc, diagnostics);
  if (!parsed) return { p8: '', diagnostics: diagnostics.list() };

  const score = abcToScore(parsed.tune, diagnostics, {
    chordStrategy: opts.chordStrategy ?? 'auto',
    drumVoices,
  });
  if (!score || diagnostics.hasErrors()) {
    return { p8: '', diagnostics: diagnostics.list() };
  }

  for (const voice of score.voices) {
    const sourceIdx = sourceVoiceIndex(voice.id);
    if (sourceIdx === null) continue;
    // Drum voices stamp per-note waveforms from the kit; the voice-level
    // instrument would just be a fallback that never fires.
    if (voice.kind === 'drum') continue;
    const wave = instruments.get(sourceIdx);
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
  drumVoices: Map<number, VoiceDrumConfig>,
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
  // Drum voices ignore voice-level waveforms: the kit drives per-hit
  // waveforms instead, so drop any directive/opt entry to keep the
  // resolved score clean.
  for (const idx of drumVoices.keys()) merged.delete(idx);
  return merged;
}

function resolveDrumVoices(
  fromDirective: Set<number>,
  fromOpts: VoiceConvertOptions[] | undefined,
  diagnostics: Diagnostics,
): Map<number, VoiceDrumConfig> {
  const drumIndices = new Set<number>(fromDirective);
  const explicitKits = new Map<number, BuiltInKitName | Kit>();
  if (fromOpts) {
    for (let i = 0; i < fromOpts.length; i += 1) {
      const opt = fromOpts[i];
      if (!opt) continue;
      if (opt.drum) drumIndices.add(i);
      // `kit:` only takes effect when `drum: true` — silently ignore
      // otherwise so callers can spread defaults without bookkeeping.
      if (opt.drum && opt.kit !== undefined) explicitKits.set(i, opt.kit);
    }
  }

  const out = new Map<number, VoiceDrumConfig>();
  for (const idx of drumIndices) {
    const requested = explicitKits.get(idx);
    const kit = resolveKit(idx, requested, diagnostics);
    if (kit === null) continue;
    out.set(idx, { kit });
  }
  return out;
}

function resolveKit(
  voiceIdx: number,
  requested: BuiltInKitName | Kit | undefined,
  diagnostics: Diagnostics,
): Kit | null {
  if (requested === undefined) return NOISE_KIT;
  if (typeof requested === 'string') {
    if (!isBuiltInKitName(requested)) {
      diagnostics.error(
        'toIR',
        'DRUM_KIT_INVALID',
        `voices[${voiceIdx}].kit "${requested}" is not a built-in kit. Known kits: ${Object.keys(BUILT_IN_KITS).join(', ')}.`,
      );
      return null;
    }
    return BUILT_IN_KITS[requested];
  }
  const errors = validateKit(requested);
  if (errors.length > 0) {
    diagnostics.error(
      'toIR',
      'DRUM_KIT_INVALID',
      `voices[${voiceIdx}].kit is invalid: ${errors.map((e) => `${e.field}: ${e.reason}`).join('; ')}.`,
    );
    return null;
  }
  return requested as Kit;
}

export interface Pico8ToAbcOptions {
  // Title to stamp into the ABC header (`T:`). Cart bytes carry no title, so
  // we accept one from the caller (CLI passes the input filename's stem).
  title?: string;
  // 0-based section index (default 0). A section is a contiguous music-row
  // run bounded by end-loop/stop, matching what Pico-8's music(N) would
  // play. Use `listSections(p8)` to enumerate available sections.
  section?: number;
}

export interface Pico8ToAbcResult {
  abc: string;
  diagnostics: readonly Diagnostic[];
  // Suggested arpSpeed for the round-trip — if any decoded chord used
  // effect 7, the caller should run `abcToPico8` with arpSpeed: 'slow' to
  // reproduce the original timbre. Absent when no chord notes were detected.
  arpSpeed?: 'fast' | 'slow';
  // Every section the cart exposes (not just the decoded one). Lets a UI
  // surface a picker without re-parsing the cart.
  sections: SectionInfo[];
  // Which section index ended up in `abc`. May differ from
  // `opts.section` if the requested index was out of range.
  decodedSection: number;
}

export function pico8ToAbc(p8: string, opts: Pico8ToAbcOptions = {}): Pico8ToAbcResult {
  const diagnostics = new Diagnostics();
  const cart = unpackCart(p8, diagnostics);
  if (!cart) {
    return { abc: '', diagnostics: diagnostics.list(), sections: [], decodedSection: 0 };
  }
  flagUnknownEffects(cart, diagnostics);

  const decoded = dequantize(cart, diagnostics, {
    ...(opts.section !== undefined ? { section: opts.section } : {}),
  });
  if (!decoded) {
    return {
      abc: '',
      diagnostics: diagnostics.list(),
      sections: detectSections(cart.music),
      decodedSection: 0,
    };
  }

  if (opts.title) decoded.score.meta.title = opts.title;

  const arpSpeed = detectArpSpeed(cart);

  const abc = fromIR(decoded.score, {
    slotsPerUnit: decoded.slotsPerUnit,
    lDen: decoded.lDen,
    voiceMeta: decoded.voiceMeta,
  });
  return {
    abc,
    diagnostics: diagnostics.list(),
    ...(arpSpeed ? { arpSpeed } : {}),
    sections: decoded.sections,
    decodedSection: decoded.decodedSection,
  };
}

// Standalone section enumeration. Useful when a UI wants to render a track
// picker before the user has committed to decoding a particular section.
export function listSections(p8: string): { sections: SectionInfo[]; diagnostics: readonly Diagnostic[] } {
  const diagnostics = new Diagnostics();
  const cart = unpackCart(p8, diagnostics);
  if (!cart) return { sections: [], diagnostics: diagnostics.list() };
  return { sections: detectSections(cart.music), diagnostics: diagnostics.list() };
}

function detectArpSpeed(cart: ReturnType<typeof unpackCart> & object): 'fast' | 'slow' | undefined {
  let sawFast = false;
  let sawSlow = false;
  for (const sfx of cart.sfx.values()) {
    for (const n of sfx.notes) {
      if (n.volume === 0) continue;
      if (n.effect === EFFECT_ARP_SLOW) sawSlow = true;
      else if (n.effect === 6) sawFast = true;
    }
  }
  if (sawSlow && !sawFast) return 'slow';
  if (sawFast) return 'fast';
  return undefined;
}
