# 01 — melody only

The simplest one-voice tune. Single channel, no chords, no drums.

**What this demonstrates**
- Minimal ABC header (`X T M L Q K`).
- A single melodic voice using `L:1/8` so quarter notes are written `C2`.
- Per-voice instrument via `%%pico8 instrument 1 1` (waveform 1 / tilted-saw).

**Should NOT produce**
- `CHORD_OVERFLOW`, `ARP_GRID_INFEASIBLE` — no chords.
- `OUT_OF_RANGE` — pitches stay in C2–D#7.
- `SFX_BUDGET_EXCEEDED` — under 64 slots.

**Acceptable info**
- `TEMPO_ROUNDED` — Pico-8 speed is integer; 110 BPM rounds to ~110.8.

Run:

```sh
npm run convert examples/llm/01-melody-only/melody.abc -o /tmp/out.p8
```
