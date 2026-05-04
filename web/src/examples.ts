import cMajorScale from '../../tests/fixtures/abc/c-major-scale.abc?raw';
import repeatSection from '../../tests/fixtures/abc/repeat-section.abc?raw';
import longMonophonic from '../../tests/fixtures/abc/long-monophonic.abc?raw';
import twoVoiceCanon from '../../tests/fixtures/abc/two-voice-canon.abc?raw';
import threeVoiceChord from '../../tests/fixtures/abc/three-voice-chord.abc?raw';
import chordProgression from '../../tests/fixtures/abc/chord-progression.abc?raw';
import chordWithMelody from '../../tests/fixtures/abc/chord-with-melody.abc?raw';
import shadowedAlleys from '../../tests/fixtures/abc/shadowed-alleys.abc?raw';

export interface Example {
  id: string;
  label: string;
  abc: string;
}

export const EXAMPLES: readonly Example[] = [
  { id: 'c-major-scale', label: 'C major scale (monophonic)', abc: cMajorScale },
  { id: 'repeat-section', label: 'Repeat section (slice 2)', abc: repeatSection },
  { id: 'long-monophonic', label: 'Long monophonic (chained SFX)', abc: longMonophonic },
  { id: 'two-voice-canon', label: 'Two-voice canon (slice 3)', abc: twoVoiceCanon },
  { id: 'three-voice-chord', label: 'Three-voice chord (slice 3)', abc: threeVoiceChord },
  { id: 'chord-progression', label: 'Chord progression (slice 4)', abc: chordProgression },
  { id: 'chord-with-melody', label: 'Chord with melody (slice 4)', abc: chordWithMelody },
  { id: 'shadowed-alleys', label: 'Shadowed Alleys (3-voice noir, auto-arps)', abc: shadowedAlleys },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0]!;
