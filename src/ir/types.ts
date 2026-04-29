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
