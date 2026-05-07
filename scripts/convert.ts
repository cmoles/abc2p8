#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import {
  abcToPico8,
  BUILT_IN_KITS,
  formatDiagnosticText,
  mergeIntoCart,
  type BuiltInKitName,
  type VoiceConvertOptions,
} from '../src/index.js';

const BUILT_IN_KIT_NAMES = Object.keys(BUILT_IN_KITS) as readonly BuiltInKitName[];

const USAGE = `Usage: convert <input.abc | -> [-o output.p8] [--quiet] [--play] [--arp] [--arp-slow] [--instrument SPEC] [--drum-voice N]... [--kit NAME] [--merge target.p8 --sfx-at N --music-at M]

Reads ABC notation and writes a Pico-8 cart. Use "-" to read from stdin.
Diagnostics are printed to stderr; --quiet suppresses info-level diagnostics.
--play injects a music(0) stub so the cart auto-plays when loaded.
--arp forces Pico-8's arpeggio effect on every chord (default behavior is
       auto: expand if chords fit in 4 channels, else arp). --arp-slow uses
       effect 7 (default 6).
--instrument SPEC sets per-voice Pico-8 waveforms (0–7). SPEC is a comma-
       separated list of "voiceIndex:waveform" pairs, 0-based by source
       ABC voice (V1=0, V2=1, …). Example: --instrument 0:2,1:5
--drum-voice N marks source voice index N (0-based) as a drum voice. Plain
       note letters then trigger named drum hits (c=kick, d=snare, e=hat-
       closed, f=hat-open, g=tom-low, a=tom-mid, b=tom-high). Repeatable.
--kit NAME picks a built-in kit for every drum voice. Built-in kits: ${BUILT_IN_KIT_NAMES.join(', ')}.
--merge TARGET.p8 splices the converted music into an existing cart, leaving
       all other sections untouched. Requires --sfx-at N and --music-at M
       (0-based slot offsets). Music patterns are rebased to point at the
       new SFX indices.
Exits 1 if any error diagnostics were emitted.`;

interface Args {
  input: string;
  output: string | null;
  quiet: boolean;
  play: boolean;
  arp: boolean;
  arpSlow: boolean;
  voices: VoiceConvertOptions[];
  drumVoiceIndices: number[];
  kit: BuiltInKitName | null;
  mergeTarget: string | null;
  sfxAt: number | null;
  musicAt: number | null;
}

function parseArgs(argv: string[]): Args {
  let input: string | null = null;
  let output: string | null = null;
  let quiet = false;
  let play = false;
  let arp = false;
  let arpSlow = false;
  const voices: VoiceConvertOptions[] = [];
  const drumVoiceIndices: number[] = [];
  let kit: BuiltInKitName | null = null;
  let mergeTarget: string | null = null;
  let sfxAt: number | null = null;
  let musicAt: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '-o' || a === '--output') {
      const next = argv[++i];
      if (next === undefined) fatal(`${a} requires a path argument`);
      output = next;
    } else if (a === '-q' || a === '--quiet') {
      quiet = true;
    } else if (a === '--play') {
      play = true;
    } else if (a === '--arp') {
      arp = true;
    } else if (a === '--arp-slow') {
      arp = true;
      arpSlow = true;
    } else if (a === '--instrument') {
      const next = argv[++i];
      if (next === undefined) fatal(`${a} requires a SPEC argument`);
      parseInstrumentSpec(next, voices);
    } else if (a === '--drum-voice') {
      const next = argv[++i];
      if (next === undefined) fatal(`${a} requires an integer argument`);
      const idx = Number(next);
      if (!Number.isInteger(idx) || idx < 0) {
        fatal(`${a}: "${next}" is not a non-negative integer`);
      }
      drumVoiceIndices.push(idx);
    } else if (a === '--kit') {
      const next = argv[++i];
      if (next === undefined) fatal(`${a} requires a NAME argument`);
      if (!(BUILT_IN_KIT_NAMES as readonly string[]).includes(next)) {
        fatal(`${a}: unknown kit "${next}". Built-in kits: ${BUILT_IN_KIT_NAMES.join(', ')}`);
      }
      kit = next as BuiltInKitName;
    } else if (a === '--merge') {
      const next = argv[++i];
      if (next === undefined) fatal(`${a} requires a path argument`);
      mergeTarget = next;
    } else if (a === '--sfx-at') {
      sfxAt = parseOffset(a, argv[++i]);
    } else if (a === '--music-at') {
      musicAt = parseOffset(a, argv[++i]);
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a.startsWith('-') && a !== '-') {
      fatal(`Unknown flag: ${a}`);
    } else if (input === null) {
      input = a;
    } else {
      fatal(`Unexpected argument: ${a}`);
    }
  }

  if (input === null) fatal(USAGE);
  if (mergeTarget !== null && (sfxAt === null || musicAt === null)) {
    fatal('--merge requires both --sfx-at N and --music-at M');
  }
  if (mergeTarget === null && (sfxAt !== null || musicAt !== null)) {
    fatal('--sfx-at and --music-at only apply with --merge');
  }
  // Apply drum-voice + kit choices into the voices opt array, growing it
  // to the highest referenced index and merging with any --instrument
  // entries the user already set.
  for (const idx of drumVoiceIndices) {
    while (voices.length <= idx) voices.push({});
    voices[idx] = { ...voices[idx], drum: true, ...(kit ? { kit } : {}) };
  }

  return {
    input: input!,
    output,
    quiet,
    play,
    arp,
    arpSlow,
    voices,
    drumVoiceIndices,
    kit,
    mergeTarget,
    sfxAt,
    musicAt,
  };
}

function parseOffset(flag: string, raw: string | undefined): number {
  if (raw === undefined) fatal(`${flag} requires an integer argument`);
  const n = Number(raw);
  if (!Number.isInteger(n)) fatal(`${flag}: "${raw}" is not an integer`);
  return n;
}

function parseInstrumentSpec(spec: string, voices: VoiceConvertOptions[]): void {
  for (const pair of spec.split(',')) {
    const [idxStr, waveStr] = pair.split(':');
    const idx = Number(idxStr);
    const wave = Number(waveStr);
    if (!Number.isInteger(idx) || idx < 0) {
      fatal(`--instrument: bad voice index "${idxStr}" in "${pair}"`);
    }
    if (!Number.isInteger(wave)) {
      fatal(`--instrument: bad waveform "${waveStr}" in "${pair}"`);
    }
    while (voices.length <= idx) voices.push({});
    voices[idx] = { instrument: wave };
  }
}

function injectPlayStub(p8: string): string {
  // Insert music(0) immediately after the __lua__ header, before any other
  // section. The emitter currently writes an empty __lua__ section.
  return p8.replace(/^__lua__\n/m, '__lua__\nmusic(0)\n');
}

function fatal(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const abc =
  args.input === '-' ? readFileSync(0, 'utf8') : readFileSync(args.input, 'utf8');
const result = abcToPico8(abc, {
  chordStrategy: args.arp ? 'arp' : 'auto',
  arpSpeed: args.arpSlow ? 'slow' : 'fast',
  ...(args.voices.length > 0 ? { voices: args.voices } : {}),
});

for (const d of result.diagnostics) {
  if (args.quiet && d.severity === 'info') continue;
  process.stderr.write(`${formatDiagnosticText(d)}\n`);
}

if (result.diagnostics.some((d) => d.severity === 'error')) {
  process.exit(1);
}

let cart: string;
if (args.mergeTarget !== null) {
  const target = readFileSync(args.mergeTarget, 'utf8');
  const merged = mergeIntoCart(target, result, {
    sfxOffset: args.sfxAt!,
    musicOffset: args.musicAt!,
  });
  for (const d of merged.diagnostics) {
    if (args.quiet && d.severity === 'info') continue;
    // Avoid double-printing diagnostics already shown from `result`.
    if (result.diagnostics.includes(d)) continue;
    process.stderr.write(`${formatDiagnosticText(d)}\n`);
  }
  if (merged.diagnostics.some((d) => d.severity === 'error')) {
    process.exit(1);
  }
  cart = args.play ? injectPlayStub(merged.p8) : merged.p8;
} else {
  cart = args.play ? injectPlayStub(result.p8) : result.p8;
}

if (args.output) {
  writeFileSync(args.output, cart);
} else {
  process.stdout.write(cart);
}
