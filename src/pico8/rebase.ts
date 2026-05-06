// Rebase a single Pico-8 __music__ text-format line so its channel SFX ids
// shift by `offset`. Used when a freshly-emitted music section is dropped
// into a cart that already has SFX slots — the music patterns reference
// `0..N-1` from emit, but in the merged cart those SFX live at
// `offset..offset+N-1`.
//
// Channel byte format (text mode): bit 6 = silent-channel marker
// (`0x40 | channelIndex`); skip rebasing those.

export function rebaseMusicLine(line: string, offset: number): string {
  if (offset === 0) return line;
  const space = line.indexOf(' ');
  if (space < 0) throw new Error(`malformed music line: ${line}`);
  const flag = line.slice(0, space);
  const channels = line.slice(space + 1);
  if (channels.length !== 8) throw new Error(`malformed music line: ${line}`);
  let rebased = '';
  for (let c = 0; c < 4; c += 1) {
    const byte = parseInt(channels.slice(c * 2, c * 2 + 2), 16);
    const next = byte & 0x40 ? byte : byte + offset;
    rebased += next.toString(16).padStart(2, '0');
  }
  return `${flag} ${rebased}`;
}
