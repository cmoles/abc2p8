# abc2p8

Convert ABC notation to Pico-8 music format. Compose chiptune in plain text instead of fighting the tracker.

## Quick start

```sh
npm install
npm run convert tests/fixtures/abc/c-major-scale.abc -o scale.p8
```

The CLI reads ABC from a path (or `-` for stdin) and writes a `.p8` cart.
Diagnostics print to stderr; the process exits non-zero if any are
error-level. Pass `--play` to inject a `music(0)` stub so the cart auto-plays
when loaded into Pico-8.

Library use:

```ts
import { abcToPico8 } from 'abc2p8';
const { p8, diagnostics } = abcToPico8(abcSource);
```

## Drum voices

Mark any voice as a drum voice and its plain note letters trigger named
drum hits from a kit. Octave is ignored; the kit picks the per-hit
waveform / pitch / volume / effect, so swapping kits changes the tone
without rewriting notes.

| Letter | Drum |
|---|---|
| `c` | kick |
| `d` | snare |
| `e` | hat-closed |
| `f` | hat-open |
| `g` | tom-low |
| `a` | tom-mid |
| `b` | tom-high |

Mark via the ABC directive (1-based voice number, matching `V:1`):

```
%%pico8 drum 2
V:1
G2 E2 C2 D2|
V:2
c e d e c e d e|
```

…or via the API (`voices` indices are 0-based: `V:1` → `voices[0]`):

```ts
abcToPico8(abc, { voices: [{}, { drum: true, kit: 'noise' }] });
```

`'noise'` is the only built-in kit today (NES-classic noise hits).
Pass a custom `Kit` object (`Record<DrumName, { waveform, pitch, volume,
effect }>`) for anything else; spread `NOISE_KIT` to override one drum
at a time. Note durations apply normally — a half-note kick holds the
same SFX shape across both slots. Drum chords expand to sibling
channels (`[ce]` = simultaneous kick + hat = 2 channels), so they
count against the 4-channel budget like melodic chords. CLI flags:
`--drum-voice N` (0-based, repeatable) and `--kit noise`.

## Merging into an existing cart

```ts
import { abcToPico8, mergeIntoCart } from 'abc2p8';
const result = abcToPico8(abc);
const merged = mergeIntoCart(targetP8Text, result, {
  sfxOffset: 4,
  musicOffset: 2,
});
```

Or from the CLI: `npm run convert song.abc --merge target.p8 --sfx-at 4
--music-at 2 --out merged.p8`. The merge replaces the SFX/music rows in
the target's range and rebases music patterns to point at the new SFX
indices; every other section (Lua, sprites, map, …) is preserved
verbatim.

## Limitations

abc2p8 is built in vertical slices; each slice lifts a class of restrictions.
Slices 1–8 are shipped:

- **Up to 4 voices** (one per Pico-8 channel). `V:1`…`V:4` map to channels in
  declaration order; more than 4 errors with `TOO_MANY_VOICES`.
- **Chords are split onto sibling channels.** `[CEG]` borrows from the unused
  channel pool; the lowest pitch lands on the lowest channel. Chord arity plus
  voice count must total ≤ 4 channels — otherwise `CHORD_OVERFLOW` errors,
  unless `chordStrategy: 'arp'` (or auto-fallback) collapses the chord onto a
  single channel via Pico-8's arp effect.
- **Up to 64 SFX slots** (Pico-8 cart limit). Long tunes are chunked across slots; tunes that exceed the budget error with `SFX_BUDGET_EXCEEDED`.
- **Pitch range C2–D#7.** Notes outside the range are shifted by whole octaves where possible; otherwise `OUT_OF_RANGE` errors.
- **One repeat region per tune.** `|: … :|` becomes a Pico-8 begin/end-loop. Multiple regions warn and keep the first; content after `:|` is dropped.
- **Ornaments and grace notes are dropped** with `DECORATION_DROPPED` / `GRACE_NOTES_DROPPED` warnings.
- **Mid-tune tempo and meter changes are ignored.**
- **Per-voice instruments** via `voices: [{ instrument: 0..7 }]` opts, the
  `--instrument 0:2,1:5` CLI flag, or `%%pico8 instrument N W` directives in
  the ABC source. Unset voices fall back to `defaultInstrument`. Drum voices
  ignore this — the kit drives per-hit waveform.
- **Drum-voice accidentals warn** with `DRUM_HIT_UNKNOWN` (the v1 letter map
  covers the 7 plain letters only) and drop to a rest. `chordStrategy: 'arp'`
  doesn't apply to drum voices — chords always expand.

For the full list of diagnostic codes, severities, and what each one means,
see [docs/limits.md](docs/limits.md). The roadmap of upcoming slices lives
in [docs/ROADMAP.md](docs/ROADMAP.md).
