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
| Chords | supported; chord arity + voice count ≤ 4 channels total |
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
| `REVERSE_TARGET_INVALID` | error | `pico8ToAbc` got a string that's missing the `pico-8 cartridge` header, has malformed `__sfx__` / `__music__` sections, or has no non-silent music rows. |
| `REVERSE_SECTION_OUT_OF_RANGE` | warn | `pico8ToAbc(p8, { section })` was passed a section index outside `[0, sections.length)`; fell back to section 0. |
| `REVERSE_FEATURE_DROPPED` | warn | Cart uses SFX features the forward path doesn't author (e.g. mixed waveforms within a single voice, out-of-range SFX byte fields, multiple SFX speeds, music rows referencing a missing SFX slot). Surface and preserve where possible; round-trip will lose them. |
| `REVERSE_UNKNOWN_EFFECT` | warn | Cart uses an SFX effect outside `{0, 4, 5, 6, 7}` (i.e. slide / vibrato / drop). The forward path won't re-emit it; the IR carries it but the round-trip drops the effect. |
| `REVERSE_MULTI_SECTION` | info | Cart exposes multiple `music(N)` tracks; the decode picked one. `result.sections` enumerates the rest; pass `section: N` to decode another. |
| `REVERSE_NONSTANDARD_DRUM` | info | A voice was noise-dominant (looks drum-like) but its slot tuples didn't match any built-in kit; emitted as melodic instead of with `%%pico8 drum`. |
| `REVERSE_AMBIGUOUS_SFX` | info | One SFX index is referenced from more than one channel across the music sequence; the first channel binding wins. |

### toIR (`src/abc/toIR.ts`)

| Code | Severity | When it fires |
|---|---|---|
| `NO_STAFF` | error | Tune parsed but has no staff content. |
| `NO_VOICES` | error | Staff has no voice content. |
| `TOO_MANY_VOICES` | error | Tune declares more than 4 `V:` voices; pico-8 has only 4 channels. |
| `VOICE_REPEAT_MISMATCH` | warn | A non-V1 voice has different `\|: … :\|` bounds than V1; V1's bounds are used. |
| `CHORD_OVERFLOW` | error | Chord arity plus voice count exceeds 4 channels. Reduce chord size or drop a voice. |
| `OVERLAY_IGNORED` | warn | Voice overlay (`&` syntax) dropped — overlaid notes will not be heard. |
| `TRANSPOSE_IGNORED` | warn | `%%transpose` directive ignored; pitches not shifted. |
| `DECORATION_DROPPED` | warn | A note carried decorations (trill, fermata, accent, etc.); the note plays without them. |
| `GRACE_NOTES_DROPPED` | warn | Grace notes attached to a main note are dropped. |
| `MULTIPLE_REPEATS` | warn | Tune contains more than one `\|: … :\|` region; only the first is preserved. |
| `INCOMPLETE_REPEAT` | warn | A `\|:` was found with no matching `:\|`; repeat dropped. |
| `EMPTY_REPEAT` | warn | Repeat region collapses to zero ticks. |
| `DROPPED_ITEM` | warn | An unrecognized abcjs voice item was dropped. |
| `INSTRUMENT_OUT_OF_RANGE` | error | A per-voice instrument waveform was outside `[0, 7]` (set via `voices[i].instrument` or `%%pico8 instrument`). |
| `INSTRUMENT_DIRECTIVE_INVALID` | error | A `%%pico8 instrument` directive was malformed (expected `<voiceNumber> <waveform>`). |
| `DRUM_DIRECTIVE_INVALID` | error | A `%%pico8 drum` directive was malformed (expected `<voiceNumber>` with a positive integer). |
| `DRUM_KIT_INVALID` | error | `voices[i].kit` was an unknown built-in name, or a custom `Kit` was missing entries / had out-of-range fields. |
| `DRUM_HIT_UNKNOWN` | warn | A drum-voice note carried an accidental (`^c`, `_e`, …); the v1 letter map covers the 7 plain letters only, so the hit dropped to a rest. |
| `CHORD_TOO_WIDE` | warn | An arp chord has more than 4 distinct pitches; truncated to the lowest 4. |
| `AUTO_ARP_FALLBACK` | info | `chordStrategy: 'auto'` would have needed more than 4 channels in expand mode, so the converter picked arp instead. |
| `PICO8_DIRECTIVE_UNKNOWN` | error | A `%%pico8 …` line used a sub-keyword other than `instrument` or `drum`. |
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
| `ARP_GRID_INFEASIBLE` | error | Arp chord onsets/durations don't share a 4-slot-aligned grid (or the grid would go finer than a 32nd note). Adjust note placements or chord durations. |
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
| `NO_VOICES` | error | Quantized score has no voices to emit. |
| `CHANNEL_OVERFLOW` | error | The quantized score has more than 4 voices. Upstream stages should catch this; if it fires the IR was constructed inconsistently. |
| `VOICE_BLOCK_MISMATCH` | error | Voices have different block counts after quantize. Internal invariant violation. |
| `OUT_OF_RANGE` | error | A note is outside C2–D#7 and ±3 octaves of shifting can't bring it in. |
| `OUT_OF_RANGE_TRANSPOSED` | info | A note was octave-shifted to fit within Pico-8's pitch range. |
| `MERGE_OFFSET_INVALID` | error | `mergeIntoCart` was called with a negative offset, or `offset + rows > 64`. |
| `MERGE_OVERWRITES` | warn | The merge range overlapped non-empty rows in the target cart; lists the indices. |
| `MERGE_TARGET_INVALID` | error | The target `.p8` was missing the `pico-8 cartridge` header or had duplicate section markers. |

## Silently handled (no diagnostic, by design)

- `clef` voice items — Pico-8 has no concept of clef.
- Tied notes that abcjs reports as a tie but where pitches differ — treated
  as separate notes. abcjs normalizes most of these already.
- Trailing silent slots within an SFX block — truncated via `loop_start`
  rather than padded with rests.
- Drum voices ignore octave (the letter is what picks the drum), the
  `K:` key signature (no transposition for percussion), the voice-level
  `instrument` setting (the kit drives per-hit waveform), and
  `chordStrategy: 'arp'` (drum chords always expand to sibling channels).

## When to update this file

Each slice that lifts a hard limit or adds a new diagnostic must update both
the relevant table and, if applicable, the "Hard limits" section.
