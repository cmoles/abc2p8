export type Effect =
  | 'none'
  | 'slide'
  | 'vibrato'
  | 'drop'
  | 'fadeIn'
  | 'fadeOut'
  | 'arpFast'
  | 'arpSlow';

export interface Note {
  startTick: number;
  durationTick: number;
  pitch: number | null;
  velocity?: number;
  instrument?: number;
  effect?: Effect;
  tiedToNext?: boolean;
  staccato?: boolean;
  // Chord pitches above `pitch`, sorted ascending (MIDI). Set only when the
  // pipeline is in arp chord mode; the quantizer/emitter render the note as a
  // single-channel arpeggio rather than expanding to sibling voices.
  extraPitches?: number[];
}

export interface Voice {
  id: string;
  notes: Note[];
  defaultInstrument?: number;
}

export interface ScoreMeta {
  title?: string;
  composer?: string;
  keySignature?: string;
  timeSignature?: [number, number];
}

export interface RepeatRegion {
  startTick: number;
  endTick: number;
}

export interface Score {
  ticksPerQuarter: number;
  tempoBpm: number;
  voices: Voice[];
  meta: ScoreMeta;
  repeat?: RepeatRegion;
}
