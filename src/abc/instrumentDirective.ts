import type { Diagnostics } from '../ir/diagnostics.js';

export interface ExtractedInstruments {
  // Map of 0-based source voice index → Pico-8 waveform 0–7.
  instruments: Map<number, number>;
  // Input ABC with `%%pico8 instrument` lines removed so abcjs doesn't
  // surface them as unknown directives.
  cleanedAbc: string;
}

const DIRECTIVE = /^%%pico8\s+instrument\s+(.*)$/;

// Parse `%%pico8 instrument <voiceNumber> <waveform>` directives. Voice numbers
// match ABC's 1-based `V:` numbering (V:1, V:2, …); waveforms are 0–7.
export function extractVoiceInstruments(
  abc: string,
  diagnostics: Diagnostics,
): ExtractedInstruments {
  const instruments = new Map<number, number>();
  const out: string[] = [];
  const lines = abc.split('\n');

  for (const line of lines) {
    const match = DIRECTIVE.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const args = match[1]!.trim().split(/\s+/);
    if (args.length !== 2) {
      diagnostics.error(
        'toIR',
        'INSTRUMENT_DIRECTIVE_INVALID',
        `%%pico8 instrument expects "<voiceNumber> <waveform>", got "${match[1]!.trim()}".`,
      );
      continue;
    }
    const voiceNum = Number(args[0]);
    const wave = Number(args[1]);
    if (!Number.isInteger(voiceNum) || voiceNum < 1) {
      diagnostics.error(
        'toIR',
        'INSTRUMENT_DIRECTIVE_INVALID',
        `%%pico8 instrument voice number "${args[0]}" must be a positive integer (V:1, V:2, …).`,
      );
      continue;
    }
    if (!Number.isInteger(wave) || wave < 0 || wave > 7) {
      diagnostics.error(
        'toIR',
        'INSTRUMENT_OUT_OF_RANGE',
        `%%pico8 instrument waveform "${args[1]}" must be an integer in [0, 7].`,
      );
      continue;
    }
    instruments.set(voiceNum - 1, wave);
  }

  return { instruments, cleanedAbc: out.join('\n') };
}
