// The Pico-8 HTML export ships its cart ROM inline as a JS array literal
// in shell.js:
//   var _cartdat=[ 0,0,...,0 ];
// We patch the playground's tune in by rewriting this array's body before
// the script executes. The array is the entire ROM image (32 KiB by default).

const CARTDAT_RE = /var\s+_cartdat\s*=\s*\[([\s\S]*?)\]\s*;/;

export interface RuntimeRom {
  rom: Uint8Array;
  before: string;
  after: string;
}

export function parseRuntimeJs(jsText: string): RuntimeRom {
  const match = CARTDAT_RE.exec(jsText);
  if (!match) {
    throw new Error('shell.js does not contain the expected `var _cartdat=[...]` literal');
  }
  const body = match[1]!;
  const before = jsText.slice(0, match.index);
  const after = jsText.slice(match.index + match[0].length);
  const bytes = body
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10));
  for (const b of bytes) {
    if (!Number.isInteger(b) || b < 0 || b > 255) {
      throw new Error(`unexpected non-byte value in _cartdat: ${b}`);
    }
  }
  return { rom: new Uint8Array(bytes), before, after };
}

export function injectRuntimeRom(parts: RuntimeRom, rom: Uint8Array): string {
  const body = Array.from(rom).join(',');
  return `${parts.before}var _cartdat=[${body}];${parts.after}`;
}

const SHELL_JS_SRC_MARKER = 'e.src = "shell.js";';

export interface PatchedRuntime {
  html: string;
  blobUrl: string;
}

// Builds a runtime ready to mount as `iframe.srcdoc = result.html`. The
// caller is responsible for revoking `blobUrl` when the iframe is replaced.
export function buildPatchedRuntime(
  shellHtml: string,
  parts: RuntimeRom,
  patchedRom: Uint8Array,
): PatchedRuntime {
  const patchedJs = injectRuntimeRom(parts, patchedRom);
  const blobUrl = URL.createObjectURL(
    new Blob([patchedJs], { type: 'application/javascript' }),
  );
  const html = shellHtml.replace(
    SHELL_JS_SRC_MARKER,
    `e.src = ${JSON.stringify(blobUrl)};`,
  );
  if (html === shellHtml) {
    URL.revokeObjectURL(blobUrl);
    throw new Error('shell.html script src marker not found — runtime version drift?');
  }
  return { html, blobUrl };
}
