// synthdefs.scd — compiled to .scsyndef binaries at Docker build time.
// Run: QT_QPA_PLATFORM=offscreen sclang audio/synthdefs.scd
// Writes defs to the directory given by SC_SYNTHDEF_PATH (default /app/synthdefs).

(
var outDir = "SC_SYNTHDEF_PATH".getenv ? "/app/synthdefs";

// One sustained ensemble voice. Every listener gets one of these.
// Slow ASR envelope so voices materialize and dissolve rather than switch.
// Per-voice detune + slow pitch drift so identical instruments chorus
// instead of phase-locking.
SynthDef(\voice, { |out = 0, freq = 220, amp = 0.14, cutoff = 1200,
                   pan = 0, gate = 1, detune = 0.006, seed = 0|
	var drift, sig, env;
	RandID.ir(seed);
	RandSeed.ir(1, seed + 1);
	// slow random-walk pitch drift, a few cents, unique per seed
	drift = LFNoise2.kr(0.07).range(detune.neg, detune) + 1;
	sig = Mix.fill(3, { |i|
		Saw.ar(freq * drift * (1 + (detune * (i - 1))), 1/3)
	});
	sig = RLPF.ar(sig, cutoff.lag(0.8), 0.4);
	env = EnvGen.kr(Env.asr(7, 1, 10, [3, -3]), gate, doneAction: 2);
	sig = Pan2.ar(sig * env * amp, pan);
	Out.ar(out, sig);
}).writeDefFile(outDir);

// The Pulse — the piece's permanent heartbeat. Runs from boot, forever.
SynthDef(\pulse, { |out = 0, freq = 880, tempo = 1.8, amp = 0.09|
	var trig = Impulse.kr(tempo);
	var env = Decay2.kr(trig, 0.002, 0.22);
	var sig = SinOsc.ar(freq) * env * amp;
	Out.ar(out, Pan2.ar(sig, 0));
}).writeDefFile(outDir);

// A low anchor drone so the stream is never silent even at population 0.
SynthDef(\anchor, { |out = 0, freq = 55, amp = 0.22, cutoff = 500|
	var sig = Mix.fill(4, { |i|
		Saw.ar(freq * (1 + (0.004 * (i - 1.5))) * [1, 2][i % 2], 0.25)
	});
	sig = RLPF.ar(sig, cutoff, 0.5);
	sig = sig * LFNoise2.kr(0.05).range(0.7, 1.0); // slow breathing
	Out.ar(out, Pan2.ar(sig * amp, 0));
}).writeDefFile(outDir);

// A struck tone — the sequencer's instrument. One synth per note, freed by
// doneAction, so the conductor never tracks note nodes. Partial content
// matches score/preview.py so what the composer auditions offline is what
// the stream actually plays.
SynthDef(\tone, { |out = 0, freq = 440, amp = 0.2, dur = 0.5, pan = 0, bright = 0.5|
	var env, sig, b;
	b = bright.clip(0, 1);
	env = EnvGen.kr(Env.perc(0.008, dur.max(0.08), 1, -4), doneAction: 2);
	sig = SinOsc.ar(freq)
		+ (SinOsc.ar(freq * 2) * 0.32 * b)
		+ (SinOsc.ar(freq * 3) * 0.14 * b)
		+ (SinOsc.ar(freq * 4) * 0.07 * b * b)
		+ (SinOsc.ar(freq * 5) * 0.035 * b * b);
	sig = sig * env * amp;
	Out.ar(out, Pan2.ar(sig, pan));
}).writeDefFile(outDir);

// The master stage. Runs in a tail group so it sees the summed orchestra.
// Without this the piece has no ceiling: sixty voices simply add up and clip.
// With it, the anchors can be raised to an audible level AND a crowd survives.
SynthDef(\master, { |out = 0, amp = 1.0, ceiling = 0.92|
	var sig = In.ar(out, 2);
	sig = Limiter.ar(sig * amp, ceiling, 0.01);
	ReplaceOut.ar(out, sig);
}).writeDefFile(outDir);

("synthdefs written to " ++ outDir).postln;
0.exit;
)
