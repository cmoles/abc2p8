import type { Diagnostics } from '../ir/diagnostics.js';
import type { QuantizedScore, QuantizedSlot, QuantizedVoice } from '../pipeline/quantize.js';
import {
  DEFAULT_EFFECT,
  PICO8_MIDI_OFFSET,
  PICO8_PITCH_MAX,
  PICO8_PITCH_MIN,
  SFX_NOTES_PER_SLOT,
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
  if (q.voices.length !== 1) {
    diagnostics.error(
      'emit',
      'CHANNEL_ALLOCATION_UNSUPPORTED',
      `Slice 2 emits a single channel; got ${q.voices.length} voices.`,
    );
    return null;
  }
  const voice = q.voices[0]!;

  const sfxLines: string[] = [];
  for (let i = 0; i < voice.blocks.length; i += 1) {
    const line = emitSfxLine(voice.blocks[i]!, voice.id, q.speed, diagnostics, opts);
    if (line === null) return null;
    sfxLines.push(line);
  }

  const musicLines = emitMusicLines(voice);
  return emptyCart(sfxLines, musicLines);
}

function emitSfxLine(
  slots: QuantizedSlot[],
  voiceId: string,
  speed: number,
  diagnostics: Diagnostics,
  opts: EmitOptions,
): string | null {
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

  // Pico-8 0.2.2+ feature: with loop_end=0, loop_start acts as the SFX length
  // (otherwise pico-8 plays the silent tail of a short SFX before advancing).
  const truncatedLength = notes.length < SFX_NOTES_PER_SLOT ? notes.length : 0;
  const sfx: Pico8Sfx = {
    editorByte: defaultEditorByte(),
    speed,
    loopStart: truncatedLength,
    loopEnd: 0,
    notes,
  };
  return encodeSfxLine(sfx);
}

function emitMusicLines(voice: QuantizedVoice): string[] {
  const lines: string[] = [];
  const lastIndex = voice.blocks.length - 1;
  const loop = voice.loop;
  // Pico-8's loop_end search excludes the current pattern, so begin+end on the
  // same pattern doesn't self-loop. When the loop region collapses to one
  // block, emit a duplicate music pattern referencing the same SFX so begin
  // and end land on different patterns.
  const expandSelfLoop = !!loop && loop.beginBlock === loop.endBlock;
  for (let i = 0; i < voice.blocks.length; i += 1) {
    const beginLoop = !!loop && i === loop.beginBlock;
    const endLoop = !!loop && i === loop.endBlock && !expandSelfLoop;
    const stop = !loop && i === lastIndex;
    lines.push(
      encodeMusicLine({
        beginLoop,
        endLoop,
        stop,
        channels: [i, 'silent', 'silent', 'silent'],
      }),
    );
  }
  if (expandSelfLoop && loop) {
    lines.push(
      encodeMusicLine({
        beginLoop: false,
        endLoop: true,
        stop: false,
        channels: [loop.beginBlock, 'silent', 'silent', 'silent'],
      }),
    );
  }
  return lines;
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
