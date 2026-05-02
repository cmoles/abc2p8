import type {
  KeySignature,
  TuneObject,
  VoiceItem,
  VoiceItemBar,
  VoiceItemNote,
} from 'abcjs';
import type { Diagnostics } from '../ir/diagnostics.js';
import type { Note, RepeatRegion, Score, Voice } from '../ir/types.js';

export const TICKS_PER_QUARTER = 48;

const DIATONIC_TO_SEMITONES: Readonly<Record<string, number>> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

const ACCIDENTAL_DELTA: Readonly<Record<string, number>> = {
  sharp: 1,
  flat: -1,
  natural: 0,
  dblsharp: 2,
  dblflat: -2,
};

interface PitchObj {
  pitch: number;
  name?: string;
  accidental?: string;
}

function isVoiceItemNote(v: VoiceItem): v is VoiceItemNote {
  return v.el_type === 'note';
}

function letterFromDiatonic(p: number): string {
  const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  return letters[((p % 7) + 7) % 7]!;
}

function octaveFromDiatonic(p: number): number {
  // abcjs pitch 0 = middle C = scientific C4. Scientific octave = 4 + floor(p/7).
  return 4 + Math.floor(p / 7);
}

function diatonicBaseMidi(p: number): number {
  // MIDI of the natural form of this diatonic step (no accidentals applied).
  const letter = letterFromDiatonic(p);
  const semitone = DIATONIC_TO_SEMITONES[letter]!;
  const octave = octaveFromDiatonic(p);
  return (octave + 1) * 12 + semitone;
}

function keySignatureMap(key: KeySignature | undefined): Map<string, number> {
  const m = new Map<string, number>();
  if (!key?.accidentals) return m;
  for (const a of key.accidentals) {
    const delta = ACCIDENTAL_DELTA[a.acc];
    if (delta === undefined) continue;
    m.set(a.note.toUpperCase(), delta);
  }
  return m;
}

function abcDurationToTicks(duration: number): number {
  // abcjs duration is in whole-note units. Quarter = 0.25.
  return Math.round(duration * 4 * TICKS_PER_QUARTER);
}

interface ConvertContext {
  diagnostics: Diagnostics;
  keyMap: Map<string, number>;
  // Per-measure accidental overrides keyed by `${letter}${octave}`.
  measureAccidentals: Map<string, number>;
}

function pitchToMidi(p: PitchObj, ctx: ConvertContext): number {
  const base = diatonicBaseMidi(p.pitch);
  const letter = letterFromDiatonic(p.pitch);
  const octave = octaveFromDiatonic(p.pitch);
  const measureKey = `${letter}${octave}`;

  let delta: number;
  if (p.accidental !== undefined) {
    delta = ACCIDENTAL_DELTA[p.accidental] ?? 0;
    ctx.measureAccidentals.set(measureKey, delta);
  } else if (ctx.measureAccidentals.has(measureKey)) {
    delta = ctx.measureAccidentals.get(measureKey)!;
  } else {
    delta = ctx.keyMap.get(letter) ?? 0;
  }
  return base + delta;
}

export function abcToScore(tune: TuneObject, diagnostics: Diagnostics): Score | null {
  const firstStaff = tune.lines.find((l) => l.staff && l.staff.length > 0)?.staff?.[0];
  if (!firstStaff) {
    diagnostics.error('toIR', 'NO_STAFF', 'Tune has no staff content.');
    return null;
  }

  const allVoices = collectVoices(tune);
  if (allVoices.length === 0) {
    diagnostics.error('toIR', 'NO_VOICES', 'Tune has no voice content.');
    return null;
  }
  if (allVoices.length > 1) {
    diagnostics.error(
      'toIR',
      'MULTI_VOICE_UNSUPPORTED',
      `Tune has ${allVoices.length} voices; slice 1 supports a single voice.`,
    );
    return null;
  }

  const ctx: ConvertContext = {
    diagnostics,
    keyMap: keySignatureMap(firstStaff.key),
    measureAccidentals: new Map(),
  };

  const tempoBpm = resolveQuarterBpm(tune, diagnostics);
  const items = allVoices[0]!;
  const notes: Note[] = [];
  let cursor = 0;
  let pendingTie: Note | null = null;
  let repeatStart: number | null = null;
  let repeatEnd: number | null = null;
  let extraRepeatWarned = false;

  for (const item of items) {
    if (item.el_type === 'bar') {
      ctx.measureAccidentals.clear();
      ({ repeatStart, repeatEnd, extraRepeatWarned } = handleRepeatBar(
        item,
        cursor,
        repeatStart,
        repeatEnd,
        extraRepeatWarned,
        diagnostics,
      ));
      continue;
    }
    if (item.el_type === 'key') {
      ctx.keyMap = keySignatureMap(item);
      ctx.measureAccidentals.clear();
      diagnostics.info('toIR', 'KEY_CHANGE', 'Mid-tune key change applied.');
      continue;
    }
    if (item.el_type === 'meter') {
      diagnostics.info(
        'toIR',
        'METER_CHANGE_IGNORED',
        'Mid-tune meter change ignored; pico-8 has no meter concept.',
      );
      continue;
    }
    if (item.el_type === 'tempo') {
      diagnostics.info(
        'toIR',
        'TEMPO_CHANGE_IGNORED',
        'Mid-tune tempo change ignored; pico-8 SFX speed is set once per slot.',
      );
      continue;
    }
    if (item.el_type === 'clef') {
      continue;
    }
    if (!isVoiceItemNote(item)) {
      diagnoseDroppedItem(item, diagnostics);
      continue;
    }

    const durationTicks = abcDurationToTicks(item.duration);
    if (durationTicks <= 0) {
      diagnostics.info(
        'toIR',
        'ZERO_DURATION',
        'Skipped voice item with zero duration.',
      );
      continue;
    }

    diagnoseNoteOrnaments(item, diagnostics);

    if (item.rest) {
      pendingTie = null;
      notes.push({ startTick: cursor, durationTick: durationTicks, pitch: null });
      cursor += durationTicks;
      continue;
    }

    const pitches = (item.pitches ?? []) as PitchObj[];
    if (pitches.length === 0) {
      diagnostics.info('toIR', 'EMPTY_NOTE', 'Note item has no pitches; skipped.');
      continue;
    }
    if (pitches.length > 1) {
      diagnostics.error(
        'toIR',
        'CHORD_UNSUPPORTED',
        `Chord with ${pitches.length} notes; slice 1 supports monophonic input only.`,
      );
      return null;
    }

    const midi = pitchToMidi(pitches[0]!, ctx);
    const note: Note = { startTick: cursor, durationTick: durationTicks, pitch: midi };

    if (pendingTie && pendingTie.pitch === midi) {
      pendingTie.durationTick += durationTicks;
    } else {
      notes.push(note);
    }
    cursor += durationTicks;

    const startsTie = noteHasTie(item);
    if (startsTie) {
      pendingTie = pendingTie && pendingTie.pitch === midi ? pendingTie : note;
      pendingTie.tiedToNext = true;
    } else {
      if (pendingTie) pendingTie.tiedToNext = false;
      pendingTie = null;
    }
  }

  const voice: Voice = { id: 'V1', notes };
  const meter = firstStaff.meter;
  const timeSignature = meter?.value?.[0]
    ? ([meter.value[0].num, meter.value[0].den ?? 4] as [number, number])
    : undefined;

  const repeat = finalizeRepeatRegion(repeatStart, repeatEnd, cursor, diagnostics);

  return {
    ticksPerQuarter: TICKS_PER_QUARTER,
    tempoBpm,
    voices: [voice],
    meta: {
      title: tune.metaText?.title,
      composer: tune.metaText?.composer,
      keySignature: firstStaff.key?.root,
      timeSignature,
    },
    ...(repeat ? { repeat } : {}),
  };
}

interface RepeatState {
  repeatStart: number | null;
  repeatEnd: number | null;
  extraRepeatWarned: boolean;
}

function handleRepeatBar(
  bar: VoiceItemBar,
  cursor: number,
  repeatStart: number | null,
  repeatEnd: number | null,
  extraRepeatWarned: boolean,
  diagnostics: Diagnostics,
): RepeatState {
  const isLeft = bar.type === 'bar_left_repeat' || bar.type === 'bar_dbl_repeat';
  const isRight = bar.type === 'bar_right_repeat' || bar.type === 'bar_dbl_repeat';
  if (!isLeft && !isRight) {
    return { repeatStart, repeatEnd, extraRepeatWarned };
  }

  let warned = extraRepeatWarned;
  const warnExtra = (): void => {
    if (warned) return;
    diagnostics.warn(
      'toIR',
      'MULTIPLE_REPEATS',
      'Multiple repeat regions found; only the first |: … :| pair is preserved.',
    );
    warned = true;
  };

  let nextStart = repeatStart;
  let nextEnd = repeatEnd;

  if (isRight) {
    if (nextEnd !== null) {
      warnExtra();
    } else {
      nextEnd = cursor;
      if (nextStart === null) nextStart = 0;
    }
  }
  if (isLeft) {
    if (nextStart !== null && nextEnd !== null) {
      warnExtra();
    } else if (nextStart === null) {
      nextStart = cursor;
    } else {
      // |: appeared twice without an intervening :| — keep the first.
      warnExtra();
    }
  }

  return { repeatStart: nextStart, repeatEnd: nextEnd, extraRepeatWarned: warned };
}

function finalizeRepeatRegion(
  repeatStart: number | null,
  repeatEnd: number | null,
  totalTicks: number,
  diagnostics: Diagnostics,
): RepeatRegion | null {
  if (repeatStart === null && repeatEnd === null) return null;
  if (repeatEnd === null) {
    diagnostics.warn(
      'toIR',
      'INCOMPLETE_REPEAT',
      '|: found without matching :|; repeat dropped.',
    );
    return null;
  }
  const start = repeatStart ?? 0;
  if (repeatEnd <= start) {
    diagnostics.warn(
      'toIR',
      'EMPTY_REPEAT',
      'Repeat region has zero or negative length; dropped.',
    );
    return null;
  }
  if (repeatEnd > totalTicks) {
    return { startTick: start, endTick: totalTicks };
  }
  return { startTick: start, endTick: repeatEnd };
}

function collectVoices(tune: TuneObject): VoiceItem[][] {
  // Slice 1: assume the tune has at most one logical voice that may be split
  // across lines; concatenate all voice arrays from each line/staff in order.
  const merged: VoiceItem[] = [];
  let voiceCount = 0;
  for (const line of tune.lines) {
    if (!line.staff) continue;
    for (const staff of line.staff) {
      if (!staff.voices) continue;
      voiceCount = Math.max(voiceCount, staff.voices.length);
      for (const v of staff.voices[0] ?? []) merged.push(v);
    }
  }
  if (voiceCount === 0) return [];
  if (voiceCount > 1) {
    return Array.from({ length: voiceCount }, (_, i) => collectVoiceIndex(tune, i));
  }
  return [merged];
}

function collectVoiceIndex(tune: TuneObject, index: number): VoiceItem[] {
  const out: VoiceItem[] = [];
  for (const line of tune.lines) {
    if (!line.staff) continue;
    for (const staff of line.staff) {
      if (!staff.voices) continue;
      for (const v of staff.voices[index] ?? []) out.push(v);
    }
  }
  return out;
}

function resolveQuarterBpm(tune: TuneObject, diagnostics: Diagnostics): number {
  const tempo = tune.metaText?.tempo;
  if (!tempo?.bpm) {
    diagnostics.info('toIR', 'NO_TEMPO', 'No tempo specified; defaulting to 120 BPM.');
    return 120;
  }
  const beatLen = tempo.duration?.[0] ?? 0.25;
  // bpm beats of duration `beatLen` (in whole-notes) per minute.
  // quarterBpm = bpm * (beatLen / 0.25)
  const quarterBpm = tempo.bpm * (beatLen / 0.25);
  return quarterBpm;
}

function diagnoseDroppedItem(item: VoiceItem, diagnostics: Diagnostics): void {
  switch (item.el_type) {
    case 'gap':
      diagnostics.info('toIR', 'GAP_IGNORED', 'Voice gap (visual spacing) ignored.');
      return;
    case 'midi':
      diagnostics.info(
        'toIR',
        'MIDI_DIRECTIVE_IGNORED',
        '%%MIDI directive ignored; instrument selection is not yet wired through.',
      );
      return;
    case 'overlay':
      diagnostics.warn(
        'toIR',
        'OVERLAY_IGNORED',
        'Voice overlay (& syntax) dropped; the overlaid notes will not be heard.',
      );
      return;
    case 'part':
      diagnostics.info(
        'toIR',
        'PART_DIRECTIVE_IGNORED',
        'P: part marker ignored; abc2p8 does not yet expand part orderings.',
      );
      return;
    case 'scale':
      diagnostics.info('toIR', 'SCALE_DIRECTIVE_IGNORED', 'Scale directive ignored (visual only).');
      return;
    case 'stem':
      diagnostics.info('toIR', 'STEM_DIRECTIVE_IGNORED', 'Stem directive ignored (visual only).');
      return;
    case 'style':
      diagnostics.info('toIR', 'STYLE_DIRECTIVE_IGNORED', 'Style directive ignored (visual only).');
      return;
    case 'transpose':
      diagnostics.warn(
        'toIR',
        'TRANSPOSE_IGNORED',
        'Transpose directive ignored; pitches will not be shifted.',
      );
      return;
    default:
      diagnostics.warn(
        'toIR',
        'DROPPED_ITEM',
        `Dropped voice item of unrecognized type "${item.el_type}".`,
      );
  }
}

interface NoteOrnaments {
  decoration?: string[];
  gracenotes?: unknown[];
}

function diagnoseNoteOrnaments(item: VoiceItemNote, diagnostics: Diagnostics): void {
  const ornaments = item as unknown as NoteOrnaments;
  if (ornaments.decoration && ornaments.decoration.length > 0) {
    diagnostics.warn(
      'toIR',
      'DECORATION_DROPPED',
      `Note decoration(s) dropped: ${ornaments.decoration.join(', ')}.`,
    );
  }
  if (ornaments.gracenotes && ornaments.gracenotes.length > 0) {
    diagnostics.warn(
      'toIR',
      'GRACE_NOTES_DROPPED',
      `${ornaments.gracenotes.length} grace note(s) dropped.`,
    );
  }
}

function noteHasTie(item: VoiceItemNote): boolean {
  const anyItem = item as unknown as { startTie?: unknown; pitches?: PitchObj[] };
  if (anyItem.startTie) return true;
  for (const p of (anyItem.pitches ?? []) as Array<PitchObj & { startTie?: unknown }>) {
    if (p.startTie) return true;
  }
  return false;
}
