# 02 — melody + sustained pad

Two voices, no chords, no drums. The pad voice holds whole notes against
the melody.

**What this demonstrates**
- Two-voice polyphony — `V:1` on Pico-8 channel 0, `V:2` on channel 1.
- Per-voice instruments via `%%pico8 instrument` (1 = tilted-saw lead,
  0 = triangle pad).
- Long sustained pitches (`A,8`) — Pico-8 holds across slots without
  retriggering.
- Pad written low (`A,`, `F,` = octave 3) so it doesn't clash with the
  melody's octave 5.

**Should NOT produce**
- `OUT_OF_RANGE` — pad and melody both fit comfortably.
- `VOICE_REPEAT_MISMATCH` — no repeat region in either voice.
