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

  /* ================================================================== scales / notes */
  // A Phrygian — dark, arcade-ish, deliberately avoids sounding cheerful.
  var PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
  var ROOT = 55; // A1
  function noteFreq(degree, octave) {
    octave = octave || 0;
    var idx = ((degree % PHRYGIAN.length) + PHRYGIAN.length) % PHRYGIAN.length;
    var octShift = Math.floor(degree / PHRYGIAN.length) + octave;
    var semis = PHRYGIAN[idx] + octShift * 12;
    return ROOT * Math.pow(2, semis / 12);
  }

  /* ================================================================== BPM / layers */
  var BPM = 128;
  var STEP_DUR = 60 / BPM / 4; // one 16th note, seconds
  var LOOKAHEAD = 0.12;

  var LAYER_NAMES = ["kick", "bass", "pad", "lead", "arp", "perc", "fx"];
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
        type: "sawtooth", dur: dur, attack: 0.008, release: 0.05, peak: 0.55,
        filterFreq: 420, filterType: "lowpass", filterQ: 1.2,
      }, layerGains.bass, t);
    },
    leadNote: function (freq, dur, t) {
      tone(freq, { type: "square", dur: dur, attack: 0.004, release: 0.06, peak: 0.28, filterFreq: 3200, filterType: "lowpass" }, layerGains.lead, t);
      tone(freq * 1.005, { type: "sawtooth", dur: dur, attack: 0.004, release: 0.06, peak: 0.16, detune: -6 }, layerGains.lead, t);
    },
    padChord: function (freqs, dur, t) {
      freqs.forEach(function (f) {
        tone(f, { type: "triangle", dur: dur, attack: 0.6, release: 0.9, peak: 0.22, filterFreq: 1200, filterType: "lowpass" }, layerGains.pad, t);
      });
    },
    arpNote: function (freq, dur, t) {
      tone(freq, { type: "square", dur: dur, attack: 0.002, release: 0.03, peak: 0.18, filterFreq: 4500, filterType: "lowpass" }, layerGains.arp, t);
    },
    noiseFX: function (t) {
      noiseBurst({ dur: 1.4, peak: 0.14, filterFreq: 300, filterSweepTo: 6000, filterType: "bandpass", filterQ: 2 }, layerGains.fx, t);
    },
  };

  /* ================================================================== Sequencer */
  // Standard "look-ahead" scheduler: driven by requestAnimationFrame, but every note
  // start time is computed from audioCtx.currentTime, never from setTimeout/setInterval
  // wall-clock delays — so there is no drift no matter how the render loop jitters.
  var stepIndex = 0, nextStepTime = 0, schedulerRunning = false, schedulerRaf = null;

  var BASS_PATTERN = [0, null, null, null, null, null, 3, null, 0, null, null, null, 5, null, null, null];
  var LEAD_DEGREES = [0, 3, 5, 7];

  function scheduleStep(step, t) {
    if (layerTargets.kick > 0.01 && step % 4 === 0) Instruments.kick(t);
    if (layerTargets.bass > 0.01 && BASS_PATTERN[step] != null) Instruments.bassNote(noteFreq(BASS_PATTERN[step], -1), STEP_DUR * 3.2, t);
    if (layerTargets.pad > 0.01 && step === 0) Instruments.padChord([noteFreq(0, 0), noteFreq(2, 0), noteFreq(4, 0)], STEP_DUR * 16, t);
    if (layerTargets.lead > 0.01 && step % 4 === 2) Instruments.leadNote(noteFreq(LEAD_DEGREES[(step >> 2) % 4], 1), STEP_DUR * 1.3, t);
    if (layerTargets.perc > 0.01) {
      if (step % 2 === 1) Instruments.hat(t);
      if (step === 4 || step === 12) Instruments.snare(t);
    }
    if (layerTargets.arp > 0.01) Instruments.arpNote(noteFreq(LEAD_DEGREES[step % 4], 2), STEP_DUR * 0.85, t);
    if (layerTargets.fx > 0.01 && step === 0) Instruments.noiseFX(t);
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
    lobby: { kick: 0, bass: 0.5, pad: 0.7, lead: 0, arp: 0, perc: 0, fx: 0, filter: 16000 },
    countdown: { kick: 0, bass: 0.5, pad: 0.7, lead: 0, arp: 0, perc: 0, fx: 0, filter: 500 },
    fight: { kick: 0.9, bass: 0.85, pad: 0.28, lead: 0.7, arp: 0, perc: 0.65, fx: 0, filter: 18000 },
    clutch: { kick: 1, bass: 1, pad: 0.3, lead: 0.9, arp: 0.55, perc: 0.85, fx: 0.4, filter: 18000 },
    gameOver: { kick: 0, bass: 0.3, pad: 0.5, lead: 0, arp: 0, perc: 0, fx: 0, filter: 400 },
    silent: { kick: 0, bass: 0, pad: 0, lead: 0, arp: 0, perc: 0, fx: 0, filter: 18000 },
  };
  var currentStateName = "lobby";
  var intensity = 1;

  function applyState(name, rampMs) {
    var cfg = STATES[name] || STATES.lobby;
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
    roundStart: function () {
      if (!ready) return;
      clutchFiredThisRound = false;
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
