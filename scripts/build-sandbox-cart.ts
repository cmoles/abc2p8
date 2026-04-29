#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { abcToPico8 } from '../src/index.js';

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

const FIXTURES: Fixture[] = [
  { name: 'long-monophonic', file: 'tests/fixtures/abc/long-monophonic.abc' },
  { name: 'repeat-section', file: 'tests/fixtures/abc/repeat-section.abc' },
  { name: 'whole-tune-repeat', file: 'tests/fixtures/abc/whole-tune-repeat.abc' },
];

const TOTAL_SLOTS = 64;
const EMPTY_SFX_LINE = '0'.repeat(168);
const EMPTY_MUSIC_LINE = '00 40414243';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function extractSection(p8: string, name: string): string[] {
  const lines = p8.split('\n');
  const start = lines.indexOf(name);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('__') && l.endsWith('__')) break;
    if (l !== '') out.push(l);
  }
  return out;
}

function rebaseMusicLine(line: string, offset: number): string {
  const space = line.indexOf(' ');
  if (space < 0) throw new Error(`malformed music line: ${line}`);
  const flag = line.slice(0, space);
  const channels = line.slice(space + 1);
  const ch0 = parseInt(channels.slice(0, 2), 16);
  const rest = channels.slice(2);
  const newCh0 = (ch0 + offset).toString(16).padStart(2, '0');
  return `${flag} ${newCh0}${rest}`;
}

function buildCart(): { manifest: ManifestEntry[]; sfx: string; music: string } {
  const sfxLines: string[] = Array(TOTAL_SLOTS).fill(EMPTY_SFX_LINE);
  const musicLines: string[] = Array(TOTAL_SLOTS).fill(EMPTY_MUSIC_LINE);
  const manifest: ManifestEntry[] = [];

  let sfxCursor = 0;
  let musicCursor = 0;
  for (const fx of FIXTURES) {
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

const cart = buildCart();
process.stdout.write(`${JSON.stringify(cart, null, 2)}\n`);
