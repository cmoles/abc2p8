import { formatDiagnosticParts, type Diagnostic } from '../../../src/index.js';

export function renderDiagnostics(
  host: HTMLUListElement,
  diagnostics: readonly Diagnostic[],
): void {
  host.replaceChildren();
  if (diagnostics.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No diagnostics.';
    host.appendChild(li);
    return;
  }
  for (const d of diagnostics) {
    host.appendChild(renderOne(d));
  }
}

function renderOne(d: Diagnostic): HTMLLIElement {
  const parts = formatDiagnosticParts(d);
  const li = document.createElement('li');
  li.className = parts.severity;

  const sev = document.createElement('span');
  sev.className = 'severity';
  sev.textContent = parts.severity;
  li.appendChild(sev);

  const code = document.createElement('span');
  code.className = 'code';
  code.textContent = `${parts.stage}/${parts.code}: `;
  li.appendChild(code);

  li.appendChild(document.createTextNode(parts.message));

  if (parts.location) {
    const loc = document.createElement('span');
    loc.className = 'location';
    loc.textContent = `[${parts.location}]`;
    li.appendChild(loc);
  }
  return li;
}
