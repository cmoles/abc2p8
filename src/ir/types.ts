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
  // Drum-voice notes carry a raw Pico-8 effect (0–7) from the kit, which
  // bypasses the abstract `effect` field above. Stamped onto every slot of
  // the note in the emitter.
  pico8Effect?: number;
  tiedToNext?: boolean;
  staccato?: boolean;
  // Chord pitches above `pitch`, sorted ascending (MIDI). Set only when the
  // pipeline is in arp chord mode; the quantizer/emitter render the note as a
  // single-channel arpeggio rather than expanding to sibling voices.
  extraPitches?: number[];
}

export type VoiceKind = 'melodic' | 'drum';

export interface Voice {
  id: string;
  notes: Note[];
  instrument?: number;
  kind?: VoiceKind;
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
