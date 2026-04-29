import type { Diagnostics } from '../ir/diagnostics.js';
import type { Note, Score, Voice } from '../ir/types.js';
import {
  PICO8_TICKS_PER_SECOND,
  SFX_NOTES_PER_SLOT,
  SFX_SLOTS,
  SPEED_MAX,
  SPEED_MIN,
} from '../pico8/constraints.js';

export interface QuantizedScore {
  speed: number;
  voices: QuantizedVoice[];
}

export interface QuantizedVoice {
  id: string;
  blocks: QuantizedSlot[][];
  loop?: { beginBlock: number; endBlock: number };
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

  const voices: QuantizedVoice[] = [];
  let totalBlocks = 0;
  for (const voice of score.voices) {
    const flat = quantizeVoice(voice, slotTicks, diagnostics);
    if (flat === null) return null;

    const loopSlots = score.repeat
      ? resolveLoopSlots(score.repeat, slotTicks, flat.length, diagnostics)
      : null;

    const slotsToBlock =
      loopSlots && flat.length > loopSlots.endSlot
        ? (() => {
            diagnostics.warn(
              'quantize',
              'CONTENT_AFTER_REPEAT',
              `${flat.length - loopSlots.endSlot} slot(s) after :| dropped; pico-8 loops indefinitely.`,
              { voice: voice.id },
            );
            return flat.slice(0, loopSlots.endSlot);
          })()
        : flat;

    const forced = loopSlots
      ? [loopSlots.startSlot, loopSlots.endSlot].filter(
          (n) => n > 0 && n < slotsToBlock.length,
        )
      : [];

    const blocks = chunkSlots(slotsToBlock, forced);

    let loop: QuantizedVoice['loop'];
    if (loopSlots) {
      const beginBlock = findBlockStartingAt(blocks, loopSlots.startSlot);
      const endBlock = findBlockEndingAt(blocks, loopSlots.endSlot);
      if (beginBlock < 0 || endBlock < 0 || beginBlock > endBlock) {
        diagnostics.warn(
          'quantize',
          'LOOP_ALIGNMENT',
          'Could not align repeat region to SFX block boundaries; loop dropped.',
          { voice: voice.id },
        );
      } else {
        loop = { beginBlock, endBlock };
      }
    }

    voices.push(loop ? { id: voice.id, blocks, loop } : { id: voice.id, blocks });
    totalBlocks += blocks.length;
  }

  if (voices.every((v) => v.blocks.length === 0)) {
    diagnostics.error('quantize', 'EMPTY_SCORE', 'Score has no notes to convert.');
    return null;
  }

  if (totalBlocks > SFX_SLOTS) {
    diagnostics.error(
      'quantize',
      'SFX_BUDGET_EXCEEDED',
      `Tune needs ${totalBlocks} SFX slot(s); pico-8 supports ${SFX_SLOTS}.`,
    );
    return null;
  }

  return { speed, voices };
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

function resolveLoopSlots(
  repeat: { startTick: number; endTick: number },
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

function chunkSlots(slots: QuantizedSlot[], forced: number[]): QuantizedSlot[][] {
  if (slots.length === 0) return [];
  const boundaries = Array.from(new Set(forced.filter((n) => n > 0 && n < slots.length))).sort(
    (a, b) => a - b,
  );
  boundaries.push(slots.length);

  const blocks: QuantizedSlot[][] = [];
  let cursor = 0;
  for (const boundary of boundaries) {
    while (cursor < boundary) {
      const end = Math.min(cursor + SFX_NOTES_PER_SLOT, boundary);
      blocks.push(slots.slice(cursor, end));
      cursor = end;
    }
  }
  return blocks;
}

function findBlockStartingAt(blocks: QuantizedSlot[][], slotIndex: number): number {
  let acc = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    if (acc === slotIndex) return i;
    acc += blocks[i]!.length;
  }
  return acc === slotIndex ? blocks.length : -1;
}

function findBlockEndingAt(blocks: QuantizedSlot[][], slotIndex: number): number {
  let acc = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    acc += blocks[i]!.length;
    if (acc === slotIndex) return i;
  }
  return -1;
}
