import { Diagnostics, type Diagnostic } from '../ir/diagnostics.js';
import { rebaseMusicLine } from './rebase.js';
import {
  EMPTY_MUSIC_LINE,
  EMPTY_SFX_LINE,
  SECTION_MUSIC,
  SECTION_SFX,
  extractSection,
} from './sections.js';

const SLOT_CAPACITY = 64;
const SECTION_MARKER = /^__\w+__$/;

export interface ConvertedResult {
  p8: string;
  diagnostics: readonly Diagnostic[];
}

export interface MergeOptions {
  sfxOffset: number;
  musicOffset: number;
}

export interface MergeResult {
  p8: string;
  diagnostics: readonly Diagnostic[];
}

interface Section {
  name: string;
  lines: string[];
}

interface ParsedCart {
  header: string[];
  trailingNewline: boolean;
  sections: Section[];
}

export function mergeIntoCart(
  existingP8: string,
  result: ConvertedResult,
  opts: MergeOptions,
): MergeResult {
  const diagnostics = new Diagnostics();
  for (const d of result.diagnostics) diagnostics.add(d);

  if (result.diagnostics.some((d) => d.severity === 'error') || result.p8 === '') {
    return { p8: '', diagnostics: diagnostics.list() };
  }

  const newSfx = extractSection(result.p8, SECTION_SFX);
  const newMusic = extractSection(result.p8, SECTION_MUSIC);

  validateOffset(opts.sfxOffset, newSfx.length, 'sfxOffset', diagnostics);
  validateOffset(opts.musicOffset, newMusic.length, 'musicOffset', diagnostics);
  if (diagnostics.hasErrors()) return { p8: '', diagnostics: diagnostics.list() };

  const cart = parseCart(existingP8, diagnostics);
  if (!cart) return { p8: '', diagnostics: diagnostics.list() };

  const rebasedMusic = newMusic.map((line) => rebaseMusicLine(line, opts.sfxOffset));

  const sfxSection = ensureSection(cart.sections, SECTION_SFX);
  const musicSection = ensureSection(cart.sections, SECTION_MUSIC);

  const sfxSplice = spliceRows(
    sfxSection.lines,
    newSfx,
    opts.sfxOffset,
    EMPTY_SFX_LINE,
    isEmptySfxRow,
  );
  sfxSection.lines = sfxSplice.lines;
  if (sfxSplice.overwritten.length > 0) {
    diagnostics.warn(
      'emit',
      'MERGE_OVERWRITES',
      `Merge overwrote non-empty sfx row(s) at index ${sfxSplice.overwritten.join(', ')}.`,
    );
  }

  const musicSplice = spliceRows(
    musicSection.lines,
    rebasedMusic,
    opts.musicOffset,
    EMPTY_MUSIC_LINE,
    isEmptyMusicRow,
  );
  musicSection.lines = musicSplice.lines;
  if (musicSplice.overwritten.length > 0) {
    diagnostics.warn(
      'emit',
      'MERGE_OVERWRITES',
      `Merge overwrote non-empty music row(s) at index ${musicSplice.overwritten.join(', ')}.`,
    );
  }

  return { p8: stitchCart(cart), diagnostics: diagnostics.list() };
}

function validateOffset(
  offset: number,
  count: number,
  name: string,
  diagnostics: Diagnostics,
): void {
  if (!Number.isInteger(offset) || offset < 0) {
    diagnostics.error(
      'emit',
      'MERGE_OFFSET_INVALID',
      `${name} ${offset} is invalid; must be a non-negative integer.`,
    );
    return;
  }
  if (offset + count > SLOT_CAPACITY) {
    diagnostics.error(
      'emit',
      'MERGE_OFFSET_INVALID',
      `${name} ${offset} + ${count} row(s) exceeds Pico-8's ${SLOT_CAPACITY}-slot cart capacity.`,
    );
  }
}

function parseCart(p8: string, diagnostics: Diagnostics): ParsedCart | null {
  const trailingNewline = p8.endsWith('\n');
  const raw = trailingNewline ? p8.slice(0, -1) : p8;
  const lines = raw.split('\n');

  if (lines.length === 0 || !lines[0]!.startsWith('pico-8 cartridge')) {
    diagnostics.error(
      'emit',
      'MERGE_TARGET_INVALID',
      'Target .p8 is missing the "pico-8 cartridge" header line.',
    );
    return null;
  }

  const header: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    if (SECTION_MARKER.test(line)) {
      if (sections.some((s) => s.name === line)) {
        diagnostics.error(
          'emit',
          'MERGE_TARGET_INVALID',
          `Target .p8 has duplicate section ${line}.`,
        );
        return null;
      }
      current = { name: line, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      header.push(line);
    }
  }

  return { header, trailingNewline, sections };
}

function ensureSection(sections: Section[], name: string): Section {
  let existing = sections.find((s) => s.name === name);
  if (!existing) {
    existing = { name, lines: [] };
    sections.push(existing);
  }
  return existing;
}

function spliceRows(
  target: string[],
  newRows: string[],
  offset: number,
  emptyLine: string,
  isEmpty: (line: string) => boolean,
): { lines: string[]; overwritten: number[] } {
  const totalLen = Math.max(target.length, offset + newRows.length);
  const out: string[] = [];
  const overwritten: number[] = [];
  for (let i = 0; i < totalLen; i += 1) {
    const inRange = i >= offset && i < offset + newRows.length;
    if (inRange) {
      if (i < target.length && !isEmpty(target[i]!)) {
        overwritten.push(i);
      }
      out.push(newRows[i - offset]!);
    } else if (i < target.length) {
      out.push(target[i]!);
    } else {
      out.push(emptyLine);
    }
  }
  while (out.length > 0 && isEmpty(out[out.length - 1]!)) out.pop();
  return { lines: out, overwritten };
}

function isEmptySfxRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed === EMPTY_SFX_LINE;
}

function isEmptyMusicRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed === EMPTY_MUSIC_LINE;
}

function stitchCart(cart: ParsedCart): string {
  const out: string[] = [...cart.header];
  for (const s of cart.sections) {
    out.push(s.name, ...s.lines);
  }
  return out.join('\n') + (cart.trailingNewline ? '\n' : '');
}
