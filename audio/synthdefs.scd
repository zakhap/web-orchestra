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
SynthDef(\pulse, { |out = 0, freq = 880, tempo = 1.8, amp = 0.05|
	var trig = Impulse.kr(tempo);
	var env = Decay2.kr(trig, 0.002, 0.22);
	var sig = SinOsc.ar(freq) * env * amp;
	Out.ar(out, Pan2.ar(sig, 0));
}).writeDefFile(outDir);

// A low anchor drone so the stream is never silent even at population 0.
SynthDef(\anchor, { |out = 0, freq = 55, amp = 0.1, cutoff = 500|
	var sig = Mix.fill(4, { |i|
		Saw.ar(freq * (1 + (0.004 * (i - 1.5))) * [1, 2][i % 2], 0.25)
	});
	sig = RLPF.ar(sig, cutoff, 0.5);
	sig = sig * LFNoise2.kr(0.05).range(0.7, 1.0); // slow breathing
	Out.ar(out, Pan2.ar(sig * amp, 0));
}).writeDefFile(outDir);

("synthdefs written to " ++ outDir).postln;
0.exit;
)
