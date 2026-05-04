import {
  EMPTY_MUSIC_LINE,
  EMPTY_SFX_LINE,
  SECTION_MUSIC,
  SECTION_SFX,
  extractSection,
} from '../../src/index.js';

export const MUSIC_OFFSET = 0x3100;
export const SFX_OFFSET = 0x3200;
export const MUSIC_REGION_BYTES = 256;
export const SFX_REGION_BYTES = 4352;

const SFX_LINE_HEX_CHARS = 168;
const SFX_SLOT_BYTES = 68;
const MUSIC_SLOTS = 64;
const SFX_SLOTS = 64;

export interface RomRegions {
  musicBytes: Uint8Array;
  sfxBytes: Uint8Array;
}

export function extractRomRegions(p8: string): RomRegions {
  const sfxLines = padToLength(extractSection(p8, SECTION_SFX), SFX_SLOTS, EMPTY_SFX_LINE);
  const musicLines = padToLength(extractSection(p8, SECTION_MUSIC), MUSIC_SLOTS, EMPTY_MUSIC_LINE);
  return {
    sfxBytes: encodeSfx(sfxLines),
    musicBytes: encodeMusic(musicLines),
  };
}

export function patchCartRom(rom: Uint8Array, regions: RomRegions): Uint8Array {
  if (regions.musicBytes.length !== MUSIC_REGION_BYTES) {
    throw new Error(`music region must be ${MUSIC_REGION_BYTES} bytes`);
  }
  if (regions.sfxBytes.length !== SFX_REGION_BYTES) {
    throw new Error(`sfx region must be ${SFX_REGION_BYTES} bytes`);
  }
  const out = new Uint8Array(rom);
  out.set(regions.musicBytes, MUSIC_OFFSET);
  out.set(regions.sfxBytes, SFX_OFFSET);
  return out;
}

function padToLength(lines: string[], count: number, filler: string): string[] {
  if (lines.length >= count) return lines.slice(0, count);
  const padded = lines.slice();
  while (padded.length < count) padded.push(filler);
  return padded;
}

function encodeSfx(lines: string[]): Uint8Array {
  const out = new Uint8Array(SFX_REGION_BYTES);
  for (let i = 0; i < SFX_SLOTS; i += 1) {
    const line = lines[i] ?? EMPTY_SFX_LINE;
    if (line.length !== SFX_LINE_HEX_CHARS) {
      throw new Error(
        `sfx line ${i} has length ${line.length}, expected ${SFX_LINE_HEX_CHARS}`,
      );
    }
    out.set(decodeSfxLine(line), i * SFX_SLOT_BYTES);
  }
  return out;
}

// Pico-8 SFX slot is 68 bytes in ROM: 32 notes × 2 bytes (offsets 0..63),
// then a 4-byte header at offsets 64..67 (editor flag, speed, loop_start,
// loop_end). Layout verified bit-for-bit against an exported shell.p8;
// see web/spike/NOTES.md.
function decodeSfxLine(line: string): Uint8Array {
  const out = new Uint8Array(68);
  // Notes first: 32 × 5-hex-char text encoding → 32 × 2-byte ROM encoding.
  for (let n = 0; n < 32; n += 1) {
    const off = 8 + n * 5;
    const pitch = parseInt(line.slice(off, off + 2), 16);       // 0..63 (6 bits)
    const waveform = parseInt(line.slice(off + 2, off + 3), 16); // 0..7 stock, 8..f custom
    const volume = parseInt(line.slice(off + 3, off + 4), 16);   // 0..7
    const effect = parseInt(line.slice(off + 4, off + 5), 16);   // 0..7
    // byte 0: pitch in low 6 bits, waveform low 2 bits in high 2 bits.
    // byte 1: waveform bit 2 in bit 0, volume in bits 1-3, effect in bits 4-6,
    //         custom-instrument flag (waveform bit 3) in bit 7.
    out[n * 2] = ((waveform & 0x3) << 6) | (pitch & 0x3f);
    out[n * 2 + 1] =
      ((waveform >> 3) & 0x1) << 7 |
      ((effect & 0x7) << 4) |
      ((volume & 0x7) << 1) |
      ((waveform >> 2) & 0x1);
  }
  // Header at slot end.
  out[64] = parseHexByte(line, 0); // editor flag
  out[65] = parseHexByte(line, 2); // speed
  out[66] = parseHexByte(line, 4); // loop_start
  out[67] = parseHexByte(line, 6); // loop_end
  return out;
}

function encodeMusic(lines: string[]): Uint8Array {
  const out = new Uint8Array(MUSIC_REGION_BYTES);
  for (let i = 0; i < MUSIC_SLOTS; i += 1) {
    const line = lines[i] ?? EMPTY_MUSIC_LINE;
    out.set(decodeMusicLine(line), i * 4);
  }
  return out;
}

// Pico-8 music pattern line: "<flag> <c0c1c2c3>" e.g. "04 00414243".
//   flag bits: 1=begin_loop, 2=end_loop, 4=stop
//   each channel text byte: low 6 bits = sfx index, bit 6 = silent
// ROM layout (verified against shell.p8 export): the channel byte in ROM is
// the same as the text byte, plus the relevant flag bit at bit 7:
//   channel 0 byte: bit 7 = begin_loop (flag & 1)
//   channel 1 byte: bit 7 = end_loop   (flag & 2)
//   channel 2 byte: bit 7 = stop       (flag & 4)
//   channel 3 byte: bit 7 = 0
function decodeMusicLine(line: string): Uint8Array {
  const space = line.indexOf(' ');
  if (space < 0) throw new Error(`malformed music line: ${line}`);
  const flag = parseInt(line.slice(0, space), 16);
  const channels = line.slice(space + 1);
  if (channels.length !== 8) throw new Error(`malformed music line: ${line}`);

  const flagBitForChannel = [flag & 0x1, flag & 0x2, flag & 0x4, 0];
  const out = new Uint8Array(4);
  for (let c = 0; c < 4; c += 1) {
    const textByte = parseInt(channels.slice(c * 2, c * 2 + 2), 16);
    out[c] = textByte | (flagBitForChannel[c]! ? 0x80 : 0);
  }
  return out;
}

function parseHexByte(line: string, offset: number): number {
  return parseInt(line.slice(offset, offset + 2), 16);
}
