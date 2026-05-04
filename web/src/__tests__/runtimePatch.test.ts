import { describe, expect, it } from 'vitest';
import { injectRuntimeRom, parseRuntimeJs } from '../runtimePatch.js';

const FIXTURE = `var _cartname=['shell.p8'];
var _cdpos=0;
var _cartdat=[
0,1,2,3,
4,5,6,7
];
console.log('runtime');
`;

describe('parseRuntimeJs', () => {
  it('extracts the _cartdat byte array', () => {
    const parts = parseRuntimeJs(FIXTURE);
    expect(Array.from(parts.rom)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(parts.before).toContain('_cartname');
    expect(parts.after).toContain('console.log');
  });

  it('throws when the literal is missing', () => {
    expect(() => parseRuntimeJs('var x = 1;')).toThrow(/_cartdat/);
  });

  it('rejects out-of-range bytes', () => {
    const bad = 'var _cartdat=[256];';
    expect(() => parseRuntimeJs(bad)).toThrow(/non-byte/);
  });
});

describe('injectRuntimeRom', () => {
  it('round-trips identical bytes back into the source', () => {
    const parts = parseRuntimeJs(FIXTURE);
    const rebuilt = injectRuntimeRom(parts, parts.rom);
    const reparsed = parseRuntimeJs(rebuilt);
    expect(Array.from(reparsed.rom)).toEqual(Array.from(parts.rom));
  });

  it('lets us swap bytes in the middle of the ROM', () => {
    const parts = parseRuntimeJs(FIXTURE);
    const swapped = new Uint8Array(parts.rom);
    swapped[3] = 99;
    const rebuilt = injectRuntimeRom(parts, swapped);
    const reparsed = parseRuntimeJs(rebuilt);
    expect(reparsed.rom[3]).toBe(99);
    expect(reparsed.rom[2]).toBe(2);
  });
});
