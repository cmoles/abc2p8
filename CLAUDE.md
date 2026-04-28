# abc2p8

Converts ABC notation → Pico-8 `__music__`/`__sfx__` cart format.

## Architecture
- TypeScript library, pure functions
- Internal JSON representation; all converters go through IR
- `abcjs` for ABC parsing, don't reinvent
- Vite build, GitHub Pages deploy

## Pico-8 constraints
- 4 mono channels, 8 waveforms, 32-note SFX slots
- Pitch range C2–D#7 (Pico-8 editor notation; 64 semitones)
- See docs/[pico8-format.md](http://pico8-format.md) for full reference

## Conventions
- No dependencies beyond abcjs and dev tools
- Tests use vitest, fixtures in tests/fixtures/
- Public API in src/index.ts, internal modules elsewhere
