# Alert sound

The sound Code Foundry plays when a thread starts needing attention while the app is not
active (`notifications.sound`, docs/notes/dock-alerts.md).

**Chosen: `soft.wav`, "Soft mallet"** (2026-10-14, Alex): a wooden double tap, the second
tap a touch higher (520 Hz then 640 Hz, 120 ms apart), struck with a felt mallet (almost
no click, rounded attack). 48 kHz mono 16-bit, 0.6 s. The shipped copy is
`gui/build/alert.wav`, embedded in the GUI binary.

## How it was made

Synthesised with the Python standard library only, no samples:

* `gen.py`: the first round (chime, glass, marimba, wood, forge, bloom). "Wood" won.
* `wood.py`: variations on "Wood", with the primitives copied from `gen.py` (sine
  partials with an exponential decay, filtered noise for the click). `soft` is the one
  shipped.
* Every sound gets a 30 ms fade-out and is loudness-normalised: -18 dBFS RMS over its
  loudest 150 ms window, with at least 1 dB of peak headroom.
* `wood.html`: the listening page used to choose (the WAVs inlined as base64, with a
  volume slider).

## Regenerate

```
python3 -I wood.py <outdir>     # writes every wood variant; soft.wav is the shipped one
python3 -I gen.py <outdir>      # the first round
```

The output is deterministic (`random.seed(7)`): `wood.py`'s `soft.wav` is byte-identical
to this directory's copy and to `gui/build/alert.wav`.
