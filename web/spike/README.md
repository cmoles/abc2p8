# Slice 5 spike

Goal: prove that we can splice fresh `__sfx__` / `__music__` bytes into a
Pico-8 HTML/WASM export at runtime and hear them. This unblocks `web/src/player.ts`.

## What's here

- `shell.p8` — the cart we export. Tiny Lua that auto-plays pattern 0, with a
  sentinel SFX (single A4 quarter on slot 0). Z re-triggers, X stops.
- `index.html` — the spike harness (added once shell.html lands here).
- `NOTES.md` — findings; created during the spike and committed.

## Steps for the user (Phase 0)

1. Open `shell.p8` in Pico-8 (`load shell.p8`).
2. Sanity check: `run` — you should hear a single A4 ping every ~1.5s.
3. Export:
   ```
   export shell.html
   export shell.bin
   ```
   `shell.bin` is for offline byte diffing during development; `shell.html`
   plus its sibling `shell.js` and `*.wasm` are the runtime.
4. Move `shell.html`, `shell.js`, and the `.wasm` (file names will be
   visible in the export folder) into `web/public/runtime/`. Add a
   `web/public/runtime/README.md` recording the Pico-8 version used so we can
   detect drift later.
5. Hand off — the spike harness will load that runtime and prove byte
   patching works.

## Pico-8 version pinning

Once exported, record the Pico-8 build number (top of Pico-8 console after
launch) in `web/public/runtime/README.md`. The byte-packing of the cart
region is stable across recent versions but not guaranteed across major
revisions; if the spike harness breaks after a Pico-8 upgrade, that's the
first place to check.
