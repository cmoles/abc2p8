# Roadmap

Slices are vertical: each one delivers an end-to-end ABC → cart capability that
the audition CLI (`npm run convert`) can demonstrate. Slices remove guard-rail
errors currently raised by the pipeline; the rejected input from one slice is
the acceptance fixture of the next.

## Slice 1 — Monophonic, single SFX (shipped)

- Single voice, no chords, ≤32 notes (one SFX slot).
- Trivial `__music__` section pointing at slot 0.
- Audition CLI with `--play` stub.
- Guard rails enforced in `src/abc/toIR.ts` (multi-voice, chord) and
  `src/pico8/emit.ts` (single channel).

## Slice 2 — Long monophonic tunes (shipped)

- Quantizer chunks a single voice into ≤32-slot SFX blocks with forced
  boundaries at loop points.
- Emitter writes one SFX line per block and chains them via `__music__`
  patterns (channel 0 used, others silent).
- ABC repeat bars (`|:` `:|`, `::`) → Pico-8 begin/end-loop flags. Implicit
  `|:` at the start when only `:|` is present. Multiple repeat regions warn
  and keep the first; orphan `|:` warns and is dropped.
- Content after `:|` is dropped with `CONTENT_AFTER_REPEAT` (Pico-8 loop is
  indefinite).
- Slot budget is enforced: a tune needing more than 64 SFX slots errors with
  `SFX_BUDGET_EXCEEDED`.

## Slice 3 — Multi-voice polyphony (shipped)

- ABC `V:` voices → distinct Pico-8 channels (deterministic by voice order).
- Up to 4 voices accepted; >4 errors with `TOO_MANY_VOICES`.
- Quantizer picks one slot grid via GCD across all voices; voices share block
  boundaries (forced cuts at loop start/end). Shorter voices are padded with
  rests so all voices end on the same boundary.
- Each voice's blocks emit one SFX each, numbered sequentially
  (voice 0 first, then voice 1, …). Music pattern row N stacks
  `[v0.block[N], v1.block[N], …]` onto channels 0..N; unused channels are
  marked silent (`0x40 | channel`).
- SFX budget is per total: `voices × blocksPerVoice ≤ 64`.
- Voice 0's `|: ... :|` is authoritative; mismatched repeats in other voices
  emit `VOICE_REPEAT_MISMATCH`.

**Resolved decisions**
- Slot-grid picks the GCD across all voices (existing slice-2 behavior; no
  per-voice grid).
- Per-voice instrument assignment is deferred — all voices share the
  `defaultInstrument` option (waveform 0 / sine). ABC `%%MIDI program` hints
  are still ignored.

## Slice 4 — Chord support (shipped)

- ABC chords (`[CEG]`) expand into sibling voices in the IR — one sibling per
  pitch in the largest chord that voice contains. Sibling 0 carries the lowest
  pitch, sibling N-1 the highest.
- At positions where the chord has fewer notes than the voice's max arity,
  the upper siblings get rests; single notes within a chord-bearing voice land
  on sibling 0 with the rest silent.
- Each sibling becomes a normal `Voice` and is fed through quantize/emit
  unchanged — the channel layout falls out of voice ordering. A 2-voice tune
  with V1=`[CE]` and V2=`g` uses three channels (V1.A, V1.B, V2).
- Channel budget is enforced at toIR: sum of per-voice max chord arity must be
  ≤ 4, otherwise `CHORD_OVERFLOW` errors.
- Voicing priority deferred — when over-budget the converter errors rather
  than picking which notes to drop. Edit the ABC to fit.

## Slice 5 — Web playground (shipped)

- Vite-built static site at `web/`, deploys to GitHub Pages from `main` via
  `.github/workflows/deploy-web.yml`.
- Textarea for ABC, diagnostics list, copy/download `.p8` buttons.
- Playback uses Pico-8's official HTML export (Pico-8 0.2.6, all-JS, no
  WASM). At convert time we fetch the committed `runtime/shell.html` +
  `runtime/shell.js`, rewrite the cart bytes inside `_cartdat` to splice in
  the user's `__sfx__` and `__music__`, and load the patched runtime in an
  iframe via `srcdoc`. Lua code stays untouched.
- Cart byte layout (verified empirically during the spike): SFX slot is
  `[notes(64) | header(4)]` (notes first, header at slot end). Music
  channel byte in ROM is the same as in text format with the appropriate
  flag bit OR'd into bit 7.

## Slice 6 — Multi-track jukebox cart

**Goal:** one cart that bundles multiple ABC tunes, plus a track-picker
running in Pico-8 Lua. The web playground grows a list-of-tunes UI; the
library grows a `bundleToPico8` function. Cart code stays a constant
build artifact — all per-bundle data flows through swappable byte regions.

**Storage strategy.** Track metadata lives in the spritesheet region
(`__gfx__`, `0x0000`–`0x1fff`, 8 KiB). The shell cart never renders
sprites, so this region is free. Layout: 4-byte preamble (3-byte magic
`'ABC'` + 1-byte track count `N`), followed by `N` × 18-byte fixed records
of `{name[16] | music_start | music_count}`. Names are NUL-padded ASCII,
≤16 chars. Max 64 tracks (one per music pattern); ~1.2 KiB used of the
available 8.

**Library work.**
- New `src/pico8/metadata.ts` defining the byte format and an encoder.
- New `bundleToPico8(tracks: TrackInput[], opts) → ConvertResult` in
  `src/index.ts` where `TrackInput = { name: string, abc: string }`. Each
  track runs through the existing `abcToPico8` pipeline; results are
  sequenced into music slots `[0..M-1]`, `[M..M+M'-1]`, … with SFX indices
  rebased per track. The existing single-track `abcToPico8` is the N=1
  case without metadata.
- Promote `rebaseMusicLine` from `scripts/build-sandbox-cart.ts:70-84` into
  the library (shared between bundle and audition flows).
- New diagnostic codes: `BUNDLE_OVERFLOW` (>64 music slots or >64 SFX
  slots in aggregate, or >64 tracks), `NAME_TRUNCATED` (info — name was
  longer than 16 chars).

**Cart-patch additions.**
- `extractRomRegions` learns about `__gfx__` and returns
  `{ sfxBytes, musicBytes, gfxBytes }`. `gfxBytes` is `0x2000` long.
- `patchCartRom` splices the gfx region at `0x0000`.

**Shell cart rewrite.** `web/spike/shell.p8` becomes a small jukebox
program. `_init` peeks the metadata at `0x0000`, parses into a Lua list.
`_update60` handles up/down/play/stop. `_draw` renders a list with a
selection cursor. Re-export to `web/public/runtime/`.

**Web UI changes.** A "tracks" panel replacing the single textarea: list
of `{name, abc}` rows, +/× to add/remove, drag-or-buttons to reorder. One
"Build & Play" button calls `bundleToPico8` and feeds the result through
the existing player.

**Carried forward.** Slice 5's player module needs no changes — it just
splices three byte regions instead of two.

## Not yet scoped

- Drum/percussion mapping (Pico-8 noise waveform).
- Effects beyond the basics already in IR (`src/ir/types.ts`).
- ABC ornaments (trills, grace notes) — currently silently dropped.
- Reverse direction (Pico-8 cart → ABC).
