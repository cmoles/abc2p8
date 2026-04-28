import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { abcToPico8 } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(resolve(here, 'fixtures/abc', name), 'utf8');

function extractSection(p8: string, name: string): string[] {
  const lines = p8.split('\n');
  const start = lines.indexOf(name);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('__') && l.endsWith('__')) break;
    if (l !== '') out.push(l);
  }
  return out;
}

describe('abcToPico8 — slice 1', () => {
  it('emits a single sfx line and music pattern for a one-octave C major scale', () => {
    const result = abcToPico8(fixture('c-major-scale.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.p8).not.toEqual('');

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(1);
    expect(music).toHaveLength(1);

    const line = sfx[0]!;
    expect(line).toHaveLength(168);

    // Header: editor=01, speed=3c (60 ticks/note ≈ half-second), loops 0/0.
    expect(line.slice(0, 8)).toBe('013c0000');

    // First 8 notes are the scale; pico-8 pitch = midi - 36.
    // C4..C5 → 24, 26, 28, 29, 31, 33, 35, 36 → hex 18, 1a, 1c, 1d, 1f, 21, 23, 24.
    const notes = [];
    for (let i = 0; i < 32; i += 1) {
      notes.push(line.slice(8 + i * 5, 8 + (i + 1) * 5));
    }
    expect(notes.slice(0, 8)).toEqual([
      '18050',
      '1a050',
      '1c050',
      '1d050',
      '1f050',
      '21050',
      '23050',
      '24050',
    ]);
    // Remaining slots are silent (all zeros).
    for (let i = 8; i < 32; i += 1) {
      expect(notes[i]).toBe('00000');
    }

    // Music pattern: stop flag set, channel 0 plays sfx 00, others silent.
    expect(music[0]).toBe('04 00414243');
  });

  it('applies key signature to unmarked notes (G major → F#)', () => {
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:G\nFGAB|';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const line = sfx[0]!;
    // First note is F in G major → F#4 = MIDI 66 → pico-8 pitch 30 → hex 1e.
    expect(line.slice(8, 13)).toBe('1e050');
  });

  it('rejects chord input with an error diagnostic', () => {
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n[CEG]|';
    const result = abcToPico8(abc);
    expect(result.p8).toBe('');
    expect(
      result.diagnostics.some((d) => d.severity === 'error' && d.code === 'CHORD_UNSUPPORTED'),
    ).toBe(true);
  });

  it('octave-shifts notes that fall below Pico-8 range', () => {
    // C,, in ABC = C2 (scientific) = MIDI 36 = pico-8 pitch 0 (in range).
    // C,,, = C1 = MIDI 24 = pico-8 pitch -12 (out of range, shift up an octave).
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nC,,,|';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(
      result.diagnostics.some((d) => d.code === 'OUT_OF_RANGE_TRANSPOSED'),
    ).toBe(true);
    const line = extractSection(result.p8, '__sfx__')[0]!;
    // After +1 octave: pitch 0 (C2). Hex 00.
    expect(line.slice(8, 13)).toBe('00050');
  });

  it('chooses an eighth-note slot for dotted rhythm and lays note repeats', () => {
    // C3 D E4 in L:1/8 = dotted-quarter, eighth, half. GCD durations = eighth.
    // Slot = eighth at 120 BPM → 30 pico-8 ticks (hex 1e).
    const result = abcToPico8(fixture('dotted-rhythm.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const line = extractSection(result.p8, '__sfx__')[0]!;
    expect(line.slice(0, 8)).toBe('011e0000');

    const slot = (i: number): string => line.slice(8 + i * 5, 8 + (i + 1) * 5);
    // C×3, D×1, E×4 = 8 occupied slots.
    expect([0, 1, 2].map(slot)).toEqual(['18050', '18050', '18050']);
    expect(slot(3)).toBe('1a050');
    expect([4, 5, 6, 7].map(slot)).toEqual(['1c050', '1c050', '1c050', '1c050']);
    expect(slot(8)).toBe('00000');
  });

  it('merges tied notes (including across barlines) into a single sustained note', () => {
    // C2- | C  D2 → tie merges C2 (96 ticks) + C (48 ticks) into 144 ticks.
    // GCD(144, 96) = quarter (48 ticks). 3 C-slots, then 2 D-slots.
    const result = abcToPico8(fixture('tied-notes.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const line = extractSection(result.p8, '__sfx__')[0]!;
    expect(line.slice(0, 8)).toBe('013c0000');

    const slot = (i: number): string => line.slice(8 + i * 5, 8 + (i + 1) * 5);
    expect([0, 1, 2].map(slot)).toEqual(['18050', '18050', '18050']);
    expect([3, 4].map(slot)).toEqual(['1a050', '1a050']);
    expect(slot(5)).toBe('00000');
  });

  it('translates non-default tempo into pico-8 speed', () => {
    // Q:1/4=240, quarter-note slot → 30 pico-8 ticks (hex 1e), half the default.
    const result = abcToPico8(fixture('tempo-fast.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const line = extractSection(result.p8, '__sfx__')[0]!;
    expect(line.slice(0, 8)).toBe('011e0000');

    const slot = (i: number): string => line.slice(8 + i * 5, 8 + (i + 1) * 5);
    expect([0, 1, 2, 3].map(slot)).toEqual(['18050', '1a050', '1c050', '1d050']);
  });

  it('rounds non-integer pico-8 speed and emits a TEMPO_ROUNDED diagnostic', () => {
    // Q:1/4=140 with quarter slot → rawSpeed ≈ 51.43 → rounds to 51 (hex 33).
    const result = abcToPico8(fixture('tempo-rounding.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'info' && d.code === 'TEMPO_ROUNDED',
      ),
    ).toBe(true);

    const line = extractSection(result.p8, '__sfx__')[0]!;
    expect(line.slice(0, 8)).toBe('01330000');
  });

  it('emits silent slots (volume=0) for rests', () => {
    // C z D z → pitch, silent, pitch, silent.
    const result = abcToPico8(fixture('rests.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const line = extractSection(result.p8, '__sfx__')[0]!;
    const slot = (i: number): string => line.slice(8 + i * 5, 8 + (i + 1) * 5);
    expect([0, 1, 2, 3].map(slot)).toEqual(['18050', '00000', '1a050', '00000']);
  });
});
