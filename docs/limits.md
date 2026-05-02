# Limits and diagnostics

abc2p8 lowers ABC notation onto Pico-8's tracker model, which is much more
restrictive than ABC. When the converter has to drop, snap, or refuse input,
it emits a `Diagnostic` with a stable `code`. This page is the contract: every
code, when it fires, and what you can do about it. The CLI (`npm run convert`)
prints these to stderr; library users get them on `result.diagnostics`.

Severity levels:

- `error` — conversion failed, no cart was written.
- `warn` — conversion succeeded but audible content was dropped or altered.
- `info` — non-audible adjustment, or a side-effect worth knowing about.

`--quiet` on the CLI suppresses `info` only.

## Hard limits (currently)

| Capability | Limit |
|---|---|
| Voices | up to 4 (one per pico-8 channel) |
| Chords | not supported within a voice (slice 4) |
| SFX slots | 64 total, 32 notes per slot |
| Pitch range | C2–D#7 in Pico-8 editor notation (MIDI 36–87) |
| Quantize grid | finest 32nd note, coarsest quarter note |
| Repeat regions | one `\|: … :\|` per tune |
| Pico-8 SFX speed | clamped to [1, 255] |

Anything beyond these surfaces as one of the codes below.

## Diagnostics by stage

### parse

| Code | Severity | When it fires |
|---|---|---|
| `EMPTY_INPUT` | error | abcjs parsed nothing; no `X:` header or no playable content. |
| `MULTIPLE_TUNES` | warn | Input contains more than one `X:` block; only the first is converted. |

### toIR (`src/abc/toIR.ts`)

| Code | Severity | When it fires |
|---|---|---|
| `NO_STAFF` | error | Tune parsed but has no staff content. |
| `NO_VOICES` | error | Staff has no voice content. |
| `TOO_MANY_VOICES` | error | Tune declares more than 4 `V:` voices; pico-8 has only 4 channels. |
| `VOICE_REPEAT_MISMATCH` | warn | A non-V1 voice has different `\|: … :\|` bounds than V1; V1's bounds are used. |
| `CHORD_UNSUPPORTED` | error | A chord (`[CEG]`) was found in monophonic mode. Lifts in slice 4. |
| `OVERLAY_IGNORED` | warn | Voice overlay (`&` syntax) dropped — overlaid notes will not be heard. |
| `TRANSPOSE_IGNORED` | warn | `%%transpose` directive ignored; pitches not shifted. |
| `DECORATION_DROPPED` | warn | A note carried decorations (trill, fermata, accent, etc.); the note plays without them. |
| `GRACE_NOTES_DROPPED` | warn | Grace notes attached to a main note are dropped. |
| `MULTIPLE_REPEATS` | warn | Tune contains more than one `\|: … :\|` region; only the first is preserved. |
| `INCOMPLETE_REPEAT` | warn | A `\|:` was found with no matching `:\|`; repeat dropped. |
| `EMPTY_REPEAT` | warn | Repeat region collapses to zero ticks. |
| `DROPPED_ITEM` | warn | An unrecognized abcjs voice item was dropped. |
| `KEY_CHANGE` | info | Mid-tune `K:` change applied. |
| `METER_CHANGE_IGNORED` | info | Mid-tune meter change ignored; pico-8 has no meter concept. |
| `TEMPO_CHANGE_IGNORED` | info | Mid-tune tempo change ignored; SFX speed is set once per slot. |
| `GAP_IGNORED` | info | Voice gap (visual spacing) ignored. |
| `MIDI_DIRECTIVE_IGNORED` | info | `%%MIDI` directive ignored; instrument selection isn't wired through yet. |
| `PART_DIRECTIVE_IGNORED` | info | `P:` part marker ignored; abc2p8 doesn't yet expand part orderings. |
| `SCALE_DIRECTIVE_IGNORED` | info | Scale directive ignored (visual only). |
| `STEM_DIRECTIVE_IGNORED` | info | Stem directive ignored (visual only). |
| `STYLE_DIRECTIVE_IGNORED` | info | Style directive ignored (visual only). |
| `ZERO_DURATION` | info | A voice item had zero duration and was skipped. |
| `EMPTY_NOTE` | info | A note item arrived with no pitches. |
| `NO_TEMPO` | info | No `Q:` tempo specified; defaulted to 120 BPM. |

### quantize (`src/pipeline/quantize.ts`)

| Code | Severity | When it fires |
|---|---|---|
| `EMPTY_SCORE` | error | All voices quantized to zero blocks. |
| `SFX_BUDGET_EXCEEDED` | error | Tune needs more than 64 SFX slots. |
| `CONTENT_AFTER_REPEAT` | warn | Notes after `:\|` are dropped; pico-8 loops indefinitely so they would never play. |
| `SPEED_CLAMPED` | warn | Computed pico-8 speed fell outside [1, 255] and was clamped. |
| `LOOP_ALIGNMENT` | warn | Repeat region couldn't be aligned to SFX block boundaries; loop dropped. |
| `EMPTY_REPEAT` | warn | Repeat region quantized to zero slots. |
| `SLOT_RAISED` | info | Note duration GCD finer than a 32nd note; slot grid raised. |
| `TEMPO_ROUNDED` | info | Pico-8 speed is integer; rounded from the computed value. |
| `NOTE_TOO_SHORT` | info | A note quantized to less than one slot; snapped to one slot. |
| `NOTE_SNAPPED` | info | A note start or duration didn't align with the slot grid; snapped. |

### emit (`src/pico8/emit.ts`)

| Code | Severity | When it fires |
|---|---|---|
| `OUT_OF_RANGE` | error | A note is outside C2–D#7 and ±3 octaves of shifting can't bring it in. |
| `OUT_OF_RANGE_TRANSPOSED` | info | A note was octave-shifted to fit within Pico-8's pitch range. |

## Silently handled (no diagnostic, by design)

- `clef` voice items — Pico-8 has no concept of clef.
- Tied notes that abcjs reports as a tie but where pitches differ — treated
  as separate notes. abcjs normalizes most of these already.
- Trailing silent slots within an SFX block — truncated via `loop_start`
  rather than padded with rests.

## When to update this file

Each slice that lifts a hard limit or adds a new diagnostic must update both
the relevant table and, if applicable, the "Hard limits" section.
