# examples/llm — recipes for ABC authoring

Each subdirectory is one ABC + expected `.p8` pair plus a short README
explaining what the recipe demonstrates and the diagnostics it should *not*
produce. Use them as starting points or as round-trip fixtures.

| Recipe | What it demonstrates |
|---|---|
| [01-melody-only](01-melody-only/) | Single voice, minimal header, per-voice instrument directive |
| [02-melody-and-pad](02-melody-and-pad/) | Two-voice polyphony, sustained pad against a melody |
| [03-melody-bass-drums](03-melody-bass-drums/) | Three-voice "complete tune" — lead + bass + drum voice |
| [04-drum-pattern](04-drum-pattern/) | Standalone drum-only voice, drum chords as sibling channels |
| [05-multi-section-with-repeats](05-multi-section-with-repeats/) | Intro then `\|: … :\|` looping verse |
| [06-chord-comping-auto-arp](06-chord-comping-auto-arp/) | Auto-arp fallback when chord siblings overflow the channel budget |

All recipes are converted with the default CLI invocation:

```sh
npm run convert examples/llm/<recipe>/<file>.abc -o /tmp/out.p8
```

The committed `.p8` files are the reference output; if the converter changes
behavior, regenerate them and review the diff.

For the authoring guide proper see [AGENTS.md](../../AGENTS.md).
