import { extractRomRegions, patchCartRom } from './cartPatch.js';
import { buildPatchedRuntime, parseRuntimeJs, type RuntimeRom } from './runtimePatch.js';

interface RuntimeAssets {
  shellHtml: string;
  parts: RuntimeRom;
}

export class Pico8Player {
  private assets: RuntimeAssets | null = null;
  private blobUrl: string | null = null;

  constructor(private readonly host: HTMLElement) {}

  async load(p8: string): Promise<void> {
    const { shellHtml, parts } = await this.preloadRuntime();
    const regions = extractRomRegions(p8);
    const patchedRom = patchCartRom(parts.rom, regions);

    this.revokeBlob();
    const runtime = buildPatchedRuntime(shellHtml, parts, patchedRom);
    this.blobUrl = runtime.blobUrl;

    this.host.replaceChildren();
    const iframe = document.createElement('iframe');
    iframe.srcdoc = runtime.html;
    iframe.allow = 'autoplay';
    iframe.title = 'Pico-8 player';
    this.host.appendChild(iframe);
    this.host.hidden = false;
  }

  stop(): void {
    this.host.replaceChildren();
    this.host.hidden = true;
    this.revokeBlob();
  }

  private async preloadRuntime(): Promise<RuntimeAssets> {
    if (this.assets) return this.assets;
    const base = import.meta.env.BASE_URL;
    const [shellHtml, shellJs] = await Promise.all([
      fetch(`${base}runtime/shell.html`).then((r) => r.text()),
      fetch(`${base}runtime/shell.js`).then((r) => r.text()),
    ]);
    this.assets = { shellHtml, parts: parseRuntimeJs(shellJs) };
    return this.assets;
  }

  private revokeBlob(): void {
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }
}
