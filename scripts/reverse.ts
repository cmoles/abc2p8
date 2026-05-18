#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { formatDiagnosticText, listSections, pico8ToAbc } from '../src/index.js';

const USAGE = `Usage: reverse <input.p8 | -> [-o output.abc] [--quiet] [--no-title] [--section N] [--list-sections]

Reads a Pico-8 .p8 cart and writes ABC notation. Use "-" to read from stdin.
Diagnostics are printed to stderr; --quiet suppresses info-level diagnostics.
--no-title omits the T: header (default: derive from the input filename).
--section N decodes the Nth track (0-based). A track is a music-row range
       bounded by an end-loop or stop flag — the same units Pico-8 plays via
       music(N). Default: 0.
--list-sections prints the available tracks (row ranges + content flag) and
       exits without converting.
Exits 1 if any error diagnostics were emitted.`;

interface Args {
  input: string;
  output: string | null;
  quiet: boolean;
  noTitle: boolean;
  section: number | null;
  listSections: boolean;
}

function parseArgs(argv: string[]): Args {
  let input: string | null = null;
  let output: string | null = null;
  let quiet = false;
  let noTitle = false;
  let section: number | null = null;
  let listSectionsFlag = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '-o' || a === '--output') {
      const next = argv[++i];
      if (next === undefined) fatal(`${a} requires a path argument`);
      output = next;
    } else if (a === '-q' || a === '--quiet') {
      quiet = true;
    } else if (a === '--no-title') {
      noTitle = true;
    } else if (a === '--section') {
      const next = argv[++i];
      if (next === undefined) fatal(`${a} requires an integer argument`);
      const n = Number(next);
      if (!Number.isInteger(n) || n < 0) fatal(`${a}: "${next}" is not a non-negative integer`);
      section = n;
    } else if (a === '--list-sections') {
      listSectionsFlag = true;
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
  return { input: input!, output, quiet, noTitle, section, listSections: listSectionsFlag };
}

function fatal(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

function deriveTitle(input: string): string | undefined {
  if (input === '-') return undefined;
  const stem = basename(input).replace(/\.p8(\.png)?$/i, '');
  return stem.length > 0 ? stem : undefined;
}

const args = parseArgs(process.argv.slice(2));
const cart = args.input === '-' ? readFileSync(0, 'utf8') : readFileSync(args.input, 'utf8');

if (args.listSections) {
  const { sections, diagnostics } = listSections(cart);
  for (const d of diagnostics) {
    if (args.quiet && d.severity === 'info') continue;
    process.stderr.write(`${formatDiagnosticText(d)}\n`);
  }
  if (sections.length === 0) {
    process.stderr.write('(no playable sections detected)\n');
    process.exit(1);
  }
  for (const s of sections) {
    const flag = s.hasContent ? '' : ' (silent)';
    const range =
      s.startRow === s.endRow ? `row ${s.startRow}` : `rows ${s.startRow}–${s.endRow}`;
    process.stdout.write(`section ${s.index}: ${range}${flag}\n`);
  }
  process.exit(0);
}

const title = args.noTitle ? undefined : deriveTitle(args.input);
const opts: Parameters<typeof pico8ToAbc>[1] = {};
if (title !== undefined) opts.title = title;
if (args.section !== null) opts.section = args.section;
const result = pico8ToAbc(cart, opts);

for (const d of result.diagnostics) {
  if (args.quiet && d.severity === 'info') continue;
  process.stderr.write(`${formatDiagnosticText(d)}\n`);
}

if (result.arpSpeed === 'slow' && !args.quiet) {
  process.stderr.write(
    'note: cart uses slow arp (effect 7); round-trip needs `convert ... --arp-slow`.\n',
  );
}

if (result.diagnostics.some((d) => d.severity === 'error')) {
  process.exit(1);
}

if (args.output) {
  writeFileSync(args.output, result.abc);
} else {
  process.stdout.write(result.abc);
}
