import type {
  KeySignature,
  TuneObject,
  VoiceItem,
  VoiceItemBar,
  VoiceItemNote,
} from 'abcjs';
import type { Diagnostics } from '../ir/diagnostics.js';
import { PICO8_MIDI_OFFSET } from '../pico8/constraints.js';
import type { DrumName, Kit } from '../pico8/kits.js';
import type { Note, RepeatRegion, Score, Voice, VoiceKind } from '../ir/types.js';

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

export const MAX_VOICES = 4;
export const MAX_ARP_CHORD = 4;

export type ChordStrategy = 'auto' | 'expand' | 'arp';
type ResolvedChordStrategy = 'expand' | 'arp';

export interface VoiceDrumConfig {
  // Resolved kit data — built-in kit name lookup happens in the caller so
  // the IR layer doesn't need to know about kit registries.
  kit: Kit;
}

export interface ToIROptions {
  chordStrategy?: ChordStrategy;
  // 0-based voice index → drum config. Voices not in the map are melodic.
  drumVoices?: Map<number, VoiceDrumConfig>;
}

// Plain ABC letter → fixed drum name. Octave is ignored in v1.
const DRUM_LETTER_MAP: Readonly<Record<string, DrumName>> = {
  C: 'kick',
  D: 'snare',
  E: 'hat-closed',
  F: 'hat-open',
  G: 'tom-low',
  A: 'tom-mid',
  B: 'tom-high',
};

function resolveAutoStrategy(
  allVoices: VoiceItem[][],
  diagnostics: Diagnostics,
): ResolvedChordStrategy {
  let total = 0;
  for (const items of allVoices) {
    let maxArity = 1;
    for (const item of items) {
      if (!isVoiceItemNote(item)) continue;
      if (item.rest) continue;
      const pitches = (item.pitches as unknown[] | undefined) ?? [];
      if (pitches.length > maxArity) maxArity = pitches.length;
    }
    total += maxArity;
  }
  if (total <= MAX_VOICES) return 'expand';
  diagnostics.info(
    'toIR',
    'AUTO_ARP_FALLBACK',
    `Expand mode would need ${total} channels (> ${MAX_VOICES}); auto-selected arp chord strategy.`,
  );
  return 'arp';
}

export function abcToScore(
  tune: TuneObject,
  diagnostics: Diagnostics,
  opts: ToIROptions = {},
): Score | null {
  const requestedStrategy: ChordStrategy = opts.chordStrategy ?? 'auto';
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
  if (allVoices.length > MAX_VOICES) {
    diagnostics.error(
      'toIR',
      'TOO_MANY_VOICES',
      `Tune has ${allVoices.length} voices; pico-8 has only ${MAX_VOICES} channels.`,
    );
    return null;
  }

  const tempoBpm = resolveQuarterBpm(tune, diagnostics);

  const chordStrategy: ResolvedChordStrategy =
    requestedStrategy === 'auto'
      ? resolveAutoStrategy(allVoices, diagnostics)
      : requestedStrategy;

  const drumVoices = opts.drumVoices ?? new Map<number, VoiceDrumConfig>();
  const converted: VoiceConvertResult[] = [];
  for (let i = 0; i < allVoices.length; i += 1) {
    const id = `V${i + 1}`;
    const drum = drumVoices.get(i);
    // Drum voices ignore the chord strategy: arpeggiating a kick+hat is
    // musically wrong, so simultaneous drum hits always expand to siblings.
    const voiceStrategy: ResolvedChordStrategy = drum ? 'expand' : chordStrategy;
    converted.push(
      convertVoiceItems(allVoices[i]!, firstStaff.key, id, diagnostics, voiceStrategy, drum),
    );
  }

  const totalChannels = converted.reduce((sum, c) => sum + c.siblings.length, 0);
  if (totalChannels > MAX_VOICES) {
    const breakdown = converted
      .map((c, i) => `V${i + 1}=${c.siblings.length}`)
      .join(', ');
    const arpHint =
      chordStrategy === 'expand'
        ? ' Drop chordStrategy: "expand" (or set "auto"/"arp") to let chords share a channel via Pico-8\'s arp effect.'
        : '';
    diagnostics.error(
      'toIR',
      'CHORD_OVERFLOW',
      `Chords need ${totalChannels} channels (${breakdown}); pico-8 has only ${MAX_VOICES}.${arpHint}`,
    );
    return null;
  }

  const scoreRepeat = converted[0]!.repeat;
  for (let i = 1; i < converted.length; i += 1) {
    const r = converted[i]!.repeat;
    const same =
      (r === null && scoreRepeat === null) ||
      (r !== null &&
        scoreRepeat !== null &&
        r.startTick === scoreRepeat.startTick &&
        r.endTick === scoreRepeat.endTick);
    if (!same) {
      diagnostics.warn(
        'toIR',
        'VOICE_REPEAT_MISMATCH',
        `Voice V${i + 1} has different repeat bounds than V1; using V1's bounds.`,
        { voice: `V${i + 1}` },
      );
    }
  }

  const voices: Voice[] = [];
  for (let i = 0; i < converted.length; i += 1) {
    const c = converted[i]!;
    const sourceId = `V${i + 1}`;
    const kind: VoiceKind = drumVoices.has(i) ? 'drum' : 'melodic';
    if (c.siblings.length === 1) {
      voices.push({ id: sourceId, notes: c.siblings[0]!, kind });
    } else {
      for (let s = 0; s < c.siblings.length; s += 1) {
        const suffix = String.fromCharCode(0x41 + s);
        voices.push({ id: `${sourceId}.${suffix}`, notes: c.siblings[s]!, kind });
      }
    }
  }

  const meter = firstStaff.meter;
  const timeSignature = meter?.value?.[0]
    ? ([meter.value[0].num, meter.value[0].den ?? 4] as [number, number])
    : undefined;

  return {
    ticksPerQuarter: TICKS_PER_QUARTER,
    tempoBpm,
    voices,
    meta: {
      title: tune.metaText?.title,
      composer: tune.metaText?.composer,
      keySignature: firstStaff.key?.root,
      timeSignature,
    },
    ...(scoreRepeat ? { repeat: scoreRepeat } : {}),
  };
}

interface VoiceConvertResult {
  // One sibling per slot in the source voice's max chord arity. A voice with no
  // chords always has exactly one sibling. Sibling 0 carries the lowest pitch
  // at each chord position; higher siblings carry higher pitches, with rests
  // padding positions where the chord has fewer notes than the max arity.
  siblings: Note[][];
  repeat: RepeatRegion | null;
}

function convertVoiceItems(
  items: VoiceItem[],
  key: KeySignature | undefined,
  voiceId: string,
  diagnostics: Diagnostics,
  chordStrategy: ResolvedChordStrategy,
  drum: VoiceDrumConfig | undefined,
): VoiceConvertResult {
  const ctx: ConvertContext = {
    diagnostics,
    // Drum voices ignore key signatures: notes look up drum names by letter,
    // not pitch, so accidentals from K: would be misleading.
    keyMap: drum ? new Map<string, number>() : keySignatureMap(key),
    measureAccidentals: new Map(),
  };

  const siblings: Note[][] = [[]];
  const pendingTies: (Note | null)[] = [null];
  let cursor = 0;
  let repeatStart: number | null = null;
  let repeatEnd: number | null = null;
  let extraRepeatWarned = false;

  const ensureSiblingCount = (n: number): void => {
    while (siblings.length < n) {
      siblings.push([]);
      pendingTies.push(null);
    }
  };

  const pushRest = (siblingIdx: number, durationTicks: number): void => {
    siblings[siblingIdx]!.push({ startTick: cursor, durationTick: durationTicks, pitch: null });
    pendingTies[siblingIdx] = null;
  };

  const pushArpChord = (
    midis: number[],
    durationTicks: number,
    staccato: boolean,
    startsTie: boolean,
  ): void => {
    const lowest = midis[0]!;
    const extras = midis.slice(1);
    const extrasKey = extras.join(',');
    const pendingTie = pendingTies[0];
    const sameShape =
      !!pendingTie &&
      pendingTie.pitch === lowest &&
      (pendingTie.extraPitches?.join(',') ?? '') === extrasKey;

    let target: Note;
    if (sameShape && pendingTie) {
      pendingTie.durationTick += durationTicks;
      if (staccato) pendingTie.staccato = true;
      target = pendingTie;
    } else {
      const note: Note = { startTick: cursor, durationTick: durationTicks, pitch: lowest };
      if (extras.length > 0) note.extraPitches = extras;
      if (staccato) note.staccato = true;
      siblings[0]!.push(note);
      target = note;
    }

    if (startsTie) {
      target.tiedToNext = true;
      pendingTies[0] = target;
    } else {
      if (pendingTie) pendingTie.tiedToNext = false;
      pendingTies[0] = null;
    }
  };

  const pushPitch = (
    siblingIdx: number,
    midi: number,
    durationTicks: number,
    staccato: boolean,
    startsTie: boolean,
    drumHit?: Kit[DrumName],
  ): void => {
    const note: Note = { startTick: cursor, durationTick: durationTicks, pitch: midi };
    if (staccato) note.staccato = true;
    if (drumHit) {
      note.instrument = drumHit.waveform;
      note.velocity = drumHit.volume;
      note.pico8Effect = drumHit.effect;
    }

    const pendingTie = pendingTies[siblingIdx];
    let target: Note;
    if (pendingTie && pendingTie.pitch === midi) {
      pendingTie.durationTick += durationTicks;
      if (staccato) pendingTie.staccato = true;
      target = pendingTie;
    } else {
      siblings[siblingIdx]!.push(note);
      target = note;
    }

    if (startsTie) {
      target.tiedToNext = true;
      pendingTies[siblingIdx] = target;
    } else {
      if (pendingTie) pendingTie.tiedToNext = false;
      pendingTies[siblingIdx] = null;
    }
  };

  for (const item of items) {
    if (item.el_type === 'bar') {
      ctx.measureAccidentals.clear();
      ({ repeatStart, repeatEnd, extraRepeatWarned } = handleRepeatBar(
        item,
        cursor,
        repeatStart,
        repeatEnd,
        extraRepeatWarned,
        voiceId,
        diagnostics,
      ));
      continue;
    }
    if (item.el_type === 'key') {
      ctx.keyMap = keySignatureMap(item);
      ctx.measureAccidentals.clear();
      diagnostics.info('toIR', 'KEY_CHANGE', 'Mid-tune key change applied.', { voice: voiceId });
      continue;
    }
    if (item.el_type === 'meter') {
      diagnostics.info(
        'toIR',
        'METER_CHANGE_IGNORED',
        'Mid-tune meter change ignored; pico-8 has no meter concept.',
        { voice: voiceId },
      );
      continue;
    }
    if (item.el_type === 'tempo') {
      diagnostics.info(
        'toIR',
        'TEMPO_CHANGE_IGNORED',
        'Mid-tune tempo change ignored; pico-8 SFX speed is set once per slot.',
        { voice: voiceId },
      );
      continue;
    }
    if (item.el_type === 'clef') {
      continue;
    }
    if (!isVoiceItemNote(item)) {
      diagnoseDroppedItem(item, voiceId, diagnostics);
      continue;
    }

    const durationTicks = abcDurationToTicks(item.duration);
    if (durationTicks <= 0) {
      diagnostics.info(
        'toIR',
        'ZERO_DURATION',
        'Skipped voice item with zero duration.',
        { voice: voiceId },
      );
      continue;
    }

    diagnoseNoteOrnaments(item, voiceId, diagnostics);

    if (item.rest) {
      for (let i = 0; i < siblings.length; i += 1) pushRest(i, durationTicks);
      cursor += durationTicks;
      continue;
    }

    const rawPitches = (item.pitches ?? []) as Array<PitchObj & { startTie?: unknown }>;
    if (rawPitches.length === 0) {
      diagnostics.info('toIR', 'EMPTY_NOTE', 'Note item has no pitches; skipped.', {
        voice: voiceId,
      });
      continue;
    }

    const itemTie = noteItemHasTie(item);
    const staccato = hasStaccato(item);

    if (drum) {
      const hits: { hit: Kit[DrumName]; startTie: boolean }[] = [];
      for (const p of rawPitches) {
        const letter = letterFromDiatonic(p.pitch);
        // Accidentals are outside the v1 drum vocabulary: they would only
        // make sense once the letter map grows (e.g. ^c → clap). Warn and
        // drop the hit so the pitch column doesn't silently misfire.
        const accidental = p.accidental;
        const explicitAccidental =
          accidental !== undefined && accidental !== 'natural';
        const drumName = explicitAccidental ? undefined : DRUM_LETTER_MAP[letter];
        if (!drumName) {
          const desc = explicitAccidental
            ? `accidental "${accidental}" on letter "${letter}"`
            : `letter "${letter}"`;
          diagnostics.warn(
            'toIR',
            'DRUM_HIT_UNKNOWN',
            `Drum hit ${desc} has no mapping in this kit; dropped to a rest.`,
            { voice: voiceId, tick: cursor },
          );
          continue;
        }
        hits.push({ hit: drum.kit[drumName], startTie: !!p.startTie });
      }
      if (hits.length === 0) {
        for (let i = 0; i < siblings.length; i += 1) pushRest(i, durationTicks);
        cursor += durationTicks;
        continue;
      }
      hits.sort((a, b) => a.hit.pitch - b.hit.pitch);
      ensureSiblingCount(hits.length);
      for (let i = 0; i < siblings.length; i += 1) {
        if (i < hits.length) {
          const e = hits[i]!;
          const startsTie = itemTie || e.startTie;
          const midi = e.hit.pitch + PICO8_MIDI_OFFSET;
          pushPitch(i, midi, durationTicks, staccato, startsTie, e.hit);
        } else {
          pushRest(i, durationTicks);
        }
      }
      cursor += durationTicks;
      continue;
    }

    const indexed = rawPitches.map((p) => ({ p, midi: pitchToMidi(p, ctx) }));
    indexed.sort((a, b) => a.midi - b.midi);

    const startsTieAny = itemTie || indexed.some((e) => !!e.p.startTie);

    if (chordStrategy === 'arp' && indexed.length > 1) {
      let chordMidis = indexed.map((e) => e.midi);
      if (chordMidis.length > MAX_ARP_CHORD) {
        diagnostics.warn(
          'toIR',
          'CHORD_TOO_WIDE',
          `Chord has ${chordMidis.length} pitches; arp truncated to lowest ${MAX_ARP_CHORD}.`,
          { voice: voiceId },
        );
        chordMidis = chordMidis.slice(0, MAX_ARP_CHORD);
      }
      pushArpChord(chordMidis, durationTicks, staccato, startsTieAny);
      cursor += durationTicks;
      continue;
    }

    ensureSiblingCount(indexed.length);

    for (let i = 0; i < siblings.length; i += 1) {
      if (i < indexed.length) {
        const entry = indexed[i]!;
        const startsTie = itemTie || !!entry.p.startTie;
        pushPitch(i, entry.midi, durationTicks, staccato, startsTie);
      } else {
        pushRest(i, durationTicks);
      }
    }
    cursor += durationTicks;
  }

  const repeat = finalizeRepeatRegion(repeatStart, repeatEnd, cursor, voiceId, diagnostics);
  return { siblings, repeat };
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
  voiceId: string,
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
      { voice: voiceId },
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
  voiceId: string,
  diagnostics: Diagnostics,
): RepeatRegion | null {
  if (repeatStart === null && repeatEnd === null) return null;
  if (repeatEnd === null) {
    diagnostics.warn(
      'toIR',
      'INCOMPLETE_REPEAT',
      '|: found without matching :|; repeat dropped.',
      { voice: voiceId },
    );
    return null;
  }
  const start = repeatStart ?? 0;
  if (repeatEnd <= start) {
    diagnostics.warn(
      'toIR',
      'EMPTY_REPEAT',
      'Repeat region has zero or negative length; dropped.',
      { voice: voiceId },
    );
    return null;
  }
  if (repeatEnd > totalTicks) {
    return { startTick: start, endTick: totalTicks };
  }
  return { startTick: start, endTick: repeatEnd };
}

function collectVoices(tune: TuneObject): VoiceItem[][] {
  // ABC voices may be laid out either as multiple voices within one staff
  // (V: with overlay) or as one voice per staff (the common multi-`V:` case;
  // abcjs gives each V: declaration its own staff). Accumulate items by the
  // (staffIndex, voiceIndex) coordinate so a logical voice that spans lines
  // gets concatenated.
  const voicesByCoord = new Map<string, VoiceItem[]>();
  const order: string[] = [];

  for (const line of tune.lines) {
    if (!line.staff) continue;
    for (let si = 0; si < line.staff.length; si += 1) {
      const staff = line.staff[si]!;
      if (!staff.voices) continue;
      for (let vi = 0; vi < staff.voices.length; vi += 1) {
        const key = `${si}:${vi}`;
        let bucket = voicesByCoord.get(key);
        if (!bucket) {
          bucket = [];
          voicesByCoord.set(key, bucket);
          order.push(key);
        }
        for (const item of staff.voices[vi] ?? []) bucket.push(item);
      }
    }
  }
  return order.map((k) => voicesByCoord.get(k)!);
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

function diagnoseDroppedItem(
  item: VoiceItem,
  voiceId: string,
  diagnostics: Diagnostics,
): void {
  const loc = { voice: voiceId };
  switch (item.el_type) {
    case 'gap':
      diagnostics.info('toIR', 'GAP_IGNORED', 'Voice gap (visual spacing) ignored.', loc);
      return;
    case 'midi':
      diagnostics.info(
        'toIR',
        'MIDI_DIRECTIVE_IGNORED',
        '%%MIDI directive ignored; instrument selection is not yet wired through.',
        loc,
      );
      return;
    case 'overlay':
      diagnostics.warn(
        'toIR',
        'OVERLAY_IGNORED',
        'Voice overlay (& syntax) dropped; the overlaid notes will not be heard.',
        loc,
      );
      return;
    case 'part':
      diagnostics.info(
        'toIR',
        'PART_DIRECTIVE_IGNORED',
        'P: part marker ignored; abc2p8 does not yet expand part orderings.',
        loc,
      );
      return;
    case 'scale':
      diagnostics.info(
        'toIR',
        'SCALE_DIRECTIVE_IGNORED',
        'Scale directive ignored (visual only).',
        loc,
      );
      return;
    case 'stem':
      diagnostics.info(
        'toIR',
        'STEM_DIRECTIVE_IGNORED',
        'Stem directive ignored (visual only).',
        loc,
      );
      return;
    case 'style':
      diagnostics.info(
        'toIR',
        'STYLE_DIRECTIVE_IGNORED',
        'Style directive ignored (visual only).',
        loc,
      );
      return;
    case 'transpose':
      diagnostics.warn(
        'toIR',
        'TRANSPOSE_IGNORED',
        'Transpose directive ignored; pitches will not be shifted.',
        loc,
      );
      return;
    default:
      diagnostics.warn(
        'toIR',
        'DROPPED_ITEM',
        `Dropped voice item of unrecognized type "${item.el_type}".`,
        loc,
      );
  }
}

interface NoteOrnaments {
  decoration?: string[];
  gracenotes?: unknown[];
}

function diagnoseNoteOrnaments(
  item: VoiceItemNote,
  voiceId: string,
  diagnostics: Diagnostics,
): void {
  const ornaments = item as unknown as NoteOrnaments;
  if (ornaments.decoration) {
    const dropped = ornaments.decoration.filter((d) => d !== 'staccato');
    if (dropped.length > 0) {
      diagnostics.warn(
        'toIR',
        'DECORATION_DROPPED',
        `Note decoration(s) dropped: ${dropped.join(', ')}.`,
        { voice: voiceId },
      );
    }
  }
  if (ornaments.gracenotes && ornaments.gracenotes.length > 0) {
    diagnostics.warn(
      'toIR',
      'GRACE_NOTES_DROPPED',
      `${ornaments.gracenotes.length} grace note(s) dropped.`,
      { voice: voiceId },
    );
  }
}

function hasStaccato(item: VoiceItemNote): boolean {
  const ornaments = item as unknown as NoteOrnaments;
  return !!ornaments.decoration?.includes('staccato');
}

function noteItemHasTie(item: VoiceItemNote): boolean {
  const anyItem = item as unknown as { startTie?: unknown };
  return !!anyItem.startTie;
}
