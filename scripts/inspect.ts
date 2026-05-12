#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import {
  BUILT_IN_KITS,
  formatDiagnosticText,
  inspect,
  renderPianoRoll,
  type BuiltInKitName,
  type ConvertOptions,
  type InspectionResult,
  type VoiceConvertOptions,
} from '../src/index.js';

const BUILT_IN_KIT_NAMES = Object.keys(BUILT_IN_KITS) as readonly BuiltInKitName[];

const USAGE = `Usage: inspect <input.abc | -> [--json] [--roll] [--max-slots N] [--arp] [--arp-slow] [--instrument SPEC] [--drum-voice N]... [--kit NAME]

Reports structural facts and algorithmic findings for an ABC tune as it
would be converted to a Pico-8 cart. Use "-" to read from stdin.

Output modes:
  default      Human-readable report (facts + findings).
  --json       Machine-readable JSON of the full InspectionResult.
  --roll       Append an ASCII piano-roll. Implied by default in text mode.
  --max-slots N  Truncate the piano-roll to N slots (default: full length).

Convert options (mirrored from \`convert\` so the inspector reports the same
shape the cart would have):
  --arp           Force Pico-8's arp effect on every chord.
  --arp-slow      Force arp with effect=7 (default 6).
  --instrument SPEC  Per-voice waveforms, e.g. 0:2,1:5 (0-based voice index).
  --drum-voice N  Mark source voice index N (0-based) as drum. Repeatable.
  --kit NAME      Built-in kit for every drum voice. Kits: ${BUILT_IN_KIT_NAMES.join(', ')}.

Exits 1 if the inspector couldn't process the input (compile errors).`;

interface Args {
  input: string;
  json: boolean;
  roll: boolean;
  noRoll: boolean;
  maxSlots: number | null;
  arp: boolean;
  arpSlow: boolean;
  voices: VoiceConvertOptions[];
  drumVoiceIndices: number[];
  kit: BuiltInKitName | null;
}

function parseArgs(argv: string[]): Args {
  let input: string | null = null;
  let json = false;
  let roll = false;
  let noRoll = false;
  let maxSlots: number | null = null;
  let arp = false;
  let arpSlow = false;
  const voices: VoiceConvertOptions[] = [];
  const drumVoiceIndices: number[] = [];
  let kit: BuiltInKitName | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--json') json = true;
    else if (a === '--roll') roll = true;
    else if (a === '--no-roll') noRoll = true;
    else if (a === '--max-slots') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) fatal('--max-slots requires a positive integer');
      maxSlots = n;
    } else if (a === '--arp') arp = true;
    else if (a === '--arp-slow') {
      arp = true;
      arpSlow = true;
    } else if (a === '--instrument') {
      const next = argv[++i];
      if (next === undefined) fatal('--instrument requires a SPEC argument');
      parseInstrumentSpec(next, voices);
    } else if (a === '--drum-voice') {
      const next = argv[++i];
      if (next === undefined) fatal('--drum-voice requires an integer argument');
      const idx = Number(next);
      if (!Number.isInteger(idx) || idx < 0) {
        fatal(`--drum-voice: "${next}" is not a non-negative integer`);
      }
      drumVoiceIndices.push(idx);
    } else if (a === '--kit') {
      const next = argv[++i];
      if (next === undefined) fatal('--kit requires a NAME argument');
      if (!(BUILT_IN_KIT_NAMES as readonly string[]).includes(next)) {
        fatal(`--kit: unknown kit "${next}". Built-in kits: ${BUILT_IN_KIT_NAMES.join(', ')}`);
      }
      kit = next as BuiltInKitName;
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
  for (const idx of drumVoiceIndices) {
    while (voices.length <= idx) voices.push({});
    voices[idx] = { ...voices[idx], drum: true, ...(kit ? { kit } : {}) };
  }

  return {
    input: input!,
    json,
    roll,
    noRoll,
    maxSlots,
    arp,
    arpSlow,
    voices,
    drumVoiceIndices,
    kit,
  };
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

function fatal(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

function formatReport(result: InspectionResult, showRoll: boolean, maxSlots: number | null): string {
  const lines: string[] = [];
  lines.push(`speed=${result.speed} slotTicks=${result.slotTicks} beatSlots=${result.beatSlots} totalSlots=${result.totalSlots} totalBlocks=${result.totalBlocks}`);
  lines.push(`channels: ${result.channelsUsed}/4 used (${result.channelsRemaining} free)`);
  if (result.loop) {
    lines.push(`loop: slot ${result.loop.beginSlot} → ${result.loop.endSlot}`);
  }
  lines.push('');
  for (const v of result.voices) {
    const inst = v.instrument !== undefined ? ` wave=${v.instrument}` : '';
    const range = v.pitchRange
      ? ` range=p${v.pitchRange.minPico8}..p${v.pitchRange.maxPico8} (midi ${v.pitchRange.minMidi}..${v.pitchRange.maxMidi})`
      : '';
    lines.push(`${v.id} [${v.kind}]${inst}: notes=${v.noteCount} noteSlots=${v.noteSlots} rests=${v.restSlots}${range}`);
    if (v.chordOnsets > 0) lines.push(`  chord onsets (arp): ${v.chordOnsets}`);
    const durKeys = Object.keys(v.durationHistogram)
      .map(Number)
      .sort((a, b) => a - b);
    if (durKeys.length > 0) {
      const hist = durKeys.map((k) => `${k}s×${v.durationHistogram[k]}`).join(' ');
      lines.push(`  durations: ${hist}   entropy=${v.durationEntropy.toFixed(2)} bits`);
    }
    if (v.drumHits) {
      const hits = Object.entries(v.drumHits)
        .map(([n, c]) => `${n}×${c}`)
        .join(' ');
      lines.push(`  drum hits: ${hits}`);
    }
  }

  lines.push('');
  if (result.findings.length === 0) {
    lines.push('findings: (none)');
  } else {
    lines.push('findings:');
    for (const f of result.findings) {
      const where = f.voice ? ` [${f.voice}]` : '';
      lines.push(`  ${f.severity.toUpperCase()} ${f.code}${where}: ${f.message}`);
    }
  }

  for (const d of result.diagnostics) {
    lines.push(`diagnostic: ${formatDiagnosticText(d)}`);
  }

  if (showRoll) {
    lines.push('');
    lines.push('piano roll (| onset, = sustain, . rest; drum-voice letters = kick/snare/hat-c/hat-o/tom-l/tom-m/tom-H):');
    const opts = maxSlots !== null ? { maxSlots } : {};
    lines.push(renderPianoRoll(result, opts));
  }

  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
const abc = args.input === '-' ? readFileSync(0, 'utf8') : readFileSync(args.input, 'utf8');
const convertOpts: ConvertOptions = {
  chordStrategy: args.arp ? 'arp' : 'auto',
  arpSpeed: args.arpSlow ? 'slow' : 'fast',
  ...(args.voices.length > 0 ? { voices: args.voices } : {}),
};
const result = inspect(abc, convertOpts);

if (args.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const showRoll = args.roll || !args.noRoll;
  process.stdout.write(`${formatReport(result, showRoll, args.maxSlots)}\n`);
}

if (!result.ok) process.exit(1);
