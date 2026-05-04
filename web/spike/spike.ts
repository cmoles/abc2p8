import { abcToPico8 } from '../../src/index.js';
import {
  extractRomRegions,
  MUSIC_REGION_BYTES,
  patchCartRom,
  SFX_REGION_BYTES,
  SFX_OFFSET,
} from '../src/cartPatch.js';
import { buildPatchedRuntime, parseRuntimeJs } from '../src/runtimePatch.js';

const BASE = import.meta.env.BASE_URL;
const RUNTIME_HTML_URL = `${BASE}runtime/shell.html`;
const RUNTIME_JS_URL = `${BASE}runtime/shell.js`;

const log = document.getElementById('log') as HTMLPreElement;
const host = document.getElementById('player-host') as HTMLDivElement;

function logLine(msg: string): void {
  log.textContent += `${msg}\n`;
  log.scrollTop = log.scrollHeight;
}

let cachedHtml: string | null = null;
let cachedJs: string | null = null;

async function loadRuntime(): Promise<{ html: string; js: string }> {
  if (cachedHtml && cachedJs) return { html: cachedHtml, js: cachedJs };
  logLine('fetching shell.html and shell.js...');
  const [html, js] = await Promise.all([
    fetch(RUNTIME_HTML_URL).then((r) => r.text()),
    fetch(RUNTIME_JS_URL).then((r) => r.text()),
  ]);
  cachedHtml = html;
  cachedJs = js;
  logLine(`shell.html: ${html.length} bytes; shell.js: ${js.length} bytes`);
  return { html, js };
}

async function bootWith(romTransform: (rom: Uint8Array) => Uint8Array, label: string): Promise<void> {
  const { html, js } = await loadRuntime();
  const parts = parseRuntimeJs(js);
  logLine(`[${label}] cart ROM size: ${parts.rom.length} bytes`);
  const patchedRom = romTransform(parts.rom);
  const runtime = buildPatchedRuntime(html, parts, patchedRom);
  logLine(`[${label}] blob URL: ${runtime.blobUrl}`);

  host.replaceChildren();
  const iframe = document.createElement('iframe');
  iframe.srcdoc = runtime.html;
  iframe.allow = 'autoplay';
  host.appendChild(iframe);
  logLine(`[${label}] iframe loaded — click into it and the runtime should auto-start.`);
}

document.getElementById('boot-sentinel')!.addEventListener('click', () => {
  bootWith((rom) => rom, 'sentinel').catch((e) => logLine(`error: ${e}`));
});

document.getElementById('boot-c2')!.addEventListener('click', () => {
  bootWith((rom) => {
    const out = new Uint8Array(rom);
    // Slot 0 layout: 32 notes × 2 B at offsets 0..63, then 4-byte header at
    // offsets 64..67. Note 0 byte 0 lives at SFX_OFFSET. Pitch is the low
    // 6 bits; zero them to pick pitch=0 (C2). Keep waveform bits intact.
    const noteByte0 = out[SFX_OFFSET]!;
    out[SFX_OFFSET] = noteByte0 & 0xc0;
    return out;
  }, 'patched-c2').catch((e) => logLine(`error: ${e}`));
});

document.getElementById('boot-abc')!.addEventListener('click', () => {
  const abc = (document.getElementById('abc') as HTMLTextAreaElement).value;
  const result = abcToPico8(abc);
  logLine(`abcToPico8 diagnostics: ${JSON.stringify(result.diagnostics)}`);
  if (result.p8 === '') {
    logLine('abcToPico8 produced no cart; aborting.');
    return;
  }
  const regions = extractRomRegions(result.p8);
  logLine(`extracted music=${regions.musicBytes.length}B (expected ${MUSIC_REGION_BYTES}), sfx=${regions.sfxBytes.length}B (expected ${SFX_REGION_BYTES})`);
  bootWith((rom) => patchCartRom(rom, regions), 'patched-abc').catch((e) =>
    logLine(`error: ${e}`),
  );
});

document.getElementById('dump-rom')!.addEventListener('click', async () => {
  const { js } = await loadRuntime();
  const parts = parseRuntimeJs(js);
  // Dump SFX header (4 B) and first 4 notes (8 B per note × 4 = 32 B) at 0x3200.
  // Also dump the surrounding context so we can spot if SFX is actually elsewhere.
  const dump = (label: string, off: number, len: number): void => {
    const slice = parts.rom.slice(off, off + len);
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    logLine(`${label} @0x${off.toString(16)} (${len} B): ${hex}`);
  };
  logLine('--- ROM dump (sentinel cart) ---');
  dump('music pattern 0', 0x3100, 4);
  dump('sfx slot 0 notes 0-3', 0x3200, 8);
  dump('sfx slot 0 notes 4-7', 0x3208, 8);
  dump('sfx slot 0 header (slot end)', 0x3240, 4);
  dump('sfx slot 1 notes 0-1', 0x3244, 4);
  // shell.p8 slot 0: header 013c0800, note 0 240500 (pitch 36, wave 0, vol 5).
  logLine(`expected slot-0 note 0: byte 0 = 0x24, byte 1 = 0x0a`);
  logLine(`expected slot-0 header: 01 3c 08 00`);
});

document.getElementById('probe-module')!.addEventListener('click', () => {
  const iframe = host.querySelector('iframe');
  if (!iframe || !iframe.contentWindow) {
    logLine('no running iframe — boot first.');
    return;
  }
  // Try to read Module from the iframe's window.
  const w = iframe.contentWindow as unknown as Record<string, unknown>;
  const mod = w.Module as Record<string, unknown> | undefined;
  if (!mod) {
    logLine('Module is undefined on the iframe window.');
    return;
  }
  const keys = Object.keys(mod).slice(0, 50);
  logLine(`Module keys (first 50): ${keys.join(', ')}`);
  const interesting = ['HEAPU8', 'HEAP8', 'ccall', '_main', 'asm', 'getMemory', '_codo_mixer_callback'];
  for (const k of interesting) {
    logLine(`  Module.${k} = ${typeof mod[k]}`);
  }
});
