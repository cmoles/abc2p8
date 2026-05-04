export type Severity = 'info' | 'warn' | 'error';

export type Stage = 'parse' | 'toIR' | 'quantize' | 'allocate' | 'emit';

export interface DiagnosticLocation {
  line?: number;
  tick?: number;
  voice?: string;
}

export interface Diagnostic {
  severity: Severity;
  stage: Stage;
  code: string;
  message: string;
  location?: DiagnosticLocation;
}

export class Diagnostics {
  private readonly items: Diagnostic[] = [];

  add(diag: Diagnostic): void {
    this.items.push(diag);
  }

  info(stage: Stage, code: string, message: string, location?: DiagnosticLocation): void {
    this.add({ severity: 'info', stage, code, message, location });
  }

  warn(stage: Stage, code: string, message: string, location?: DiagnosticLocation): void {
    this.add({ severity: 'warn', stage, code, message, location });
  }

  error(stage: Stage, code: string, message: string, location?: DiagnosticLocation): void {
    this.add({ severity: 'error', stage, code, message, location });
  }

  hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error');
  }

  list(): readonly Diagnostic[] {
    return this.items;
  }
}

export interface DiagnosticParts {
  severity: Severity;
  stage: Stage;
  code: string;
  message: string;
  location: string | null;
}

function formatLocation(loc: DiagnosticLocation | undefined): string | null {
  if (!loc) return null;
  const bits = [
    loc.voice,
    loc.tick !== undefined ? `tick ${loc.tick}` : null,
    loc.line !== undefined ? `line ${loc.line}` : null,
  ].filter((x): x is string => x !== null && x !== undefined);
  return bits.length > 0 ? bits.join(', ') : null;
}

export function formatDiagnosticParts(d: Diagnostic): DiagnosticParts {
  return {
    severity: d.severity,
    stage: d.stage,
    code: d.code,
    message: d.message,
    location: formatLocation(d.location),
  };
}

export function formatDiagnosticText(d: Diagnostic): string {
  const parts = formatDiagnosticParts(d);
  const loc = parts.location ? ` [${parts.location}]` : '';
  return `${parts.severity.toUpperCase()} ${parts.stage}/${parts.code}: ${parts.message}${loc}`;
}
