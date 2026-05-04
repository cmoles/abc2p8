# Roadmap

Slices are vertical: each one delivers an end-to-end ABC → cart capability that
the audition CLI (`npm run convert`) can demonstrate. Slices remove guard-rail
errors currently raised by the pipeline; the rejected input from one slice is
the acceptance fixture of the next.

## Slice 1 — Monophonic, single SFX (shipped)

- Single voice, no chords, ≤32 notes (one SFX slot).
- Trivial `__music__` section pointing at slot 0.
- Audition CLI with `--play` stub.
- Guard rails enforced in `src/abc/toIR.ts` (multi-voice, chord) and
  `src/pico8/emit.ts` (single channel).

## Slice 2 — Long monophonic tunes (shipped)

- Quantizer chunks a single voice into ≤32-slot SFX blocks with forced
  boundaries at loop points.
- Emitter writes one SFX line per block and chains them via `__music__`
  patterns (channel 0 used, others silent).
- ABC repeat bars (`|:` `:|`, `::`) → Pico-8 begin/end-loop flags. Implicit
  `|:` at the start when only `:|` is present. Multiple repeat regions warn
  and keep the first; orphan `|:` warns and is dropped.
- Content after `:|` is dropped with `CONTENT_AFTER_REPEAT` (Pico-8 loop is
  indefinite).
- Slot budget is enforced: a tune needing more than 64 SFX slots errors with
  `SFX_BUDGET_EXCEEDED`.

## Slice 3 — Multi-voice polyphony (shipped)

- ABC `V:` voices → distinct Pico-8 channels (deterministic by voice order).
- Up to 4 voices accepted; >4 errors with `TOO_MANY_VOICES`.
- Quantizer picks one slot grid via GCD across all voices; voices share block
  boundaries (forced cuts at loop start/end). Shorter voices are padded with
  rests so all voices end on the same boundary.
- Each voice's blocks emit one SFX each, numbered sequentially
  (voice 0 first, then voice 1, …). Music pattern row N stacks
  `[v0.block[N], v1.block[N], …]` onto channels 0..N; unused channels are
  marked silent (`0x40 | channel`).
- SFX budget is per total: `voices × blocksPerVoice ≤ 64`.
- Voice 0's `|: ... :|` is authoritative; mismatched repeats in other voices
  emit `VOICE_REPEAT_MISMATCH`.

**Resolved decisions**
- Slot-grid picks the GCD across all voices (existing slice-2 behavior; no
  per-voice grid).
- Per-voice instrument assignment is deferred — all voices share the
  `defaultInstrument` option (waveform 0 / sine). ABC `%%MIDI program` hints
  are still ignored.

## Slice 4 — Chord support (shipped)

- ABC chords (`[CEG]`) expand into sibling voices in the IR — one sibling per
  pitch in the largest chord that voice contains. Sibling 0 carries the lowest
  pitch, sibling N-1 the highest.
- At positions where the chord has fewer notes than the voice's max arity,
  the upper siblings get rests; single notes within a chord-bearing voice land
  on sibling 0 with the rest silent.
- Each sibling becomes a normal `Voice` and is fed through quantize/emit
  unchanged — the channel layout falls out of voice ordering. A 2-voice tune
  with V1=`[CE]` and V2=`g` uses three channels (V1.A, V1.B, V2).
- Channel budget is enforced at toIR: sum of per-voice max chord arity must be
  ≤ 4, otherwise `CHORD_OVERFLOW` errors.
- Voicing priority deferred — when over-budget the converter errors rather
  than picking which notes to drop. Edit the ABC to fit.

### Slice 4.5 — Chord arp (shipped)

- `chordStrategy` option with three values: `'auto'` (default), `'expand'`,
  `'arp'`. Auto picks expand when per-voice chord arities sum to ≤ 4 channels
  and arp otherwise; the fallback emits `AUTO_ARP_FALLBACK` info so the user
  knows which path ran. Arp encodes each chord on a single channel using
  Pico-8's arp effect (6 fast / 7 slow), trading sibling channels for one
  shared SFX layout.
- Quantizer picks a slot grid where chord onsets and durations are multiples
  of 4 slots — Pico-8's arp aligns to absolute SFX positions 0–3, 4–7, …, so
  each chord owns one or more 4-slot groups. Constraint:
  `gcd(chord onsets ∪ chord durations) % 4 == 0`. Repeat boundaries are folded
  in too. `ARP_GRID_INFEASIBLE` if the grid would have to go below the
  32nd-note floor.
- Each slot in a chord 4-group is stamped with the SFX pitch at its position
  (chord pitches in arp order, padded by repeating the root to 4 notes). The
  emitter writes effect=6/7 on slots that are part of the chord; the per-slot
  pitch already encodes the right "arp position" pitch so the SFX layout is
  self-consistent.
- Chords with >4 pitches truncate to the lowest 4 with `CHORD_TOO_WIDE`.
- Channel budget in arp mode = number of source voices (1 chord-bearing voice
  uses 1 channel regardless of arity), so 3-voice tunes with triad comping
  (which would need 5 channels in expand mode) now fit.
- Wired into the audition CLI as `--arp` / `--arp-slow` (force arp; default
  is auto) and the web playground as a "Force arp on chords" toggle.

## Slice 5 — Web playground (shipped)

- Vite-built static site at `web/`, deploys to GitHub Pages from `main` via
  `.github/workflows/deploy-web.yml`.
- Textarea for ABC, diagnostics list, copy/download `.p8` buttons.
- Playback uses Pico-8's official HTML export (Pico-8 0.2.6, all-JS, no
  WASM). At convert time we fetch the committed `runtime/shell.html` +
  `runtime/shell.js`, rewrite the cart bytes inside `_cartdat` to splice in
  the user's `__sfx__` and `__music__`, and load the patched runtime in an
  iframe via `srcdoc`. Lua code stays untouched.
- Cart byte layout (verified empirically during the spike): SFX slot is
  `[notes(64) | header(4)]` (notes first, header at slot end). Music
  channel byte in ROM is the same as in text format with the appropriate
  flag bit OR'd into bit 7.

## Slice 6 — Per-voice instrument selection (shipped)

- Each voice gets its own Pico-8 waveform (0–7) instead of every voice
  sharing `defaultInstrument`. Specified in `abcToPico8` opts as
  `voices: [{ instrument: 2 }, ...]`; entries left unset fall back to
  `defaultInstrument` (which itself defaults to 0 / sine).
- ABC custom directive `%%pico8 instrument <voiceNumber> <waveform>` is
  honored as input (1-based voice numbers matching `V:1`, `V:2`, …; the
  directive is stripped before abcjs parses). Standard `%%MIDI program N`
  continues to emit `MIDI_DIRECTIVE_IGNORED` — the GM→Pico-8 mapping is
  too lossy to be a default, so users opt into the custom directive when
  they care. `voices[i].instrument` wins over the directive.
- IR carries `instrument` on the `Voice`. Quantize is unchanged. Emitter
  stamps the per-voice waveform on every slot in that voice's SFX blocks.
  Chord-expand siblings inherit their parent voice's instrument; arp mode
  is single-channel, so the chord plays on one waveform too.
- CLI: `--instrument 0:2,1:5` (voice-index : waveform pairs, 0-based).
  Playground: one waveform dropdown per detected voice, rendered after
  conversion and persisted across re-converts within the session.
- New diagnostics: `INSTRUMENT_OUT_OF_RANGE` (waveform outside 0–7) and
  `INSTRUMENT_DIRECTIVE_INVALID` (malformed `%%pico8 instrument` line).

**Resolved decisions**
- Per-note instrument overrides (varying waveform within a voice) are out
  of scope. The IR keeps `instrument` at the `Voice` level; per-slot
  waveform is a future extension if a real use case shows up.
- Drum/percussion mapping (Pico-8 noise / waveform 6) reuses the same
  plumbing — users can pick waveform 6 manually for now. A real "drum
  voice" with pitch→drum-hit mapping is still deferred.

## Slice 7 — Merge into existing cart

**Goal:** drop the converted music into a user's existing `.p8` file at
specified offsets, leaving Lua/sprites/map/everything else untouched.
Replaces the never-shipped jukebox slice — same underlying itch (carry
the music forward into a real game), much smaller surface.

- New `mergeIntoCart(existingP8: string, result: ConvertResult, opts:
  { sfxOffset: number, musicOffset: number }): string` in `src/index.ts`.
  Parses the target `.p8` text into named sections, replaces SFX rows
  `[sfxOffset .. sfxOffset+N-1]` and music rows
  `[musicOffset .. musicOffset+M-1]`, preserves all other sections
  verbatim, re-stitches.
- Music patterns inside the merged result are rebased to point at the
  new SFX indices. Promote `rebaseMusicLine` from
  `scripts/build-sandbox-cart.ts:70-84` into a shared
  `src/pico8/rebase.ts` so both the audition path and the merge path
  use one implementation.
- Empty rows in the target stay empty unless overlapped by the merge
  range. Sections absent from the target (e.g. no `__music__`) are added
  with leading empty rows up to the merge offset.
- CLI: `npm run convert song.abc --merge path/to/target.p8 --sfx-at N
  --music-at M --out merged.p8`. Without `--merge` the existing single-
  cart output is unchanged.
- Playground: a "Merge into cart" panel with a file-picker for the target
  `.p8`, two number inputs for offsets, "Build & download" button. The
  in-iframe Pico-8 player keeps previewing the standalone convert (the
  point is to download the merged cart, not run someone's full game in
  the playground).
- New diagnostics:
  - `MERGE_OFFSET_INVALID` (error) — offset + length > 64, or negative.
  - `MERGE_OVERWRITES` (warn) — target had non-empty rows in the merge
    range; lists the overwritten indices.
  - `MERGE_TARGET_INVALID` (error) — `.p8` couldn't be parsed (missing
    `pico-8 cartridge` header, malformed section markers).

**Resolved decisions**
- Explicit offsets, not auto-find-free-slots. "Empty" is fuzzy (a row of
  all-zero SFX bytes is technically a valid silent slot, not unused) and
  explicit offsets keep behavior predictable. An `--auto` mode can be
  added later once we know what users actually want.
- Text-level cart manipulation, not byte-level ROM patching. The slice-5
  byte splicer is fine for the runtime shell where the source is known
  fixed bytes; merging into arbitrary user carts means dealing with
  optional sections, comment lines, and Pico-8 text-format quirks —
  string parsing is the right granularity.
- One target-cart format: standard `.p8` text. PNG carts (`.p8.png`) are
  out of scope; users can export `.p8` from Pico-8 first.

## Not yet scoped

- Drum/percussion mapping (Pico-8 noise waveform 6 as a real drum voice).
- Per-note instrument changes within a voice.
- Effects beyond the basics already in IR (`src/ir/types.ts`).
- ABC ornaments (trills, grace notes) — currently silently dropped.
- Reverse direction (Pico-8 cart → ABC).
- PNG cart format (`.p8.png`) input/output.
- Multi-track jukebox cart (bundle N tunes + Lua picker into one cart).
  Was drafted as the original slice 6; superseded by slice 7's merge
  flow, which lets users assemble jukeboxes themselves in their own
  carts. Spec lives in git history if we want to revive it.
