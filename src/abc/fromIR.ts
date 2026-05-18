// Score IR -> ABC text. Mirror of abc/toIR.ts. Used by the reverse pipeline
// (pico8ToAbc) to render decoded carts into ABC.

import type { Note, Score, Voice } from '../ir/types.js';
import type { BuiltInKitName, DrumName, Kit } from '../pico8/kits.js';
import { BUILT_IN_KITS, DRUM_NAMES } from '../pico8/kits.js';
import { PICO8_MIDI_OFFSET } from '../pico8/constraints.js';

export interface FromIROptions {
  // Number of slots per ABC unit. Drives duration rendering — each note's
  // ABC duration = (durationTick / slotTicks) / slotsPerUnit. The dequantize
  // step picks this together with `lDen` so they're consistent.
  slotsPerUnit: number;
  // Denominator of L: (e.g. 8 for L:1/8).
  lDen: number;
  // Per-voice metadata (instrument waveform, drum kit). voiceMeta[i]
  // corresponds to score.voices[i] in declaration order.
  voiceMeta: FromIRVoiceMeta[];
}

export interface FromIRVoiceMeta {
  // Source voice number (1-based — V:1, V:2, ...). Matches score.voices[i].id.
  voiceNumber: number;
  instrument?: number;
  drumKit?: BuiltInKitName;
}

// Pico-8 pitch -> default ABC letter for the kit's drum vocabulary.
// Inverse of DRUM_LETTER_MAP in toIR.ts. Used to render drum-voice notes.
const DRUM_NAME_TO_LETTER: Readonly<Record<DrumName, string>> = {
  kick: 'c',
  snare: 'd',
  'hat-closed': 'e',
  'hat-open': 'f',
  'tom-low': 'g',
  'tom-mid': 'a',
  'tom-high': 'b',
};

export function fromIR(score: Score, opts: FromIROptions): string {
  const lines: string[] = [];
  lines.push('X:1');
  if (score.meta.title) lines.push(`T:${score.meta.title}`);
  const ts = score.meta.timeSignature ?? [4, 4];
  lines.push(`M:${ts[0]}/${ts[1]}`);
  lines.push(`L:1/${opts.lDen}`);
  lines.push(`Q:1/4=${Math.round(score.tempoBpm)}`);

  // Emit %%pico8 directives before K: (matches existing example layout).
  for (const meta of opts.voiceMeta) {
    if (meta.drumKit) {
      lines.push(`%%pico8 drum ${meta.voiceNumber}`);
      if (meta.drumKit !== 'noise') {
        // Round-trip hint: the forward path's CLI flag is --kit <name>.
        // No directive equivalent in the ABC layer, so we surface a comment.
        lines.push(`% pico8 kit ${meta.voiceNumber} ${meta.drumKit}`);
      }
    } else if (meta.instrument !== undefined) {
      lines.push(`%%pico8 instrument ${meta.voiceNumber} ${meta.instrument}`);
    }
  }

  lines.push('K:C');

  // Slot-tick conversion: every note's durationTick is a multiple of slotTicks.
  // slotTicks = ticksPerQuarter * 4 / lDen / slotsPerUnit.
  const slotTicks = (score.ticksPerQuarter * 4) / opts.lDen / opts.slotsPerUnit;
  // ticks per ABC unit.
  const ticksPerUnit = slotTicks * opts.slotsPerUnit;

  for (let i = 0; i < score.voices.length; i += 1) {
    const voice = score.voices[i]!;
    const meta = opts.voiceMeta[i];
    lines.push(`V:${voiceIdToNumber(voice.id)}`);
    const kit = meta?.drumKit ? BUILT_IN_KITS[meta.drumKit] : null;
    lines.push(renderVoiceBody(voice, ticksPerUnit, score, kit));
  }

  return lines.join('\n') + '\n';
}

function voiceIdToNumber(id: string): number {
  const m = /^V(\d+)/.exec(id);
  return m ? Number(m[1]) : 1;
}

function renderVoiceBody(
  voice: Voice,
  ticksPerUnit: number,
  score: Score,
  kit: Kit | null,
): string {
  // Render notes left-to-right, splitting rests that span multiple bars so
  // each bar contains its own content and bar lines never double up.
  const repeat = score.repeat;
  const ts = score.meta.timeSignature ?? [4, 4];
  const ticksPerQuarter = score.ticksPerQuarter;
  const ticksPerBar = ticksPerQuarter * 4 * (ts[0] / ts[1]);

  // Skip pitch=null notes (dequantize-emitted rests); leading/intermediate
  // silence is reconstructed by `advanceWithRest` as a gap, which correctly
  // splits across bar lines.
  const notes = voice.notes
    .filter((n) => n.pitch !== null)
    .slice()
    .sort((a, b) => a.startTick - b.startTick);

  // Total voice length is the max endTick across all notes (including rests).
  const totalTicks = voice.notes.reduce((m, n) => Math.max(m, n.startTick + n.durationTick), 0);

  const ctx: RenderCtx = {
    tokens: [],
    cursor: 0,
    nextBar: ticksPerBar,
    ticksPerBar,
    ticksPerUnit,
    repeat: repeat ?? null,
    repeatStarted: !repeat,
    repeatEnded: !repeat,
  };

  for (const note of notes) {
    if (note.startTick > ctx.cursor) {
      advanceWithRest(ctx, note.startTick);
    }
    maybeEmitRepeatStart(ctx);
    maybeEmitBar(ctx);
    ctx.tokens.push(renderNoteToken(note, ctx.ticksPerUnit, kit, voice));
    ctx.cursor += note.durationTick;
    maybeEmitRepeatEnd(ctx);
  }

  // Fill any trailing silence so the voice ends at the full length.
  if (ctx.cursor < totalTicks) {
    advanceWithRest(ctx, totalTicks);
  }
  // Trailing bar line.
  if (ctx.tokens.length === 0) ctx.tokens.push('z');
  if (ctx.tokens[ctx.tokens.length - 1] !== '|' && ctx.tokens[ctx.tokens.length - 1] !== ':|') {
    ctx.tokens.push('|');
  }
  return ctx.tokens.join(' ');
}

interface RenderCtx {
  tokens: string[];
  cursor: number;
  nextBar: number;
  ticksPerBar: number;
  ticksPerUnit: number;
  repeat: { startTick: number; endTick: number } | null;
  repeatStarted: boolean;
  repeatEnded: boolean;
}

function advanceWithRest(ctx: RenderCtx, target: number): void {
  while (ctx.cursor < target) {
    const restEnd = Math.min(target, ctx.nextBar);
    const dur = restEnd - ctx.cursor;
    if (dur > 0) ctx.tokens.push(restToken(dur, ctx.ticksPerUnit));
    ctx.cursor = restEnd;
    maybeEmitRepeatStart(ctx);
    maybeEmitRepeatEnd(ctx);
    if (ctx.cursor >= ctx.nextBar) {
      ctx.tokens.push('|');
      ctx.nextBar += ctx.ticksPerBar;
    }
  }
}

function maybeEmitBar(ctx: RenderCtx): void {
  if (ctx.cursor >= ctx.nextBar) {
    ctx.tokens.push('|');
    ctx.nextBar += ctx.ticksPerBar;
  }
}

function maybeEmitRepeatStart(ctx: RenderCtx): void {
  if (ctx.repeat && !ctx.repeatStarted && ctx.cursor >= ctx.repeat.startTick) {
    ctx.tokens.push('|:');
    ctx.repeatStarted = true;
  }
}

function maybeEmitRepeatEnd(ctx: RenderCtx): void {
  if (ctx.repeat && !ctx.repeatEnded && ctx.cursor >= ctx.repeat.endTick) {
    ctx.tokens.push(':|');
    ctx.repeatEnded = true;
    // Avoid emitting a bar at the exact repeat-end slot too.
    if (ctx.cursor >= ctx.nextBar) ctx.nextBar += ctx.ticksPerBar;
  }
}

function restToken(durationTicks: number, ticksPerUnit: number): string {
  const u = Math.max(1, Math.round(durationTicks / ticksPerUnit));
  return `z${u === 1 ? '' : u}`;
}

function renderNoteToken(
  note: Note,
  ticksPerUnit: number,
  kit: Kit | null,
  voice: Voice,
): string {
  const u = Math.max(1, Math.round(note.durationTick / ticksPerUnit));
  if (note.pitch === null) return restToken(note.durationTick, ticksPerUnit);
  const body = renderNoteBody(note, kit, voice);
  return `${body}${u === 1 ? '' : u}`;
}

function renderNoteBody(note: Note, kit: Kit | null, voice: Voice): string {
  // Drum-voice notes: reverse-map (waveform, pitch, volume, effect) back to
  // the kit's drum letter. If lookup fails (kit drift), fall back to the
  // melodic letter so the user can see what slipped through.
  if (voice.kind === 'drum' && kit) {
    const drumName = findDrumName(note, kit);
    if (drumName) return DRUM_NAME_TO_LETTER[drumName];
  }

  // Arp chord: emit [pitches] with all chord pitches.
  if (note.extraPitches && note.extraPitches.length > 0 && note.pitch !== null) {
    const allPitches = [note.pitch, ...note.extraPitches];
    return `[${allPitches.map(midiToAbcLetter).join('')}]`;
  }

  return midiToAbcLetter(note.pitch as number);
}

function findDrumName(note: Note, kit: Kit): DrumName | null {
  if (note.pitch === null) return null;
  const pico8Pitch = note.pitch - PICO8_MIDI_OFFSET;
  for (const name of DRUM_NAMES) {
    const hit = kit[name];
    if (
      note.instrument === hit.waveform &&
      pico8Pitch === hit.pitch &&
      note.velocity === hit.volume &&
      note.pico8Effect === hit.effect
    ) {
      return name;
    }
  }
  return null;
}

// MIDI 60 = "C" (no marks), 72 = "c", 84 = "c'", 48 = "C,", 36 = "C,,".
// Accidentals: use ^ for sharps with K:C as the reverse default (no key
// alterations in play).
const NATURAL_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SEMITONE_OF_NATURAL: Readonly<Record<string, number>> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

export function midiToAbcLetter(midi: number): string {
  const octave = Math.floor(midi / 12) - 1; // scientific octave: MIDI 60 = C4
  const semitone = midi % 12;
  let baseLetter = '';
  let accidental = '';
  // Find the diatonic letter whose natural is closest (and emit sharp if
  // semitone is one above).
  for (const letter of NATURAL_LETTERS) {
    if (SEMITONE_OF_NATURAL[letter] === semitone) {
      baseLetter = letter;
      break;
    }
    if (SEMITONE_OF_NATURAL[letter] === semitone - 1) {
      baseLetter = letter;
      accidental = '^';
      break;
    }
  }
  if (!baseLetter) {
    // Fallback: B# wraps to next-octave C. Just emit ^B in current octave;
    // shouldn't happen for the natural-letter-then-sharp lookup above.
    baseLetter = 'C';
  }

  // ABC octave conventions:
  //   C  = scientific C4 (MIDI 60)  → octave 4 base
  //   c  = scientific C5 (MIDI 72)
  //   c' = scientific C6, c'' = C7, ...
  //   C, = scientific C3, C,, = C2, ...
  let body: string;
  if (octave >= 5) {
    body = baseLetter.toLowerCase();
    if (octave > 5) body += "'".repeat(octave - 5);
  } else {
    body = baseLetter;
    if (octave < 4) body += ','.repeat(4 - octave);
  }
  return accidental + body;
}
