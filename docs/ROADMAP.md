# Roadmap

Slices are vertical: each one delivers an end-to-end ABC → cart capability that
the audition CLI (`npm run convert`) can demonstrate. Slices remove guard-rail
errors currently raised by the pipeline; the rejected input from one slice is
the acceptance fixture of the next.

## Slice 1 — Monophonic, single SFX (shipped)

- Single voice, no chords, ≤32 notes (one SFX slot).
- Trivial `__music__` section pointing at slot 0.
- Audition CLI with `--play` stub.
- Guard rails enforced in `src/abc/toIR.ts:109,175`,
  `src/pipeline/quantize.ts:112`, `src/pico8/emit.ts:32`.

## Slice 2 — Long monophonic tunes

**Goal:** lift the 32-note ceiling so real tunes fit.

- Quantizer splits a single voice across multiple SFX slots.
- Emitter chains slots via a `__music__` pattern sequence (one channel, three
  silent).
- Loop point handling: ABC repeat bars (`|:` `:|`) → music loop flags (see
  `docs/pico8-format.md`).
- Removes guard at `src/pipeline/quantize.ts:112`.

**Open questions**
- How do we pick SFX speed when sub-tune sections want different note lengths?
  Probably one speed per tune; warn on truncation.
- Slot budget — error vs. warn when a tune exceeds 64 SFX slots.

## Slice 3 — Multi-voice polyphony

**Goal:** ABC `V:` voices → distinct Pico-8 channels.

- Score IR already models voices; wire toIR to accept ≥2 and ≤4.
- Per-voice quantize + slot allocation; each music pattern row picks one SFX
  per channel.
- Voice-to-channel mapping (deterministic by ABC voice order; CLI flag to
  override).
- Removes guards at `src/abc/toIR.ts:109` and `src/pico8/emit.ts:32`.

**Open questions**
- Different voices may want different note-length grids. Pick the LCM, or
  reject mismatches?
- Per-voice instrument assignment — ABC `%%MIDI program` hint, or just a CLI
  default per voice?

## Slice 4 — Chord support

**Goal:** chords within a voice, split across remaining channels.

- toIR accepts ABC chords (`[CEG]`), expands them onto sibling channels
  borrowed from the unused channel pool.
- Channel-budget diagnostics: warn/error when chord arity + voice count > 4.
- Removes guard at `src/abc/toIR.ts:175`.

**Open questions**
- Voicing priority when over-budget — drop the lowest note? The highest?
  Configurable?
- Interaction with slice 3: a 2-voice tune leaves 2 channels for chords; a
  4-voice tune leaves 0. Document this clearly.

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
