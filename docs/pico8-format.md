# Pico-8 `.p8` SFX & Music Byte Layout

Reference for the `__sfx__` and `__music__` sections of a Pico-8 `.p8` cartridge file (text format). Used by `abc2p8` for parsing and emitting cart sound data.

The `.p8` format is text-based: each non-code section is a delimiter line (e.g. `__sfx__`) followed by lines of hex digit pairs that represent bytes (most-significant nybble first, except where noted). Every section that is identical to a default empty cart is omitted on save; trailing default lines within a section are also omitted. A parser must therefore not assume a fixed line count.

> **Important:** the `.p8` file layout described here is **not** the same as Pico-8's in-memory layout at `0x3100` (music) and `0x3200` (sfx). The on-disk encoding is expanded for human readability. See [In-memory vs `.p8` differences](#in-memory-vs-p8-differences) at the bottom.

---

## SFX section — `__sfx__`

Up to 64 lines, one per sfx slot (sfx 0 on the first line, sfx 63 on the last). Each line is exactly **168 hex characters** representing **84 bytes**.

### Per-line byte layout

| Offset | Size      | Field                                 |
| ------ | --------- | ------------------------------------- |
| 0      | 1 byte    | Editor mode + filter switches (packed) |
| 1      | 1 byte    | Note duration / "speed"               |
| 2      | 1 byte    | Loop start (0–63)                     |
| 3      | 1 byte    | Loop end (0–63)                       |
| 4–83   | 80 bytes  | 32 notes × 20 bits each (5 hex nybbles per note) |

So each line is `HH HH HH HH NNNNN NNNNN ... NNNNN` (8 header hex chars + 32 × 5 = 160 note hex chars).

Each pair of notes occupies exactly 5 bytes (40 bits = 10 nybbles). Notes are NOT byte-aligned — work in nybbles (4-bit units), not bytes, when reading the note region.

### Note encoding (5 nybbles per note, in line order)

| Nybble | Bits | Field                                              |
| ------ | ---- | -------------------------------------------------- |
| 0–1    | 8    | Pitch, 0–63 (only low 6 bits used). 0 = C0, 63 = D♯5 |
| 2      | 4    | Waveform / instrument, 0–F                         |
| 3      | 4    | Volume, 0–7 (top bit unused)                       |
| 4      | 4    | Effect, 0–7 (top bit unused)                       |

#### Waveform values

| Value | Waveform                                          |
| ----- | ------------------------------------------------- |
| 0     | Sine (triangle in older versions; "tri/sin")      |
| 1     | Triangle                                          |
| 2     | Sawtooth                                          |
| 3     | Square (long / 50% pulse)                         |
| 4     | Square (short / 25% pulse)                        |
| 5     | Ringing                                           |
| 6     | Noise                                             |
| 7     | Ringing sine ("phaser")                           |
| 8–F   | Custom waveform — uses sfx 0–7 as an instrument (Pico-8 0.1.11+) |

#### Effect values

| Value | Effect                                                |
| ----- | ----------------------------------------------------- |
| 0     | None                                                  |
| 1     | Slide (to next note's pitch and volume)               |
| 2     | Vibrato (within a quarter-tone)                       |
| 3     | Drop (rapid frequency drop)                           |
| 4     | Fade in (volume ramps up from 0)                      |
| 5     | Fade out (volume ramps down to 0)                     |
| 6     | Arpeggio fast (cycle every 4 notes at speed 4; halved to 2 if sfx speed ≤ 8) |
| 7     | Arpeggio slow (cycle every 4 notes at speed 8; halved to 4 if sfx speed ≤ 8) |

### Byte 0 — editor mode + filter switches

A single byte packs six fields. Two are 1-bit toggles, three are 3-level switches (0/1/2), and one is the editor-mode flag. Encoding (matches the formula used by the editor):

```
byte =  (editor_mode ? 1 : 0)        // bit 0
     | ((noiz ? 1 : 0) << 1)         // bit 1
     | ((buzz ? 1 : 0) << 2)         // bit 2
     +  detune * 8                   // 0, 8, 16
     +  reverb * 24                  // 0, 24, 48
     +  dampen * 72                  // 0, 72, 144
```

Decode:

```
editor_mode = (byte & 1) != 0          // 0 = graph mode, 1 = tracker mode
noiz        = (byte & 2) != 0
buzz        = (byte & 4) != 0
detune      = Math.floor(byte / 8)  % 3   // 0, 1, or 2
reverb      = Math.floor(byte / 24) % 3
dampen      = Math.floor(byte / 72) % 3
```

The 3-level switches are packed into the upper 5 bits using mixed-radix base-3 encoding so all 27 combinations fit (max byte value = `1 | 2 | 4 | 16 | 48 | 144 = 215`). The editor-mode bit affects only which UI mode opens; it has no effect on playback.

### Byte 1 — speed

Note duration in ticks. The Pico-8 manual describes it as "multiples of 1/128 second" and is the value shown as **SPD** in the editor; the underlying tick rate is 183 samples per tick at 22050 Hz (≈ 1/120 s per tick). A value of 0 is treated as 1. With `spd = 1`, all 32 notes play in roughly 0.266 s.

### Bytes 2 & 3 — loop start / loop end

Both are note indices 0–63, though only 0–31 reference real notes; values past 32 play silence. If `loop_end` is 0, looping is disabled and `loop_start` instead acts as the sfx **length** (Pico-8 0.2.2+ feature for sfx longer than 32 notes; not commonly used).

### Worked example

A line beginning:

```
010c000028050200002a050... (continues for a total of 168 chars)
```

decodes as:

| Bytes  | Hex  | Meaning                                                |
| ------ | ---- | ------------------------------------------------------ |
| 0      | `01` | editor_mode=1 (tracker), all filters off               |
| 1      | `0c` | speed = 12                                             |
| 2      | `00` | loop start = 0                                         |
| 3      | `00` | loop end = 0 (no loop)                                 |
| Note 0 | `28050` | pitch=0x28=40 (E3), waveform=0 (sine), vol=5, effect=0 |
| Note 1 | `2a050` | pitch=0x2a=42 (F♯3), waveform=0, vol=5, effect=0    |

---

## Music section — `__music__`

Up to 64 lines, one per music pattern (0–63). Each line has a fixed text format:

```
FF SSSSSSSS
```

That is: **2 hex digits** (flag byte), one **space** character, then **8 hex digits** (4 sfx-id bytes, one per channel, MSB-first byte-by-byte). Total 11 characters per line plus newline.

### Flag byte (first 2 hex digits)

Lower 3 bits only; upper 5 bits unused.

| Bit | Flag                            |
| --- | ------------------------------- |
| 0   | Begin pattern loop              |
| 1   | End pattern loop                |
| 2   | Stop at end of pattern          |

When playback finishes a pattern: if **stop** is set, music halts; otherwise if **end loop** is set, the player searches backwards for the most recent pattern with **begin loop** set and resumes there; otherwise the next pattern plays.

### Channel sfx-id bytes (next 8 hex digits = 4 bytes)

The 4 bytes correspond to channels 0, 1, 2, 3 in order. Each byte is:

| Value     | Meaning                                              |
| --------- | ---------------------------------------------------- |
| `0x00`–`0x3F` | Play sfx 0–63 on this channel                    |
| `0x40` + channel_index | This channel is silent for the pattern. Channel 0 silent = `0x40`, ch 1 = `0x41`, ch 2 = `0x42`, ch 3 = `0x43`. |

A pattern with all four channels silent is the empty/default pattern and is normally omitted from the file entirely.

### Worked example

```
01 00014142
```

- Flag byte `01` → begin-loop set; end-loop and stop clear.
- Channel 0 plays sfx `00`.
- Channel 1 plays sfx `01`.
- Channel 2 silent (`0x41` = 0x40 | 1; in-memory the channel-1 silent marker is reused here — see the note below).
- Channel 3 silent (`0x42` = 0x40 | 2).

> Note: there is some inconsistency in third-party documentation about which silent value goes in which channel. In practice in real `.p8` carts, a silent channel `n` is stored as exactly `0x40 | n`. A robust parser should treat any byte with bit 6 set as "silent" and ignore the low bits.

---

## In-memory vs `.p8` differences

If your code also pokes/peeks Pico-8 memory directly, note that the on-disk and in-RAM layouts differ:

### SFX in memory (at `0x3200`, 68 bytes per sfx)

| Offset | Size | Field                              |
| ------ | ---- | ---------------------------------- |
| 0–63   | 64 B | 32 notes × 16 bits, little-endian  |
| 64     | 1 B  | Editor mode + filter switches (same packing as `.p8` byte 0) |
| 65     | 1 B  | Speed                              |
| 66     | 1 B  | Loop start                         |
| 67     | 1 B  | Loop end                           |

Each in-memory note is **16 bits** (vs 20 bits in `.p8`):

| Bits  | Field                          |
| ----- | ------------------------------ |
| 0–5   | Pitch (0–63)                   |
| 6–9   | Waveform (0–F)                 |
| 10–12 | Volume (0–7)                   |
| 13–15 | Effect (0–7)                   |

Address of sfx `n`: `0x3200 + n * 68`. Address of note `i` of sfx `n`: `0x3200 + n * 68 + i * 2`.

### Music in memory (at `0x3100`, 4 bytes per pattern)

Each of the 4 channel bytes packs both an sfx id and one bit of the flag byte:

| Byte  | Bits 0–6                | Bit 7                        |
| ----- | ----------------------- | ---------------------------- |
| 0     | sfx id (channel 0)      | begin-loop flag              |
| 1     | sfx id (channel 1)      | end-loop flag                |
| 2     | sfx id (channel 2)      | stop flag                    |
| 3     | sfx id (channel 3)      | unused                       |

A silent channel sets bit 6 of its sfx-id (so the 7-bit id range 64–127 indicates silent). Address of pattern `n`: `0x3100 + n * 4`.

### Conversion summary for `abc2p8`

When emitting a `.p8` from an in-memory representation:

1. Per sfx note: extract the 4 fields from 16 bits and re-emit them as the 5-nybble `.p8` form (pitch in 8 bits, waveform/volume/effect in 4 bits each).
2. Per music pattern: split the 4 in-memory bytes into a flag byte (3 bits gathered from bit 7 of bytes 0/1/2) and 4 sfx-id bytes (low 7 bits of each, with bit 6 preserved as the silent marker, padded into a full byte).

When parsing a `.p8` into in-memory form, do the inverse.

---

## References

- [Pico-8 Wiki: P8FileFormat](https://pico-8.fandom.com/wiki/P8FileFormat)
- [Pico-8 Wiki: Memory § Sound effects](https://pico-8.fandom.com/wiki/Memory)
- [Pico-8 User Manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html) — sfx editor, effects, filters
- [BBS thread: Data structures for sfx and music](https://www.lexaloffle.com/bbs/?tid=2341) — original write-up by zep
- [Pico-8 0.2.2 release notes](https://www.lexaloffle.com/bbs/?tid=41544) — added filters (noiz, buzz, detune, reverb, dampen) and sfx-length feature
