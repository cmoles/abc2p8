#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { abcToPico8, formatDiagnosticText } from '../src/index.js';

const USAGE = `Usage: convert <input.abc | -> [-o output.p8] [--quiet] [--play] [--arp] [--arp-slow]

Reads ABC notation and writes a Pico-8 cart. Use "-" to read from stdin.
Diagnostics are printed to stderr; --quiet suppresses info-level diagnostics.
--play injects a music(0) stub so the cart auto-plays when loaded.
--arp forces Pico-8's arpeggio effect on every chord (default behavior is
       auto: expand if chords fit in 4 channels, else arp). --arp-slow uses
       effect 7 (default 6).
Exits 1 if any error diagnostics were emitted.`;

interface Args {
  input: string;
  output: string | null;
  quiet: boolean;
  play: boolean;
  arp: boolean;
  arpSlow: boolean;
}

function parseArgs(argv: string[]): Args {
  let input: string | null = null;
  let output: string | null = null;
  let quiet = false;
  let play = false;
  let arp = false;
  let arpSlow = false;

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
  return { input: input!, output, quiet, play, arp, arpSlow };
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
});

for (const d of result.diagnostics) {
  if (args.quiet && d.severity === 'info') continue;
  process.stderr.write(`${formatDiagnosticText(d)}\n`);
}

if (result.diagnostics.some((d) => d.severity === 'error')) {
  process.exit(1);
}

const cart = args.play ? injectPlayStub(result.p8) : result.p8;
if (args.output) {
  writeFileSync(args.output, cart);
} else {
  process.stdout.write(cart);
}
