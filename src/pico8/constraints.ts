export const PICO8_PITCH_MIN = 0;
export const PICO8_PITCH_MAX = 63;

// Pico-8 editor labels pitch 0 as "C2"; we treat that as MIDI 36 (scientific
// pitch notation C2). pico8_pitch = midi - PICO8_MIDI_OFFSET.
export const PICO8_MIDI_OFFSET = 36;

export const SFX_NOTES_PER_SLOT = 32;
export const SFX_SLOTS = 64;
export const MUSIC_PATTERNS = 64;
export const CHANNEL_COUNT = 4;

export const SPEED_MIN = 1;
export const SPEED_MAX = 255;

export const DEFAULT_VOLUME = 5;
export const DEFAULT_INSTRUMENT = 0;
export const DEFAULT_EFFECT = 0;

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 7;
export const WAVEFORM_MIN = 0;
export const WAVEFORM_MAX = 0xf;
export const EFFECT_MIN = 0;
export const EFFECT_MAX = 7;

// Pico-8 plays one SFX tick every ~1/120 second (183 samples / 22050 Hz).
export const PICO8_TICKS_PER_SECOND = 120;
