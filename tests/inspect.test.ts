import { describe, expect, it } from 'vitest';
import { inspect, renderPianoRoll } from '../src/index.js';

describe('inspect — structural facts', () => {
  it('reports per-voice ranges, durations, channel usage', () => {
    const abc = `X:1
T:Two-voice
M:4/4
L:1/8
Q:1/4=120
K:C
V:1
C2 D2 E2 F2|G2 A2 B2 c2|
V:2
C,4 G,,4|C,4 G,,4|`;
    const r = inspect(abc);
    expect(r.ok).toBe(true);
    expect(r.channelsUsed).toBe(2);
    expect(r.channelsRemaining).toBe(2);
    expect(r.voices).toHaveLength(2);

    const v1 = r.voices[0]!;
    expect(v1.id).toBe('V1');
    expect(v1.kind).toBe('melodic');
    expect(v1.noteCount).toBe(8);
    expect(v1.pitchRange?.minMidi).toBe(60); // C4
    expect(v1.pitchRange?.maxMidi).toBe(72); // C5
    expect(v1.durationEntropy).toBeCloseTo(0, 2);
  });

  it('counts arp chord onsets when chordStrategy auto fires', () => {
    const abc = `X:1
T:Arp test
M:4/4
L:1/4
Q:1/4=120
K:C
V:1
C
V:2
e
V:3
g
V:4
[ceg]4|`;
    const r = inspect(abc);
    if (!r.ok) {
      // Tune is intentionally 4 channels with a chord on V4; expect arp fallback.
      // If toIR rejects it, the test fixture is wrong.
      throw new Error(`inspect not ok: ${r.diagnostics.map((d) => d.code).join(',')}`);
    }
    const v4 = r.voices.find((v) => v.id === 'V4');
    expect(v4?.chordOnsets ?? 0).toBeGreaterThan(0);
  });

  it('reports drum-hit counts when a kit is configured', () => {
    const abc = `X:1
T:Drum
M:4/4
L:1/4
Q:1/4=120
%%pico8 drum 1
K:C
V:1
c d e f|c d e f|`;
    const r = inspect(abc);
    expect(r.ok).toBe(true);
    const v = r.voices[0]!;
    expect(v.kind).toBe('drum');
    expect(v.drumHits).toEqual({
      kick: 2,
      snare: 2,
      'hat-closed': 2,
      'hat-open': 2,
    });
  });

  it('uses the post-resolution waveform on melodic voices', () => {
    const abc = `X:1
T:Inst
M:4/4
L:1/4
Q:1/4=120
%%pico8 instrument 1 3
K:C
V:1
C D E F|`;
    const r = inspect(abc);
    expect(r.voices[0]!.instrument).toBe(3);
  });
});

describe('inspect — findings', () => {
  it('flags SILENT_VOICE for a rest-only voice', () => {
    const abc = `X:1
M:4/4
L:1/4
Q:1/4=120
K:C
V:1
C D E F|
V:2
z4|`;
    const r = inspect(abc);
    const sv = r.findings.filter((f) => f.code === 'SILENT_VOICE');
    expect(sv).toHaveLength(1);
    expect(sv[0]!.voice).toBe('V2');
  });

  it('flags MONOTONIC_RHYTHM only on melodic voices', () => {
    const abc = `X:1
M:4/4
L:1/4
Q:1/4=120
%%pico8 drum 2
K:C
V:1
C C C C|C C C C|
V:2
c c c c|c c c c|`;
    const r = inspect(abc);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain('MONOTONIC_RHYTHM');
    // V2 is drum — should not get MONOTONIC_RHYTHM even though identical rhythm.
    const monoVoices = r.findings.filter((f) => f.code === 'MONOTONIC_RHYTHM').map((f) => f.voice);
    expect(monoVoices).not.toContain('V2');
  });

  it('flags PITCH_AT_RANGE_EDGE for very low notes', () => {
    const abc = `X:1
M:4/4
L:1/4
Q:1/4=120
K:C
V:1
C,,, D,,, C,,, D,,,|`;
    const r = inspect(abc);
    expect(r.findings.some((f) => f.code === 'PITCH_AT_RANGE_EDGE')).toBe(true);
  });

  it('flags CHANNEL_BUDGET_TIGHT at 4 channels', () => {
    const abc = `X:1
M:4/4
L:1/4
Q:1/4=120
K:C
V:1
C C C C|
V:2
E E E E|
V:3
G G G G|
V:4
c c c c|`;
    const r = inspect(abc);
    expect(r.findings.some((f) => f.code === 'CHANNEL_BUDGET_TIGHT')).toBe(true);
  });

  it('flags DRUMS_ON_DOWNBEAT only when every onset lands on the beat', () => {
    // V2 melody on eighths forces an eighth-note slot grid; V1 drum kicks
    // are all on quarter beats → every onset is at an even slot index.
    const abc = `X:1
M:4/4
L:1/8
Q:1/4=120
%%pico8 drum 1
K:C
V:1
c2 c2 c2 c2|c2 c2 c2 c2|
V:2
C D E F G A B c|C D E F G A B c|`;
    const r = inspect(abc);
    expect(r.beatSlots).toBeGreaterThan(1);
    const findings = r.findings.filter((f) => f.code === 'DRUMS_ON_DOWNBEAT');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.voice).toBe('V1');
  });

  it('does not flag DRUMS_ON_DOWNBEAT when offbeats are present', () => {
    // Hat on every eighth → half the onsets are at odd slot indices.
    const abc = `X:1
M:4/4
L:1/8
Q:1/4=120
%%pico8 drum 1
K:C
V:1
e e e e e e e e|e e e e e e e e|
V:2
C D E F G A B c|C D E F G A B c|`;
    const r = inspect(abc);
    expect(r.findings.some((f) => f.code === 'DRUMS_ON_DOWNBEAT')).toBe(false);
  });

  it('flags REGISTER_CLASH for voices in heavily overlapping octaves', () => {
    const abc = `X:1
M:4/4
L:1/4
Q:1/4=120
K:C
V:1
C D E F|G A B c|
V:2
C D E F|G A B c|`;
    const r = inspect(abc);
    expect(r.findings.some((f) => f.code === 'REGISTER_CLASH')).toBe(true);
  });
});

describe('renderPianoRoll', () => {
  it('lays out one row per voice, one column per slot', () => {
    const abc = `X:1
M:4/4
L:1/4
Q:1/4=120
K:C
V:1
C D E F|`;
    const r = inspect(abc);
    const roll = renderPianoRoll(r);
    const lines = roll.split('\n');
    expect(lines).toHaveLength(2); // ruler + 1 voice
    expect(lines[1]).toContain('V1');
    expect(lines[1]).toContain('||||');
  });

  it('respects maxSlots truncation', () => {
    const abc = `X:1
M:4/4
L:1/4
Q:1/4=120
K:C
V:1
C D E F|G A B c|`;
    const r = inspect(abc);
    const roll = renderPianoRoll(r, { maxSlots: 4 });
    expect(roll).toContain('truncated');
  });
});
