# 03 — melody + bass + drums

Three voices: lead melody on square (waveform 2), bass on triangle, and a
backbeat drum voice. This is the canonical "complete game tune" shape.

**What this demonstrates**
- Three voices fitting in the 4-channel budget (V1 + V2 + V3 = 3 channels).
- Drum voice declaration via `%%pico8 drum 3` (1-based; here voice 3).
- Drum letters: `c` = kick, `d` = snare, `e` = hat-closed. Octave is
  ignored on drum voices.
- Bass written deep (`C,`, `G,,`) to leave headroom for melody on top.
- Per-voice instrument directives let each part have its own timbre.

**Should NOT produce**
- `CHORD_OVERFLOW` — three voices, no chords.
- `DRUM_HIT_UNKNOWN` — drum voice uses only plain `c/d/e`.
- `OUT_OF_RANGE` — bass clamps within Pico-8's range; if you write
  `G,,,` it will get auto-shifted up an octave.

**Acceptable info**
- `TEMPO_ROUNDED` — Pico-8 speed rounding.

**Try variations**
- Swap `%%pico8 drum 3` for `--kit hybrid` or `--kit tonal` on the CLI to
  hear different drum tones over the same notes.
