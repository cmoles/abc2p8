import type { Diagnostics } from '../ir/diagnostics.js';
import type { Note, RepeatRegion, Score, Voice } from '../ir/types.js';
import {
  ARP_GROUP_SIZE,
  PICO8_TICKS_PER_SECOND,
  SFX_NOTES_PER_SLOT,
  SFX_SLOTS,
  SPEED_MAX,
  SPEED_MIN,
} from '../pico8/constraints.js';

export interface QuantizedScore {
  speed: number;
  voices: QuantizedVoice[];
  loop?: { beginBlock: number; endBlock: number };
}

export interface QuantizedVoice {
  id: string;
  blocks: QuantizedSlot[][];
}

export interface QuantizedSlot {
  pitch: number | null;
  // True on the slot where a source IR Note begins. Used downstream to detect
  // same-pitch repeats and force a retrigger; a sequence of same-pitch slots
  // with no isOnset boundary plays as one sustained tone in pico-8.
  isOnset?: boolean;
  onsetStaccato?: boolean;
  // Set on every slot inside an arp chord group. Length = ARP_GROUP_SIZE; the
  // i-th entry is the SFX pitch at position (groupStart + i). The slot's own
  // `pitch` mirrors arpChord[groupOffset] so downstream layouts stay self-
  // consistent. Emitter stamps these into the SFX and sets effect=arpFast/Slow.
  arpChord?: number[];
}

const MIN_SLOT_TICKS_FALLBACK = 12; // 16th note at TICKS_PER_QUARTER=48

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    [x, y] = [y, x % y];
  }
  return x;
}

function gcdAll(values: number[]): number {
  if (values.length === 0) return 0;
  let acc = values[0]!;
  for (let i = 1; i < values.length; i += 1) {
    acc = gcd(acc, values[i]!);
    if (acc === 1) return 1;
  }
  return acc;
}

function chooseSlotTicks(score: Score, diagnostics: Diagnostics): number | null {
  const durations: number[] = [];
  const arpAlignTicks: number[] = [];
  for (const v of score.voices) {
    for (const n of v.notes) {
      durations.push(n.durationTick);
      if (n.extraPitches && n.extraPitches.length > 0) {
        arpAlignTicks.push(n.durationTick);
        if (n.startTick > 0) arpAlignTicks.push(n.startTick);
      }
    }
  }
  if (durations.length === 0) return MIN_SLOT_TICKS_FALLBACK;

  // When arp chords are present, loop boundaries also have to land on a
  // 4-aligned slot — otherwise the cycle restarts mid-pattern at the loop
  // jump and the chord audibly skips.
  if (arpAlignTicks.length > 0 && score.repeat) {
    if (score.repeat.startTick > 0) arpAlignTicks.push(score.repeat.startTick);
    if (score.repeat.endTick > 0) arpAlignTicks.push(score.repeat.endTick);
  }

  let arpDivisor: number | null = null;
  if (arpAlignTicks.length > 0) {
    const arpGCD = gcdAll(arpAlignTicks);
    if (arpGCD <= 0 || arpGCD % ARP_GROUP_SIZE !== 0) {
      diagnostics.error(
        'quantize',
        'ARP_GRID_INFEASIBLE',
        `Chord arp needs onset/duration GCD divisible by ${ARP_GROUP_SIZE}; got ${arpGCD} ticks.`,
      );
      return null;
    }
    arpDivisor = arpGCD / ARP_GROUP_SIZE;
  }

  const g = gcdAll(durations);
  if (g <= 0) return MIN_SLOT_TICKS_FALLBACK;
  const candidate = arpDivisor === null ? g : gcd(g, arpDivisor);

  // Don't go finer than a 32nd note (6 ticks at TPQ=48) or coarser than a quarter (48).
  const minSlot = Math.max(1, Math.floor(score.ticksPerQuarter / 8));
  const maxSlot = score.ticksPerQuarter;
  if (candidate < minSlot) {
    if (arpDivisor !== null) {
      diagnostics.error(
        'quantize',
        'ARP_GRID_INFEASIBLE',
        `Arp 4-alignment requires a ${candidate}-tick slot grid, finer than the ${minSlot}-tick floor.`,
      );
      return null;
    }
    diagnostics.info(
      'quantize',
      'SLOT_RAISED',
      `GCD of durations (${candidate} ticks) finer than 32nd note; using ${minSlot} ticks.`,
    );
    return minSlot;
  }
  if (candidate > maxSlot) {
    return maxSlot;
  }
  return candidate;
}

function speedFromSlot(slotTicks: number, ticksPerQuarter: number, quarterBpm: number): number {
  // slot duration in seconds:
  const slotSeconds = (slotTicks / ticksPerQuarter) * (60 / quarterBpm);
  return slotSeconds * PICO8_TICKS_PER_SECOND;
}

export function quantize(score: Score, diagnostics: Diagnostics): QuantizedScore | null {
  const slotTicks = chooseSlotTicks(score, diagnostics);
  if (slotTicks === null) return null;
  const rawSpeed = speedFromSlot(slotTicks, score.ticksPerQuarter, score.tempoBpm);
  const speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(rawSpeed)));

  if (Math.abs(speed - rawSpeed) > 0.01) {
    diagnostics.info(
      'quantize',
      'TEMPO_ROUNDED',
      `Pico-8 speed rounded from ${rawSpeed.toFixed(3)} to ${speed} (≈ ${(((PICO8_TICKS_PER_SECOND / speed) * (slotTicks / score.ticksPerQuarter)) * 60).toFixed(1)} quarter-bpm playback).`,
    );
  }
  if (rawSpeed < SPEED_MIN || rawSpeed > SPEED_MAX) {
    diagnostics.warn(
      'quantize',
      'SPEED_CLAMPED',
      `Computed speed ${rawSpeed.toFixed(2)} clamped to [${SPEED_MIN}, ${SPEED_MAX}].`,
    );
  }

  const voiceSlots: { id: string; slots: QuantizedSlot[] }[] = [];
  for (const voice of score.voices) {
    const flat = quantizeVoice(voice, slotTicks, diagnostics);
    if (flat === null) return null;
    voiceSlots.push({ id: voice.id, slots: flat });
  }

  const maxSlots = voiceSlots.reduce((m, v) => Math.max(m, v.slots.length), 0);

  let loopSlots = score.repeat
    ? resolveLoopSlots(score.repeat, slotTicks, maxSlots, diagnostics)
    : null;

  let totalSlots = maxSlots;
  if (loopSlots && totalSlots > loopSlots.endSlot) {
    diagnostics.warn(
      'quantize',
      'CONTENT_AFTER_REPEAT',
      `${totalSlots - loopSlots.endSlot} slot(s) after :| dropped; pico-8 loops indefinitely.`,
    );
    totalSlots = loopSlots.endSlot;
  }

  // Pad shorter voices with rests so all voices share the same slot length.
  // Truncate any voice that ran past `totalSlots` (only possible when content
  // after the loop end was dropped above).
  for (const v of voiceSlots) {
    if (v.slots.length > totalSlots) v.slots.length = totalSlots;
    while (v.slots.length < totalSlots) v.slots.push({ pitch: null });
  }

  if (totalSlots === 0) {
    diagnostics.error('quantize', 'EMPTY_SCORE', 'Score has no notes to convert.');
    return null;
  }

  const forced = loopSlots
    ? [loopSlots.startSlot, loopSlots.endSlot].filter((n) => n > 0 && n < totalSlots)
    : [];

  const blockBoundaries = computeBlockBoundaries(totalSlots, forced);
  const blocksPerVoice = blockBoundaries.length;

  const voices: QuantizedVoice[] = voiceSlots.map((v) => ({
    id: v.id,
    blocks: blockBoundaries.map(([s, e]) => v.slots.slice(s, e)),
  }));

  const totalBlocks = voices.length * blocksPerVoice;
  if (totalBlocks > SFX_SLOTS) {
    diagnostics.error(
      'quantize',
      'SFX_BUDGET_EXCEEDED',
      `Tune needs ${totalBlocks} SFX slot(s) (${voices.length} voice(s) × ${blocksPerVoice} block(s)); pico-8 supports ${SFX_SLOTS}.`,
    );
    return null;
  }

  let loop: QuantizedScore['loop'];
  if (loopSlots) {
    const beginBlock = findBlockStartingAt(blockBoundaries, loopSlots.startSlot);
    const endBlock = findBlockEndingAt(blockBoundaries, loopSlots.endSlot);
    if (beginBlock < 0 || endBlock < 0 || beginBlock > endBlock) {
      diagnostics.warn(
        'quantize',
        'LOOP_ALIGNMENT',
        'Could not align repeat region to SFX block boundaries; loop dropped.',
      );
    } else {
      loop = { beginBlock, endBlock };
    }
  }

  return loop ? { speed, voices, loop } : { speed, voices };
}

function padArpPitches(pitches: number[]): number[] {
  const result: number[] = [];
  for (let i = 0; i < ARP_GROUP_SIZE; i += 1) {
    result.push(pitches[i % pitches.length]!);
  }
  return result;
}

function quantizeVoice(
  voice: Voice,
  slotTicks: number,
  diagnostics: Diagnostics,
): QuantizedSlot[] | null {
  const slots: QuantizedSlot[] = [];
  for (const note of voice.notes) {
    const startSlot = Math.round(note.startTick / slotTicks);
    const endSlot = Math.round((note.startTick + note.durationTick) / slotTicks);
    let span = endSlot - startSlot;

    if (span < 1) {
      diagnostics.info(
        'quantize',
        'NOTE_TOO_SHORT',
        `Note at tick ${note.startTick} (${note.durationTick} ticks) snapped to 1 slot.`,
        { tick: note.startTick, voice: voice.id },
      );
      span = 1;
    }
    if (note.startTick % slotTicks !== 0 || note.durationTick % slotTicks !== 0) {
      diagnostics.info(
        'quantize',
        'NOTE_SNAPPED',
        `Note at tick ${note.startTick} snapped to slot grid (${slotTicks} ticks/slot).`,
        { tick: note.startTick, voice: voice.id },
      );
    }

    while (slots.length < startSlot) {
      slots.push({ pitch: null });
    }

    const isArpChord = !!note.extraPitches && note.extraPitches.length > 0 && note.pitch !== null;
    if (isArpChord) {
      if (startSlot % ARP_GROUP_SIZE !== 0 || span % ARP_GROUP_SIZE !== 0) {
        diagnostics.error(
          'quantize',
          'ARP_GRID_INFEASIBLE',
          `Chord at tick ${note.startTick} (slot ${startSlot}, span ${span}) does not align to ${ARP_GROUP_SIZE}-slot arp groups.`,
          { tick: note.startTick, voice: voice.id },
        );
        return null;
      }
      const chordPitches = padArpPitches([note.pitch!, ...(note.extraPitches ?? [])]);
      for (let i = 0; i < span; i += 1) {
        const groupOffset = (startSlot + i) % ARP_GROUP_SIZE;
        const slot: QuantizedSlot = {
          pitch: chordPitches[groupOffset]!,
          arpChord: chordPitches,
        };
        if (i === 0) {
          slot.isOnset = true;
          if (note.staccato) slot.onsetStaccato = true;
        }
        slots.push(slot);
      }
      continue;
    }

    for (let i = 0; i < span; i += 1) {
      const slot: QuantizedSlot = { pitch: note.pitch };
      if (i === 0 && note.pitch !== null) {
        slot.isOnset = true;
        if (note.staccato) slot.onsetStaccato = true;
      }
      slots.push(slot);
    }
  }
  return slots;
}

function resolveLoopSlots(
  repeat: RepeatRegion,
  slotTicks: number,
  totalSlots: number,
  diagnostics: Diagnostics,
): { startSlot: number; endSlot: number } | null {
  const startSlot = Math.max(0, Math.round(repeat.startTick / slotTicks));
  const endSlot = Math.min(totalSlots, Math.round(repeat.endTick / slotTicks));
  if (endSlot <= startSlot) {
    diagnostics.warn(
      'quantize',
      'EMPTY_REPEAT',
      'Repeat region quantized to zero slots; loop dropped.',
    );
    return null;
  }
  return { startSlot, endSlot };
}

function computeBlockBoundaries(totalSlots: number, forced: number[]): [number, number][] {
  if (totalSlots === 0) return [];
  const cuts = Array.from(new Set(forced.filter((n) => n > 0 && n < totalSlots))).sort(
    (a, b) => a - b,
  );
  cuts.push(totalSlots);

  const ranges: [number, number][] = [];
  let cursor = 0;
  for (const cut of cuts) {
    while (cursor < cut) {
      const end = Math.min(cursor + SFX_NOTES_PER_SLOT, cut);
      ranges.push([cursor, end]);
      cursor = end;
    }
  }
  return ranges;
}

function findBlockStartingAt(boundaries: [number, number][], slotIndex: number): number {
  for (let i = 0; i < boundaries.length; i += 1) {
    if (boundaries[i]![0] === slotIndex) return i;
  }
  return -1;
}

function findBlockEndingAt(boundaries: [number, number][], slotIndex: number): number {
  for (let i = 0; i < boundaries.length; i += 1) {
    if (boundaries[i]![1] === slotIndex) return i;
  }
  return -1;
}
