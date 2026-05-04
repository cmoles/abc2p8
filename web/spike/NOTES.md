# Spike findings

## Export structure

Pico-8 0.2.6's `EXPORT shell.html` produces **two files**, no WASM:

- `shell.html` — page chrome and the boot script (`p8_run_cart`).
- `shell.js` — Emscripten-asm.js compiled runtime + the cart ROM.

There is **no `.wasm` file**. The runtime predates Pico-8's WASM pipeline
(or this version uses asm.js for compatibility). The "Module" object
exposed by the runtime still uses Emscripten conventions (`HEAPU8`,
`ccall`, `_main`, etc.), but the ASM runs as plain JavaScript.

## Cart ROM location in shell.js

The cart bytes live as a comma-separated JS array literal at the top of
`shell.js`:

```js
var _cartname=[`shell.p8`];
var _cdpos=0; var iii=0; var ciii=0;
var _cartdat=[
0,0,0,0,0,0,0,0, …,
];
```

This is the entire ROM image. We rewrite the array's body with our patched
bytes before the script executes (`web/src/runtimePatch.ts`).

## Patching strategy chosen

**Pre-boot patch via fetch + Blob URL.** The flow:

1. `fetch(shell.js)` → text.
2. `parseRuntimeJs` extracts the `_cartdat` array as a `Uint8Array`.
3. `patchCartRom` overwrites bytes `0x3100..0x31ff` (music) and
   `0x3200..0x42ff` (sfx) with the regions from the user's `.p8`.
4. `injectRuntimeRom` re-emits the patched JS as text.
5. `URL.createObjectURL(new Blob([text]))` → blob URL.
6. `fetch(shell.html)` → text. Replace `e.src = "shell.js"` (literal in
   `p8_run_cart`) with the blob URL.
7. `iframe.srcdoc = patchedHtml`. The iframe inherits the parent origin,
   so the blob URL is loadable.

This keeps the Lexaloffle runtime untouched and the patch fully
client-side.

## Hot-swap probe

Not pursued in this spike. Rationale: every Convert in the playground
implies a fresh tune, which means a fresh ROM. Reloading the iframe per
Convert is acceptable UX for slice 5 (one-click Convert & Play). If we
later want continuous editing without flicker, the relevant Module
symbols (`HEAPU8`, `ccall`) are exposed by the asm runtime and we could
write to the cart RAM region directly via `Module.HEAPU8.set(...)` plus
`Module.ccall("_music", ...)`. Out of scope for slice 5.

## Risks observed

- **Blob URL inside `srcdoc`** — works in current Chromium/Firefox. If a
  future browser tightens srcdoc origin handling, swap to
  `URL.createObjectURL` for the HTML too and assign `iframe.src` to it.
- **Audio context autoplay** — the runtime opens its own AudioContext
  inside the iframe; the user's click on Convert in the parent counts as
  the gesture for the parent origin, but the iframe's first user
  interaction with the canvas is what actually starts audio reliably.
  The spike harness loads the iframe and the user clicks into it to
  start; the slice-5 player will need the same one-time interaction.
- **Pico-8 version drift** — see `web/public/runtime/README.md`.

## What this unblocks

`web/src/player.ts` can be implemented as:

- `load(p8: string)`: builds patched runtime via the flow above, sets
  `iframe.srcdoc`.
- `play()` / `stop()`: postMessage to a small inner script we inject via
  the patched shell.html, calling Pico-8's `_music(0)` / `_music(-1)` —
  OR (simpler MVP) just rely on the shell cart's btn(4)/btn(5) handlers
  and surface the "click into iframe" instruction in the UI.

The spike's third button (Boot PATCHED from ABC) is the end-to-end
demonstration: paste any ABC, hear the converted result via the real
Pico-8 runtime.
