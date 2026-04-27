import type { Diagnostics } from '../ir/diagnostics.js';
import type { Note, Score, Voice } from '../ir/types.js';
import {
  PICO8_TICKS_PER_SECOND,
  SFX_NOTES_PER_SLOT,
  SPEED_MAX,
  SPEED_MIN,
} from '../pico8/constraints.js';

export interface QuantizedScore {
  speed: number;
  slotsPerVoice: QuantizedSlot[][];
  voiceIds: string[];
}

export interface QuantizedSlot {
  pitch: number | null;
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

function chooseSlotTicks(score: Score, diagnostics: Diagnostics): number {
  const durations: number[] = [];
  for (const v of score.voices) {
    for (const n of v.notes) durations.push(n.durationTick);
  }
  if (durations.length === 0) return MIN_SLOT_TICKS_FALLBACK;

  const g = gcdAll(durations);
  if (g <= 0) return MIN_SLOT_TICKS_FALLBACK;

  // Don't go finer than a 32nd note (6 ticks at TPQ=48) or coarser than a quarter (48).
  const minSlot = Math.max(1, Math.floor(score.ticksPerQuarter / 8));
  const maxSlot = score.ticksPerQuarter;
  if (g < minSlot) {
    diagnostics.info(
      'quantize',
      'SLOT_RAISED',
      `GCD of durations (${g} ticks) finer than 32nd note; using ${minSlot} ticks.`,
    );
    return minSlot;
  }
  if (g > maxSlot) {
    return maxSlot;
  }
  return g;
}

function speedFromSlot(slotTicks: number, ticksPerQuarter: number, quarterBpm: number): number {
  // slot duration in seconds:
  const slotSeconds = (slotTicks / ticksPerQuarter) * (60 / quarterBpm);
  return slotSeconds * PICO8_TICKS_PER_SECOND;
}

export function quantize(score: Score, diagnostics: Diagnostics): QuantizedScore | null {
  const slotTicks = chooseSlotTicks(score, diagnostics);
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

  const slotsPerVoice: QuantizedSlot[][] = [];
  const voiceIds: string[] = [];
  for (const voice of score.voices) {
    const slots = quantizeVoice(voice, slotTicks, diagnostics);
    if (slots === null) return null;
    slotsPerVoice.push(slots);
    voiceIds.push(voice.id);
  }

  const maxLen = Math.max(0, ...slotsPerVoice.map((s) => s.length));
  if (maxLen === 0) {
    diagnostics.error('quantize', 'EMPTY_SCORE', 'Score has no notes to convert.');
    return null;
  }
  if (maxLen > SFX_NOTES_PER_SLOT) {
    diagnostics.error(
      'quantize',
      'TOO_MANY_SLOTS',
      `Voice expanded to ${maxLen} slots; slice 1 supports up to ${SFX_NOTES_PER_SLOT}.`,
    );
    return null;
  }

  return { speed, slotsPerVoice, voiceIds };
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
    for (let i = 0; i < span; i += 1) {
      slots.push({ pitch: note.pitch });
    }
  }
  return slots;
}
