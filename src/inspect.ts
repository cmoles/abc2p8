// Structural analysis + algorithmic lint for ABC → Pico-8 conversions.
//
// Runs the convert pipeline through quantize (no emit) and reports the facts
// downstream LLM/humans need to evaluate output: pitch ranges, rhythm
// histograms, drum-hit counts, channel usage, plus a set of findings that
// flag common authoring mistakes (silent voices, register clash, monotonic
// rhythm, etc.). See docs/llm-failure-modes.md for the catalogue this lints
// against.

import { parseAbc } from './abc/parse.js';
import { abcToScore, type VoiceDrumConfig } from './abc/toIR.js';
import { extractPico8Directives } from './abc/instrumentDirective.js';
import { Diagnostics, type Diagnostic } from './ir/diagnostics.js';
import type { Voice } from './ir/types.js';
import {
  CHANNEL_COUNT,
  PICO8_MIDI_OFFSET,
  PICO8_PITCH_MAX,
  PICO8_PITCH_MIN,
} from './pico8/constraints.js';
import {
  BUILT_IN_KITS,
  DRUM_NAMES,
  NOISE_KIT,
  isBuiltInKitName,
  validateKit,
  type BuiltInKitName,
  type DrumHit,
  type DrumName,
  type Kit,
} from './pico8/kits.js';
import { quantize, type QuantizedScore, type QuantizedSlot } from './pipeline/quantize.js';
import type { ConvertOptions, VoiceConvertOptions } from './index.js';

export type FindingCode =
  | 'SILENT_VOICE'
  | 'REGISTER_CLASH'
  | 'NO_RESTS'
  | 'MONOTONIC_RHYTHM'
  | 'PITCH_AT_RANGE_EDGE'
  | 'DRUMS_ON_DOWNBEAT'
  | 'CHANNEL_BUDGET_TIGHT';

export interface InspectionFinding {
  code: FindingCode;
  severity: 'info' | 'warn';
  voice?: string;
  message: string;
}

export interface PitchRange {
  minMidi: number;
  maxMidi: number;
  minPico8: number;
  maxPico8: number;
}

export interface VoiceInspection {
  id: string;
  kind: 'melodic' | 'drum';
  instrument?: number;
  noteCount: number;
  noteSlots: number;
  restSlots: number;
  pitchRange?: PitchRange;
  durationHistogram: Record<number, number>;
  durationEntropy: number;
  chordOnsets: number;
  drumHits?: Record<string, number>;
  drumOnsetSlots?: number[];
  // One character per slot, length = totalSlots. Empty for rest, '|' for
  // onset, '=' for sustained pitch, drum-letter for drum onset (k/s/h/o/l/m/H
  // for kick/snare/hat-closed/hat-open/tom-low/tom-mid/tom-high), '?' for
  // unmapped drum hit. Drives renderPianoRoll.
  roll: string;
}

export interface InspectionResult {
  ok: boolean;
  totalSlots: number;
  totalBlocks: number;
  slotTicks: number;
  speed: number;
  ticksPerQuarter: number;
  tempoBpm: number;
  beatSlots: number;
  channelsUsed: number;
  channelsRemaining: number;
  loop?: { beginSlot: number; endSlot: number };
  voices: VoiceInspection[];
  findings: InspectionFinding[];
  diagnostics: readonly Diagnostic[];
}

export function inspect(abc: string, opts: ConvertOptions = {}): InspectionResult {
  const diagnostics = new Diagnostics();
  const empty = (): InspectionResult => ({
    ok: false,
    totalSlots: 0,
    totalBlocks: 0,
    slotTicks: 0,
    speed: 0,
    ticksPerQuarter: 0,
    tempoBpm: 0,
    beatSlots: 0,
    channelsUsed: 0,
    channelsRemaining: CHANNEL_COUNT,
    voices: [],
    findings: [],
    diagnostics: diagnostics.list(),
  });

  const directive = extractPico8Directives(abc, diagnostics);
  const drumVoices = resolveDrumVoices(directive.drums, opts.voices, diagnostics);
  if (diagnostics.hasErrors()) return empty();

  const parsed = parseAbc(directive.cleanedAbc, diagnostics);
  if (!parsed) return empty();

  const score = abcToScore(parsed.tune, diagnostics, {
    chordStrategy: opts.chordStrategy ?? 'auto',
    drumVoices,
  });
  if (!score || diagnostics.hasErrors()) return empty();

  // Apply voice-level instrument overrides (mirrors abcToPico8's behaviour;
  // we report on the post-resolution waveform, so the user sees what the
  // emitter would actually stamp).
  applyInstrumentOverrides(score.voices, directive.instruments, opts.voices, drumVoices);

  const quantized = quantize(score, diagnostics);
  if (!quantized || diagnostics.hasErrors()) return empty();

  const slotTicks = quantized.slotTicks;
  const beatSlots = Math.max(1, Math.round(score.ticksPerQuarter / slotTicks));

  const voices: VoiceInspection[] = quantized.voices.map((qv, i) => {
    const source = score.voices[i]!;
    const sourceIdx = sourceVoiceIndex(source.id);
    const drumKit = sourceIdx === null ? undefined : drumVoices.get(sourceIdx)?.kit;
    return inspectVoice(qv, source, drumKit);
  });

  const totalSlots = voices.reduce((m, v) => Math.max(m, v.noteSlots + v.restSlots), 0);
  const totalBlocks = quantized.voices.length * (quantized.voices[0]?.blocks.length ?? 0);
  const channelsUsed = quantized.voices.length;
  const channelsRemaining = Math.max(0, CHANNEL_COUNT - channelsUsed);
  const loop = quantized.loop ? resolveLoopSlots(quantized) : undefined;

  const findings = runChecks(voices, {
    totalSlots,
    beatSlots,
    channelsUsed,
  });

  return {
    ok: true,
    totalSlots,
    totalBlocks,
    slotTicks,
    speed: quantized.speed,
    ticksPerQuarter: score.ticksPerQuarter,
    tempoBpm: score.tempoBpm,
    beatSlots,
    channelsUsed,
    channelsRemaining,
    ...(loop ? { loop } : {}),
    voices,
    findings,
    diagnostics: diagnostics.list(),
  };
}

function inspectVoice(
  qv: QuantizedScore['voices'][number],
  source: Voice,
  drumKit: Kit | undefined,
): VoiceInspection {
  const slots: QuantizedSlot[] = qv.blocks.flat();
  let noteSlots = 0;
  let restSlots = 0;
  let chordOnsets = 0;
  const pitches: number[] = [];
  const onsetIndices: number[] = [];

  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i]!;
    if (s.pitch === null) {
      restSlots += 1;
      continue;
    }
    noteSlots += 1;
    pitches.push(s.pitch);
    if (s.isOnset) {
      onsetIndices.push(i);
      if (s.arpChord && s.arpChord.length > 0) chordOnsets += 1;
    }
  }

  const durationHistogram: Record<number, number> = {};
  const noteDurations = computeNoteDurations(slots, onsetIndices);
  for (const d of noteDurations) {
    durationHistogram[d] = (durationHistogram[d] ?? 0) + 1;
  }
  const durationEntropy = shannonEntropy(Object.values(durationHistogram));

  const result: VoiceInspection = {
    id: qv.id,
    kind: source.kind ?? 'melodic',
    noteCount: onsetIndices.length,
    noteSlots,
    restSlots,
    durationHistogram,
    durationEntropy,
    chordOnsets,
    roll: '',
  };

  if (qv.instrument !== undefined) result.instrument = qv.instrument;
  else if (source.instrument !== undefined) result.instrument = source.instrument;

  if (pitches.length > 0) {
    const minMidi = Math.min(...pitches);
    const maxMidi = Math.max(...pitches);
    result.pitchRange = {
      minMidi,
      maxMidi,
      minPico8: minMidi - PICO8_MIDI_OFFSET,
      maxPico8: maxMidi - PICO8_MIDI_OFFSET,
    };
  }

  // Pre-compute per-slot drum-name lookup so we can both fill `drumHits`
  // and stamp the right letter into `roll` without scanning the kit twice.
  const drumNameAtSlot = new Map<number, DrumName | null>();
  if (result.kind === 'drum' && drumKit) {
    for (const idx of onsetIndices) {
      drumNameAtSlot.set(idx, matchDrumHit(slots[idx]!, drumKit));
    }
  }

  if (result.kind === 'drum') {
    result.drumOnsetSlots = onsetIndices.slice();
    if (drumKit) {
      const hits: Record<string, number> = {};
      for (const idx of onsetIndices) {
        const name = drumNameAtSlot.get(idx) ?? null;
        const key = name ?? 'unknown';
        hits[key] = (hits[key] ?? 0) + 1;
      }
      result.drumHits = hits;
    }
  }

  result.roll = renderVoiceRoll(slots, result.kind, drumNameAtSlot);
  return result;
}

const DRUM_LETTER: Readonly<Record<DrumName, string>> = {
  kick: 'k',
  snare: 's',
  'hat-closed': 'h',
  'hat-open': 'o',
  'tom-low': 'l',
  'tom-mid': 'm',
  'tom-high': 'H',
};

function renderVoiceRoll(
  slots: QuantizedSlot[],
  kind: 'melodic' | 'drum',
  drumNameAtSlot: Map<number, DrumName | null>,
): string {
  const chars: string[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i]!;
    if (s.pitch === null) {
      chars.push('.');
      continue;
    }
    if (s.isOnset) {
      if (kind === 'drum') {
        const name = drumNameAtSlot.get(i);
        chars.push(name ? DRUM_LETTER[name] : '?');
      } else {
        chars.push('|');
      }
    } else {
      chars.push('=');
    }
  }
  return chars.join('');
}

function computeNoteDurations(slots: QuantizedSlot[], onsetIndices: number[]): number[] {
  // Note duration in slots = run from this onset until pitch changes to null
  // or to a different pitch (the next onset). The quantizer already encodes
  // sustained same-pitch slots without an isOnset break, so an onset+sustain
  // group is contiguous slots with the same pitch starting at the onset.
  const durations: number[] = [];
  for (const start of onsetIndices) {
    const startPitch = slots[start]!.pitch;
    let end = start + 1;
    while (
      end < slots.length &&
      slots[end]!.pitch === startPitch &&
      !slots[end]!.isOnset
    ) {
      end += 1;
    }
    durations.push(end - start);
  }
  return durations;
}

function shannonEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function matchDrumHit(slot: QuantizedSlot, kit: Kit): DrumName | null {
  // The IR builder stamped (waveform, MIDI pitch, volume, effect) onto every
  // slot from kit lookup. Reverse-match against the kit's hits to recover the
  // drum name.
  if (slot.pitch === null) return null;
  const pico8Pitch = slot.pitch - PICO8_MIDI_OFFSET;
  for (const name of DRUM_NAMES) {
    const hit: DrumHit = kit[name];
    if (
      slot.waveform === hit.waveform &&
      pico8Pitch === hit.pitch &&
      slot.volume === hit.volume &&
      slot.effect === hit.effect
    ) {
      return name;
    }
  }
  return null;
}

function resolveLoopSlots(q: QuantizedScore): { beginSlot: number; endSlot: number } {
  // Convert block-based loop boundaries into slot-based ones by summing
  // block lengths up to those indices. Uses voice 0 (all voices share a
  // block layout by construction).
  const blocks = q.voices[0]?.blocks ?? [];
  let beginSlot = 0;
  for (let i = 0; i < (q.loop?.beginBlock ?? 0); i += 1) beginSlot += blocks[i]?.length ?? 0;
  let endSlot = 0;
  for (let i = 0; i <= (q.loop?.endBlock ?? -1); i += 1) endSlot += blocks[i]?.length ?? 0;
  return { beginSlot, endSlot };
}

function sourceVoiceIndex(voiceId: string): number | null {
  const head = voiceId.split('.')[0]!;
  const m = /^V(\d+)$/.exec(head);
  if (!m) return null;
  return Number(m[1]) - 1;
}

// Shared with abcToPico8; kept inline so inspect.ts doesn't reach into
// index.ts's private helpers. Behaviour must mirror.
function applyInstrumentOverrides(
  voices: Voice[],
  fromDirective: Map<number, number>,
  fromOpts: VoiceConvertOptions[] | undefined,
  drumVoices: Map<number, VoiceDrumConfig>,
): void {
  const merged = new Map(fromDirective);
  if (fromOpts) {
    for (let i = 0; i < fromOpts.length; i += 1) {
      const w = fromOpts[i]?.instrument;
      if (w === undefined) continue;
      if (!Number.isInteger(w) || w < 0 || w > 7) continue;
      merged.set(i, w);
    }
  }
  for (const idx of drumVoices.keys()) merged.delete(idx);
  for (const voice of voices) {
    const idx = sourceVoiceIndex(voice.id);
    if (idx === null) continue;
    if (voice.kind === 'drum') continue;
    const w = merged.get(idx);
    if (w !== undefined) voice.instrument = w;
  }
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

interface ChecksContext {
  totalSlots: number;
  beatSlots: number;
  channelsUsed: number;
}

function runChecks(voices: VoiceInspection[], ctx: ChecksContext): InspectionFinding[] {
  const findings: InspectionFinding[] = [];

  for (const v of voices) {
    if (v.noteCount === 0) {
      findings.push({
        code: 'SILENT_VOICE',
        severity: 'warn',
        voice: v.id,
        message: `${v.id} has no notes — it wastes a channel.`,
      });
    }
    if (
      v.kind === 'melodic' &&
      v.noteCount >= 8 &&
      Object.keys(v.durationHistogram).length > 0 &&
      v.durationEntropy < 0.5
    ) {
      // Drum voices intentionally hit a uniform grid — entropy on note
      // durations isn't the right musical signal there. DRUMS_ON_DOWNBEAT
      // covers the analogous concern (onset placement).
      findings.push({
        code: 'MONOTONIC_RHYTHM',
        severity: 'info',
        voice: v.id,
        message: `${v.id} has rhythm entropy ${v.durationEntropy.toFixed(2)} bits (${v.noteCount} notes); consider varying note durations.`,
      });
    }
    const totalV = v.noteSlots + v.restSlots;
    if (totalV >= 32 && v.restSlots / totalV < 0.05 && v.kind === 'melodic') {
      findings.push({
        code: 'NO_RESTS',
        severity: 'info',
        voice: v.id,
        message: `${v.id} rests on ${v.restSlots}/${totalV} slots (<5%); a non-stop voice is exhausting to listen to.`,
      });
    }
    if (v.pitchRange) {
      const lowEdge = v.pitchRange.minPico8 <= PICO8_PITCH_MIN + 1;
      const highEdge = v.pitchRange.maxPico8 >= PICO8_PITCH_MAX - 1;
      if (lowEdge || highEdge) {
        const where = lowEdge && highEdge ? 'both edges' : lowEdge ? 'low edge' : 'high edge';
        findings.push({
          code: 'PITCH_AT_RANGE_EDGE',
          severity: 'info',
          voice: v.id,
          message: `${v.id} hits Pico-8 ${where} (range ${v.pitchRange.minPico8}–${v.pitchRange.maxPico8}); notes at the edges sound thin.`,
        });
      }
    }
    if (
      v.kind === 'drum' &&
      v.drumOnsetSlots &&
      v.drumOnsetSlots.length >= 4 &&
      ctx.beatSlots > 1 &&
      v.drumOnsetSlots.every((s) => s % ctx.beatSlots === 0)
    ) {
      findings.push({
        code: 'DRUMS_ON_DOWNBEAT',
        severity: 'info',
        voice: v.id,
        message: `${v.id} only hits on downbeats (${v.drumOnsetSlots.length} hits, all on beat); consider offbeat hats or syncopation.`,
      });
    }
  }

  const melodics = voices.filter((v) => v.kind === 'melodic' && v.pitchRange);
  for (let i = 0; i < melodics.length; i += 1) {
    for (let j = i + 1; j < melodics.length; j += 1) {
      const overlap = pitchHistogramOverlap(melodics[i]!, melodics[j]!);
      if (overlap > 0.7) {
        findings.push({
          code: 'REGISTER_CLASH',
          severity: 'info',
          message: `${melodics[i]!.id} and ${melodics[j]!.id} share ${(overlap * 100).toFixed(0)}% of their pitch ranges; audibly muddy.`,
        });
      }
    }
  }

  if (ctx.channelsUsed >= CHANNEL_COUNT) {
    findings.push({
      code: 'CHANNEL_BUDGET_TIGHT',
      severity: 'info',
      message: `Tune uses all ${CHANNEL_COUNT} channels — any added chord or new voice will overflow.`,
    });
  }

  return findings;
}

function pitchHistogramOverlap(a: VoiceInspection, b: VoiceInspection): number {
  if (!a.pitchRange || !b.pitchRange) return 0;
  const lo = Math.max(a.pitchRange.minMidi, b.pitchRange.minMidi);
  const hi = Math.min(a.pitchRange.maxMidi, b.pitchRange.maxMidi);
  if (hi < lo) return 0;
  const spanA = Math.max(1, a.pitchRange.maxMidi - a.pitchRange.minMidi + 1);
  const spanB = Math.max(1, b.pitchRange.maxMidi - b.pitchRange.minMidi + 1);
  const overlap = hi - lo + 1;
  // Jaccard-ish: overlap / min(spanA, spanB). Using min so an overlap that
  // fully covers the smaller voice scores 1.0 even if the wider voice spans
  // beyond it. This matches the "voices spending most of their time in
  // overlapping octaves" framing from docs/llm-failure-modes.md.
  return overlap / Math.min(spanA, spanB);
}

export interface PianoRollOptions {
  // Cap the rendered slot count. Defaults to no cap.
  maxSlots?: number;
}

export function renderPianoRoll(result: InspectionResult, opts: PianoRollOptions = {}): string {
  if (!result.ok || result.voices.length === 0) return '(no content)';
  const cap = opts.maxSlots ?? result.totalSlots;
  const slotsToRender = Math.min(result.totalSlots, cap);
  const idWidth = Math.max(...result.voices.map((v) => v.id.length));
  const lines: string[] = [];
  const ruler = buildRuler(slotsToRender, result.beatSlots);
  lines.push(`${' '.repeat(idWidth)}  ${ruler}`);
  for (const v of result.voices) {
    const padded = v.id.padStart(idWidth);
    const roll = v.roll.slice(0, slotsToRender);
    lines.push(`${padded}  ${roll}`);
  }
  if (slotsToRender < result.totalSlots) {
    lines.push(`(truncated: ${result.totalSlots - slotsToRender} more slots)`);
  }
  return lines.join('\n');
}

function buildRuler(slots: number, beatSlots: number): string {
  if (beatSlots < 1) return '.'.repeat(slots);
  const chars: string[] = [];
  for (let i = 0; i < slots; i += 1) {
    chars.push(i % beatSlots === 0 ? '|' : '.');
  }
  return chars.join('');
}
