import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  abcToPico8,
  extractSection,
  formatDiagnosticText,
  listSections,
  pico8ToAbc,
  unpackCart,
} from '../src/index.js';
import { Diagnostics } from '../src/ir/diagnostics.js';
import { encodeMusicLine, encodeSfxLine } from '../src/pico8/format.js';
import { unpackMusicLine, unpackSfxLine } from '../src/pico8/unpack.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleCart = (name: string): string =>
  readFileSync(resolve(here, '..', 'examples', 'llm', name), 'utf8');

describe('unpack — SFX/music line symmetry', () => {
  it('round-trips a single SFX line through encode -> unpack', () => {
    const diagnostics = new Diagnostics();
    const original = encodeSfxLine({
      editorByte: 0x01,
      speed: 30,
      loopStart: 16,
      loopEnd: 0,
      notes: [
        { pitch: 24, waveform: 1, volume: 5, effect: 0 },
        { pitch: 26, waveform: 1, volume: 5, effect: 4 },
        { pitch: 28, waveform: 1, volume: 5, effect: 5 },
        { pitch: 31, waveform: 2, volume: 5, effect: 6 },
        // remaining 28 notes default to silent
      ],
    });
    const parsed = unpackSfxLine(original, 0, diagnostics);
    expect(parsed).not.toBeNull();
    expect(parsed!.speed).toBe(30);
    expect(parsed!.loopStart).toBe(16);
    expect(parsed!.notes[0]).toEqual({ pitch: 24, waveform: 1, volume: 5, effect: 0 });
    expect(parsed!.notes[3]).toEqual({ pitch: 31, waveform: 2, volume: 5, effect: 6 });
    expect(diagnostics.list().filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('round-trips a music line through encode -> unpack', () => {
    const diagnostics = new Diagnostics();
    const original = encodeMusicLine({
      beginLoop: true,
      endLoop: false,
      stop: false,
      channels: [0, 1, 2, 'silent'],
    });
    const parsed = unpackMusicLine(original, 0, diagnostics);
    expect(parsed).toEqual({
      beginLoop: true,
      endLoop: false,
      stop: false,
      channels: [0, 1, 2, 'silent'],
    });
    expect(diagnostics.list().filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('rejects malformed SFX lines', () => {
    const diagnostics = new Diagnostics();
    const result = unpackSfxLine('not-hex', 0, diagnostics);
    expect(result).toBeNull();
    expect(diagnostics.list().some((d) => d.code === 'REVERSE_TARGET_INVALID')).toBe(true);
  });
});

describe('pico8ToAbc — end-to-end on example carts', () => {
  it('decodes the melody-only example into ABC that re-converts cleanly', () => {
    const cart = exampleCart('01-melody-only/melody.p8');
    const reversed = pico8ToAbc(cart);
    expect(reversed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(reversed.abc).toContain('X:1');
    expect(reversed.abc).toContain('V:1');
    expect(reversed.abc).toContain('%%pico8 instrument 1 1');

    // Round-trip: feed the emitted ABC back into the forward pipeline and
    // verify it produces a non-empty cart with no errors.
    const forward = abcToPico8(reversed.abc);
    expect(forward.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(extractSection(forward.p8, '__sfx__').length).toBeGreaterThan(0);
    expect(extractSection(forward.p8, '__music__').length).toBeGreaterThan(0);
  });

  it('detects the noise kit in the drum-pattern example and emits drum letters', () => {
    const cart = exampleCart('04-drum-pattern/drum-pattern.p8');
    const reversed = pico8ToAbc(cart);
    expect(reversed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(reversed.abc).toContain('%%pico8 drum 1');
    // Drum vocabulary letters c/d/e/f/g/a/b in the ABC body.
    const v1Body = reversed.abc.split('V:1')[1] ?? '';
    expect(/[cdefgab]/.test(v1Body)).toBe(true);

    const forward = abcToPico8(reversed.abc);
    expect(forward.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('recovers chord-arp shapes from the chord-comping example', () => {
    const cart = exampleCart('06-chord-comping-auto-arp/chord-comping.p8');
    const reversed = pico8ToAbc(cart);
    expect(reversed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(reversed.abc).toMatch(/\[[A-Ga-g'^_,]+\]/);
    expect(reversed.arpSpeed).toBe('fast');

    const forward = abcToPico8(reversed.abc);
    expect(forward.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('errors on a cart without the pico-8 header', () => {
    const result = pico8ToAbc('not a cart');
    expect(result.abc).toBe('');
    expect(
      result.diagnostics.some((d) => d.code === 'REVERSE_TARGET_INVALID' && d.severity === 'error'),
    ).toBe(true);
  });

  it('truncates multi-section music carts to the first section and warns', () => {
    // Two loop regions (rows 0-1 and 2-3) using a single short SFX.
    const sfxLine =
      '011e0000' + '18050' + '00000'.repeat(31);
    const cart =
      `pico-8 cartridge // http://www.pico-8.com\n` +
      `version 41\n` +
      `__lua__\n` +
      `__sfx__\n${sfxLine}\n${sfxLine}\n` +
      `__music__\n` +
      `01 00414243\n` +
      `02 01414243\n` +
      `01 01414243\n` +
      `02 00414243\n`;
    const result = pico8ToAbc(cart);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.diagnostics.some((d) => d.code === 'REVERSE_MULTI_SECTION')).toBe(true);
    expect(result.sections).toHaveLength(2);
    expect(result.decodedSection).toBe(0);
    // Forward pipeline accepts the truncated tune.
    const forward = abcToPico8(result.abc);
    expect(forward.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('decodes the requested section when section:N is passed', () => {
    const sfxA = '011e0000' + '18050' + '00000'.repeat(31);
    const sfxB = '011e0000' + '20050' + '00000'.repeat(31); // higher pitch so we can tell them apart
    const cart =
      `pico-8 cartridge // http://www.pico-8.com\n` +
      `version 41\n` +
      `__lua__\n` +
      `__sfx__\n${sfxA}\n${sfxB}\n` +
      `__music__\n` +
      `01 00414243\n` +
      `02 00414243\n` +
      `01 01414243\n` +
      `02 01414243\n`;
    const list = listSections(cart);
    expect(list.sections).toHaveLength(2);
    expect(list.sections[0]).toMatchObject({ index: 0, startRow: 0, endRow: 1 });
    expect(list.sections[1]).toMatchObject({ index: 1, startRow: 2, endRow: 3 });

    const s0 = pico8ToAbc(cart, { section: 0 });
    const s1 = pico8ToAbc(cart, { section: 1 });
    expect(s0.decodedSection).toBe(0);
    expect(s1.decodedSection).toBe(1);
    // The two sections use different SFX pitches, so the emitted ABC should
    // differ — proving we actually decoded section 1, not section 0.
    expect(s0.abc).not.toEqual(s1.abc);
  });

  it('falls back to section 0 with REVERSE_SECTION_OUT_OF_RANGE on a bad index', () => {
    const sfxLine = '011e0000' + '18050' + '00000'.repeat(31);
    const cart =
      `pico-8 cartridge // http://www.pico-8.com\n` +
      `version 41\n` +
      `__lua__\n` +
      `__sfx__\n${sfxLine}\n` +
      `__music__\n` +
      `02 00414243\n`;
    const result = pico8ToAbc(cart, { section: 7 });
    expect(result.decodedSection).toBe(0);
    expect(
      result.diagnostics.some((d) => d.code === 'REVERSE_SECTION_OUT_OF_RANGE'),
    ).toBe(true);
  });
});

describe('pico8ToAbc — bit-perfect round-trip on shipped examples', () => {
  const cases: { path: string; arpSpeed?: 'slow' }[] = [
    { path: '01-melody-only/melody.p8' },
    { path: '02-melody-and-pad/melody-and-pad.p8' },
    { path: '03-melody-bass-drums/melody-bass-drums.p8' },
    { path: '04-drum-pattern/drum-pattern.p8' },
    { path: '05-multi-section-with-repeats/multi-section.p8' },
    { path: '06-chord-comping-auto-arp/chord-comping.p8' },
  ];
  for (const { path } of cases) {
    it(`round-trips ${path} to the same SFX + music bytes`, () => {
      const original = exampleCart(path);
      const reversed = pico8ToAbc(original);
      expect(reversed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const forward = abcToPico8(reversed.abc, {
        ...(reversed.arpSpeed === 'slow' ? { arpSpeed: 'slow' } : {}),
      });
      expect(forward.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(extractSection(forward.p8, '__sfx__')).toEqual(extractSection(original, '__sfx__'));
      expect(extractSection(forward.p8, '__music__')).toEqual(
        extractSection(original, '__music__'),
      );
    });
  }
});

describe('unpackCart — section extraction', () => {
  it('parses a roundtrip cart and returns typed sfx/music maps', () => {
    const cart = exampleCart('04-drum-pattern/drum-pattern.p8');
    const diagnostics = new Diagnostics();
    const parsed = unpackCart(cart, diagnostics);
    expect(parsed).not.toBeNull();
    expect(parsed!.sfx.size).toBe(2);
    expect(parsed!.music.length).toBe(1);
    expect(diagnostics.list().filter((d) => d.severity === 'error')).toEqual([]);
  });
});

// Silence "unused import" if formatDiagnosticText drops out of an assertion;
// keeping it imported makes debugging failures easier.
void formatDiagnosticText;
