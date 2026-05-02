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

## Slice 5 — Web playground

**Goal:** browser app — paste ABC, get a cart, hear it.

- Vite-built static site, deploys to GitHub Pages from `main`.
- Textarea for ABC, download/copy buttons for the `.p8`.
- Optional: in-browser playback via a Pico-8 WASM player or by emitting WebAudio
  from the IR directly (cheaper, but diverges from the cart).
- No new pipeline features — purely a UI layer over `abcToPico8()`.

**Open questions**
- Playback strategy (WASM vs. WebAudio-from-IR) — pick one before slice 5
  starts.
- Hosting: project page (`<user>.github.io/abc2p8`) vs. custom domain.

## Not yet scoped

- Drum/percussion mapping (Pico-8 noise waveform).
- Effects beyond the basics already in IR (`src/ir/types.ts`).
- ABC ornaments (trills, grace notes) — currently silently dropped.
- Reverse direction (Pico-8 cart → ABC).
