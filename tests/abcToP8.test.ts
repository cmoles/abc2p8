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

    // Header: editor=01, speed=3c (60 ticks/note ≈ half-second), loop_start=08
    // (sfx length = 8 notes, truncates the silent tail), loop_end=00.
    expect(line.slice(0, 8)).toBe('013c0800');

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
    // 8 occupied slots → loop_start=08 truncates the silent tail.
    expect(line.slice(0, 8)).toBe('011e0800');

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
    // 5 occupied slots after tie merge → loop_start=05 truncates the tail.
    expect(line.slice(0, 8)).toBe('013c0500');

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
    // 4 occupied slots → loop_start=04 truncates the silent tail.
    expect(line.slice(0, 8)).toBe('011e0400');

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
    // 4 occupied slots → loop_start=04 truncates the silent tail.
    expect(line.slice(0, 8)).toBe('01330400');
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

describe('abcToPico8 — slice 2', () => {
  it('splits a 48-slot tune across two SFX slots and chains music patterns', () => {
    // Block 0: 4 bars of CDEF GABc | dcBA GFED (32 quarter notes of treble
    // melody). Block 1: 2 bars of half-note bass figure (C3/G3/E3/C3, 16
    // quarter slots). Different register + rhythm makes the chaining audible.
    const result = abcToPico8(fixture('long-monophonic.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(2);
    expect(music).toHaveLength(2);

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);

    // Block 0 first bar: CDEF GABc → hex 18 1a 1c 1d 1f 21 23 24.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => slot(sfx[0]!, i))).toEqual([
      '18050', '1a050', '1c050', '1d050', '1f050', '21050', '23050', '24050',
    ]);
    // Last note of block 0 is the trailing D from "dcBA GFED" → hex 1a.
    expect(slot(sfx[0]!, 31)).toBe('1a050');

    // Block 1: 2× half-note C3 (hex 0c), 2× half-note G3 (hex 13),
    // then 2× half E3 (hex 10), 2× half C3.
    expect([0, 1, 2, 3].map((i) => slot(sfx[1]!, i))).toEqual([
      '0c050', '0c050', '0c050', '0c050',
    ]);
    expect([4, 5, 6, 7].map((i) => slot(sfx[1]!, i))).toEqual([
      '13050', '13050', '13050', '13050',
    ]);
    expect(slot(sfx[1]!, 15)).toBe('0c050');
    expect(slot(sfx[1]!, 16)).toBe('00000');

    // Pattern 0 chains forward; pattern 1 stops.
    expect(music[0]).toBe('00 00414243');
    expect(music[1]).toBe('04 01414243');
  });

  it('marks begin- and end-loop on the patterns spanning |: ... :|', () => {
    // CDEF|:GABc|dcBA:| — 4-slot intro, 8-slot loop body, no trailing content
    // (anything after :| would be unreachable in pico-8's indefinite loop).
    const result = abcToPico8(fixture('repeat-section.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(2);
    // Single-block loop expands to 2 patterns (begin + end on the same SFX);
    // total = 1 intro + 2 loop = 3 patterns.
    expect(music).toHaveLength(3);

    // Intro: no flags. Loop body: begin (flag=1). Loop end-marker: end (flag=2),
    // re-references the loop body's SFX so playback stays on the same content.
    expect(music[0]).toBe('00 00414243');
    expect(music[1]).toBe('01 01414243');
    expect(music[2]).toBe('02 01414243');

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);

    // Intro: C D E F → hex 18, 1a, 1c, 1d.
    expect([0, 1, 2, 3].map((i) => slot(sfx[0]!, i))).toEqual([
      '18050',
      '1a050',
      '1c050',
      '1d050',
    ]);
    expect(slot(sfx[0]!, 4)).toBe('00000');

    // Loop body: G A B c d c B A → 1f, 21, 23, 24, 26, 24, 23, 21.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => slot(sfx[1]!, i))).toEqual([
      '1f050',
      '21050',
      '23050',
      '24050',
      '26050',
      '24050',
      '23050',
      '21050',
    ]);
    expect(slot(sfx[1]!, 8)).toBe('00000');
  });

  it('warns and drops content after :| (pico-8 loops are indefinite)', () => {
    // CDEF|:GABc:|dcBA| — the trailing dcBA is unreachable once the loop runs.
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nCDEF|:GABc:|dcBA|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'warn' && d.code === 'CONTENT_AFTER_REPEAT',
      ),
    ).toBe(true);
  });

  it('treats |: at start and :| at end as a whole-tune loop in a single pattern', () => {
    const result = abcToPico8(fixture('whole-tune-repeat.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(1);
    // Self-loop expands to begin pattern + duplicate end pattern (same SFX).
    expect(music).toHaveLength(2);
    expect(music[0]).toBe('01 00414243');
    expect(music[1]).toBe('02 00414243');
  });

  it('infers an implicit |: at the tune start when only :| is present', () => {
    // No |:; first :| should retroactively start the loop at tick 0.
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nCDEF GABc:|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const music = extractSection(result.p8, '__music__');
    expect(music).toHaveLength(2);
    expect(music[0]).toBe('01 00414243');
    expect(music[1]).toBe('02 00414243');
  });

  it('warns and keeps the first repeat region when the tune contains multiple', () => {
    const abc =
      'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n|:CDEF:|GABc|:dcBA:|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'warn' && d.code === 'MULTIPLE_REPEATS',
      ),
    ).toBe(true);
  });

  it('warns and drops a |: that has no matching :|', () => {
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n|:CDEF GABc|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'warn' && d.code === 'INCOMPLETE_REPEAT',
      ),
    ).toBe(true);
    const music = extractSection(result.p8, '__music__');
    // Falls back to no-loop / stop-at-end behavior.
    expect(music[0]!.startsWith('04 ')).toBe(true);
  });

  it('errors when a tune needs more than 64 SFX slots', () => {
    // L:1/4 quarter slot → 32 quarter notes per SFX. 64×32=2048 max; 2049 fails.
    // C2048 is 2048 quarter-slots; one trailing C makes 2049.
    const abc = `X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nC2048|C|\n`;
    const result = abcToPico8(abc);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'error' && d.code === 'SFX_BUDGET_EXCEEDED',
      ),
    ).toBe(true);
    expect(result.p8).toBe('');
  });
});
