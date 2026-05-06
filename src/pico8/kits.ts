// Drum kit data — used by drum voices to look up per-hit Pico-8 SFX
// parameters. The letter→drum-name map lives in src/abc/toIR.ts and is
// fixed; kits define the *sound* of each named drum, not which letter
// triggers it.

export const DRUM_NAMES = [
  'kick',
  'snare',
  'hat-closed',
  'hat-open',
  'tom-low',
  'tom-mid',
  'tom-high',
] as const;

export type DrumName = (typeof DRUM_NAMES)[number];

export interface DrumHit {
  // Pico-8 waveform 0–7 (and 8–15 for the custom slots, though kits should
  // stick to the built-in 0–7 set).
  waveform: number;
  // Pico-8 pitch 0–63 (NOT MIDI). The IR builder offsets this into MIDI for
  // the rest of the pipeline; the emitter offsets it back.
  pitch: number;
  // Pico-8 volume 0–7.
  volume: number;
  // Pico-8 effect 0–7. Drum hits typically use 5 (fade-out) so that
  // sustained-duration notes still articulate as discrete hits.
  effect: number;
}

export type Kit = Record<DrumName, DrumHit>;

// All-noise kit. Simplest to validate and gives the NES-classic timbre.
export const NOISE_KIT: Kit = {
  kick: { waveform: 6, pitch: 8, volume: 5, effect: 5 },
  snare: { waveform: 6, pitch: 24, volume: 5, effect: 5 },
  'hat-closed': { waveform: 6, pitch: 50, volume: 4, effect: 5 },
  'hat-open': { waveform: 6, pitch: 50, volume: 4, effect: 0 },
  'tom-low': { waveform: 6, pitch: 18, volume: 5, effect: 5 },
  'tom-mid': { waveform: 6, pitch: 25, volume: 5, effect: 5 },
  'tom-high': { waveform: 6, pitch: 32, volume: 5, effect: 5 },
};

export const BUILT_IN_KITS = {
  noise: NOISE_KIT,
} as const satisfies Record<string, Kit>;

export type BuiltInKitName = keyof typeof BUILT_IN_KITS;

export function isBuiltInKitName(name: string): name is BuiltInKitName {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_KITS, name);
}

export interface KitValidationError {
  field: string;
  reason: string;
}

// Validate a user-supplied kit. Returns the list of problems; empty array
// means the kit is usable. Checked: every DrumName is present and every
// numeric field is an integer in its Pico-8 range.
export function validateKit(kit: unknown): KitValidationError[] {
  const errors: KitValidationError[] = [];
  if (!kit || typeof kit !== 'object') {
    errors.push({ field: '<kit>', reason: 'kit is not an object' });
    return errors;
  }
  const obj = kit as Record<string, unknown>;
  for (const name of DRUM_NAMES) {
    const hit = obj[name];
    if (!hit || typeof hit !== 'object') {
      errors.push({ field: name, reason: `missing or non-object entry for "${name}"` });
      continue;
    }
    const h = hit as Record<string, unknown>;
    checkInt(errors, `${name}.waveform`, h.waveform, 0, 15);
    checkInt(errors, `${name}.pitch`, h.pitch, 0, 63);
    checkInt(errors, `${name}.volume`, h.volume, 0, 7);
    checkInt(errors, `${name}.effect`, h.effect, 0, 7);
  }
  return errors;
}

function checkInt(
  errors: KitValidationError[],
  field: string,
  value: unknown,
  min: number,
  max: number,
): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push({
      field,
      reason: `expected integer in [${min}, ${max}], got ${typeof value === 'number' ? value : typeof value}`,
    });
  }
}
