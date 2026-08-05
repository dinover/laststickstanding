/* Procedural audio system for Last Stick Standing (FreeConsole build: screen.html +
   controller.html). Web Audio API only — no libraries, no audio files, nothing loaded
   from disk. Everything below is synthesized in real time.

   AudioManager.on.* is the ONLY surface the game touches. Game code never creates an
   oscillator, never knows a scale exists — it just says "a punch landed" or "round
   started" and this file decides what that sounds like. That's the seam that lets any
   of this be swapped later (e.g. MusicManager's procedural sequencer replaced by real
   audio tracks) without touching screen.html/controller.html at all.

   Layout: Mixer/Master -> SynthEngine (primitives) -> InstrumentLibrary -> Sequencer
   -> MusicManager (IMusicSource) + SFXGenerator -> AudioManager.on (EventRouter). */
var AudioManager = (function () {
  "use strict";

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ================================================================== settings */
  var STORAGE_KEY = "lss_audio_settings";
  var settings = { master: 0.8, music: 0.65, sfx: 0.9, muted: false };
  (function loadSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      for (var k in parsed) if (k in settings) settings[k] = parsed[k];
    } catch (e) { /* localStorage unavailable — fall back to defaults, non-fatal */ }
  })();
  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  /* ================================================================== Mixer / Master */
  var ctx = null;
  var masterGain, musicBus, musicFilter, sfxBus, reverbSend, reverbDelay, reverbDamp, reverbFeedback;
  var noiseBuffer = null;
  var ready = false;

  function now() { return ctx.currentTime; }

  function init() {
    if (ready) return;
    ready = true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // unsupported browser — the game just stays silent, nothing crashes
    ctx = new AC();

    masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);

    musicBus = ctx.createGain();
    musicFilter = ctx.createBiquadFilter();
    musicFilter.type = "lowpass";
    musicFilter.frequency.value = 18000;
    musicBus.connect(musicFilter);
    musicFilter.connect(masterGain);

    sfxBus = ctx.createGain();
    sfxBus.connect(masterGain);

    // A tiny feedback-delay "room" used sparingly by big hits (KO, victory) — a simple
    // reverb without needing a convolution impulse file.
    reverbSend = ctx.createGain(); reverbSend.gain.value = 1;
    reverbDelay = ctx.createDelay(1.0); reverbDelay.delayTime.value = 0.17;
    reverbDamp = ctx.createBiquadFilter(); reverbDamp.type = "lowpass"; reverbDamp.frequency.value = 2800;
    reverbFeedback = ctx.createGain(); reverbFeedback.gain.value = 0.3;
    reverbSend.connect(reverbDelay);
    reverbDelay.connect(reverbDamp);
    reverbDamp.connect(reverbFeedback);
    reverbFeedback.connect(reverbDelay);
    reverbDamp.connect(sfxBus);

    applyVolumes();
    noiseBuffer = buildNoiseBuffer();
    Music.init();
    Music.start();
  }

  function applyVolumes() {
    if (!ctx) return;
    var m = settings.muted ? 0 : settings.master;
    var t = now();
    masterGain.gain.setTargetAtTime(m, t, 0.02);
    musicBus.gain.setTargetAtTime(settings.music, t, 0.02);
    sfxBus.gain.setTargetAtTime(settings.sfx, t, 0.02);
  }

  function setMasterVolume(v) { settings.master = clamp01(v); applyVolumes(); saveSettings(); }
  function setMusicVolume(v) { settings.music = clamp01(v); applyVolumes(); saveSettings(); }
  function setSfxVolume(v) { settings.sfx = clamp01(v); applyVolumes(); saveSettings(); }
  function setMuted(m) { settings.muted = !!m; applyVolumes(); saveSettings(); }
  function getSettings() { return { master: settings.master, music: settings.music, sfx: settings.sfx, muted: settings.muted }; }

  // Browsers refuse to start an AudioContext before a real user gesture. This arms a
  // one-shot listener so the very first click/tap/keypress on the page silently boots
  // the whole audio system — no "click to enable sound" prompt needed.
  function armUnlock() {
    function unlock() {
      init();
      if (ctx && ctx.state === "suspended") ctx.resume();
    }
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  function buildNoiseBuffer() {
    var len = Math.floor(ctx.sampleRate * 1.5);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Ducks the music bus for a big hit — a small sidechain-style dip and recovery.
  function duckMusic(amount, ms) {
    if (!ctx) return;
    var t0 = now();
    var base = settings.music;
    musicBus.gain.cancelScheduledValues(t0);
    musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), t0);
    musicBus.gain.linearRampToValueAtTime(base * (1 - amount), t0 + 0.02);
    musicBus.gain.linearRampToValueAtTime(base, t0 + ms / 1000);
  }

  /* ================================================================== SynthEngine */
  // One oscillator/buffer-source per note is correct and standard for Web Audio (a node
  // can't be restarted once stopped) — what actually gets reused across the whole
  // session are the buses, the filters and the noise buffer built above.

  function tone(freq, opts, bus, atTime) {
    opts = opts || {};
    var t0 = atTime != null ? atTime : now();
    var type = opts.type || "sawtooth";
    var dur = opts.dur != null ? opts.dur : 0.2;
    var attack = opts.attack != null ? opts.attack : 0.005;
    var release = opts.release != null ? opts.release : 0.08;
    var peak = opts.peak != null ? opts.peak : 0.5;

    var osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.detune) osc.detune.setValueAtTime(opts.detune, t0);
    if (opts.pitchTo != null) {
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.pitchTo), t0 + (opts.pitchTime || dur));
    }

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.linearRampToValueAtTime(peak * 0.7, t0 + attack + dur * 0.5);
    g.gain.linearRampToValueAtTime(0, t0 + dur + release);

    var outNode = g;
    if (opts.filterFreq != null) {
      var filt = ctx.createBiquadFilter();
      filt.type = opts.filterType || "lowpass";
      filt.frequency.setValueAtTime(opts.filterFreq, t0);
      if (opts.filterQ) filt.Q.setValueAtTime(opts.filterQ, t0);
      osc.connect(filt);
      filt.connect(g);
    } else {
      osc.connect(g);
    }
    g.connect(bus || sfxBus);
    if (opts.reverb) g.connect(reverbSend);

    osc.start(t0);
    osc.stop(t0 + dur + release + 0.05);
    osc.onended = function () { osc.disconnect(); g.disconnect(); };
    return { osc: osc, gain: g };
  }

  function noiseBurst(opts, bus, atTime) {
    opts = opts || {};
    var t0 = atTime != null ? atTime : now();
    var dur = opts.dur != null ? opts.dur : 0.12;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    var offset = Math.random() * Math.max(0.01, noiseBuffer.duration - dur - 0.01);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(opts.peak != null ? opts.peak : 0.4, t0 + (opts.attack || 0.003));
    g.gain.linearRampToValueAtTime(0, t0 + dur);

    if (opts.filterFreq != null) {
      var filt = ctx.createBiquadFilter();
      filt.type = opts.filterType || "highpass";
      filt.frequency.setValueAtTime(opts.filterFreq, t0);
      if (opts.filterSweepTo != null) filt.frequency.exponentialRampToValueAtTime(Math.max(1, opts.filterSweepTo), t0 + dur);
      if (opts.filterQ) filt.Q.setValueAtTime(opts.filterQ, t0);
      src.connect(filt);
      filt.connect(g);
    } else {
      src.connect(g);
    }
    g.connect(bus || sfxBus);
    if (opts.reverb) g.connect(reverbSend);

    src.start(t0, offset, dur);
    src.onended = function () { src.disconnect(); g.disconnect(); };
    return { src: src, gain: g };
  }

  /* ================================================================== scales / notes / biome themes */
  // All dark/arcade scales — deliberately avoid sounding cheerful. Each biome (from
  // world.js's Biomes) gets its own root/scale/timbre AND its own rhythmic patterns +
  // ambient texture generator, so the same state machine (lobby/countdown/fight/clutch/
  // victory) genuinely sounds like a different track per map — not just "same song,
  // different key" — while tempo (128 BPM) never changes.
  var SCALES = {
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],      // natural minor
    dorian: [0, 2, 3, 5, 7, 9, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  };

  var BIOME_THEMES = {
    // Dark, sparse, echoing — ancient stone. The "default" feel.
    ruinas: {
      root: 55, scale: "phrygian", bright: 1.0, bassWave: "sawtooth", leadWave: "square", detune: -6,
      kickDiv: 4,
      bassPattern: [0, null, null, null, null, null, 3, null, 0, null, null, null, 5, null, null, null],
      leadDegrees: [0, 3, 5, 7], leadDiv: 4,
      percStyle: "default",
      ambientEvery: 16, ambient: function (t) { Instruments.ambientEcho(t); },
    },
    // Aggressive, tribal, driving — low rumble and double-time kicks.
    volcan: {
      root: 49, scale: "harmonicMinor", bright: 0.7, bassWave: "square", leadWave: "sawtooth", detune: -10,
      kickDiv: 2,
      bassPattern: [0, null, 3, null, 0, null, 3, null, 0, null, 5, null, 0, null, 3, null],
      leadDegrees: [0, 1, 3, 5], leadDiv: 4,
      percStyle: "tribal",
      ambientEvery: 8, ambient: function (t) { Instruments.ambientRumble(t); },
      stateOverrides: { fight: { kick: 1 }, clutch: { kick: 1 } },
    },
    // Organic, airy, sparse — soft pad, gentle shaker, occasional bird-like pluck.
    bosque: {
      root: 58, scale: "dorian", bright: 0.85, bassWave: "triangle", leadWave: "triangle", detune: -3,
      kickDiv: 8,
      bassPattern: [0, null, null, null, null, null, null, null, null, 4, null, null, null, null, null, null],
      leadDegrees: [0, 2, 4, 6], leadDiv: 4,
      percStyle: "soft",
      ambientEvery: 24, ambient: function (t) { Instruments.ambientAir(t); },
    },
    // Bright synthwave pulse — dense claps/hats, always-on arpeggio, octave-jump bass.
    neon: {
      root: 55, scale: "aeolian", bright: 1.35, bassWave: "sawtooth", leadWave: "square", detune: -14,
      kickDiv: 4,
      bassPattern: [0, null, 0, null, 7, null, 0, null, 0, null, 0, null, 7, null, 0, null],
      leadDegrees: [0, 4, 7, 4], leadDiv: 2,
      percStyle: "pulse",
      ambientEvery: 16, ambient: function (t) { Instruments.ambientShimmer(t); },
      stateOverrides: { fight: { arp: 0.55 }, clutch: { arp: 0.8 } },
    },
    // Cold, glassy, hushed — near-silent bass, sparse bell tones, wind texture.
    nieve: {
      root: 62, scale: "aeolian", bright: 1.15, bassWave: "triangle", leadWave: "square", detune: -4,
      kickDiv: 8,
      bassPattern: [0, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      leadDegrees: [0, 4], leadDiv: 8,
      percStyle: "sparse",
      ambientEvery: 16, ambient: function (t) { Instruments.ambientBell(t); },
    },
  };
  var DEFAULT_THEME = BIOME_THEMES.ruinas;
  var theme = DEFAULT_THEME;

  function setBiome(biomeId) {
    theme = BIOME_THEMES[biomeId] || DEFAULT_THEME;
  }

  function noteFreq(degree, octave) {
    octave = octave || 0;
    var scale = SCALES[theme.scale] || SCALES.phrygian;
    var idx = ((degree % scale.length) + scale.length) % scale.length;
    var octShift = Math.floor(degree / scale.length) + octave;
    var semis = scale[idx] + octShift * 12;
    return theme.root * Math.pow(2, semis / 12);
  }

  /* ================================================================== BPM / layers */
  var BPM = 128;
  var STEP_DUR = 60 / BPM / 4; // one 16th note, seconds
  var LOOKAHEAD = 0.12;

  var LAYER_NAMES = ["kick", "bass", "pad", "lead", "arp", "perc", "fx", "amb"];
  var layerGains = {};   // persistent GainNode per layer, created once
  var layerTargets = {}; // current state's target level per layer, 0..1

  function buildLayers() {
    LAYER_NAMES.forEach(function (name) {
      var g = ctx.createGain();
      g.gain.value = 0;
      g.connect(musicBus);
      layerGains[name] = g;
      layerTargets[name] = 0;
    });
  }

  /* ================================================================== InstrumentLibrary */
  var Instruments = {
    kick: function (t) {
      var osc = ctx.createOscillator(); osc.type = "sine";
      var g = ctx.createGain();
      osc.connect(g); g.connect(layerGains.kick);
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.11);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.9, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
      osc.start(t); osc.stop(t + 0.3);
      osc.onended = function () { osc.disconnect(); g.disconnect(); };
    },
    snare: function (t) {
      noiseBurst({ dur: 0.13, peak: 0.35, filterFreq: 1500, filterType: "bandpass", filterQ: 0.8 }, layerGains.perc, t);
      tone(190, { type: "triangle", dur: 0.05, attack: 0.001, release: 0.05, peak: 0.25 }, layerGains.perc, t);
    },
    hat: function (t) {
      noiseBurst({ dur: 0.045, peak: 0.16, filterFreq: 7000, filterType: "highpass" }, layerGains.perc, t);
    },
    bassNote: function (freq, dur, t) {
      tone(freq, {
        type: theme.bassWave, dur: dur, attack: 0.008, release: 0.05, peak: 0.55,
        filterFreq: 420 * theme.bright, filterType: "lowpass", filterQ: 1.2,
      }, layerGains.bass, t);
    },
    leadNote: function (freq, dur, t) {
      tone(freq, { type: theme.leadWave, dur: dur, attack: 0.004, release: 0.06, peak: 0.28, filterFreq: 3200 * theme.bright, filterType: "lowpass" }, layerGains.lead, t);
      tone(freq * 1.005, { type: "sawtooth", dur: dur, attack: 0.004, release: 0.06, peak: 0.16, detune: theme.detune }, layerGains.lead, t);
    },
    padChord: function (freqs, dur, t) {
      freqs.forEach(function (f) {
        tone(f, { type: "triangle", dur: dur, attack: 0.6, release: 0.9, peak: 0.22, filterFreq: 1200 * theme.bright, filterType: "lowpass" }, layerGains.pad, t);
      });
    },
    arpNote: function (freq, dur, t) {
      tone(freq, { type: theme.leadWave, dur: dur, attack: 0.002, release: 0.03, peak: 0.18, filterFreq: 4500 * theme.bright, filterType: "lowpass" }, layerGains.arp, t);
    },
    noiseFX: function (t) {
      noiseBurst({ dur: 1.4, peak: 0.14, filterFreq: 300, filterSweepTo: 6000, filterType: "bandpass", filterQ: 2 }, layerGains.fx, t);
    },

    /* ---- extra percussion voices, picked per biome by percStyle ---- */
    tom: function (t) {
      var osc = ctx.createOscillator(); osc.type = "sine";
      var g = ctx.createGain();
      osc.connect(g); g.connect(layerGains.perc);
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.exponentialRampToValueAtTime(90, t + 0.15);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.start(t); osc.stop(t + 0.22);
      osc.onended = function () { osc.disconnect(); g.disconnect(); };
    },
    softHat: function (t) {
      noiseBurst({ dur: 0.035, peak: 0.09, filterFreq: 5500, filterType: "highpass" }, layerGains.perc, t);
    },
    clap: function (t) {
      noiseBurst({ dur: 0.08, peak: 0.3, filterFreq: 1600, filterType: "bandpass", filterQ: 1.4 }, layerGains.perc, t);
      noiseBurst({ dur: 0.06, peak: 0.18, filterFreq: 1800, filterType: "bandpass", filterQ: 1.4 }, layerGains.perc, t + 0.015);
    },

    /* ---- ambient textures, one per biome, called sparsely by the sequencer ---- */
    ambientEcho: function (t) {
      // Ruinas: a sparse pluck with a quiet delayed repeat, like a note echoing off stone.
      Instruments.arpNoteTo(layerGains.amb, noteFreq(theme.leadDegrees[0], 0), 0.4, t, 0.16);
      Instruments.arpNoteTo(layerGains.amb, noteFreq(theme.leadDegrees[2], 0), 0.35, t + 0.16, 0.08);
    },
    ambientRumble: function (t) {
      // Volcán: a long low rumble plus an occasional distant sub boom.
      noiseBurst({ dur: 3.2, peak: 0.16, filterFreq: 90, filterType: "lowpass" }, layerGains.amb, t);
      tone(38, { type: "sine", dur: 0.5, attack: 0.2, release: 0.6, peak: 0.3 }, layerGains.amb, t);
    },
    ambientAir: function (t) {
      // Bosque: a soft wind swell, occasionally with a short high "bird" chirp.
      noiseBurst({ dur: 2.6, peak: 0.09, filterFreq: 900, filterType: "bandpass", filterQ: 0.6 }, layerGains.amb, t);
      if (Math.random() < 0.5) {
        tone(noteFreq(theme.leadDegrees[3], 3), { type: "triangle", dur: 0.12, attack: 0.005, release: 0.15, peak: 0.1 }, layerGains.amb, t + 0.3);
      }
    },
    ambientShimmer: function (t) {
      // Neón: bright sizzling texture plus a detuned sustained shimmer note.
      noiseBurst({ dur: 0.9, peak: 0.1, filterFreq: 6000, filterType: "highpass" }, layerGains.amb, t);
      tone(noteFreq(theme.leadDegrees[0], 2), { type: "sawtooth", dur: 1.2, attack: 0.4, release: 0.6, peak: 0.12, detune: theme.detune * 2, filterFreq: 5000 }, layerGains.amb, t);
    },
    ambientBell: function (t) {
      // Nieve: airy wind plus a soft glassy bell tone with a long tail.
      noiseBurst({ dur: 2.0, peak: 0.07, filterFreq: 2200, filterType: "bandpass", filterQ: 0.5 }, layerGains.amb, t);
      tone(noteFreq(theme.leadDegrees[1], 3), { type: "triangle", dur: 1.0, attack: 0.01, release: 1.4, peak: 0.14, filterFreq: 6000 }, layerGains.amb, t);
    },
    // small helper so ambientEcho can send its plucks to an arbitrary bus/time
    arpNoteTo: function (bus, freq, peak, t, dur) {
      tone(freq, { type: theme.leadWave, dur: dur || 0.2, attack: 0.002, release: 0.15, peak: peak, filterFreq: 4000 * theme.bright }, bus, t);
    },
  };

  /* ================================================================== Sequencer */
  // Standard "look-ahead" scheduler: driven by requestAnimationFrame, but every note
  // start time is computed from audioCtx.currentTime, never from setTimeout/setInterval
  // wall-clock delays — so there is no drift no matter how the render loop jitters.
  var stepIndex = 0, nextStepTime = 0, schedulerRunning = false, schedulerRaf = null;

  function playPerc(style, step, t) {
    if (style === "tribal") {
      if (step % 2 === 0) Instruments.hat(t);
      if (step === 3 || step === 7 || step === 11 || step === 15) Instruments.tom(t);
    } else if (style === "soft") {
      if (step % 2 === 1) Instruments.softHat(t);
    } else if (style === "pulse") {
      Instruments.hat(t); // dense 16th hats — synthwave pulse
      if (step % 4 === 0) Instruments.clap(t);
    } else if (style === "sparse") {
      if (step % 4 === 0) Instruments.softHat(t);
    } else {
      if (step % 2 === 1) Instruments.hat(t);
      if (step === 4 || step === 12) Instruments.snare(t);
    }
  }

  function scheduleStep(step, t) {
    var th = theme;
    if (layerTargets.kick > 0.01 && step % th.kickDiv === 0) Instruments.kick(t);
    if (layerTargets.bass > 0.01 && th.bassPattern[step] != null) Instruments.bassNote(noteFreq(th.bassPattern[step], -1), STEP_DUR * 3.2, t);
    if (layerTargets.pad > 0.01 && step === 0) Instruments.padChord([noteFreq(0, 0), noteFreq(2, 0), noteFreq(4, 0)], STEP_DUR * 16, t);
    if (layerTargets.lead > 0.01 && step % th.leadDiv === 2) {
      var ld = th.leadDegrees[(step >> 2) % th.leadDegrees.length];
      Instruments.leadNote(noteFreq(ld, 1), STEP_DUR * (th.leadDiv * 0.65), t);
    }
    if (layerTargets.perc > 0.01) playPerc(th.percStyle, step, t);
    if (layerTargets.arp > 0.01) Instruments.arpNote(noteFreq(th.leadDegrees[step % th.leadDegrees.length], 2), STEP_DUR * 0.85, t);
    if (layerTargets.fx > 0.01 && step === 0) Instruments.noiseFX(t);
    if (layerTargets.amb > 0.01 && step % th.ambientEvery === 0) th.ambient(t);
  }

  function schedulerTick() {
    if (!schedulerRunning) return;
    while (nextStepTime < now() + LOOKAHEAD) {
      scheduleStep(stepIndex, nextStepTime);
      nextStepTime += STEP_DUR;
      stepIndex = (stepIndex + 1) % 16;
    }
    schedulerRaf = requestAnimationFrame(schedulerTick);
  }

  function startScheduler() {
    if (schedulerRunning) return;
    schedulerRunning = true;
    stepIndex = 0;
    nextStepTime = now() + 0.05;
    schedulerRaf = requestAnimationFrame(schedulerTick);
  }

  /* ================================================================== MusicManager (IMusicSource) */
  // { start(), stop(), setState(name), setIntensity(0..1) } — the only shape that
  // matters to the rest of the game. A future non-procedural source (real tracks, an
  // <audio> element, whatever) could implement the same four methods and swap in here
  // without a single line changing outside this file.
  var STATES = {
    lobby: { kick: 0, bass: 0.5, pad: 0.7, lead: 0, arp: 0, perc: 0, fx: 0, amb: 0.5, filter: 16000 },
    countdown: { kick: 0, bass: 0.5, pad: 0.7, lead: 0, arp: 0, perc: 0, fx: 0, amb: 0.4, filter: 500 },
    fight: { kick: 0.9, bass: 0.85, pad: 0.28, lead: 0.7, arp: 0, perc: 0.65, fx: 0, amb: 0.22, filter: 18000 },
    clutch: { kick: 1, bass: 1, pad: 0.3, lead: 0.9, arp: 0.55, perc: 0.85, fx: 0.4, amb: 0.3, filter: 18000 },
    gameOver: { kick: 0, bass: 0.3, pad: 0.5, lead: 0, arp: 0, perc: 0, fx: 0, amb: 0.35, filter: 400 },
    silent: { kick: 0, bass: 0, pad: 0, lead: 0, arp: 0, perc: 0, fx: 0, amb: 0, filter: 18000 },
  };
  var currentStateName = "lobby";
  var intensity = 1;

  function applyState(name, rampMs) {
    var base = STATES[name] || STATES.lobby;
    var cfg = {};
    for (var k in base) cfg[k] = base[k];
    var overrides = theme.stateOverrides && theme.stateOverrides[name];
    if (overrides) for (var k2 in overrides) cfg[k2] = overrides[k2];
    var t = now();
    var ramp = (rampMs != null ? rampMs : 550) / 1000;
    LAYER_NAMES.forEach(function (layer) {
      var target = clamp01((cfg[layer] || 0) * intensity);
      layerTargets[layer] = target;
      var g = layerGains[layer];
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(target, t + ramp);
    });
    musicFilter.frequency.cancelScheduledValues(t);
    musicFilter.frequency.setValueAtTime(musicFilter.frequency.value, t);
    musicFilter.frequency.linearRampToValueAtTime(cfg.filter, t + ramp);
  }

  var Music = {
    init: function () { buildLayers(); },
    start: function () { currentStateName = "lobby"; applyState("lobby", 50); startScheduler(); },
    stop: function (rampMs) { applyState("silent", rampMs); },
    setState: function (name, rampMs) {
      if (!STATES[name]) return;
      currentStateName = name;
      applyState(name, rampMs);
    },
    setIntensity: function (v) { intensity = clamp01(v); applyState(currentStateName, 300); },
    victorySting: function () {
      Music.stop(500);
      setTimeout(function () { Sfx.victoryFanfare(); }, 350);
      setTimeout(function () { Music.setState("lobby", 900); }, 2200);
    },
  };

  /* ================================================================== SFXGenerator */
  var Sfx = {
    punchSwing: function () {
      noiseBurst({ dur: 0.09, peak: 0.14, filterFreq: 2500, filterType: "bandpass", filterSweepTo: 900, filterQ: 1 }, sfxBus);
    },
    kickSwing: function () {
      noiseBurst({ dur: 0.12, peak: 0.18, filterFreq: 1800, filterType: "bandpass", filterSweepTo: 500, filterQ: 1 }, sfxBus);
    },
    punchHit: function () {
      var t = now();
      noiseBurst({ dur: 0.05, peak: 0.3, filterFreq: 3500, filterType: "highpass" }, sfxBus, t); // snap
      noiseBurst({ dur: 0.14, peak: 0.35, filterFreq: 1600, filterType: "lowpass" }, sfxBus, t); // body
      tone(220, { type: "sine", dur: 0.09, attack: 0.001, release: 0.05, peak: 0.5, pitchTo: 75, pitchTime: 0.12 }, sfxBus, t);
    },
    kickHit: function () {
      var t = now();
      noiseBurst({ dur: 0.06, peak: 0.35, filterFreq: 3200, filterType: "highpass" }, sfxBus, t);
      noiseBurst({ dur: 0.2, peak: 0.42, filterFreq: 1100, filterType: "lowpass" }, sfxBus, t);
      tone(150, { type: "sine", dur: 0.14, attack: 0.001, release: 0.08, peak: 0.65, pitchTo: 48, pitchTime: 0.18 }, sfxBus, t);
    },
    jump: function () {
      tone(320, { type: "square", dur: 0.09, attack: 0.002, release: 0.03, peak: 0.22, pitchTo: 620, pitchTime: 0.09, filterFreq: 4000 }, sfxBus);
    },
    land: function (strength) {
      strength = clamp01(strength != null ? strength : 0.5);
      var t = now();
      var freq = lerp(140, 65, strength);
      var peak = lerp(0.18, 0.5, strength);
      tone(freq, { type: "sine", dur: 0.08, attack: 0.001, release: 0.09, peak: peak, pitchTo: freq * 0.6, pitchTime: 0.1 }, sfxBus, t);
      noiseBurst({ dur: 0.07, peak: peak * 0.5, filterFreq: 1200, filterType: "lowpass" }, sfxBus, t);
    },
    ko: function () {
      var t = now();
      noiseBurst({ dur: 0.3, peak: 0.5, filterFreq: 2200, filterType: "lowpass", reverb: true }, sfxBus, t);
      tone(480, { type: "sawtooth", dur: 0.32, attack: 0.002, release: 0.2, peak: 0.55, pitchTo: 55, pitchTime: 0.38, filterFreq: 2200, filterType: "lowpass", reverb: true }, sfxBus, t);
    },
    countdownBeep: function (step) {
      var idx = Math.max(0, Math.min(2, step | 0));
      var freq = [440, 554, 698][idx];
      tone(freq, { type: "triangle", dur: 0.12, attack: 0.003, release: 0.08, peak: 0.35, filterFreq: 5000 }, sfxBus);
    },
    fightImpact: function () {
      var t = now();
      noiseBurst({ dur: 0.35, peak: 0.55, filterFreq: 4000, filterType: "lowpass", reverb: true }, sfxBus, t);
      tone(90, { type: "square", dur: 0.3, attack: 0.001, release: 0.25, peak: 0.6, filterFreq: 900, filterType: "lowpass" }, sfxBus, t);
    },
    victoryFanfare: function () {
      var t = now();
      var notes = [523.25, 659.25, 783.99, 1046.5]; // bright arcade triad + octave — deliberate exception to the dark gameplay scale
      notes.forEach(function (f, i) {
        tone(f, { type: "square", dur: 0.22, attack: 0.004, release: 0.18, peak: 0.32, filterFreq: 6000, reverb: true }, sfxBus, t + i * 0.13);
      });
    },
    uiHover: function () {
      tone(700, { type: "sine", dur: 0.03, attack: 0.002, release: 0.03, peak: 0.06 }, sfxBus);
    },
    uiClick: function () {
      tone(900, { type: "triangle", dur: 0.045, attack: 0.002, release: 0.04, peak: 0.14, pitchTo: 650, pitchTime: 0.05 }, sfxBus);
    },
    duck: duckMusic,
  };

  /* ================================================================== EventRouter */
  // The only functions screen.html / controller.html ever call.
  var clutchFiredThisRound = false;

  var on = {
    roundStart: function (biomeId) {
      if (!ready) return;
      clutchFiredThisRound = false;
      setBiome(biomeId);
      Music.setState("countdown");
      Sfx.countdownBeep(0);
      setTimeout(function () { if (ready) Sfx.countdownBeep(1); }, 350);
      setTimeout(function () { if (ready) Sfx.countdownBeep(2); }, 700);
    },
    fightBegin: function () {
      if (!ready) return;
      Music.setState("fight");
      Sfx.fightImpact();
    },
    swing: function (type) {
      if (!ready) return;
      if (type === "kick") Sfx.kickSwing(); else Sfx.punchSwing();
    },
    hit: function (type) {
      if (!ready) return;
      if (type === "kick") Sfx.kickHit(); else Sfx.punchHit();
      duckMusic(0.35, 100);
    },
    jump: function () { if (ready) Sfx.jump(); },
    land: function (strength) { if (ready) Sfx.land(strength); },
    ko: function () {
      if (!ready) return;
      Sfx.ko();
      duckMusic(0.5, 100);
    },
    clutch: function () {
      if (!ready || clutchFiredThisRound) return;
      clutchFiredThisRound = true;
      Music.setState("clutch");
    },
    victory: function () { if (ready) Music.victorySting(); },
    gameOver: function () { if (ready) Music.setState("gameOver"); },
    toLobby: function () { if (ready) Music.setState("lobby"); },
    uiHover: function () { if (ready) Sfx.uiHover(); },
    uiClick: function () { if (ready) Sfx.uiClick(); },
  };

  return {
    init: init,
    armUnlock: armUnlock,
    setMasterVolume: setMasterVolume,
    setMusicVolume: setMusicVolume,
    setSfxVolume: setSfxVolume,
    setMuted: setMuted,
    getSettings: getSettings,
    on: on,
  };
})();
