// Inverse of format.ts. Parses cart text into typed SFX/music rows so the
// reverse pipeline can work in the same shapes the forward emitter produces.

import { Diagnostics } from '../ir/diagnostics.js';
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
import type { Pico8MusicPattern, Pico8Note, Pico8Sfx } from './format.js';
import { extractSection, SECTION_MUSIC, SECTION_SFX } from './sections.js';

export interface UnpackedCart {
  // SFX row index → unpacked SFX. Sparse — only rows that appear in the
  // cart (i.e. not empty/default lines) are present.
  sfx: Map<number, Pico8Sfx>;
  music: Pico8MusicPattern[];
}

const HEX2 = /^[0-9a-fA-F]{2}$/;
const SFX_LINE_LEN = 168;
const MUSIC_LINE_PATTERN = /^([0-9a-fA-F]{2}) ([0-9a-fA-F]{8})$/;

export function unpackSfxLine(line: string, lineIndex: number, diagnostics: Diagnostics): Pico8Sfx | null {
  if (line.length !== SFX_LINE_LEN) {
    diagnostics.error(
      'parse',
      'REVERSE_TARGET_INVALID',
      `__sfx__ line ${lineIndex} has ${line.length} chars; expected ${SFX_LINE_LEN}.`,
    );
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(line)) {
    diagnostics.error(
      'parse',
      'REVERSE_TARGET_INVALID',
      `__sfx__ line ${lineIndex} contains non-hex characters.`,
    );
    return null;
  }

  const editorByte = parseInt(line.slice(0, 2), 16);
  const speed = parseInt(line.slice(2, 4), 16);
  const loopStart = parseInt(line.slice(4, 6), 16);
  const loopEnd = parseInt(line.slice(6, 8), 16);

  if (!inRange(speed, SPEED_MIN, SPEED_MAX)) {
    // Speed=0 is treated as 1 by the runtime; accept rather than reject.
  }

  const notes: Pico8Note[] = [];
  for (let i = 0; i < SFX_NOTES_PER_SLOT; i += 1) {
    const off = 8 + i * 5;
    const noteHex = line.slice(off, off + 5);
    const pitch = parseInt(noteHex.slice(0, 2), 16) & 0x3f;
    const waveform = parseInt(noteHex.slice(2, 3), 16);
    const volume = parseInt(noteHex.slice(3, 4), 16) & 0x7;
    const effect = parseInt(noteHex.slice(4, 5), 16) & 0x7;
    notes.push({ pitch, waveform, volume, effect });
  }

  return {
    editorByte,
    speed: Math.max(1, speed),
    loopStart,
    loopEnd,
    notes,
  };
}

export function unpackMusicLine(
  line: string,
  lineIndex: number,
  diagnostics: Diagnostics,
): Pico8MusicPattern | null {
  const m = MUSIC_LINE_PATTERN.exec(line.trim());
  if (!m) {
    diagnostics.error(
      'parse',
      'REVERSE_TARGET_INVALID',
      `__music__ line ${lineIndex} does not match "FF SSSSSSSS" form: "${line}".`,
    );
    return null;
  }
  const flag = parseInt(m[1]!, 16);
  const bytesHex = m[2]!;
  const channels: (number | 'silent')[] = [];
  for (let i = 0; i < CHANNEL_COUNT; i += 1) {
    const byte = parseInt(bytesHex.slice(i * 2, i * 2 + 2), 16);
    if (byte & 0x40) {
      channels.push('silent');
    } else {
      channels.push(byte & 0x3f);
    }
  }
  return {
    beginLoop: (flag & 0x01) !== 0,
    endLoop: (flag & 0x02) !== 0,
    stop: (flag & 0x04) !== 0,
    channels,
  };
}

export function unpackCart(p8: string, diagnostics: Diagnostics): UnpackedCart | null {
  if (!p8.split('\n').some((l) => l.startsWith('pico-8 cartridge'))) {
    diagnostics.error(
      'parse',
      'REVERSE_TARGET_INVALID',
      'Cart text is missing the "pico-8 cartridge" header line.',
    );
    return null;
  }

  const sfxLines = extractSection(p8, SECTION_SFX);
  const musicLines = extractSection(p8, SECTION_MUSIC);

  const sfx = new Map<number, Pico8Sfx>();
  for (let i = 0; i < sfxLines.length; i += 1) {
    const line = sfxLines[i]!;
    if (isEmptySfxLine(line)) continue;
    const parsed = unpackSfxLine(line, i, diagnostics);
    if (!parsed) return null;
    sfx.set(i, parsed);
  }

  const music: Pico8MusicPattern[] = [];
  for (let i = 0; i < musicLines.length; i += 1) {
    const parsed = unpackMusicLine(musicLines[i]!, i, diagnostics);
    if (!parsed) return null;
    music.push(parsed);
  }

  // Light sanity check: warn (not error) if SFX field values land outside the
  // canonical ranges. Forward emit enforces these but third-party carts may
  // have anything in the high bits — we ignore them on parse and surface a
  // diagnostic so the round-trip user knows.
  for (const [idx, s] of sfx) {
    for (let i = 0; i < s.notes.length; i += 1) {
      const n = s.notes[i]!;
      if (!inRange(n.pitch, PICO8_PITCH_MIN, PICO8_PITCH_MAX)) {
        flagFeatureDropped(diagnostics, idx, i, `pitch ${n.pitch} outside 0–63`);
      }
      if (!inRange(n.waveform, WAVEFORM_MIN, WAVEFORM_MAX)) {
        flagFeatureDropped(diagnostics, idx, i, `waveform ${n.waveform} outside 0–15`);
      }
      if (!inRange(n.volume, VOLUME_MIN, VOLUME_MAX)) {
        flagFeatureDropped(diagnostics, idx, i, `volume ${n.volume} outside 0–7`);
      }
      if (!inRange(n.effect, EFFECT_MIN, EFFECT_MAX)) {
        flagFeatureDropped(diagnostics, idx, i, `effect ${n.effect} outside 0–7`);
      }
    }
  }

  return { sfx, music };
}

function isEmptySfxLine(line: string): boolean {
  // Forward emit uses 0-fill for unused slots within a row but writes the
  // whole row anyway. A truly empty row (all zeros for 168 chars) is also a
  // valid silent SFX so we keep it; "empty" here means a blank/whitespace
  // line accidentally left in the section.
  return line.trim() === '';
}

function flagFeatureDropped(
  diagnostics: Diagnostics,
  sfxIdx: number,
  noteIdx: number,
  reason: string,
): void {
  diagnostics.warn(
    'parse',
    'REVERSE_FEATURE_DROPPED',
    `SFX ${sfxIdx} note ${noteIdx}: ${reason}.`,
  );
}

function inRange(n: number, min: number, max: number): boolean {
  return Number.isFinite(n) && n >= min && n <= max;
}

// Re-export the canonical pico8 shapes so dequantize doesn't have to hop
// through format.ts directly.
export type { Pico8MusicPattern, Pico8Note, Pico8Sfx };
