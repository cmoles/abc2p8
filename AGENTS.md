# AGENTS.md — authoring ABC for abc2p8

You're an LLM (or a human pretending to be one) writing ABC notation that will
be lowered onto Pico-8's tracker by this repo's `abcToPico8` pipeline. ABC was
designed for sheet music; Pico-8 is a 4-channel chiptune engine with hard
quantization. Lots of ABC features survive the trip; some don't. This file
tells you which is which, and how to write ABC that converts cleanly the
first time.

If you only read one section: [Authoring rules](#authoring-rules).

## What the pipeline does

```
abc text
  → abcjs parse
  → toIR (Score: voices, notes, repeats)        src/abc/toIR.ts
  → quantize (slot grid, blocks, loop)           src/pipeline/quantize.ts
  → emit (.p8 SFX + music sections)              src/pico8/emit.ts
```

Single entry point: `abcToPico8(abc, opts) → { p8, diagnostics }`. Diagnostics
have `severity` (`info`/`warn`/`error`) and a stable `code`. Errors mean no
cart was written; warns mean audible content was dropped or altered; infos
are non-audible bookkeeping. Full code list:
[docs/limits.md](docs/limits.md). Hard limits:
[docs/limits.md#hard-limits-currently](docs/limits.md#hard-limits-currently).

## Hard limits — the four numbers to remember

| Constraint | Value |
|---|---|
| Voices | ≤ 4 (one per Pico-8 channel) |
| Channels for chords + voices | ≤ 4 total (in expand mode) |
| SFX slots | ≤ 64 (`voices × blocksPerVoice`) |
| Pitch range | C2–D#7 (Pico-8 editor) / MIDI 36–87 |

Plus: 8 waveforms (0–7), one repeat region per tune, slot grid between 32nd
and quarter note. Tempo (Pico-8 SFX speed) is one integer per slot, clamped
to `[1, 255]`.

## Authoring rules

### Header

Always include in this order:

```
X:1
T:<title>
M:<meter>             (e.g. 4/4)
L:<note unit>         (e.g. 1/8 — every plain letter is this duration)
Q:<unit>=<bpm>        (e.g. 1/4=120 — without it, defaults to 120 with NO_TEMPO)
K:<key>               (e.g. C, Dm, Bb)
```

Then voice declarations (`V:1`, `V:2`, …) and the note content. ABC is whitespace-
sensitive between header lines but not within bars.

### Voices

- Use `V:1` … `V:4`. Declaration order = Pico-8 channel order.
- `V:n` per line, then notes. For polyphony you can also use `[V:n]…` inline.
- More than 4 voices → `TOO_MANY_VOICES` (error).
- Per-voice instrument: `%%pico8 instrument <voiceNumber> <waveform>` in the
  header (1-based voice number, waveform 0–7). Or pass
  `voices: [{ instrument: 2 }, …]` to `abcToPico8`. Standard `%%MIDI program`
  is ignored — too lossy to map cleanly.

### Pitches

ABC pitch letters are familiar but octave-encoded:

```
C, D, E, F, G, A, B,    → octave 3 (low)
C  D  E  F  G  A  B     → octave 4 (middle C = C4)
c  d  e  f  g  a  b     → octave 5
c' d' e' f' g' a' b'    → octave 6
```

`,` lowers an octave, `'` raises one. Accidentals: `^c` (sharp), `_e` (flat),
`=f` (natural), persist within the bar, reset on barline. Key signature
accidentals apply automatically.

Pico-8 only plays C2–D#7 (MIDI 36–87, exclusive). Notes outside that range
are octave-shifted up to ±3 octaves to fit (`OUT_OF_RANGE_TRANSPOSED` info);
if no shift fits, the conversion errors with `OUT_OF_RANGE`. **Don't rely on
the auto-shift** — it will move bass notes into the middle register and
break voicing. Write pitches that are already in range.

### Durations and rhythm

`L:1/8` makes plain letters eighth notes. Multipliers are explicit:

```
C    eighth (= L)
C2   quarter (2 × eighth)
C/2  sixteenth
C/4  thirty-second (the floor)
C3/2 dotted eighth
C/   shorthand for C/2
```

Rests use `z` with the same multipliers (`z2`, `z/2`).

The quantizer picks one slot grid for the whole tune — the GCD of all note
durations, clamped to `[32nd, quarter]`. Mixing very short and very long
notes wastes slots. Stick to a small set of duration multiples (e.g.
quarters and eighths) and avoid dotted thirty-seconds unless you mean it.

### Chords

Two strategies, picked by `chordStrategy`:

- **`'expand'` (default when it fits):** each chord pitch becomes its own
  channel. `[CEG]` plus a bass `V:2` = 4 channels (3 chord siblings + 1
  bass). Sum of (per-voice max chord arity) must be ≤ 4 — otherwise
  `CHORD_OVERFLOW`.
- **`'arp'`:** chord plays on one channel using Pico-8's arp effect, which
  cycles through 4 SFX-slot pitches per group. Works for chords up to 4
  pitches; >4 truncates to lowest 4 with `CHORD_TOO_WIDE`.
- **`'auto'` (default):** expand if total channels ≤ 4, else arp
  (`AUTO_ARP_FALLBACK` info).

**Arp grid constraint:** chord onsets and durations must be multiples of 4
slots. The slot grid's GCD with `chord_onsets ∪ chord_durations` has to be
divisible by 4 — otherwise `ARP_GRID_INFEASIBLE` (error). In practice: chord
chunks should land on quarter-note boundaries with quarter-note (or longer)
durations when you're working at `L:1/4`, or every 4th eighth at `L:1/8`.
Repeat boundaries also have to land on a 4-slot grid in arp mode.

### Repeats

```
|: ... :|       loop begin / end
::              both in one bar
|:CDEF GABc:|   whole tune repeats
CDEF|:GABc:|    intro then loop
```

- One region per tune. `MULTIPLE_REPEATS` warns and keeps the first.
- `:|` without a `|:` implies `|:` at the start.
- Content after `:|` is dropped (`CONTENT_AFTER_REPEAT`) — Pico-8 loops
  forever, so trailing notes would never play.
- `V:1`'s repeat is authoritative. Other voices that disagree get
  `VOICE_REPEAT_MISMATCH`.

### Drum voices

Mark a voice as a drum voice and plain letters trigger named drum hits:

| Letter | Drum |
|---|---|
| `c` | kick |
| `d` | snare |
| `e` | hat-closed |
| `f` | hat-open |
| `g` | tom-low |
| `a` | tom-mid |
| `b` | tom-high |

Octave is ignored — the letter picks the drum, the kit picks the sound.
Accidentals (`^c`, `_e`, …) → `DRUM_HIT_UNKNOWN` and drop to a rest.
Key signature is also ignored on drum voices.

Mark via directive (1-based voice number):

```
%%pico8 drum 2
V:1
G2 E2 C2 D2|
V:2
c e d e c e d e|
```

…or via API (0-based): `voices: [{}, { drum: true, kit: 'noise' }]`.

Built-in kits: `'noise'` (NES-classic), `'hybrid'` (triangle kick/toms +
noise snare/hats), `'tonal'` (all pitched, no noise channel). Custom kits
are `Record<DrumName, { waveform, pitch, volume, effect }>`.

Note durations apply normally — `c2` holds the kick across two slots. Drum
chords (`[ce]` = simultaneous kick + hat) expand to sibling channels and
count against the 4-channel budget. `chordStrategy: 'arp'` doesn't apply
to drum voices — arpeggiating a kick+hat is musically wrong.

### Common pitfalls

| Symptom | Code | Fix |
|---|---|---|
| Tune has too many simultaneous notes | `CHORD_OVERFLOW` | Reduce chord arity or voice count, or set `chordStrategy: 'arp'` |
| Arp chord won't quantize | `ARP_GRID_INFEASIBLE` | Align chord onsets/durations to multiples of 4 slots; use coarser `L:` |
| Tune too long | `SFX_BUDGET_EXCEEDED` | Shorter tune, fewer voices, or use a repeat to halve content |
| Bass note inaudible / wrong octave | `OUT_OF_RANGE_TRANSPOSED` | Raise the source octave so it lands inside C2–D#7 |
| Drum hit silent | `DRUM_HIT_UNKNOWN` | Use plain `c`/`d`/`e`/`f`/`g`/`a`/`b` — no accidentals |
| Wrong voice's repeat used | `VOICE_REPEAT_MISMATCH` | Mirror V1's `\|: … :\|` in every voice (or just rely on V1) |
| Ornaments missing | `DECORATION_DROPPED`, `GRACE_NOTES_DROPPED` | They're stripped; don't author ornaments expecting playback |
| Mid-tune tempo/meter ignored | `TEMPO_CHANGE_IGNORED`, `METER_CHANGE_IGNORED` | Pico-8 has one speed per SFX slot. Pick one tempo. |

### What's silently dropped

- Voice overlays (`&` syntax) — `OVERLAY_IGNORED` warn.
- `%%transpose` directives — `TRANSPOSE_IGNORED` warn.
- `P:` part markers — `PART_DIRECTIVE_IGNORED` info.
- `clef=` — Pico-8 has no clef concept. No diagnostic.
- ABC ties between different pitches — treated as separate notes.

## Recipe library

End-to-end ABC + expected `.p8` pairs live in [examples/llm/](examples/llm/),
one per use case. Each recipe has a README explaining what it demonstrates
and the diagnostics it should *not* produce. Use them as starting points.

## API surface

```ts
import { abcToPico8, mergeIntoCart, BUILT_IN_KITS } from 'abc2p8';

const result = abcToPico8(abcSource, {
  defaultInstrument: 0,                  // waveform 0–7, fallback for unset voices
  defaultVolume: 5,                      // 0–7
  chordStrategy: 'auto',                 // 'auto' | 'expand' | 'arp'
  arpSpeed: 'fast',                      // 'fast' (effect 6) | 'slow' (effect 7)
  voices: [                              // 0-based, indexed by source ABC voice
    { instrument: 2 },
    { drum: true, kit: 'noise' },
  ],
});
// result.p8: cart text, '' on error
// result.diagnostics: readonly Diagnostic[]

const merged = mergeIntoCart(existingCartText, result, {
  sfxOffset: 4,                          // 0-based row in target __sfx__
  musicOffset: 2,                        // 0-based row in target __music__
});
```

CLI: `npm run convert <input.abc> -o <out.p8>`. Flags:
`--play` (auto-play stub), `--arp` / `--arp-slow` (force arp),
`--instrument 0:2,1:5` (per-voice waveforms),
`--drum-voice N` (repeatable), `--kit noise|hybrid|tonal`,
`--merge target.p8 --sfx-at N --music-at M`.

## Reverse direction: `.p8` → ABC

```ts
import { pico8ToAbc } from 'abc2p8';

const { abc, diagnostics, arpSpeed } = pico8ToAbc(cartText, { title: 'mytune' });
```

CLI: `npm run reverse <input.p8> -o <output.abc>`. Reads a `.p8` cart and
emits ABC that re-converts cleanly through `abcToPico8`. The six shipped
`examples/llm/` carts round-trip bit-perfectly. Drum voices are detected
by matching slot tuples against the built-in kits; chord-arp groups are
collapsed into ABC chord notation (`[CEG]`). `arpSpeed` in the result is
`'slow'` when the cart uses effect 7 — pass `--arp-slow` to `convert` to
preserve it on the round-trip. Non-default kits emit a `% pico8 kit V N`
comment so the user knows which `--kit` flag to use.

Diagnostics: `REVERSE_TARGET_INVALID` (error), `REVERSE_UNKNOWN_EFFECT`
(warn, slide/vibrato/drop), `REVERSE_FEATURE_DROPPED` (warn, e.g. mixed
waveforms within a melodic voice), `REVERSE_NONSTANDARD_DRUM` (info,
drum-like voice that didn't match a built-in kit), `REVERSE_AMBIGUOUS_SFX`
(info, same SFX index referenced from multiple channels).

## Inspecting before you ship

LLMs can't hear the cart, so use the inspector to evaluate output programmatically.
`inspect(abcSource, opts)` returns the same compile diagnostics plus
**structural facts** (per-voice pitch range, note count, rest density, slot grid,
chord-onset count, channel usage, loop boundaries, drum-hit histogram) and
**findings** — algorithmic warnings drawn from the failure-mode catalogue at
[docs/llm-failure-modes.md](docs/llm-failure-modes.md):

| Code | Fires when | Why it matters |
|---|---|---|
| `SILENT_VOICE` | voice has zero onsets | wasted channel |
| `REGISTER_CLASH` | two melodic voices' pitch ranges overlap by >70% | audibly muddy |
| `NO_RESTS` | rest fraction <5% across ≥32 slots (melodic only) | exhausting to listen to |
| `MONOTONIC_RHYTHM` | duration entropy <0.5 bits and ≥8 notes (melodic only) | rhythmic stiffness |
| `PITCH_AT_RANGE_EDGE` | a voice touches Pico-8 pitch 0–1 or 62–63 | thin/dull tone |
| `DRUMS_ON_DOWNBEAT` | every drum onset lands on a beat (no offbeats) | mechanical groove |
| `CHANNEL_BUDGET_TIGHT` | all 4 channels used (no room for chords later) | future overflow risk |

CLI: `npm run inspect <input.abc>` prints a human-readable report plus an ASCII
piano-roll. `--json` for the raw `InspectionResult`; `--max-slots N` to truncate
the roll. The inspector accepts the same convert flags (`--arp`, `--instrument`,
`--drum-voice`, `--kit`), so the facts reflect the exact cart your convert call
would produce.

Piano-roll legend: `|` onset, `=` sustain, `.` rest; drum voices show one letter
per hit (`k`/`s`/`h`/`o`/`l`/`m`/`H` for kick/snare/hat-c/hat-o/tom-l/tom-m/tom-H,
`?` for an unmapped hit).

The inspector lints — it never fixes. Treat findings as prompts to revise the
ABC, not as compile errors.

## When in doubt

1. Run `npm run convert <abc-file>` and read the diagnostics on stderr.
2. Run `npm run inspect <abc-file>` to see structural facts and findings.
3. Cross-reference codes against [docs/limits.md](docs/limits.md).
4. Look at the closest [examples/llm/](examples/llm/) recipe.
5. Pico-8's tracker model is in [docs/pico8-format.md](docs/pico8-format.md).
