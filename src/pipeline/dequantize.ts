// Walk an unpacked Pico-8 cart's music + sfx into a Score IR.
//
// Pipeline mirror of quantize.ts but inverted: music rows + SFX rows ->
// per-channel slot timelines -> coalesced IR notes -> Score. Detects arp
// chords, drum kits, and the cart's loop region along the way.

import { Diagnostics } from '../ir/diagnostics.js';
import type { Note, RepeatRegion, Score, Voice, VoiceKind } from '../ir/types.js';
import {
  ARP_GROUP_SIZE,
  CHANNEL_COUNT,
  EFFECT_ARP_FAST,
  EFFECT_ARP_SLOW,
  EFFECT_FADE_IN,
  EFFECT_FADE_OUT,
  EFFECT_NONE,
  PICO8_MIDI_OFFSET,
  SFX_NOTES_PER_SLOT,
} from '../pico8/constraints.js';
import type { Pico8MusicPattern, Pico8Note, Pico8Sfx } from '../pico8/format.js';
import {
  BUILT_IN_KITS,
  type BuiltInKitName,
  type DrumHit,
  type DrumName,
  DRUM_NAMES,
  type Kit,
} from '../pico8/kits.js';
import type { UnpackedCart } from '../pico8/unpack.js';

const TPQ = 48;
const KNOWN_EFFECTS = new Set<number>([
  EFFECT_NONE,
  EFFECT_FADE_IN,
  EFFECT_FADE_OUT,
  EFFECT_ARP_FAST,
  EFFECT_ARP_SLOW,
]);

export interface VoiceMeta {
  // Voice index 1-based in the emitted ABC (V:1, V:2, ...). The IR Voice
  // `id` already matches "V{n}" so this is just for convenience.
  voiceNumber: number;
  // Stamped on melodic voices that have a single dominant waveform. Drives
  // %%pico8 instrument emission. Absent on drum voices or mixed-waveform
  // melodic voices (those trigger REVERSE_FEATURE_DROPPED).
  instrument?: number;
  // Set on drum voices. Names a built-in kit so the round-trip caller can
  // pass --kit <name> to recover the per-hit shapes.
  drumKit?: BuiltInKitName;
}

export interface DequantizeResult {
  score: Score;
  voiceMeta: VoiceMeta[];
  // Number of slots per ABC unit (lDen-th note). Drives fromIR's duration
  // formatting; not part of the Score IR itself.
  slotsPerUnit: number;
  lDen: number;
}

export function dequantize(cart: UnpackedCart, diagnostics: Diagnostics): DequantizeResult | null {
  if (cart.music.length === 0) {
    diagnostics.error('parse', 'REVERSE_TARGET_INVALID', 'Cart has no __music__ rows to play.');
    return null;
  }

  const channelTimelines = buildChannelTimelines(cart, diagnostics);
  if (!channelTimelines) return null;

  // Channels with at least one onset across the played sequence become voices.
  const usedChannels: number[] = [];
  for (let c = 0; c < CHANNEL_COUNT; c += 1) {
    if (channelTimelines.slots[c]!.some((s) => s.volume > 0)) usedChannels.push(c);
  }

  if (usedChannels.length === 0) {
    diagnostics.error(
      'parse',
      'REVERSE_TARGET_INVALID',
      'Cart has no non-silent channels — nothing to convert.',
    );
    return null;
  }

  // Pull speed from the first non-silent SFX that appears in the sequence.
  // Forward emit always writes the same speed across SFX slots; if the cart
  // has heterogeneous speeds the user's running something we don't author,
  // so use the first speed and flag it.
  const speed = collectSpeed(cart, channelTimelines.playedSfxIds, diagnostics);

  // First pass per channel: collapse slot streams into provisional notes so
  // we know which slots are onsets vs sustains. Drum-kit detection then runs
  // on the onset tuples and decides voice kind; final IR-note construction
  // uses kind-aware logic.
  const perChannel: PerChannel[] = usedChannels.map((c) =>
    collapseChannel(channelTimelines.slots[c]!),
  );

  // gcd of note durations (in slots) decides the ABC unit grid.
  const allDurations: number[] = [];
  for (const ch of perChannel) {
    for (const note of ch.notes) {
      if (note.kind === 'note' || note.kind === 'chord') allDurations.push(note.durationSlots);
    }
  }
  const gcdSlots = allDurations.length === 0 ? 1 : gcdAll(allDurations);
  const { lDen, bpm } = pickLAndBpm(speed, gcdSlots);
  const slotTicks = (TPQ * 4) / lDen / gcdSlots; // ticks per slot (NOT per ABC unit)

  // Re-anchor: ABC unit = gcdSlots slots; one ABC unit = TPQ * 4 / lDen ticks.
  // So one slot = (TPQ * 4 / lDen) / gcdSlots ticks. This keeps the IR
  // duration-GCD aligned to slotTicks * gcdSlots, which the forward
  // quantizer will collapse back into the same grid.
  const ticksPerSlot = slotTicks; // alias for readability

  // Build IR Voices.
  const voices: Voice[] = [];
  const voiceMeta: VoiceMeta[] = [];
  let voiceIdx = 0;
  for (let i = 0; i < perChannel.length; i += 1) {
    const ch = perChannel[i]!;
    const voiceNum = voiceIdx + 1;
    const id = `V${voiceNum}`;
    const kitMatch = matchKit(ch);
    const kind: VoiceKind = kitMatch ? 'drum' : 'melodic';

    const irNotes: Note[] = ch.notes.map((n) => buildIrNote(n, ticksPerSlot, kind, kitMatch));

    let instrument: number | undefined;
    if (kind === 'melodic') {
      const inst = resolveMelodicInstrument(ch, diagnostics, id);
      if (inst !== undefined) instrument = inst;
    }

    voices.push({
      id,
      notes: irNotes,
      kind,
      ...(instrument !== undefined ? { instrument } : {}),
    });

    voiceMeta.push({
      voiceNumber: voiceNum,
      ...(kitMatch ? { drumKit: kitMatch.kitName } : {}),
      ...(instrument !== undefined ? { instrument } : {}),
    });

    if (!kitMatch && looksLikeDrums(ch)) {
      diagnostics.info(
        'parse',
        'REVERSE_NONSTANDARD_DRUM',
        `${id} appears drum-like (waveform 6 dominant) but did not match a built-in kit; emitted as melodic.`,
        { voice: id },
      );
    }

    voiceIdx += 1;
  }

  const repeat = resolveLoopRegion(channelTimelines, ticksPerSlot);

  const score: Score = {
    ticksPerQuarter: TPQ,
    tempoBpm: bpm,
    voices,
    meta: {
      timeSignature: [4, 4],
    },
    ...(repeat ? { repeat } : {}),
  };

  return {
    score,
    voiceMeta,
    slotsPerUnit: gcdSlots,
    lDen,
  };
}

// --- Music timeline ----------------------------------------------------------

interface ChannelTimelines {
  // Per-channel flat slot stream (length = totalSlots across all rows).
  slots: Pico8Note[][];
  // Map from slot index -> the music-row index that produced it. Used to
  // recover loop offsets.
  rowStartSlot: number[];
  rowLength: number[];
  music: Pico8MusicPattern[];
  // SFX ids actually referenced from the music sequence (deduped).
  playedSfxIds: Set<number>;
}

function buildChannelTimelines(
  cart: UnpackedCart,
  diagnostics: Diagnostics,
): ChannelTimelines | null {
  const slots: Pico8Note[][] = Array.from({ length: CHANNEL_COUNT }, () => []);
  const rowStartSlot: number[] = [];
  const rowLength: number[] = [];
  const playedSfxIds = new Set<number>();
  const sfxChannelBinding = new Map<number, number>(); // sfx idx -> first channel
  const ambiguousReported = new Set<number>();

  // Multi-section music (carts that play different songs via several
  // music() calls) shows up as multiple begin-loop / end-loop pairs in the
  // sequence. The forward path can only express one |: :| region, so cap
  // the decode at the end of the first section and warn. Without this the
  // reverse path concatenates every section into one mega-tune that
  // typically blows past the 64-SFX-slot budget on round-trip.
  const sectionEnd = detectFirstSectionEnd(cart.music);
  const lastRow = sectionEnd !== null ? sectionEnd.endRow : cart.music.length - 1;
  if (sectionEnd?.multiSection) {
    diagnostics.warn(
      'parse',
      'REVERSE_MULTI_SECTION',
      `Cart has multiple loop sections (begin/end-loop pairs); decoding only rows 0–${sectionEnd.endRow}. Edit the source cart to extract a single section if a different one is desired.`,
    );
  }

  for (let r = 0; r <= lastRow && r < cart.music.length; r += 1) {
    const row = cart.music[r]!;
    rowStartSlot.push(slots[0]!.length);

    // Per-channel SFX, padded to row length (max of effective lengths).
    let maxLen = 0;
    const channelSfx: (Pico8Sfx | null)[] = [];
    for (let c = 0; c < CHANNEL_COUNT; c += 1) {
      const id = row.channels[c]!;
      if (id === 'silent') {
        channelSfx.push(null);
        continue;
      }
      playedSfxIds.add(id);
      const sfx = cart.sfx.get(id) ?? null;
      if (!sfx) {
        diagnostics.warn(
          'parse',
          'REVERSE_FEATURE_DROPPED',
          `Music row ${r} channel ${c} references SFX ${id} but the cart has no such slot; treating as silent.`,
        );
        channelSfx.push(null);
        continue;
      }
      const existing = sfxChannelBinding.get(id);
      if (existing === undefined) {
        sfxChannelBinding.set(id, c);
      } else if (existing !== c && !ambiguousReported.has(id)) {
        diagnostics.info(
          'parse',
          'REVERSE_AMBIGUOUS_SFX',
          `SFX ${id} is played on channels ${existing} and ${c}; the first channel binding wins.`,
        );
        ambiguousReported.add(id);
      }
      channelSfx.push(sfx);
      const len = effectiveSfxLength(sfx);
      if (len > maxLen) maxLen = len;
    }

    if (maxLen === 0) {
      // Fully-silent row. Pad each channel with one silent slot so the row
      // still advances the playback timeline, mirroring how Pico-8 would
      // play through an empty pattern.
      maxLen = SFX_NOTES_PER_SLOT;
    }
    rowLength.push(maxLen);

    for (let c = 0; c < CHANNEL_COUNT; c += 1) {
      const sfx = channelSfx[c];
      const stream = slots[c]!;
      for (let i = 0; i < maxLen; i += 1) {
        if (sfx && i < sfx.notes.length) stream.push(sfx.notes[i]!);
        else stream.push(silentSlot());
      }
    }

    if (row.stop) {
      // After a stop flag the runtime halts; trailing music rows are ignored.
      // Drop them so the IR matches what the cart actually plays.
      break;
    }
  }

  // Slice the music array so resolveLoopRegion sees only the section we
  // decoded; otherwise it could grab a begin/end-loop pair from a later
  // (truncated) section.
  const playedMusic = cart.music.slice(0, rowStartSlot.length);
  return { slots, rowStartSlot, rowLength, music: playedMusic, playedSfxIds };
}

interface SectionEnd {
  endRow: number;
  multiSection: boolean;
}

function detectFirstSectionEnd(music: Pico8MusicPattern[]): SectionEnd | null {
  // A "section" is everything from the start (or first begin-loop) through
  // the matching end-loop. If we see another begin-loop AFTER the first
  // end-loop, the cart is multi-section.
  let firstEnd: number | null = null;
  let multi = false;
  for (let r = 0; r < music.length; r += 1) {
    const m = music[r]!;
    if (m.endLoop && firstEnd === null) firstEnd = r;
    else if (m.beginLoop && firstEnd !== null && r > firstEnd) {
      multi = true;
      break;
    }
    if (m.stop) {
      if (firstEnd === null) firstEnd = r;
      break;
    }
  }
  if (firstEnd === null) return null;
  return { endRow: firstEnd, multiSection: multi };
}

function effectiveSfxLength(sfx: Pico8Sfx): number {
  // Pico-8 0.2.2+: with loopEnd=0, loopStart acts as the SFX length
  // (truncating the silent tail). Otherwise the full 32 notes play.
  if (sfx.loopEnd === 0 && sfx.loopStart > 0 && sfx.loopStart <= SFX_NOTES_PER_SLOT) {
    return sfx.loopStart;
  }
  return SFX_NOTES_PER_SLOT;
}

function silentSlot(): Pico8Note {
  return { pitch: 0, waveform: 0, volume: 0, effect: 0 };
}

// --- Coalescing slot stream -> provisional notes ----------------------------

type ProvisionalNote =
  | { kind: 'rest'; startSlot: number; durationSlots: number }
  | {
      kind: 'note';
      startSlot: number;
      durationSlots: number;
      pitch: number; // pico-8 pitch (0-63)
      waveform: number;
      volume: number;
      effect: number;
      // True if this note exists because the forward emitter forced a
      // retrigger (effect 4/5 on a same-pitch boundary). Drives the heuristic
      // that strips the retrigger effect when emitting back to IR — we don't
      // want pico8Effect=5 to roundtrip onto every same-pitch boundary.
      forcedRetrigger?: boolean;
    }
  | {
      kind: 'chord';
      startSlot: number;
      durationSlots: number;
      pitches: number[]; // pico-8 pitches, in arp slot order (4 entries)
      waveform: number;
      volume: number;
      effect: 6 | 7; // arp speed
    };

interface PerChannel {
  notes: ProvisionalNote[];
}

function collapseChannel(slots: Pico8Note[]): PerChannel {
  const notes: ProvisionalNote[] = [];
  let i = 0;
  while (i < slots.length) {
    const s = slots[i]!;
    if (isSilent(s)) {
      let j = i + 1;
      while (j < slots.length && isSilent(slots[j]!)) j += 1;
      notes.push({ kind: 'rest', startSlot: i, durationSlots: j - i });
      i = j;
      continue;
    }

    // Arp chord detection: an arp slot has effect ∈ {6,7} and lives in a
    // 4-slot aligned group. Forward stamps the arp effect on every slot of
    // the chord, so we look ahead in 4-slot strides and collapse contiguous
    // groups sharing the same 4-pitch layout.
    if (
      (s.effect === EFFECT_ARP_FAST || s.effect === EFFECT_ARP_SLOW) &&
      i % ARP_GROUP_SIZE === 0 &&
      i + ARP_GROUP_SIZE - 1 < slots.length &&
      isArpGroup(slots, i)
    ) {
      const firstGroupPitches = arpGroupPitches(slots, i);
      const effect = s.effect as 6 | 7;
      let end = i + ARP_GROUP_SIZE;
      while (
        end + ARP_GROUP_SIZE - 1 < slots.length &&
        isArpGroup(slots, end) &&
        sameArpPitches(arpGroupPitches(slots, end), firstGroupPitches) &&
        slots[end]!.effect === effect
      ) {
        end += ARP_GROUP_SIZE;
      }
      notes.push({
        kind: 'chord',
        startSlot: i,
        durationSlots: end - i,
        pitches: firstGroupPitches,
        waveform: s.waveform,
        volume: s.volume,
        effect,
      });
      i = end;
      continue;
    }

    // Single-pitch run: a note begins at slot `i` and absorbs subsequent
    // same-pitch slots. Stop conditions:
    //   - Silent slot.
    //   - Different pitch/waveform/volume.
    //   - A slot with effect ∈ {4,5} mid-run — forward stamps these only on
    //     onset slots, so each such slot is a fresh note.
    //   - For non-retrigger heads (effect != 4,5): the sustain must be
    //     effect=0 (default). A different non-default effect implies the
    //     next slot is a separate note (e.g. drum tuples with effect=5).
    // For drum voices over-segmentation is safe — forward stamps the kit
    // tuple on every slot of every note, so cart bytes round-trip.
    const headEffect = s.effect;
    const headIsRetrigger = headEffect === EFFECT_FADE_IN || headEffect === EFFECT_FADE_OUT;
    let j = i + 1;
    while (j < slots.length) {
      const n = slots[j]!;
      if (isSilent(n)) break;
      if (n.pitch !== s.pitch || n.waveform !== s.waveform || n.volume !== s.volume) break;
      if (n.effect === EFFECT_FADE_IN || n.effect === EFFECT_FADE_OUT) break;
      if (headIsRetrigger) {
        // Retrigger-onset notes sustain through effect=0 slots only.
        if (n.effect !== EFFECT_NONE) break;
      } else if (n.effect !== headEffect) {
        // Non-retrigger heads require the sustain to share the head's effect
        // (typically 0 for melodic, or the kit's per-slot effect for drums).
        break;
      }
      j += 1;
    }
    notes.push({
      kind: 'note',
      startSlot: i,
      durationSlots: j - i,
      pitch: s.pitch,
      waveform: s.waveform,
      volume: s.volume,
      effect: s.effect,
      // Mark notes that look like forced-retrigger artifacts so the IR
      // builder can strip the synthetic fade-in/out. Heuristic: effect=4
      // (fade-in) on a melodic single-pitch note is a forward-emit retrigger
      // signal, not an authored articulation.
      ...(headIsRetrigger ? { forcedRetrigger: true } : {}),
    });
    i = j;
  }
  return { notes };
}

function isSilent(s: Pico8Note): boolean {
  return s.volume === 0;
}

function isArpGroup(slots: Pico8Note[], start: number): boolean {
  const first = slots[start]!;
  if (first.effect !== EFFECT_ARP_FAST && first.effect !== EFFECT_ARP_SLOW) return false;
  for (let k = 1; k < ARP_GROUP_SIZE; k += 1) {
    const s = slots[start + k]!;
    if (s.effect !== first.effect) return false;
    if (s.volume === 0) return false;
    if (s.waveform !== first.waveform) return false;
  }
  return true;
}

function arpGroupPitches(slots: Pico8Note[], start: number): number[] {
  return [0, 1, 2, 3].map((k) => slots[start + k]!.pitch);
}

function sameArpPitches(a: number[], b: number[]): boolean {
  for (let k = 0; k < ARP_GROUP_SIZE; k += 1) if (a[k] !== b[k]) return false;
  return true;
}

// --- Drum kit detection ------------------------------------------------------

interface KitMatch {
  kitName: BuiltInKitName;
  // pico-8 pitch -> drum name (precomputed lookup for this kit so the IR
  // builder can stamp note.pitch from a chosen drum letter)
  pitchToName: Map<string, DrumName>;
}

function matchKit(ch: PerChannel): KitMatch | null {
  // Drum chords often expand into sibling voices where a sibling only carries
  // 1–2 of the chord's drum names. We still want those siblings tagged as
  // drum voices so the per-hit kit volumes survive the round-trip, so we
  // accept ≥2 distinct names when all of them match a single kit. The
  // alternative (>=3) would mis-classify siblings as melodic and force the
  // kit's per-slot waveform/volume to drop on re-emit.
  const onsetTuples = ch.notes
    .filter((n): n is Extract<ProvisionalNote, { kind: 'note' }> => n.kind === 'note')
    .map((n) => tupleKey(n.waveform, n.pitch, n.volume, n.effect));
  if (onsetTuples.length < 2) return null;
  const distinct = new Set(onsetTuples);
  if (distinct.size < 2) return null;

  let bestKit: BuiltInKitName | null = null;
  let bestDistinctNames = 0;
  for (const [name, kit] of Object.entries(BUILT_IN_KITS) as [BuiltInKitName, Kit][]) {
    const matchedDistinctNames = new Set<DrumName>();
    let allMatch = true;
    for (const t of distinct) {
      const hit = matchTupleToKit(t, kit);
      if (!hit) {
        allMatch = false;
        break;
      }
      matchedDistinctNames.add(hit);
    }
    if (allMatch && matchedDistinctNames.size > bestDistinctNames) {
      bestDistinctNames = matchedDistinctNames.size;
      bestKit = name;
    }
  }
  if (bestKit === null || bestDistinctNames < 2) return null;

  const kit = BUILT_IN_KITS[bestKit];
  const pitchToName = new Map<string, DrumName>();
  for (const name of DRUM_NAMES) {
    const hit = kit[name];
    pitchToName.set(tupleKey(hit.waveform, hit.pitch, hit.volume, hit.effect), name);
  }

  return {
    kitName: bestKit,
    pitchToName,
  };
}

function tupleKey(waveform: number, pitch: number, volume: number, effect: number): string {
  return `${waveform}:${pitch}:${volume}:${effect}`;
}

function matchTupleToKit(key: string, kit: Record<DrumName, DrumHit>): DrumName | null {
  for (const name of DRUM_NAMES) {
    const hit = kit[name];
    if (tupleKey(hit.waveform, hit.pitch, hit.volume, hit.effect) === key) return name;
  }
  return null;
}

function looksLikeDrums(ch: PerChannel): boolean {
  let noiseSlots = 0;
  let totalNoteSlots = 0;
  for (const n of ch.notes) {
    if (n.kind === 'note') {
      totalNoteSlots += n.durationSlots;
      if (n.waveform === 6) noiseSlots += n.durationSlots;
    }
  }
  return totalNoteSlots > 0 && noiseSlots / totalNoteSlots > 0.5;
}

// --- IR note construction ----------------------------------------------------

function buildIrNote(
  p: ProvisionalNote,
  ticksPerSlot: number,
  kind: VoiceKind,
  kit: KitMatch | null,
): Note {
  const startTick = p.startSlot * ticksPerSlot;
  const durationTick = p.durationSlots * ticksPerSlot;
  if (p.kind === 'rest') {
    return { startTick, durationTick, pitch: null };
  }
  if (p.kind === 'chord') {
    const midis = p.pitches.map((p8) => p8 + PICO8_MIDI_OFFSET);
    const distinct = uniqueSorted(midis);
    const root = distinct[0]!;
    const extras = distinct.slice(1);
    const note: Note = { startTick, durationTick, pitch: root };
    if (extras.length > 0) note.extraPitches = extras;
    return note;
  }
  // Single-pitch note.
  const midi = p.pitch + PICO8_MIDI_OFFSET;
  const note: Note = { startTick, durationTick, pitch: midi };
  if (kind === 'drum' && kit) {
    const drumName = kit.pitchToName.get(tupleKey(p.waveform, p.pitch, p.volume, p.effect));
    if (drumName) {
      // Stamp per-note kit shape so fromIR can reverse-map letter, and so
      // forward quantize would reproduce the same SFX bytes.
      note.instrument = p.waveform;
      note.velocity = p.volume;
      note.pico8Effect = p.effect;
    }
  } else if (!p.forcedRetrigger && p.effect !== EFFECT_NONE) {
    // Carry non-default effects on melodic notes so we don't silently drop
    // authored articulations. Forced fade-in (effect 4) from the emit-side
    // retrigger trick is intentionally stripped.
    const e = pico8EffectName(p.effect);
    if (e) note.effect = e;
  }
  return note;
}

function pico8EffectName(effect: number): Note['effect'] | null {
  switch (effect) {
    case EFFECT_FADE_IN:
      return 'fadeIn';
    case EFFECT_FADE_OUT:
      return 'fadeOut';
    case 1:
      return 'slide';
    case 2:
      return 'vibrato';
    case 3:
      return 'drop';
    default:
      return null;
  }
}

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function resolveMelodicInstrument(
  ch: PerChannel,
  diagnostics: Diagnostics,
  voiceId: string,
): number | undefined {
  const counts = new Map<number, number>();
  for (const n of ch.notes) {
    if (n.kind === 'note') counts.set(n.waveform, (counts.get(n.waveform) ?? 0) + n.durationSlots);
    else if (n.kind === 'chord') counts.set(n.waveform, (counts.get(n.waveform) ?? 0) + n.durationSlots);
  }
  if (counts.size === 0) return undefined;
  let mode = -1;
  let modeCount = 0;
  let total = 0;
  for (const [wf, c] of counts) {
    total += c;
    if (c > modeCount) {
      mode = wf;
      modeCount = c;
    }
  }
  if (counts.size > 1) {
    diagnostics.warn(
      'parse',
      'REVERSE_FEATURE_DROPPED',
      `${voiceId} uses multiple waveforms (${Array.from(counts.keys()).join(', ')}); emitted with modal waveform ${mode} only.`,
      { voice: voiceId },
    );
  }
  return mode;
}

// --- Tempo / L: picking -----------------------------------------------------

function collectSpeed(
  cart: UnpackedCart,
  playedIds: Set<number>,
  diagnostics: Diagnostics,
): number {
  const speeds = new Map<number, number>();
  for (const id of playedIds) {
    const s = cart.sfx.get(id);
    if (!s) continue;
    speeds.set(s.speed, (speeds.get(s.speed) ?? 0) + 1);
  }
  if (speeds.size === 0) return 1;
  let mode = 1;
  let modeCount = 0;
  for (const [sp, c] of speeds) {
    if (c > modeCount) {
      mode = sp;
      modeCount = c;
    }
  }
  if (speeds.size > 1) {
    diagnostics.warn(
      'parse',
      'REVERSE_FEATURE_DROPPED',
      `Cart has multiple SFX speeds (${Array.from(speeds.keys()).join(', ')}); using ${mode} for tempo.`,
    );
  }
  return mode;
}

function pickLAndBpm(speed: number, gcdSlots: number): { lDen: number; bpm: number } {
  // Relationship from quantize.ts:
  //   speed = (slotTicks / TPQ) * (60/bpm) * 120
  // We want one ABC unit (lDen-th note) = gcdSlots slots. Substituting
  // slotTicks (per slot) = TPQ * 4 / lDen / gcdSlots:
  //   bpm = 28800 / (lDen * gcdSlots * speed)
  // Pick the lDen in {1,2,4,8,16,32} that puts bpm in a comfortable musical
  // range, preferring 8 (the spec default) when multiple work.
  const candidates = [4, 8, 2, 16, 1, 32];
  let best: { lDen: number; bpm: number; score: number } | null = null;
  for (const lDen of candidates) {
    const bpm = Math.round(28800 / (lDen * gcdSlots * speed));
    if (bpm < 30 || bpm > 300) continue;
    const score = Math.abs(bpm - 110);
    if (best === null || score < best.score) best = { lDen, bpm, score };
  }
  if (best) return { lDen: best.lDen, bpm: best.bpm };
  // Last resort: L:1/8 even if bpm is out of range.
  return { lDen: 8, bpm: Math.max(1, Math.round(28800 / (8 * gcdSlots * speed))) };
}

// --- Loop region recovery ---------------------------------------------------

function resolveLoopRegion(t: ChannelTimelines, ticksPerSlot: number): RepeatRegion | null {
  let beginRow: number | null = null;
  let endRow: number | null = null;
  for (let r = 0; r < t.music.length; r += 1) {
    const m = t.music[r]!;
    if (m.beginLoop && beginRow === null) beginRow = r;
    if (m.endLoop) endRow = r;
    if (m.stop) break;
  }
  if (endRow === null) return null;
  if (beginRow === null) beginRow = 0;
  const startSlot = t.rowStartSlot[beginRow] ?? 0;
  const endSlot = (t.rowStartSlot[endRow] ?? 0) + (t.rowLength[endRow] ?? 0);
  if (endSlot <= startSlot) return null;
  return { startTick: startSlot * ticksPerSlot, endTick: endSlot * ticksPerSlot };
}

// --- Small utils ------------------------------------------------------------

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    [x, y] = [y, x % y];
  }
  return x;
}

function gcdAll(values: number[]): number {
  if (values.length === 0) return 0;
  let acc = values[0]!;
  for (let i = 1; i < values.length; i += 1) {
    acc = gcd(acc, values[i]!);
    if (acc === 1) return 1;
  }
  return acc;
}

// --- Unknown-effect surface -------------------------------------------------

export function flagUnknownEffects(cart: UnpackedCart, diagnostics: Diagnostics): void {
  const seen = new Set<number>();
  for (const sfx of cart.sfx.values()) {
    for (const n of sfx.notes) {
      if (n.volume === 0) continue;
      if (!KNOWN_EFFECTS.has(n.effect) && !seen.has(n.effect)) {
        seen.add(n.effect);
        diagnostics.warn(
          'parse',
          'REVERSE_UNKNOWN_EFFECT',
          `Cart uses effect ${n.effect} (slide/vibrato/drop); preserved as IR effect but the forward path will not re-emit it.`,
        );
      }
    }
  }
}
