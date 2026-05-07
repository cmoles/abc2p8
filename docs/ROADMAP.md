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

## Slice 7 — Merge into existing cart (shipped)

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

## Slice 8 — Drum voice with kit framework (shipped)

Adds a drum/percussion primitive so LLMs (and humans) can write rhythm
tracks naturally without hand-picking noise pitches and hoping they
sound drum-like. Closes the biggest perceptual gap for "finished-
sounding" tunes — chiptunes need drums to land.

- A voice can be marked as a *drum voice*, which intentionally lifts
  slice 6's per-voice instrument rule: each note carries its own
  (waveform, pitch, volume, effect) tuple from the active kit instead
  of a uniform waveform. The IR gains a discriminator on `Voice`
  (`kind: 'melodic' | 'drum'`).
- Marked via ABC directive `%%pico8 drum <voiceNumber>` (1-based,
  matches slice 6's `%%pico8 instrument` style) or via API as
  `voices: [{ drum: true, kit: 'noise' }]`.
- ABC notation: in a drum voice, plain note letters trigger named drum
  hits via a fixed letter→drum-name map (octave ignored in v1):
  - `c` → kick
  - `d` → snare
  - `e` → hat-closed
  - `f` → hat-open
  - `g` → tom-low
  - `a` → tom-mid
  - `b` → tom-high

  Note durations apply normally (a half-note kick holds the kick hit's
  SFX shape for that duration). Rests work as in melodic voices.
  Accidentals outside the map emit `DRUM_HIT_UNKNOWN` (warn) and drop
  to a rest.
- Kits are data: `Kit = Record<DrumName, { waveform: 0..7, pitch: 0..63,
  volume: 0..7, effect: 0..7 }>`. Users pass custom kits via API
  (`{ drum: true, kit: customKitObject }`) or by built-in name
  (`kit: 'noise'`). Built-ins are exported from `src/pico8/kits.ts` so
  callers can spread+override.
- Default built-in kit `'noise'`: all hits use waveform 6 (noise) at
  calibrated pitches with fade-out effects. Simplest to validate;
  NES-classic tone. Named-preset kits (`'hybrid'`, `'tonal'`, etc.)
  deferred — ship the framework and one default, add presets once real
  LLM output tells us which sounds carry.
- Quantize/emit: drum voice flows through the existing pipeline. Each
  hit stamps its kit tuple onto the corresponding SFX slots; sustained
  notes hold the same hit shape across slots.
- Channel budget: a drum voice counts as one channel like any other.
  Drum chords (`[ce]` = simultaneous kick + hat) expand into sibling
  voices the same way melodic chords do, and consume channels
  accordingly. The existing `CHORD_OVERFLOW` rule applies.
- New diagnostics:
  - `DRUM_HIT_UNKNOWN` (warn) — note carries an accidental that's not in
    the v1 drum vocabulary (`^c`, `_e`, …); dropped to a rest. The 7
    plain letters always map.
  - `DRUM_KIT_INVALID` (error) — built-in kit name unknown, or custom
    kit missing required hits / has out-of-range field values.
  - `DRUM_DIRECTIVE_INVALID` (error) — `%%pico8 drum` line malformed
    (wrong arg count, non-positive voice number).
- CLI: `--drum-voice <i>` (0-based, repeatable for multiple drum
  voices) marks a voice as drum; `--kit <name>` picks a built-in (only
  `'noise'` for v1). Custom kits stay API-only.
- Playground: drum-voice toggle next to each voice's instrument
  dropdown; when toggled on, the dropdown swaps to a kit picker.

**Resolved decisions**
- The letter→drum map is fixed, not kit-controlled. Kits define the
  *sound* of each drum, not which letter triggers it. Keeps ABC
  portable across kits — swap kits to change tone without rewriting
  notes.
- Drum chords expand into sibling voices like melodic chords, rather
  than folding into a single SFX slot. Pico-8 plays one hit per
  channel-slot, so simultaneous drum hits genuinely need separate
  channels. Auto-arp doesn't apply (arpeggiating a kick+hat is
  musically wrong).
- Octave is ignored on drum-voice notes in v1. Extending the vocabulary
  via accidentals (`^c` = clap, `^d` = rim, etc.) is an easy follow-up
  once the basic 7 are validated.
- Built-in preset kits beyond `'noise'` deferred. Avoids opinionating
  on tone before we've validated the framework against real tunes,
  and avoids the "this 808 doesn't sound like an 808" trap of naming
  presets after real machines.
- Drum voices default to the `'noise'` kit when `kit:` is unset.
  `voices[i].instrument` (and the `%%pico8 instrument` directive) is
  silently ignored on drum voices — the kit drives per-hit waveform —
  so callers can spread shared per-voice config without bookkeeping.

## Slice 9 — Drum-kit presets (shipped)

Tonal variety beyond the `'noise'` kit shipped in slice 8. "Finished-
sounding" tunes need more than one drum palette, and slice 8 explicitly
punted preset design pending real use.

- Two named built-in kits added to `src/pico8/kits.ts` alongside
  `'noise'`: `'hybrid'` (triangle kick + toms with noise snare/hats)
  and `'tonal'` (all pitched, no noise channel — triangle kick/toms,
  square snare, pulse hats). Same `Kit` shape as slice 8; no IR or
  pipeline changes.
- CLI `--kit <name>` and the playground kit dropdown both pick up the
  new entries. The CLI's accepted-name list is now derived from
  `BUILT_IN_KITS` so additional presets won't need a CLI patch.
- No new diagnostics — `DRUM_KIT_INVALID` already covers unknown names,
  and built-in kits are author-validated.

**Resolved decisions**
- Kit hit shapes use effect=5 (fade-out) on every articulating slot,
  matching slice 8's noise-kit pattern. This keeps sustained drum
  notes re-articulating consistently across all built-in kits;
  hat-open's effect=0 (sustain) is the one intentional exception.

## Slice 10 — LLM authoring guide (next)

**Goal:** make it possible for an LLM to write idiomatic ABC for this
pipeline without trial-and-error. Doubles as failure-mode discovery for
slice 11 (inspector) — writing the guide forces us to catalogue what
goes wrong, which becomes the inspector's target list.

- `AGENTS.md` at repo root: pipeline-aware authoring guide (channel
  budget, chord arity, slot grid, drum vocabulary, instrument
  selection, repeat semantics, common diagnostics and how to avoid
  them). Style: machine-readable, like CLAUDE.md but written for any
  LLM consuming the repo.
- `examples/llm/` recipe library: one ABC + expected-cart pair per
  use case (melody only, melody + pad, melody + bass + drums, drum
  pattern, multi-section tune with repeats, chord comping with
  auto-arp). Each recipe has a short README explaining what it
  demonstrates and the diagnostics it should *not* produce.
- No library code changes expected. Any pipeline gaps surfaced by the
  recipes (e.g. an ornament that should round-trip but doesn't) get
  written up as candidate follow-on slices, not patched inline.
- Output: a catalogued list of LLM failure modes, which feeds slice 11.

## Slice 11 — Inspector / lint tooling

**Goal:** programmatic evaluation of converter output, scoped against
the real failure modes catalogued in slice 10 rather than speculative
ones. Substitutes "ear" for LLMs that can't hear the output.

- CLI + library export returning structural facts: per-voice pitch
  range, slot grid, chord onsets, voice-activity timeline, drum-hit
  density, instrument assignments per voice.
- Algorithmic warnings drawn from slice 10's failure-mode list. Likely
  starters: silent voice, register clash, no rests, monotonic rhythm,
  pitch clamped at range edges, drums-only-on-downbeat, channel-budget
  near-miss.
- Optional ASCII piano-roll output for human spot-checks.

## Not yet scoped

Order roughly reflects "next-after-slice-11" priority but isn't
committed:

- Reverse direction (Pico-8 cart → ABC). Natural follow-on to the
  inspector once IR ↔ cart parity is well-tested.
- ABC ornaments (trills, grace notes) — currently silently dropped.
  Promote if slice 10 surfaces them as real LLM-output content.
- Effects beyond the basics already in IR (`src/ir/types.ts`) — fade,
  vibrato, slide, drop. Promote if slice 10 surfaces dynamics gaps.
- Per-note instrument changes within a voice (melodic voices). Drum
  voices already do this by design in slice 8.
- PNG cart format (`.p8.png`) input/output.
- Multi-track jukebox cart (bundle N tunes + Lua picker into one cart).
  Was drafted as the original slice 6; superseded by slice 7's merge
  flow, which lets users assemble jukeboxes themselves in their own
  carts. Spec lives in git history if we want to revive it.
