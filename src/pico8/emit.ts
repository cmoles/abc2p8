import type { Diagnostics } from '../ir/diagnostics.js';
import type { QuantizedScore, QuantizedSlot } from '../pipeline/quantize.js';
import {
  DEFAULT_EFFECT,
  PICO8_MIDI_OFFSET,
  PICO8_PITCH_MAX,
  PICO8_PITCH_MIN,
} from './constraints.js';
import {
  defaultEditorByte,
  emptyCart,
  encodeMusicLine,
  encodeSfxLine,
  type Pico8Note,
  type Pico8Sfx,
} from './format.js';

export interface EmitOptions {
  defaultInstrument: number;
  defaultVolume: number;
}

export function emit(
  q: QuantizedScore,
  diagnostics: Diagnostics,
  opts: EmitOptions,
): string | null {
  if (q.slotsPerVoice.length !== 1) {
    diagnostics.error(
      'emit',
      'CHANNEL_ALLOCATION_UNSUPPORTED',
      `Slice 1 emits a single channel; got ${q.slotsPerVoice.length} voices.`,
    );
    return null;
  }
  const slots = q.slotsPerVoice[0]!;
  const voiceId = q.voiceIds[0]!;

  const notes: Pico8Note[] = [];
  for (const slot of slots) {
    const pitch = pitchForSlot(slot, diagnostics, voiceId);
    if (pitch === null && slot.pitch !== null) return null;
    if (pitch === null) {
      notes.push({ pitch: 0, waveform: 0, volume: 0, effect: 0 });
    } else {
      notes.push({
        pitch,
        waveform: opts.defaultInstrument,
        volume: opts.defaultVolume,
        effect: DEFAULT_EFFECT,
      });
    }
  }

  const sfx: Pico8Sfx = {
    editorByte: defaultEditorByte(),
    speed: q.speed,
    loopStart: 0,
    loopEnd: 0,
    notes,
  };

  const sfxLine = encodeSfxLine(sfx);
  const musicLine = encodeMusicLine({
    beginLoop: false,
    endLoop: false,
    stop: true,
    channels: [0, 'silent', 'silent', 'silent'],
  });

  return emptyCart([sfxLine], [musicLine]);
}

function pitchForSlot(
  slot: QuantizedSlot,
  diagnostics: Diagnostics,
  voiceId: string,
): number | null {
  if (slot.pitch === null) return null;
  const offset = slot.pitch - PICO8_MIDI_OFFSET;
  if (offset >= PICO8_PITCH_MIN && offset <= PICO8_PITCH_MAX) return offset;

  // Try octave shifts up to ±3 octaves.
  for (let shift = 1; shift <= 3; shift += 1) {
    for (const direction of [-1, 1] as const) {
      const candidate = offset + direction * shift * 12;
      if (candidate >= PICO8_PITCH_MIN && candidate <= PICO8_PITCH_MAX) {
        diagnostics.info(
          'emit',
          'OUT_OF_RANGE_TRANSPOSED',
          `MIDI ${slot.pitch} out of Pico-8 range; shifted ${direction * shift} octave(s) → pitch ${candidate}.`,
          { voice: voiceId },
        );
        return candidate;
      }
    }
  }
  diagnostics.error(
    'emit',
    'OUT_OF_RANGE',
    `MIDI ${slot.pitch} cannot be brought into Pico-8 range with ≤3 octave shifts.`,
    { voice: voiceId },
  );
  return null;
}
