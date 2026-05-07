# LLM authoring failure modes

Catalogued during slice 10 (the AGENTS.md guide and the `examples/llm/`
recipes). This list is the target backlog for slice 11's inspector — each
entry below is something the converter currently lets through (or warns
about with insufficient context) where an LLM author would benefit from a
structured signal.

Sorted by signal-to-noise: the highest-payoff items are at the top.

## Already diagnosed; LLMs still hit them

These have stable codes today; the inspector should still surface them
with explanations / recovery hints rather than just printing the message.

1. **`CHORD_OVERFLOW` without arp hint.** LLMs default to expand semantics
   and don't know `chordStrategy: 'auto'` will rescue them. The error
   message already mentions arp; the inspector could pre-flight the
   channel sum and recommend strategy before conversion.
2. **`ARP_GRID_INFEASIBLE`.** Triggered when chord onsets/durations
   aren't 4-slot multiples. Very opaque: an LLM that wrote `[CEG]2` at
   `L:1/8` (= 2-slot duration) gets a quantize error with no clear
   actionable recovery beyond "use longer chord notes."
3. **`OUT_OF_RANGE_TRANSPOSED`.** An info, but it's the symptom of a
   musical mistake (writing bass notes too low). LLMs read the auto-shift
   as success, then are confused why their bass line sounds inverted.
   Consider promoting to warn, or surfacing in the inspector as
   "voice X has N notes shifted by ±M octaves."
4. **`VOICE_REPEAT_MISMATCH`.** Common — LLMs add `|: :|` to V1 and
   forget to mirror in V2/V3. Silent for V1 but confusing.
5. **`CONTENT_AFTER_REPEAT`.** LLMs author "outros" after `:|` expecting
   them to play once-after-loop. They're dropped.

## Not yet diagnosed; need new checks

These are the slice-11 inspector's net-new checks.

6. **Silent voice.** A voice that contains only rests (or rests + a single
   tied note) wastes a channel. Likely an LLM mistake where a voice's
   content was elided.
7. **Register clash.** Two or more voices spending most of their time in
   overlapping octaves (typically octaves 4–5). Audibly muddy. Inspector
   could flag voices whose pitch histograms overlap by >70%.
8. **Bass-too-high.** A voice authored as bass (lowest of the set) that
   sits in or above octave 4. Common when an LLM forgets to use `,`
   modifiers.
9. **Pitch clamped at range edges.** Notes at MIDI 36–37 (low end) or
   85–87 (high end) sound thin/dull on Pico-8. Worth flagging clusters
   of notes within 2 semitones of the edge.
10. **Monotonic rhythm.** Every note in a voice the same duration.
    Inspector can compute duration entropy per voice; very low entropy
    is a strong signal of unmusical output (especially for melody).
11. **Drums-only-on-downbeat.** A drum voice whose hits all land on
    integer beats (no offbeat hats, no syncopation). Strong sign of
    LLM stiffness.
12. **No rests.** A voice that never rests in a long tune — exhausting
    to listen to. Inspector flag if rest density < some threshold.
13. **Channel-budget near-miss.** Tune uses exactly 4 channels with no
    headroom. Adding any chord later will overflow. Inspector should
    advise "you have N channels free."
14. **Identical-instrument voices.** Two melodic voices with the same
    waveform sit on top of each other audibly. Inspector flag.
15. **Drum kit + melodic noise voice.** An LLM picking waveform 6 for a
    melodic voice while a drum voice uses the noise kit will mask the
    noise channel's drums.
16. **`L:` granularity mismatch.** A tune authored at `L:1/4` that has
    no notes shorter than a half — wastes budget. Or `L:1/16` where
    every note is `Cn` for n ≥ 4 — also wasteful. Inspector could
    suggest a more fitting `L:`.
17. **Tied chord with differing pitches.** ABC ties between `C-E` are
    treated as separate notes (no glide on Pico-8); LLMs sometimes write
    these expecting a portamento.

## Out-of-band (don't fit the inspector)

These are LLM-author mistakes the inspector can't easily catch but the
authoring guide should keep flagging.

- Mid-tune `K:` / `Q:` / `M:` changes — partially supported (key) or
  ignored (tempo, meter).
- `%%MIDI program N` — ignored; LLM should use `%%pico8 instrument`.
- ABC ornaments / grace notes — silently dropped (warned but easily
  missed).
- `chordStrategy: 'arp'` on drum voices — silently ignored (drum chords
  always expand). LLMs sometimes try to `--arp` a drum kit.

## Signal review

Before slice 11 implementation, sanity-check this list against:
- Real LLM-generated ABC fed through the pipeline (sample size N ≥ 30
  diverse prompts).
- The `examples/llm/` recipes — if any of these checks would fire on a
  recipe that's supposed to be clean, the heuristic is too aggressive.
- The diagnostic codes already in [docs/limits.md](limits.md) — avoid
  shipping an inspector finding that duplicates an existing code.
