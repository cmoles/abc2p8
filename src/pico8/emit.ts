import type { Diagnostics } from '../ir/diagnostics.js';
import type { QuantizedScore, QuantizedSlot, QuantizedVoice } from '../pipeline/quantize.js';
import {
  CHANNEL_COUNT,
  DEFAULT_EFFECT,
  EFFECT_ARP_FAST,
  EFFECT_ARP_SLOW,
  EFFECT_FADE_IN,
  EFFECT_FADE_OUT,
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
  arpSpeed: 'fast' | 'slow';
}

export function emit(
  q: QuantizedScore,
  diagnostics: Diagnostics,
  opts: EmitOptions,
): string | null {
  if (q.voices.length === 0) {
    diagnostics.error('emit', 'NO_VOICES', 'Quantized score has no voices.');
    return null;
  }
  if (q.voices.length > CHANNEL_COUNT) {
    diagnostics.error(
      'emit',
      'CHANNEL_OVERFLOW',
      `${q.voices.length} voices exceeds pico-8's ${CHANNEL_COUNT} channels.`,
    );
    return null;
  }

  const blocksPerVoice = q.voices[0]!.blocks.length;
  for (const v of q.voices) {
    if (v.blocks.length !== blocksPerVoice) {
      diagnostics.error(
        'emit',
        'VOICE_BLOCK_MISMATCH',
        `Voice ${v.id} has ${v.blocks.length} block(s); expected ${blocksPerVoice}.`,
        { voice: v.id },
      );
      return null;
    }
  }

  const sfxLines: string[] = [];
  for (let v = 0; v < q.voices.length; v += 1) {
    const voice = q.voices[v]!;
    for (let b = 0; b < voice.blocks.length; b += 1) {
      const line = emitSfxLine(voice.blocks[b]!, voice.id, q.speed, diagnostics, opts);
      if (line === null) return null;
      sfxLines.push(line);
    }
  }

  const musicLines = emitMusicLines(q.voices, blocksPerVoice, q.loop);
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
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i]!;
    const pitch = pitchForSlot(slot, diagnostics, voiceId);
    if (pitch === null && slot.pitch !== null) return null;
    if (pitch === null) {
      notes.push({ pitch: 0, waveform: 0, volume: 0, effect: 0 });
    } else {
      let effect: number;
      if (slot.arpChord) {
        // Arp slots play through the 4 SFX positions of their aligned-4 group;
        // the slot's own pitch is already set to the position-in-group pitch
        // by the quantizer, so we just stamp the arp effect.
        effect = opts.arpSpeed === 'slow' ? EFFECT_ARP_SLOW : EFFECT_ARP_FAST;
      } else {
        // Pico-8 sustains across same-pitch slots — going from C3 vol=5 to C3
        // vol=5 with no effect plays as one merged tone, losing the second
        // onset. To preserve the source's note boundaries, force a retrigger
        // on onset slots whose previous slot in the same SFX has the same
        // pitch. Default to fade-in; staccato sources prefer fade-out.
        const prev = i > 0 ? slots[i - 1]! : null;
        const samePrev = prev !== null && prev.pitch === slot.pitch;
        const needsRetrigger = !!slot.isOnset && samePrev;
        effect = needsRetrigger
          ? slot.onsetStaccato
            ? EFFECT_FADE_OUT
            : EFFECT_FADE_IN
          : DEFAULT_EFFECT;
      }
      notes.push({
        pitch,
        waveform: opts.defaultInstrument,
        volume: opts.defaultVolume,
        effect,
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

function emitMusicLines(
  voices: QuantizedVoice[],
  blocksPerVoice: number,
  loop: QuantizedScore['loop'],
): string[] {
  const lines: string[] = [];
  const lastIndex = blocksPerVoice - 1;

  const channelsForBlock = (blockIdx: number): (number | 'silent')[] => {
    const channels: (number | 'silent')[] = [];
    for (let c = 0; c < CHANNEL_COUNT; c += 1) {
      if (c < voices.length) channels.push(sfxIdFor(c, blockIdx, blocksPerVoice));
      else channels.push('silent');
    }
    return channels;
  };

  for (let i = 0; i < blocksPerVoice; i += 1) {
    const beginLoop = !!loop && i === loop.beginBlock;
    const endLoop = !!loop && i === loop.endBlock;
    const stop = !loop && i === lastIndex;
    lines.push(
      encodeMusicLine({ beginLoop, endLoop, stop, channels: channelsForBlock(i) }),
    );
  }
  return lines;
}

function sfxIdFor(voiceIdx: number, blockIdx: number, blocksPerVoice: number): number {
  return voiceIdx * blocksPerVoice + blockIdx;
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
