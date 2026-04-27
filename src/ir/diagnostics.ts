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
