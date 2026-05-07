# 05 — multi-section tune with repeats

Intro then a looping verse. Demonstrates the `intro|: loop :|` pattern —
the intro plays once, then the loop plays forever.

**What this demonstrates**
- Pre-loop content (the first bar) plays once.
- `|: ... :|` marks the loop region. Pico-8 plays it indefinitely.
- Both voices mirror the loop bounds — V1's are authoritative, but
  matching them in V2 keeps the IR clean (no `VOICE_REPEAT_MISMATCH`).
- Bass octave (`G,8`, `D,8`) sits two octaves below the lead.

**Should NOT produce**
- `MULTIPLE_REPEATS` — exactly one `|: … :|` region.
- `VOICE_REPEAT_MISMATCH` — bounds are aligned.
- `CONTENT_AFTER_REPEAT` — nothing after `:|`.

**Acceptable info**
- `TEMPO_ROUNDED`.

**Pitfall to avoid**
- Don't put notes after `:|`. They'd be dropped with `CONTENT_AFTER_REPEAT`
  because Pico-8 loops forever once it hits the end-loop marker.
- If you only mark `:|` (no `|:`), the loop is implicitly the whole tune
  from the start.
