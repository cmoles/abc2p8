# 04 — drum pattern

A standalone drum loop. Sole voice marked as a drum voice so plain letters
trigger named hits.

**What this demonstrates**
- A drum-only voice (`%%pico8 drum 1` — voice 1 is the drum).
- Standard backbeat: kick on 1+3, snare on 2+4, eighth-note hats throughout.
- Drum chord `[df]` = simultaneous snare + hat-open. Drum chords expand to
  sibling channels (this fixture uses up to 2 channels: the snare and one
  hat at a time, so it stays under the 4-channel budget).
- Final fill `[de] [de] [de]` = three quick snare+hat-closed hits.

**Should NOT produce**
- `DRUM_HIT_UNKNOWN` — only plain `c/d/e/f` letters.
- `CHORD_OVERFLOW` — peak simultaneous hits = 2 (snare + hat), well under 4.

**Pitfall to avoid**
- Drum voices ignore `chordStrategy: 'arp'`. Don't expect `[cdef]` to
  arpeggiate — it will expand into 4 sibling channels and consume the
  whole channel budget. Keep drum chords ≤ 2 hits in practice if you also
  want melody/bass.
