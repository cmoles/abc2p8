import { describe, expect, it } from 'vitest';
import { abcToPico8 } from '../../../src/index.js';
import {
  extractRomRegions,
  MUSIC_OFFSET,
  MUSIC_REGION_BYTES,
  patchCartRom,
  SFX_OFFSET,
  SFX_REGION_BYTES,
} from '../cartPatch.js';

const SCALE_ABC = `X:1
T:scale
M:4/4
L:1/8
Q:1/4=120
K:C
CDEF GABc |
`;

describe('extractRomRegions', () => {
  it('produces fixed-size music and sfx regions', () => {
    const { p8 } = abcToPico8(SCALE_ABC);
    const regions = extractRomRegions(p8);
    expect(regions.musicBytes.length).toBe(MUSIC_REGION_BYTES);
    expect(regions.sfxBytes.length).toBe(SFX_REGION_BYTES);
  });

  it('pads to full slot count when the cart has fewer slots', () => {
    const { p8 } = abcToPico8(SCALE_ABC);
    const regions = extractRomRegions(p8);
    // The scale produces a single non-empty SFX slot; bytes 68..end of the
    // SFX region should reflect the empty-slot fill (header 0, all-zero notes).
    for (let off = 68; off < SFX_REGION_BYTES; off += 1) {
      expect(regions.sfxBytes[off]).toBe(0);
    }
  });

  it('produces non-zero header bytes for the populated SFX slot', () => {
    const { p8 } = abcToPico8(SCALE_ABC);
    const { sfxBytes } = extractRomRegions(p8);
    // Header speed is non-zero (we emit 0x3c per the slice-1 fixture test).
    expect(sfxBytes[1]).toBeGreaterThan(0);
  });
});

describe('patchCartRom', () => {
  it('splices music at 0x3100 and sfx at 0x3200, preserving everything else', () => {
    const rom = new Uint8Array(0x8000).fill(0xaa);
    const musicBytes = new Uint8Array(MUSIC_REGION_BYTES).fill(0x11);
    const sfxBytes = new Uint8Array(SFX_REGION_BYTES).fill(0x22);
    const out = patchCartRom(rom, { musicBytes, sfxBytes });

    // Music region overwritten.
    for (let i = 0; i < MUSIC_REGION_BYTES; i += 1) {
      expect(out[MUSIC_OFFSET + i]).toBe(0x11);
    }
    // SFX region overwritten.
    for (let i = 0; i < SFX_REGION_BYTES; i += 1) {
      expect(out[SFX_OFFSET + i]).toBe(0x22);
    }
    // Bytes before music and after sfx untouched.
    expect(out[MUSIC_OFFSET - 1]).toBe(0xaa);
    expect(out[SFX_OFFSET + SFX_REGION_BYTES]).toBe(0xaa);
    expect(out[0]).toBe(0xaa);
    expect(out[rom.length - 1]).toBe(0xaa);
  });

  it('returns a new array, not mutating the input', () => {
    const rom = new Uint8Array(0x8000).fill(0xaa);
    const musicBytes = new Uint8Array(MUSIC_REGION_BYTES);
    const sfxBytes = new Uint8Array(SFX_REGION_BYTES);
    const out = patchCartRom(rom, { musicBytes, sfxBytes });
    expect(out).not.toBe(rom);
    expect(rom[MUSIC_OFFSET]).toBe(0xaa);
  });

  it('rejects mis-sized regions', () => {
    const rom = new Uint8Array(0x8000);
    expect(() =>
      patchCartRom(rom, {
        musicBytes: new Uint8Array(10),
        sfxBytes: new Uint8Array(SFX_REGION_BYTES),
      }),
    ).toThrow(/music region/);
    expect(() =>
      patchCartRom(rom, {
        musicBytes: new Uint8Array(MUSIC_REGION_BYTES),
        sfxBytes: new Uint8Array(10),
      }),
    ).toThrow(/sfx region/);
  });
});
