#!/usr/bin/env python3
"""
Authors demo-v1.json — the first real score for the server orchestra.

Pitch model
-----------
Every pitch is an integer partial of ONE fundamental (55 Hz, A1). Not a scale
of ratios: literally the harmonic series. Partial 8 is 440 Hz, partial 11 is
605 Hz, partial 14 is 770 Hz.

This is the whole trick. Adjacency compatibility — the piece's central
compositional constraint, that any cells sounding within ±3 positions of each
other must sound intentional — is nearly automatic, because every simultaneity
is a subset of a single harmonic series. There is no bad chord available.

Form
----
In C drifts by leaking new pitches into the collection (F#, then Bb). Here the
drift is up the harmonic series and back: the fundamental never moves, but the
harmonic LIMIT rises through the lap and returns. Phase D is voiced to overlap
phase A so the ring closes at the seam.

Cells 23 and 24 deliberately restate cells 2 and 1. That joint is the seam,
composed first, per the roadmap.
"""
import json, pathlib

FUNDAMENTAL = 55.0          # A1
BPM = 108                   # quarter note
SUBDIVISION = 2             # the pulse ticks eighths

PHASES = [
    dict(id="A", name="home",     partials=[4,5,6,8,9,10,12,15,16,18,20],
         note="5-limit. Pure thirds and fifths, familiar and open."),
    dict(id="B", name="septimal", partials=[7,14,21],
         note="The 7th harmonic enters: 31 cents under a tempered flat 7th."),
    dict(id="C", name="alien",    partials=[11,13,22],
         note="11 and 13 — neutral intervals with no keyboard equivalent."),
    dict(id="D", name="return",   partials=[],
         note="Sheds 13, then 11, then 7. Rejoins phase A at the seam."),
]

# (partial, onset in beats, duration in beats)
#
# Cell LENGTHS are compositional material, not packaging. They are drawn from
# {3,4,5,7} — pairwise coprime except 4 — so cells of different lengths cycle
# against each other for a very long time before realigning. Two voices on the
# same 5-beat cell, arrived at from different histories, sit at different
# offsets inside it and stay there. That drift is the piece's main engine of
# interest, and it is entirely a function of these numbers: with lengths of
# {2,3,4,6,8} everything resets every 24 beats and the texture goes flat.
CELLS = [
    # ---- A: home -----------------------------------------------------------
    (1,  "A", 5, [(8,0,4.5)]),
    (2,  "A", 3, [(8,0,.5),(9,.5,.5),(8,1,.5),(9,1.5,1.5)]),
    (3,  "A", 3, [(8,0,.5),(9,.5,.5),(10,1,.5),(9,1.5,.5),(8,2,1)]),
    (4,  "A", 4, [(12,0,1),(10,1,1),(9,2,1),(8,3,1)]),
    (5,  "A", 7, [(6,0,1.5),(8,1.5,1.5),(9,3,1),(10,4,1),(8,5,2)]),
    (6,  "A", 5, [(8,0,1),(10,1,1),(12,2,1.5),(10,3.5,1.5)]),
    # ---- B: the seventh arrives --------------------------------------------
    (7,  "B", 5, [(8,0,.5),(9,.5,.5),(10,1,.5),(14,1.5,3.5)]),
    (8,  "B", 3, [(14,0,1),(12,1,1),(14,2,1)]),
    (9,  "B", 7, [(7,0,2),(8,2,1.5),(7,3.5,1.5),(6,5,2)]),
    (10, "B", 5, [(12,0,1),(14,1,2),(16,3,2)]),
    (11, "B", 4, [(14,0,4)]),
    (12, "B", 7, [(10,0,1),(12,1,1),(14,2,2),(12,4,1),(10,5,2)]),
    # ---- C: 11 and 13 ------------------------------------------------------
    (13, "C", 5, [(11,0,5)]),
    (14, "C", 3, [(10,0,.5),(11,.5,1),(12,1.5,.5),(11,2,1)]),
    (15, "C", 7, [(11,0,2),(13,2,2),(11,4,1.5),(9,5.5,1.5)]),
    (16, "C", 5, [(8,0,1.5),(11,1.5,1.5),(13,3,2)]),
    (17, "C", 4, [(13,0,1),(12,1,1),(11,2,1),(10,3,1)]),
    (18, "C", 3, [(22,0,1),(11,1,1),(13,2,1)]),
    # ---- D: retreat, and close the ring ------------------------------------
    (19, "D", 3, [(11,0,1),(10,1,1),(9,2,1)]),
    (20, "D", 5, [(14,0,2),(12,2,1.5),(10,3.5,1.5)]),
    (21, "D", 7, [(10,0,1.5),(9,1.5,1.5),(8,3,2),(9,5,2)]),
    (22, "D", 4, [(12,0,1),(10,1,1),(8,2,2)]),
    (23, "D", 3, [(8,0,.5),(9,.5,.5),(8,1,.5),(9,1.5,1.5)]),  # echoes cell 2
    (24, "D", 5, [(8,0,4.5)]),                                 # echoes cell 1 — SEAM
]

score = {
    "id": "demo-v1",
    "title": "harmonic drift",
    "note": "Partials of one fundamental. The limit rises and falls; the key never moves.",
    "pulse": {"bpm": BPM, "subdivision": SUBDIVISION},
    "tuning": {
        "kind": "harmonic-series",
        "fundamental_hz": FUNDAMENTAL,
        "comment": "pitch_hz = fundamental_hz * partial. Any subset is consonant.",
    },
    "phases": PHASES,
    "cells": [
        {"n": n, "phase": ph, "beats": b,
         "events": [{"partial": p, "at": a, "dur": d} for (p, a, d) in ev]}
        for (n, ph, b, ev) in CELLS
    ],
    # Global arc over lap position (0..1), multiplied into every voice.
    "arc": {"dynamics": [[0.0,0.72],[0.25,0.88],[0.5,1.0],[0.72,0.94],[0.9,0.78],[1.0,0.72]]},
    # Tier table; the compiler turns this into continuous curves over smoothed
    # population so nothing can snap. Placeholder values pending rehearsal.
    "tiers": [
        {"name":"chamber",  "upto":8,  "dwell_beats":[12,28], "voice_amp":0.34},
        {"name":"ensemble", "upto":24, "dwell_beats":[20,44], "voice_amp":0.22},
        {"name":"orchestra","upto":60, "dwell_beats":[28,60], "voice_amp":0.14},
        {"name":"mass",     "upto":999,"dwell_beats":[36,76], "voice_amp":0.09},
    ],
}

out = pathlib.Path(__file__).parent / "demo-v1.json"
out.write_text(json.dumps(score, indent=2) + "\n")
print(f"wrote {out}  ({len(CELLS)} cells, {sum(c[2] for c in CELLS)} beats of material)")
