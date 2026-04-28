import {
  CHANNEL_COUNT,
  EFFECT_MAX,
  EFFECT_MIN,
  PICO8_PITCH_MAX,
  PICO8_PITCH_MIN,
  SFX_NOTES_PER_SLOT,
  SPEED_MAX,
  SPEED_MIN,
  VOLUME_MAX,
  VOLUME_MIN,
  WAVEFORM_MAX,
  WAVEFORM_MIN,
} from './constraints.js';

export interface Pico8Note {
  pitch: number;
  waveform: number;
  volume: number;
  effect: number;
}

export interface Pico8Sfx {
  editorByte: number;
  speed: number;
  loopStart: number;
  loopEnd: number;
  notes: Pico8Note[];
}

export interface Pico8MusicPattern {
  beginLoop: boolean;
  endLoop: boolean;
  stop: boolean;
  channels: (number | 'silent')[];
}

const SILENT_NOTE: Pico8Note = {
  pitch: 0,
  waveform: 0,
  volume: 0,
  effect: 0,
};

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');
const hex1 = (n: number): string => (n & 0xf).toString(16);

function checkRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} ${value} out of range [${min}, ${max}]`);
  }
}

export function encodeNote(note: Pico8Note): string {
  checkRange('pitch', note.pitch, PICO8_PITCH_MIN, PICO8_PITCH_MAX);
  checkRange('waveform', note.waveform, WAVEFORM_MIN, WAVEFORM_MAX);
  checkRange('volume', note.volume, VOLUME_MIN, VOLUME_MAX);
  checkRange('effect', note.effect, EFFECT_MIN, EFFECT_MAX);
  return hex2(note.pitch) + hex1(note.waveform) + hex1(note.volume) + hex1(note.effect);
}

export function encodeSfxLine(sfx: Pico8Sfx): string {
  checkRange('editorByte', sfx.editorByte, 0, 0xff);
  checkRange('speed', sfx.speed, SPEED_MIN, SPEED_MAX);
  checkRange('loopStart', sfx.loopStart, 0, 63);
  checkRange('loopEnd', sfx.loopEnd, 0, 63);
  if (sfx.notes.length > SFX_NOTES_PER_SLOT) {
    throw new RangeError(`sfx has ${sfx.notes.length} notes; max is ${SFX_NOTES_PER_SLOT}`);
  }

  const header = hex2(sfx.editorByte) + hex2(sfx.speed) + hex2(sfx.loopStart) + hex2(sfx.loopEnd);
  let body = '';
  for (let i = 0; i < SFX_NOTES_PER_SLOT; i += 1) {
    body += encodeNote(sfx.notes[i] ?? SILENT_NOTE);
  }
  const line = header + body;
  if (line.length !== 168) {
    throw new Error(`sfx line length ${line.length}, expected 168`);
  }
  return line;
}

// Bit 0 = tracker mode (no playback effect; matches what the editor writes).
export function defaultEditorByte(): number {
  return 0x01;
}

export function silentChannelByte(channelIndex: number): number {
  if (!Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex >= CHANNEL_COUNT) {
    throw new RangeError(`channel ${channelIndex} out of range [0, ${CHANNEL_COUNT - 1}]`);
  }
  return 0x40 | channelIndex;
}

export function encodeMusicLine(pattern: Pico8MusicPattern): string {
  if (pattern.channels.length !== CHANNEL_COUNT) {
    throw new RangeError(`pattern needs ${CHANNEL_COUNT} channels, got ${pattern.channels.length}`);
  }
  const flag =
    (pattern.beginLoop ? 1 : 0) | (pattern.endLoop ? 2 : 0) | (pattern.stop ? 4 : 0);
  let bytes = '';
  for (let i = 0; i < CHANNEL_COUNT; i += 1) {
    const ch = pattern.channels[i];
    if (ch === 'silent') {
      bytes += hex2(silentChannelByte(i));
    } else {
      checkRange(`channel ${i} sfx id`, ch as number, 0, 0x3f);
      bytes += hex2(ch as number);
    }
  }
  return `${hex2(flag)} ${bytes}`;
}

export function emptyCart(sfxLines: string[], musicLines: string[]): string {
  const sections = [
    'pico-8 cartridge // http://www.pico-8.com',
    'version 41',
    '__lua__',
  ];
  if (sfxLines.length > 0) {
    sections.push('__sfx__', ...sfxLines);
  }
  if (musicLines.length > 0) {
    sections.push('__music__', ...musicLines);
  }
  return sections.join('\n') + '\n';
}
