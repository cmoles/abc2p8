import type { BuiltInKitName } from '../../../src/index.js';

// Pico-8's 8 built-in waveforms. Names from the Pico-8 manual / common usage.
const WAVEFORM_LABELS: readonly string[] = [
  '0 — Triangle',
  '1 — Tilted saw',
  '2 — Saw',
  '3 — Square',
  '4 — Pulse',
  '5 — Organ',
  '6 — Noise',
  '7 — Phaser',
];

const KIT_LABELS: readonly { id: BuiltInKitName; label: string }[] = [
  { id: 'noise', label: 'Noise (NES-classic)' },
];

export interface VoiceConfigSelections {
  instruments: Map<number, number>;
  drumKits: Map<number, BuiltInKitName>;
}

export function renderVoiceInstruments(
  host: HTMLElement,
  voiceCount: number,
  selections: VoiceConfigSelections,
  onChange: () => void,
): void {
  host.replaceChildren();
  for (let i = 0; i < voiceCount; i += 1) {
    host.appendChild(renderRow(i, selections, onChange));
  }
}

function renderRow(
  voiceIdx: number,
  selections: VoiceConfigSelections,
  onChange: () => void,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'voice-instrument';

  const tag = document.createElement('span');
  tag.className = 'voice-instrument-tag';
  tag.textContent = `V${voiceIdx + 1}`;
  row.appendChild(tag);

  const drumToggle = document.createElement('label');
  drumToggle.className = 'voice-drum-toggle';
  const drumCheckbox = document.createElement('input');
  drumCheckbox.type = 'checkbox';
  drumCheckbox.checked = selections.drumKits.has(voiceIdx);
  drumToggle.appendChild(drumCheckbox);
  drumToggle.appendChild(document.createTextNode(' Drum'));
  row.appendChild(drumToggle);

  const select = document.createElement('select');
  row.appendChild(select);

  const populate = (): void => {
    select.replaceChildren();
    if (selections.drumKits.has(voiceIdx)) {
      for (const k of KIT_LABELS) {
        const opt = document.createElement('option');
        opt.value = k.id;
        opt.textContent = k.label;
        select.appendChild(opt);
      }
      select.value = selections.drumKits.get(voiceIdx) ?? KIT_LABELS[0]!.id;
    } else {
      for (let w = 0; w < WAVEFORM_LABELS.length; w += 1) {
        const opt = document.createElement('option');
        opt.value = String(w);
        opt.textContent = WAVEFORM_LABELS[w]!;
        select.appendChild(opt);
      }
      const current = selections.instruments.get(voiceIdx) ?? 0;
      select.value = String(current);
    }
  };
  populate();

  drumCheckbox.addEventListener('change', () => {
    if (drumCheckbox.checked) {
      // Default to noise kit; drop any prior melodic instrument override.
      selections.drumKits.set(voiceIdx, 'noise');
    } else {
      selections.drumKits.delete(voiceIdx);
    }
    populate();
    onChange();
  });

  select.addEventListener('change', () => {
    if (selections.drumKits.has(voiceIdx)) {
      selections.drumKits.set(voiceIdx, select.value as BuiltInKitName);
    } else {
      const wave = Number(select.value);
      if (wave === 0 && !selections.instruments.has(voiceIdx)) return;
      selections.instruments.set(voiceIdx, wave);
    }
    onChange();
  });

  return row;
}
