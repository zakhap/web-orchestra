# score

The composition lives here as data. Iterating on the music never means
touching the engine.

```
build_demo.py    authors demo-v1.json (the composition itself lives in CELLS)
demo-v1.json     the score: tuning, phases, cells, global arc, tier table
preview.py       offline renderer — N agents perform the score straight to WAV
```

## Pitch model

Every pitch is an **integer partial of one fundamental** (55 Hz). Partial 8 is
440 Hz, partial 11 is 605 Hz. `pitch_hz = fundamental_hz * partial`.

This is doing real work. Adjacency compatibility — that any cells sounding
within ±3 positions must sound intentional together — is the piece's central
compositional constraint. Because every simultaneity is a subset of a single
harmonic series, there is no bad chord available. The constraint is satisfied
by construction rather than by vigilance.

## Form

*In C* drifts by leaking new pitches into the collection. Here the drift is up
the harmonic series and back — the fundamental never moves, but the harmonic
*limit* rises through the lap and returns:

| phase | partials admitted | character |
|-------|-------------------|-----------|
| A home     | 4,5,6,8,9,10,12,15,16,18,20 | 5-limit; pure thirds |
| B septimal | + 7, 14, 21                 | the 7th harmonic, 31¢ under a tempered ♭7 |
| C alien    | + 11, 13, 22                | neutral intervals with no keyboard equivalent |
| D return   | sheds 13, 11, then 7        | back to 5-limit, rejoining phase A |

Cells 23 and 24 restate cells 2 and 1. That joint is the **seam**, composed
first so the ring closes.

## Cell lengths are material, not packaging

Lengths come from **{3, 4, 5, 7}** — pairwise coprime except 4 — so cells of
different lengths cycle against each other for 420 beats (≈3.9 min) before
everything realigns. The first draft used {2,3,4,6,8}, which shares small
factors and resets every 24 beats; phase relationships collapsed in 13 seconds
and the texture went flat.

Two things must both hold for phasing to happen:

1. **coprime lengths** (above), and
2. **staggered entry** — voices enter on a seeded beat offset. Without this
   every agent starts its cell on the same beat and voices sharing a cell play
   in exact unison, which throws the coprime lengths away. The offset a voice
   enters on is the offset it keeps.

Voices that do land on the same offset still do not phase-lock: per-voice
detune and the fixed 0–15 ms offset turn coincidence into chorus.

## Rendering

```bash
python3 preview.py --seed 22 --seconds 240 --voices 14 --patience 5.5 -o take.wav
python3 preview.py --seed 22 --seconds 90  --voices 3  --patience 9   -o chamber.wav
```

`--patience` is mean beats a voice dwells on a cell. Low values walk the pack
around the ring quickly, which is how you audition the whole harmonic arc in
one short take; high values are how the piece actually behaves at population.

**Every run is fully determined by `--seed` plus the score.** Same seed, same
score, bit-identical audio — so score v2 can be A/B'd against v1 with agent
behaviour held constant. Do not introduce unseeded randomness (T1).

## Known gaps

- Cells are authored in Python, not MIDI. The MIDI→score compiler (M1) still
  needs writing; the score format is ready for it, since a MIDI note number
  maps cleanly onto a partial index.
- The tier table is present but the compiler that turns it into continuous
  curves over smoothed population (so nothing can snap) is not written yet.
- `preview.py` synthesises its own mallet tone. The real instrument pool lives
  in `audio/synthdefs.scd` and these must eventually be the same instruments.
