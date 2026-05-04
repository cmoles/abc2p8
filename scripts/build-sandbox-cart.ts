#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { abcToPico8, EMPTY_MUSIC_LINE, EMPTY_SFX_LINE, extractSection } from '../src/index.js';

interface Fixture {
  name: string;
  file: string;
}

interface ManifestEntry {
  name: string;
  musicStart: number;
  musicCount: number;
  sfxStart: number;
  sfxCount: number;
}

const SLICE2_FIXTURES: Fixture[] = [
  { name: 'long-monophonic', file: 'tests/fixtures/abc/long-monophonic.abc' },
  { name: 'repeat-section', file: 'tests/fixtures/abc/repeat-section.abc' },
  { name: 'whole-tune-repeat', file: 'tests/fixtures/abc/whole-tune-repeat.abc' },
];

// Slice 3 introduces multi-voice polyphony. The slice2 worktree already
// audits the monophonic fixtures, so this set is just the new multi-voice
// ones.
const SLICE3_FIXTURES: Fixture[] = [
  { name: 'two-voice-canon', file: 'tests/fixtures/abc/two-voice-canon.abc' },
  { name: 'three-voice-chord', file: 'tests/fixtures/abc/three-voice-chord.abc' },
];

// Slice 4 introduces in-voice chord support. The triad shows pure chord
// splitting; the cadence walks chord changes across multiple positions; the
// chord+melody fixture mixes a chord-bearing voice with a separate
// monophonic voice (sustained chord under a moving line).
const SLICE4_FIXTURES: Fixture[] = [
  { name: 'chord-triad', file: 'tests/fixtures/abc/chord-triad.abc' },
  { name: 'chord-progression', file: 'tests/fixtures/abc/chord-progression.abc' },
  { name: 'chord-with-melody', file: 'tests/fixtures/abc/chord-with-melody.abc' },
];

const SLICES: Record<string, Fixture[]> = {
  slice2: SLICE2_FIXTURES,
  slice3: SLICE3_FIXTURES,
  slice4: SLICE4_FIXTURES,
};

const TOTAL_SLOTS = 64;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function rebaseMusicLine(line: string, offset: number): string {
  const space = line.indexOf(' ');
  if (space < 0) throw new Error(`malformed music line: ${line}`);
  const flag = line.slice(0, space);
  const channels = line.slice(space + 1);
  if (channels.length !== 8) throw new Error(`malformed music line: ${line}`);
  let rebased = '';
  for (let c = 0; c < 4; c += 1) {
    const byte = parseInt(channels.slice(c * 2, c * 2 + 2), 16);
    // Bit 6 set = silent channel marker (0x40 | channelIndex); leave it alone.
    const next = (byte & 0x40) ? byte : byte + offset;
    rebased += next.toString(16).padStart(2, '0');
  }
  return `${flag} ${rebased}`;
}

function buildCart(fixtures: Fixture[]): { manifest: ManifestEntry[]; sfx: string; music: string } {
  const sfxLines: string[] = Array(TOTAL_SLOTS).fill(EMPTY_SFX_LINE);
  const musicLines: string[] = Array(TOTAL_SLOTS).fill(EMPTY_MUSIC_LINE);
  const manifest: ManifestEntry[] = [];

  let sfxCursor = 0;
  let musicCursor = 0;
  for (const fx of fixtures) {
    const abc = readFileSync(resolve(repoRoot, fx.file), 'utf8');
    const result = abcToPico8(abc);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      const summary = errors.map((d) => `${d.stage}/${d.code}: ${d.message}`).join('\n');
      throw new Error(`abcToPico8 failed for ${fx.name}:\n${summary}`);
    }

    const sfx = extractSection(result.p8, '__sfx__');
    const music = extractSection(result.p8, '__music__');
    if (sfxCursor + sfx.length > TOTAL_SLOTS) {
      throw new Error(`cart overflow: ${fx.name} would land past sfx slot ${TOTAL_SLOTS}`);
    }
    if (musicCursor + music.length > TOTAL_SLOTS) {
      throw new Error(`cart overflow: ${fx.name} would land past music slot ${TOTAL_SLOTS}`);
    }

    for (let i = 0; i < sfx.length; i += 1) {
      sfxLines[sfxCursor + i] = sfx[i]!;
    }
    for (let i = 0; i < music.length; i += 1) {
      musicLines[musicCursor + i] = rebaseMusicLine(music[i]!, sfxCursor);
    }

    manifest.push({
      name: fx.name,
      musicStart: musicCursor,
      musicCount: music.length,
      sfxStart: sfxCursor,
      sfxCount: sfx.length,
    });
    sfxCursor += sfx.length;
    musicCursor += music.length;
  }

  return {
    manifest,
    sfx: sfxLines.join('\n'),
    music: musicLines.join('\n'),
  };
}

const sliceArg = process.argv[2] ?? 'slice3';
const fixtures = SLICES[sliceArg];
if (!fixtures) {
  process.stderr.write(`Unknown slice "${sliceArg}". Available: ${Object.keys(SLICES).join(', ')}\n`);
  process.exit(2);
}
const cart = buildCart(fixtures);
process.stdout.write(`${JSON.stringify(cart, null, 2)}\n`);
