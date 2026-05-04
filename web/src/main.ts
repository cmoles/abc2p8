import {
  abcToPico8,
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

function setControlsEnabled(enabled: boolean): void {
  copyBtn.disabled = !enabled;
  downloadBtn.disabled = !enabled;
  stopBtn.disabled = !enabled;
}

// Per-source-voice waveform overrides keyed by 0-based voice index. Survives
// re-renders so a user setting V1=organ then editing the ABC keeps V1=organ.
const voiceInstruments = new Map<number, number>();

examplesSelect.addEventListener('change', () => {
  const chosen = EXAMPLES.find((e) => e.id === examplesSelect.value);
  if (chosen) {
    abcInput.value = chosen.abc;
    // Different example, different voice layout — start fresh.
    voiceInstruments.clear();
  }
});

function buildVoicesOpt(): VoiceConvertOptions[] | undefined {
  if (voiceInstruments.size === 0) return undefined;
  const max = Math.max(...voiceInstruments.keys());
  const list: VoiceConvertOptions[] = [];
  for (let i = 0; i <= max; i += 1) {
    const wave = voiceInstruments.get(i);
    list.push(wave !== undefined ? { instrument: wave } : {});
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
    setControlsEnabled(false);
    player.stop();
    return;
  }
  lastP8 = result.p8;
  setControlsEnabled(true);

  const voiceCount = countSourceVoices(abcInput.value);
  if (voiceCount > 0) {
    voiceInstrumentsHost.hidden = false;
    renderVoiceInstruments(voiceInstrumentsList, voiceCount, voiceInstruments, () => {
      void convert();
    });
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
