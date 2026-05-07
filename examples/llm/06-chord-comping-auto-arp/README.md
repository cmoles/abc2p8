# 06 — chord comping with auto-arp

A 3-voice tune where V2 plays triadic chords against a melody and bass.
In `expand` mode this would need 5 channels (3 chord siblings + lead +
bass), one over the budget. `chordStrategy: 'auto'` (the default) detects
the overflow and falls back to arp mode, where V2's chord plays on a
single channel using Pico-8's arp effect.

**What this demonstrates**
- Auto-arp fallback: writer doesn't need to think about the channel
  budget — auto picks the strategy.
- Chord onsets and durations are quarter-note multiples (4 slots each at
  the chosen grid), so arp's 4-slot alignment is satisfied.
- Three distinct timbres: tilted-saw lead, square comping, triangle bass.

**Should NOT produce**
- `CHORD_OVERFLOW` — auto strategy avoids it by going to arp.
- `ARP_GRID_INFEASIBLE` — chord onsets land on quarter-note boundaries,
  which align to the 4-slot arp groups.

**Acceptable info**
- `AUTO_ARP_FALLBACK` — confirms arp was chosen automatically.

**Pitfall to avoid**
- If chord onsets aren't multiples of 4 slots (e.g. starting a chord on
  an off-beat eighth at `L:1/4` quantization), arp will fail with
  `ARP_GRID_INFEASIBLE`. Keep chord chunks on quarter-note boundaries
  with quarter-note (or longer) durations.
- Forcing `chordStrategy: 'expand'` on this fixture errors with
  `CHORD_OVERFLOW`. Prefer `'auto'` unless you specifically want one or
  the other.
