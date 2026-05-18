import {
  abcToPico8,
  formatDiagnosticParts,
  formatDiagnosticText,
  mergeIntoCart,
  pico8ToAbc,
  type BuiltInKitName,
  type Diagnostic,
  type VoiceConvertOptions,
} from '../../src/index.js';
import { DEFAULT_EXAMPLE, EXAMPLES } from './examples.js';
import { Pico8Player } from './player.js';
import { renderDiagnostics } from './ui/diagnostics.js';
import { renderVoiceInstruments } from './ui/voiceInstruments.js';

const abcInput = document.getElementById('abc') as HTMLTextAreaElement;
const examplesSelect = document.getElementById('examples') as HTMLSelectElement;
const convertBtn = document.getElementById('convert') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const copyBtn = document.getElementById('copy') as HTMLButtonElement;
const downloadBtn = document.getElementById('download') as HTMLButtonElement;
const chordArpToggle = document.getElementById('chord-arp') as HTMLInputElement;
const diagnosticsList = document.getElementById('diagnostics') as HTMLUListElement;
const playerHost = document.getElementById('player-host') as HTMLDivElement;
const voiceInstrumentsHost = document.getElementById('voice-instruments') as HTMLDivElement;
const voiceInstrumentsList = document.getElementById('voice-instruments-list') as HTMLDivElement;
const loadCartInput = document.getElementById('load-cart') as HTMLInputElement;
const sectionPicker = document.getElementById('section-picker') as HTMLSelectElement;
const sectionPickerLabel = document.getElementById('section-picker-label') as HTMLLabelElement;
const mergeFileInput = document.getElementById('merge-file') as HTMLInputElement;
const mergeSfxInput = document.getElementById('merge-sfx-at') as HTMLInputElement;
const mergeMusicInput = document.getElementById('merge-music-at') as HTMLInputElement;
const mergeBuildBtn = document.getElementById('merge-build') as HTMLButtonElement;
const mergeStatus = document.getElementById('merge-status') as HTMLParagraphElement;

for (const ex of EXAMPLES) {
  const opt = document.createElement('option');
  opt.value = ex.id;
  opt.textContent = ex.label;
  examplesSelect.appendChild(opt);
}
examplesSelect.value = DEFAULT_EXAMPLE.id;
abcInput.value = DEFAULT_EXAMPLE.abc;

const player = new Pico8Player(playerHost);
let lastP8: string | null = null;
let lastResult: { p8: string; diagnostics: readonly Diagnostic[] } | null = null;
let mergeTargetText: string | null = null;
let mergeTargetName: string | null = null;

function setControlsEnabled(enabled: boolean): void {
  copyBtn.disabled = !enabled;
  downloadBtn.disabled = !enabled;
  stopBtn.disabled = !enabled;
  updateMergeButton();
}

function updateMergeButton(): void {
  mergeBuildBtn.disabled = lastResult === null || mergeTargetText === null;
}

function setMergeStatus(message: string | null, kind: 'ok' | 'error' | null): void {
  if (message === null) {
    mergeStatus.hidden = true;
    mergeStatus.textContent = '';
    mergeStatus.className = 'merge-status';
    return;
  }
  mergeStatus.hidden = false;
  mergeStatus.textContent = message;
  mergeStatus.className = `merge-status${kind ? ` ${kind}` : ''}`;
}

// Per-source-voice config keyed by 0-based voice index. Survives re-renders
// so a user setting V1=organ then editing the ABC keeps V1=organ. Drum-kit
// selections live in a sibling map; presence implies "this voice is drum."
const voiceInstruments = new Map<number, number>();
const voiceDrumKits = new Map<number, BuiltInKitName>();

examplesSelect.addEventListener('change', () => {
  const chosen = EXAMPLES.find((e) => e.id === examplesSelect.value);
  if (chosen) {
    abcInput.value = chosen.abc;
    // Different example, different voice layout — start fresh.
    voiceInstruments.clear();
    voiceDrumKits.clear();
    // Clear the section picker too; sections are a property of a loaded
    // cart, not of an ABC example.
    loadedCartText = null;
    loadedCartTitle = null;
    sectionPickerLabel.hidden = true;
    sectionPicker.innerHTML = '';
  }
});

function buildVoicesOpt(): VoiceConvertOptions[] | undefined {
  if (voiceInstruments.size === 0 && voiceDrumKits.size === 0) return undefined;
  const max = Math.max(
    -1,
    ...voiceInstruments.keys(),
    ...voiceDrumKits.keys(),
  );
  const list: VoiceConvertOptions[] = [];
  for (let i = 0; i <= max; i += 1) {
    if (voiceDrumKits.has(i)) {
      list.push({ drum: true, kit: voiceDrumKits.get(i)! });
    } else if (voiceInstruments.has(i)) {
      list.push({ instrument: voiceInstruments.get(i)! });
    } else {
      list.push({});
    }
  }
  return list;
}

async function convert(): Promise<void> {
  const voicesOpt = buildVoicesOpt();
  const result = abcToPico8(abcInput.value, {
    chordStrategy: chordArpToggle.checked ? 'arp' : 'auto',
    ...(voicesOpt ? { voices: voicesOpt } : {}),
  });
  renderDiagnostics(diagnosticsList, result.diagnostics);
  const hasErrors = result.diagnostics.some((d: Diagnostic) => d.severity === 'error');
  if (hasErrors || result.p8 === '') {
    lastP8 = null;
    lastResult = null;
    setControlsEnabled(false);
    player.stop();
    return;
  }
  lastP8 = result.p8;
  lastResult = result;
  setControlsEnabled(true);

  const voiceCount = countSourceVoices(abcInput.value);
  if (voiceCount > 0) {
    voiceInstrumentsHost.hidden = false;
    renderVoiceInstruments(
      voiceInstrumentsList,
      voiceCount,
      { instruments: voiceInstruments, drumKits: voiceDrumKits },
      () => {
        void convert();
      },
    );
  } else {
    voiceInstrumentsHost.hidden = true;
  }

  try {
    await player.load(result.p8);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const li = document.createElement('li');
    li.className = 'error';
    li.textContent = `Player failed to load: ${msg}`;
    diagnosticsList.appendChild(li);
  }
}

function countSourceVoices(abc: string): number {
  let count = 0;
  for (const line of abc.split('\n')) {
    if (/^V\s*:\s*\S/.test(line)) count += 1;
  }
  return count === 0 ? 1 : count;
}

convertBtn.addEventListener('click', () => {
  void convert();
});

stopBtn.addEventListener('click', () => {
  player.stop();
  stopBtn.disabled = true;
});

copyBtn.addEventListener('click', async () => {
  if (lastP8 === null) return;
  await navigator.clipboard.writeText(lastP8);
});

downloadBtn.addEventListener('click', () => {
  if (lastP8 === null) return;
  const blob = new Blob([lastP8], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tune.p8';
  a.click();
  URL.revokeObjectURL(url);
});

// Sticky context for the section-picker: when the user re-picks a section
// we re-decode from the same cart bytes rather than asking them to re-upload.
let loadedCartText: string | null = null;
let loadedCartTitle: string | null = null;

async function decodeAndConvertSection(section: number): Promise<void> {
  if (loadedCartText === null) return;
  const reversed = pico8ToAbc(loadedCartText, {
    section,
    ...(loadedCartTitle !== null ? { title: loadedCartTitle } : {}),
  });
  if (reversed.diagnostics.some((d) => d.severity === 'error')) {
    renderDiagnostics(diagnosticsList, reversed.diagnostics.slice());
    return;
  }
  abcInput.value = reversed.abc;
  voiceInstruments.clear();
  voiceDrumKits.clear();
  if (reversed.arpSpeed === 'slow') chordArpToggle.checked = true;
  renderSectionPicker(reversed.sections, reversed.decodedSection);
  if (reversed.diagnostics.length > 0) {
    renderDiagnostics(diagnosticsList, reversed.diagnostics.slice());
    for (const d of reversed.diagnostics) {
      if (d.severity === 'warn' || d.severity === 'error') {
        console.warn(formatDiagnosticText(d));
      }
    }
  }
  await convert();
}

function renderSectionPicker(
  sections: readonly { index: number; startRow: number; endRow: number; hasContent: boolean }[],
  selected: number,
): void {
  const playable = sections.filter((s) => s.hasContent);
  if (playable.length <= 1) {
    sectionPickerLabel.hidden = true;
    sectionPicker.innerHTML = '';
    return;
  }
  sectionPickerLabel.hidden = false;
  sectionPicker.innerHTML = '';
  for (const s of playable) {
    const opt = document.createElement('option');
    opt.value = String(s.index);
    const range = s.startRow === s.endRow ? `row ${s.startRow}` : `rows ${s.startRow}–${s.endRow}`;
    opt.textContent = `Section ${s.index} (${range})`;
    if (s.index === selected) opt.selected = true;
    sectionPicker.appendChild(opt);
  }
}

sectionPicker.addEventListener('change', () => {
  const next = Number(sectionPicker.value);
  if (Number.isInteger(next)) void decodeAndConvertSection(next);
});

loadCartInput.addEventListener('change', async () => {
  const file = loadCartInput.files?.[0];
  if (!file) return;
  try {
    loadedCartText = await file.text();
    loadedCartTitle = file.name.replace(/\.p8(\.png)?$/i, '');
    await decodeAndConvertSection(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnosticsList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'error';
    li.textContent = `Failed to read cart: ${msg}`;
    diagnosticsList.appendChild(li);
  } finally {
    // Allow re-selecting the same file again.
    loadCartInput.value = '';
  }
});

mergeFileInput.addEventListener('change', async () => {
  const file = mergeFileInput.files?.[0];
  if (!file) {
    mergeTargetText = null;
    mergeTargetName = null;
    setMergeStatus(null, null);
    updateMergeButton();
    return;
  }
  try {
    mergeTargetText = await file.text();
    mergeTargetName = file.name;
    setMergeStatus(`Loaded ${file.name} (${file.size} bytes).`, 'ok');
  } catch (err) {
    mergeTargetText = null;
    mergeTargetName = null;
    const msg = err instanceof Error ? err.message : String(err);
    setMergeStatus(`Failed to read file: ${msg}`, 'error');
  }
  updateMergeButton();
});

mergeBuildBtn.addEventListener('click', () => {
  if (lastResult === null || mergeTargetText === null) return;
  const sfxOffset = Number(mergeSfxInput.value);
  const musicOffset = Number(mergeMusicInput.value);
  const merged = mergeIntoCart(mergeTargetText, lastResult, { sfxOffset, musicOffset });

  // Re-render diagnostics with merge results appended (don't double-list the
  // ones that came from the convert step — mergeIntoCart copies those in).
  renderDiagnostics(diagnosticsList, merged.diagnostics);

  const errors = merged.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0 || merged.p8 === '') {
    const first = errors[0];
    const summary = first
      ? `${formatDiagnosticParts(first).code}: ${formatDiagnosticParts(first).message}`
      : 'merge produced no output';
    setMergeStatus(`Merge failed — ${summary}`, 'error');
    return;
  }

  const blob = new Blob([merged.p8], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = mergeTargetName ? `merged-${mergeTargetName}` : 'merged.p8';
  a.click();
  URL.revokeObjectURL(url);

  const warnCount = merged.diagnostics.filter((d) => d.severity === 'warn').length;
  setMergeStatus(
    warnCount > 0
      ? `Downloaded merged cart (${warnCount} warning${warnCount === 1 ? '' : 's'} — see diagnostics).`
      : 'Downloaded merged cart.',
    'ok',
  );
});
