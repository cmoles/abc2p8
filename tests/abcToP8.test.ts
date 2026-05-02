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
    // then 2× half E3 (hex 10), 2× half C3. Each half-note is two slots of
    // the same pitch; the second onset within a same-pitch run carries the
    // fade-in retrigger flag (e=4 → trailing nybble "4") so pico-8 doesn't
    // merge the two halves into one sustained tone.
    expect([0, 1, 2, 3].map((i) => slot(sfx[1]!, i))).toEqual([
      '0c050', '0c050', '0c054', '0c050',
    ]);
    expect([4, 5, 6, 7].map((i) => slot(sfx[1]!, i))).toEqual([
      '13050', '13050', '13054', '13050',
    ]);
    // Last 4 slots: E onset+cont, then C onset (pitch change → no retrigger
    // needed) and same-pitch C continuation+retrigger.
    expect([12, 13, 14, 15].map((i) => slot(sfx[1]!, i))).toEqual([
      '0c050', '0c050', '0c054', '0c050',
    ]);
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
    // Single-block loop self-loops with one pattern carrying both begin and
    // end flags (0x03). Total = 1 intro + 1 loop = 2 patterns.
    expect(music).toHaveLength(2);

    // Intro: no flags. Loop body: begin|end (flag=3) on the same SFX.
    expect(music[0]).toBe('00 00414243');
    expect(music[1]).toBe('03 01414243');

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
    // Whole-tune self-loop is one pattern with begin|end flags (0x03).
    expect(music).toHaveLength(1);
    expect(music[0]).toBe('03 00414243');
  });

  it('infers an implicit |: at the tune start when only :| is present', () => {
    // No |:; first :| should retroactively start the loop at tick 0.
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nCDEF GABc:|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const music = extractSection(result.p8, '__music__');
    expect(music).toHaveLength(1);
    expect(music[0]).toBe('03 00414243');
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

  it('warns when input contains more than one tune', () => {
    const abc =
      'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nCDEF|\n\n' +
      'X:2\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nGABc|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'warn' && d.code === 'MULTIPLE_TUNES',
      ),
    ).toBe(true);
  });

  it('emits METER_CHANGE_IGNORED for an inline meter change', () => {
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nCDEF|[M:3/4]GAB|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'info' && d.code === 'METER_CHANGE_IGNORED',
      ),
    ).toBe(true);
  });

  it('warns when a note carries decorations', () => {
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n!trill!C DEF|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'warn' && d.code === 'DECORATION_DROPPED',
      ),
    ).toBe(true);
  });

  it('warns when a note has grace notes attached', () => {
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n{D}C DEF|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'warn' && d.code === 'GRACE_NOTES_DROPPED',
      ),
    ).toBe(true);
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

describe('abcToPico8 — slice 3', () => {
  it('emits one SFX per voice and stacks them into a single music pattern', () => {
    // Two 8-quarter-note voices in unison-canon. Each voice fits in one SFX
    // block; the music pattern places voice 1 on channel 0, voice 2 on
    // channel 1, channels 2 and 3 silent.
    const result = abcToPico8(fixture('two-voice-canon.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(2);
    expect(music).toHaveLength(1);

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);

    // Voice 1: C4..C5 → hex 18, 1a, 1c, 1d, 1f, 21, 23, 24.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => slot(sfx[0]!, i))).toEqual([
      '18050', '1a050', '1c050', '1d050', '1f050', '21050', '23050', '24050',
    ]);
    // Voice 2: E4..E5 → hex 1c, 1d, 1f, 21, 23, 24, 26, 28.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => slot(sfx[1]!, i))).toEqual([
      '1c050', '1d050', '1f050', '21050', '23050', '24050', '26050', '28050',
    ]);

    // Stop flag set; channels [sfx0, sfx1, silent ch2 (0x42), silent ch3 (0x43)].
    expect(music[0]).toBe('04 00014243');
  });

  it('maps three voices to channels 0–2 and leaves channel 3 silent', () => {
    const result = abcToPico8(fixture('three-voice-chord.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(3);
    expect(music).toHaveLength(1);

    expect(music[0]).toBe('04 00010243');
  });

  it('pads shorter voices with rests so all voices share block boundaries', () => {
    // V1 has 8 quarter slots; V2 has 4. After padding, V2's last 4 slots are
    // silent. Both voices still produce one SFX block of 8 slots.
    const abc =
      'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nV:1\nCDEF GABc|\nV:2\nC2 G2|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    expect(sfx).toHaveLength(2);

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);

    // V2: C×2 then G×2, then 4 padding rests.
    expect([0, 1, 2, 3].map((i) => slot(sfx[1]!, i))).toEqual([
      '18050', '18050', '1f050', '1f050',
    ]);
    expect([4, 5, 6, 7].map((i) => slot(sfx[1]!, i))).toEqual([
      '00000', '00000', '00000', '00000',
    ]);
    // Both voices have a single 8-slot SFX → loop_start=08 truncates the tail.
    expect(sfx[0]!.slice(0, 8)).toBe('013c0800');
    expect(sfx[1]!.slice(0, 8)).toBe('013c0800');
  });

  it('rejects more than four voices', () => {
    const abc =
      'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n' +
      'V:1\nC|\nV:2\nC|\nV:3\nC|\nV:4\nC|\nV:5\nC|\n';
    const result = abcToPico8(abc);
    expect(result.p8).toBe('');
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'error' && d.code === 'TOO_MANY_VOICES',
      ),
    ).toBe(true);
  });

  it('aligns shared loop boundaries across voices', () => {
    // |:CDEF GABc:| in V1, |:cBAG FEDC:| in V2. Both repeat the whole tune.
    // Single SFX block per voice; expand-self-loop emits 2 patterns referencing
    // the same SFX pair on both channels.
    const abc =
      'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n' +
      'V:1\n|:CDEF GABc:|\n' +
      'V:2\n|:cBAG FEDC:|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(2);
    // Single-block self-loop on both voices: one pattern with begin|end flags.
    expect(music).toHaveLength(1);
    expect(music[0]).toBe('03 00014243');
  });

  it('counts SFX budget across voices', () => {
    // 4 voices × 17 blocks = 68 > 64-slot budget. Each voice has 17 blocks of
    // 32 quarter notes. C544 = 544 quarter slots = 17 blocks of 32.
    const abc =
      'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n' +
      'V:1\nC544|\nV:2\nE544|\nV:3\nG544|\nV:4\nc544|\n';
    const result = abcToPico8(abc);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'error' && d.code === 'SFX_BUDGET_EXCEEDED',
      ),
    ).toBe(true);
    expect(result.p8).toBe('');
  });

  it('forces a fade-in retrigger when consecutive notes share a pitch', () => {
    // Three half-note Cs in a row. Without a retrigger marker pico-8 would
    // sustain them as one tone; the converter must mark the 2nd and 3rd
    // onsets with effect=4 (fade-in).
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nC2 C2 C2|';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const line = extractSection(result.p8, '__sfx__')[0]!;
    const slot = (i: number): string => line.slice(8 + i * 5, 8 + (i + 1) * 5);
    // Slot 0 = first onset (no prior); slot 2 = 2nd onset (same pitch → e=4);
    // slot 4 = 3rd onset (same pitch → e=4). Continuation slots stay e=0.
    expect([0, 1, 2, 3, 4, 5].map(slot)).toEqual([
      '18050', '18050', '18054', '18050', '18054', '18050',
    ]);
  });

  it('uses fade-out for staccato repeated notes', () => {
    // Same shape, but staccato decoration on each note → e=5 (fade-out).
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n.C2 .C2 .C2|';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // The staccato decoration must not trigger DECORATION_DROPPED — we
    // consume it now.
    expect(
      result.diagnostics.some((d) => d.code === 'DECORATION_DROPPED'),
    ).toBe(false);

    const line = extractSection(result.p8, '__sfx__')[0]!;
    const slot = (i: number): string => line.slice(8 + i * 5, 8 + (i + 1) * 5);
    expect([0, 1, 2, 3, 4, 5].map(slot)).toEqual([
      '18050', '18050', '18055', '18050', '18055', '18050',
    ]);
  });

  it('does not retrigger when adjacent same-pitch slots belong to one note', () => {
    // A single dotted-quarter C is one IR onset spanning 3 eighth-slots — no
    // retrigger between continuations. (Regression test for the slice-1
    // dotted-rhythm fixture, which was correct before the fix and should
    // stay correct.)
    const result = abcToPico8(fixture('dotted-rhythm.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const line = extractSection(result.p8, '__sfx__')[0]!;
    const slot = (i: number): string => line.slice(8 + i * 5, 8 + (i + 1) * 5);
    expect([0, 1, 2].map(slot)).toEqual(['18050', '18050', '18050']);
  });

  it('warns when voice repeat regions disagree', () => {
    // V1 loops the first half; V2 loops the whole bar. We keep V1's bounds.
    const abc =
      'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n' +
      'V:1\n|:CDEF:|GABc|\n' +
      'V:2\n|:cBAG FEDC:|\n';
    const result = abcToPico8(abc);
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'warn' && d.code === 'VOICE_REPEAT_MISMATCH',
      ),
    ).toBe(true);
  });
});

describe('abcToPico8 — slice 4', () => {
  it('expands a triad onto sibling channels (lowest pitch first)', () => {
    // [CEG] → V1.A=C(18), V1.B=E(1c), V1.C=G(1f) on channels 0/1/2.
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n[CEG]|';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(3);
    expect(music).toHaveLength(1);

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);
    expect(slot(sfx[0]!, 0)).toBe('18050');
    expect(slot(sfx[1]!, 0)).toBe('1c050');
    expect(slot(sfx[2]!, 0)).toBe('1f050');

    // Channels 0..2 carry the chord; channel 3 is silent.
    expect(music[0]).toBe('04 00010243');
  });

  it('walks chord siblings in step across multiple chord positions', () => {
    // [CEG]2 [FAc]2 — two half-note chords. Slot grid is a quarter (48 ticks),
    // so each chord occupies two slots. Lowest pitch travels in V1.A, etc.
    const result = abcToPico8(fixture('chord-triad.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    expect(sfx).toHaveLength(3);

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);

    // V1.A: C C F F
    expect([0, 1, 2, 3].map((i) => slot(sfx[0]!, i))).toEqual([
      '18050', '18050', '1d050', '1d050',
    ]);
    // V1.B: E E A A
    expect([0, 1, 2, 3].map((i) => slot(sfx[1]!, i))).toEqual([
      '1c050', '1c050', '21050', '21050',
    ]);
    // V1.C: G G c c
    expect([0, 1, 2, 3].map((i) => slot(sfx[2]!, i))).toEqual([
      '1f050', '1f050', '24050', '24050',
    ]);
  });

  it('mixes a chord voice with a separate monophonic voice across the channel pool', () => {
    // V1 has a 2-note chord [CE] sustained for 4 quarters; V2 plays GAGA.
    // Total channels = 2 (V1) + 1 (V2) = 3. Channel 3 stays silent.
    const result = abcToPico8(fixture('chord-with-melody.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(3);
    expect(music).toHaveLength(1);

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);

    // V1.A: C sustained for 4 slots.
    expect([0, 1, 2, 3].map((i) => slot(sfx[0]!, i))).toEqual([
      '18050', '18050', '18050', '18050',
    ]);
    // V1.B: E sustained for 4 slots.
    expect([0, 1, 2, 3].map((i) => slot(sfx[1]!, i))).toEqual([
      '1c050', '1c050', '1c050', '1c050',
    ]);
    // V2: G A G A.
    expect([0, 1, 2, 3].map((i) => slot(sfx[2]!, i))).toEqual([
      '1f050', '21050', '1f050', '21050',
    ]);

    expect(music[0]).toBe('04 00010243');
  });

  it('rests the upper siblings on positions where the chord has fewer notes', () => {
    // [CEG] D [CFA]: max arity 3, but the middle position is a single note.
    // Sibling A carries C, D, C; siblings B and C rest at position 1.
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n[CEG] D [CFA]|';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    expect(sfx).toHaveLength(3);

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);

    // V1.A: C, D, C
    expect([0, 1, 2].map((i) => slot(sfx[0]!, i))).toEqual([
      '18050', '1a050', '18050',
    ]);
    // V1.B: E, rest, F
    expect([0, 1, 2].map((i) => slot(sfx[1]!, i))).toEqual([
      '1c050', '00000', '1d050',
    ]);
    // V1.C: G, rest, A
    expect([0, 1, 2].map((i) => slot(sfx[2]!, i))).toEqual([
      '1f050', '00000', '21050',
    ]);
  });

  it('packs two two-note chords into all four channels', () => {
    // V1=[CE], V2=[GB]: 2 + 2 = 4 channels exactly. No silent channel.
    const abc =
      'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n' +
      'V:1\n[CE]|\n' +
      'V:2\n[GB]|\n';
    const result = abcToPico8(abc);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    expect(sfx).toHaveLength(4);
    expect(music).toHaveLength(1);

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);
    // V1.A=C, V1.B=E, V2.A=G, V2.B=B → 18, 1c, 1f, 23.
    expect(slot(sfx[0]!, 0)).toBe('18050');
    expect(slot(sfx[1]!, 0)).toBe('1c050');
    expect(slot(sfx[2]!, 0)).toBe('1f050');
    expect(slot(sfx[3]!, 0)).toBe('23050');

    // All four channels active — none of the 0x40|c silent markers.
    expect(music[0]).toBe('04 00010203');
  });

  it('errors when the total channel demand exceeds 4', () => {
    // 5-note chord — sole voice but 5 > 4 channels.
    const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n[CEGce]|';
    const result = abcToPico8(abc);
    expect(result.p8).toBe('');
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'error' && d.code === 'CHORD_OVERFLOW',
      ),
    ).toBe(true);
  });

  it('chains chord changes across a cadence', () => {
    // I IV V I in C: each chord is a 3-note triad. Sibling A walks the bass
    // line C → F → G → C → F → G → C; each slot transition is a pitch change
    // so no same-pitch retrigger flags are emitted.
    const result = abcToPico8(fixture('chord-progression.abc'));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sfx = extractSection(result.p8, '__sfx__');
    expect(sfx).toHaveLength(3);

    const slot = (line: string, i: number): string =>
      line.slice(8 + i * 5, 8 + (i + 1) * 5);

    // Sibling A (bass): C C F F G G C C F F G G C C C C → 18 18 1d 1d 1f 1f 18 18 …
    expect([0, 2, 4, 6, 8, 10, 12, 14].map((i) => slot(sfx[0]!, i))).toEqual([
      '18050', '1d050', '1f050', '18050', '1d050', '1f050', '18050', '18050',
    ]);
  });

  it('errors when chord arity plus voice count exceeds 4', () => {
    // 3-note chord in V1 + monophonic V2 + monophonic V3 = 5 channels.
    const abc =
      'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n' +
      'V:1\n[CEG]|\n' +
      'V:2\nc|\n' +
      'V:3\ne|\n';
    const result = abcToPico8(abc);
    expect(result.p8).toBe('');
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'error' && d.code === 'CHORD_OVERFLOW',
      ),
    ).toBe(true);
  });
});
