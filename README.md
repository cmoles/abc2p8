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

## Limitations

abc2p8 is built in vertical slices; each slice lifts a class of restrictions.
The current shipped slice (slice 2) supports:

- **One voice per tune.** `V:1` `V:2` …  errors with `MULTI_VOICE_UNSUPPORTED`. Slice 3 will lift this.
- **No chords within a voice.** `[CEG]` errors with `CHORD_UNSUPPORTED`. Slice 4 will lift this.
- **Up to 64 SFX slots** (Pico-8 cart limit). Long tunes are chunked across slots; tunes that exceed the budget error with `SFX_BUDGET_EXCEEDED`.
- **Pitch range C2–D#7.** Notes outside the range are shifted by whole octaves where possible; otherwise `OUT_OF_RANGE` errors.
- **One repeat region per tune.** `|: … :|` becomes a Pico-8 begin/end-loop. Multiple regions warn and keep the first; content after `:|` is dropped.
- **Ornaments and grace notes are dropped** with `DECORATION_DROPPED` / `GRACE_NOTES_DROPPED` warnings.
- **Mid-tune tempo and meter changes are ignored.**

For the full list of diagnostic codes, severities, and what each one means,
see [docs/limits.md](docs/limits.md). The roadmap of upcoming slices lives
in [docs/ROADMAP.md](docs/ROADMAP.md).
