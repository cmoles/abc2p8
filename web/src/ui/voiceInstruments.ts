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

export function renderVoiceInstruments(
  host: HTMLElement,
  voiceCount: number,
  selections: Map<number, number>,
  onChange: () => void,
): void {
  host.replaceChildren();
  for (let i = 0; i < voiceCount; i += 1) {
    host.appendChild(renderRow(i, selections, onChange));
  }
}

function renderRow(
  voiceIdx: number,
  selections: Map<number, number>,
  onChange: () => void,
): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'voice-instrument';

  const tag = document.createElement('span');
  tag.className = 'voice-instrument-tag';
  tag.textContent = `V${voiceIdx + 1}`;
  label.appendChild(tag);

  const select = document.createElement('select');
  for (let w = 0; w < WAVEFORM_LABELS.length; w += 1) {
    const opt = document.createElement('option');
    opt.value = String(w);
    opt.textContent = WAVEFORM_LABELS[w]!;
    select.appendChild(opt);
  }
  const current = selections.get(voiceIdx) ?? 0;
  select.value = String(current);

  select.addEventListener('change', () => {
    const wave = Number(select.value);
    if (wave === 0 && !selections.has(voiceIdx)) return; // No-op: already default.
    selections.set(voiceIdx, wave);
    onChange();
  });

  label.appendChild(select);
  return label;
}
