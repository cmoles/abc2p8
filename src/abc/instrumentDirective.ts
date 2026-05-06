import type { Diagnostics } from '../ir/diagnostics.js';

export interface ExtractedDirectives {
  // Map of 0-based source voice index → Pico-8 waveform 0–7.
  instruments: Map<number, number>;
  // Set of 0-based source voice indices marked as drum voices.
  drums: Set<number>;
  // Input ABC with `%%pico8 …` directive lines removed so abcjs doesn't
  // surface them as unknown directives.
  cleanedAbc: string;
}

const PICO8_DIRECTIVE = /^%%pico8\s+(\S+)\s+(.*)$/;

// Parse abc2p8-specific custom directives.
//   %%pico8 instrument <voiceNumber> <waveform>  — set per-voice waveform 0–7.
//   %%pico8 drum <voiceNumber>                   — mark the voice as a drum voice.
// Voice numbers match ABC's 1-based `V:` numbering (V:1, V:2, …).
export function extractPico8Directives(
  abc: string,
  diagnostics: Diagnostics,
): ExtractedDirectives {
  const instruments = new Map<number, number>();
  const drums = new Set<number>();
  const out: string[] = [];

  for (const line of abc.split('\n')) {
    const match = PICO8_DIRECTIVE.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const kind = match[1]!;
    const rest = match[2]!.trim();
    if (kind === 'instrument') {
      handleInstrument(rest, instruments, diagnostics);
    } else if (kind === 'drum') {
      handleDrum(rest, drums, diagnostics);
    } else {
      diagnostics.error(
        'toIR',
        'PICO8_DIRECTIVE_UNKNOWN',
        `Unknown %%pico8 directive "${kind}".`,
      );
    }
  }

  return { instruments, drums, cleanedAbc: out.join('\n') };
}

function handleInstrument(
  rest: string,
  instruments: Map<number, number>,
  diagnostics: Diagnostics,
): void {
  const args = rest.split(/\s+/);
  if (args.length !== 2) {
    diagnostics.error(
      'toIR',
      'INSTRUMENT_DIRECTIVE_INVALID',
      `%%pico8 instrument expects "<voiceNumber> <waveform>", got "${rest}".`,
    );
    return;
  }
  const voiceNum = Number(args[0]);
  const wave = Number(args[1]);
  if (!Number.isInteger(voiceNum) || voiceNum < 1) {
    diagnostics.error(
      'toIR',
      'INSTRUMENT_DIRECTIVE_INVALID',
      `%%pico8 instrument voice number "${args[0]}" must be a positive integer (V:1, V:2, …).`,
    );
    return;
  }
  if (!Number.isInteger(wave) || wave < 0 || wave > 7) {
    diagnostics.error(
      'toIR',
      'INSTRUMENT_OUT_OF_RANGE',
      `%%pico8 instrument waveform "${args[1]}" must be an integer in [0, 7].`,
    );
    return;
  }
  instruments.set(voiceNum - 1, wave);
}

function handleDrum(rest: string, drums: Set<number>, diagnostics: Diagnostics): void {
  const args = rest.split(/\s+/).filter((s) => s.length > 0);
  if (args.length !== 1) {
    diagnostics.error(
      'toIR',
      'DRUM_DIRECTIVE_INVALID',
      `%%pico8 drum expects "<voiceNumber>", got "${rest}".`,
    );
    return;
  }
  const voiceNum = Number(args[0]);
  if (!Number.isInteger(voiceNum) || voiceNum < 1) {
    diagnostics.error(
      'toIR',
      'DRUM_DIRECTIVE_INVALID',
      `%%pico8 drum voice number "${args[0]}" must be a positive integer (V:1, V:2, …).`,
    );
    return;
  }
  drums.add(voiceNum - 1);
}
