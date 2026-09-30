/* Audio procedural (Web Audio): música por bioma con loop de 8 compases y efectos sintetizados.
   Port de V1 (audio.js), mismos temas y mezcla. Suma de V2:
   - Compresor/limitador en el máster: con 8 jugadores pegándose a la vez V1 saturaba.
   - Paneo estéreo por posición: un golpe a la izquierda del mapa suena a la izquierda.
   - Reverb por convolución (impulso generado) en vez del delay con feedback.
   - Sonido propio para agarrar un orbe (antes reusaba el click de UI). */

import { WORLD_W, type BiomeId } from "@lss/shared";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
}

const STORAGE_KEY = "lss_audio_settings";

type ToneOpts = {
  type?: OscillatorType; dur?: number; attack?: number; release?: number; peak?: number; detune?: number;
  pitchTo?: number; pitchTime?: number; filterFreq?: number; filterType?: BiquadFilterType; filterQ?: number; reverb?: boolean;
};
type NoiseOpts = {
  dur?: number; peak?: number; attack?: number; filterFreq?: number; filterType?: BiquadFilterType;
  filterSweepTo?: number; filterQ?: number; reverb?: boolean;
};

interface Theme {
  root: number; scale: keyof typeof SCALES; bright: number; bassWave: OscillatorType; leadWave: OscillatorType; detune: number;
  kickDiv: number; bassPattern: (number | null)[]; progression: number[]; leadDegrees: number[]; leadDiv: number;
  arpPattern: (number | null)[]; percStyle: string; ambientEvery: number; ambient: (t: number) => void;
  mix: Partial<Record<string, Partial<Record<string, number>>>>;
}

const SCALES = {
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

const BPM = 128;
const STEP_DUR = 60 / BPM / 4;
const LOOKAHEAD = 0.12;
const STEPS_PER_BAR = 16;
const BARS_PER_BLOCK = 2;
const BARS_PER_LOOP = 8;
const LOOP_STEPS = STEPS_PER_BAR * BARS_PER_LOOP;
const ARP_TONES = [0, 2, 4, 7];
const LAYER_NAMES = ["kick", "bass", "pad", "lead", "arp", "perc", "fx", "amb"] as const;
type Layer = (typeof LAYER_NAMES)[number];

const STATES: Record<string, Record<Layer | "filter", number>> = {
  lobby: { kick: 0, bass: 0.6, pad: 0.45, lead: 0, arp: 0, perc: 0, fx: 0, amb: 0, filter: 16000 },
  countdown: { kick: 0, bass: 0.5, pad: 0.7, lead: 0, arp: 0, perc: 0, fx: 0, amb: 0.4, filter: 500 },
  fight: { kick: 0.7, bass: 0.75, pad: 0, lead: 0.2, arp: 0, perc: 0.55, fx: 0.15, amb: 0.15, filter: 9100 },
  clutch: { kick: 1, bass: 1, pad: 0.3, lead: 0.9, arp: 0.55, perc: 0.85, fx: 0.4, amb: 0.3, filter: 18000 },
  gameOver: { kick: 0, bass: 0.3, pad: 0.5, lead: 0, arp: 0, perc: 0, fx: 0, amb: 0.35, filter: 400 },
  silent: { kick: 0, bass: 0, pad: 0, lead: 0, arp: 0, perc: 0, fx: 0, amb: 0, filter: 18000 },
};

class AudioEngine {
  settings: AudioSettings = { master: 0.8, music: 0.65, sfx: 0.9, muted: false };
  private ctx: AudioContext | null = null;
  private ready = false;
  private masterGain!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private musicBus!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private sfxBus!: GainNode;
  private reverbSend!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private layerGains = {} as Record<Layer, GainNode>;
  private layerTargets = {} as Record<Layer, number>;
  private theme!: Theme;
  private themes!: Record<BiomeId, Theme>;
  private stepIndex = 0;
  private nextStepTime = 0;
  private schedulerRunning = false;
  private schedulerTimer: number | null = null;
  private currentState = "lobby";
  private clutchFired = false;
  private lastSfx: Record<string, number> = {};

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) Object.assign(this.settings, JSON.parse(raw));
    } catch { /* storage bloqueado */ }
  }

  private now() { return this.ctx!.currentTime; }

  /** El navegador no deja arrancar audio sin un gesto del usuario: el primer click/tecla lo inicia. */
  armUnlock() {
    const unlock = () => {
      this.init();
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true });
  }

  private init() {
    if (this.ready) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ready = true;
    const ctx = (this.ctx = new AC({ latencyHint: "interactive" }));
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;
    this.limiter.connect(ctx.destination);
    this.masterGain = ctx.createGain();
    this.masterGain.connect(this.limiter);
    this.musicBus = ctx.createGain();
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = "lowpass";
    this.musicFilter.frequency.value = 18000;
    this.musicBus.connect(this.musicFilter);
    this.musicFilter.connect(this.masterGain);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.masterGain);
    const convolver = ctx.createConvolver();
    convolver.buffer = this.buildImpulse(1.6, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.55;
    this.reverbSend.connect(convolver);
    convolver.connect(this.sfxBus);
    this.noiseBuffer = this.buildNoise();
    this.themes = this.buildThemes();
    this.theme = this.themes.ruinas;
    this.applyVolumes();
    for (const name of LAYER_NAMES) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.musicBus);
      this.layerGains[name] = g;
      this.layerTargets[name] = 0;
    }
    this.currentState = "lobby";
    this.applyState("lobby", 50);
    this.startScheduler();
  }

  private buildNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * 1.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private buildImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const t = this.now();
    this.masterGain.gain.setTargetAtTime(this.settings.muted ? 0 : this.settings.master, t, 0.02);
    this.musicBus.gain.setTargetAtTime(this.settings.music, t, 0.02);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfx, t, 0.02);
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* */ }
  }

  set(partial: Partial<AudioSettings>) {
    Object.assign(this.settings, partial);
    this.settings.master = clamp01(this.settings.master);
    this.settings.music = clamp01(this.settings.music);
    this.settings.sfx = clamp01(this.settings.sfx);
    this.applyVolumes();
    this.save();
  }

  /* ---------------------------------------------------------------- síntesis */
  private out(bus: AudioNode | undefined, pan: number | undefined): AudioNode {
    const target = bus || this.sfxBus;
    if (pan == null || !this.ctx!.createStereoPanner) return target;
    const p = this.ctx!.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    p.connect(target);
    return p;
  }

  private tone(freq: number, o: ToneOpts = {}, bus?: AudioNode, atTime?: number, pan?: number) {
    const ctx = this.ctx!;
    const t0 = atTime ?? this.now();
    const dur = o.dur ?? 0.2, attack = o.attack ?? 0.005, release = o.release ?? 0.08, peak = o.peak ?? 0.5;
    const osc = ctx.createOscillator();
    osc.type = o.type || "sawtooth";
    osc.frequency.setValueAtTime(freq, t0);
    if (o.detune) osc.detune.setValueAtTime(o.detune, t0);
    if (o.pitchTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.pitchTo), t0 + (o.pitchTime || dur));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.linearRampToValueAtTime(peak * 0.7, t0 + attack + dur * 0.5);
    g.gain.linearRampToValueAtTime(0, t0 + dur + release);
    if (o.filterFreq != null) {
      const f = ctx.createBiquadFilter();
      f.type = o.filterType || "lowpass";
      f.frequency.setValueAtTime(o.filterFreq, t0);
      if (o.filterQ) f.Q.setValueAtTime(o.filterQ, t0);
      osc.connect(f);
      f.connect(g);
    } else osc.connect(g);
    const dest = this.out(bus, pan);
    g.connect(dest);
    if (o.reverb) g.connect(this.reverbSend);
    osc.start(t0);
    osc.stop(t0 + dur + release + 0.05);
    osc.onended = () => { osc.disconnect(); g.disconnect(); if (dest !== bus && dest !== this.sfxBus) dest.disconnect(); };
  }

  private noise(o: NoiseOpts = {}, bus?: AudioNode, atTime?: number, pan?: number) {
    const ctx = this.ctx!;
    const t0 = atTime ?? this.now();
    const dur = o.dur ?? 0.12;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const offset = Math.random() * Math.max(0.01, this.noiseBuffer.duration - dur - 0.01);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(o.peak ?? 0.4, t0 + (o.attack || 0.003));
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    if (o.filterFreq != null) {
      const f = ctx.createBiquadFilter();
      f.type = o.filterType || "highpass";
      f.frequency.setValueAtTime(o.filterFreq, t0);
      if (o.filterSweepTo != null) f.frequency.exponentialRampToValueAtTime(Math.max(1, o.filterSweepTo), t0 + dur);
      if (o.filterQ) f.Q.setValueAtTime(o.filterQ, t0);
      src.connect(f);
      f.connect(g);
    } else src.connect(g);
    const dest = this.out(bus, pan);
    g.connect(dest);
    if (o.reverb) g.connect(this.reverbSend);
    src.start(t0, offset, dur);
    src.onended = () => { src.disconnect(); g.disconnect(); if (dest !== bus && dest !== this.sfxBus) dest.disconnect(); };
  }

  private noteFreq(degree: number, octave = 0): number {
    const scale = SCALES[this.theme.scale] || SCALES.phrygian;
    const idx = ((degree % scale.length) + scale.length) % scale.length;
    const octShift = Math.floor(degree / scale.length) + octave;
    return this.theme.root * Math.pow(2, (scale[idx] + octShift * 12) / 12);
  }

  /* ---------------------------------------------------------------- instrumentos */
  private kick(t: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator(); osc.type = "sine";
    const g = ctx.createGain();
    osc.connect(g); g.connect(this.layerGains.kick);
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    osc.start(t); osc.stop(t + 0.3);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }
  private tom(t: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator(); osc.type = "sine";
    const g = ctx.createGain();
    osc.connect(g); g.connect(this.layerGains.perc);
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.15);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.start(t); osc.stop(t + 0.22);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }
  private snare(t: number) {
    this.noise({ dur: 0.13, peak: 0.35, filterFreq: 1500, filterType: "bandpass", filterQ: 0.8 }, this.layerGains.perc, t);
    this.tone(190, { type: "triangle", dur: 0.05, attack: 0.001, release: 0.05, peak: 0.25 }, this.layerGains.perc, t);
  }
  private hat(t: number) { this.noise({ dur: 0.045, peak: 0.16, filterFreq: 7000, filterType: "highpass" }, this.layerGains.perc, t); }
  private softHat(t: number) { this.noise({ dur: 0.035, peak: 0.09, filterFreq: 5500, filterType: "highpass" }, this.layerGains.perc, t); }
  private clap(t: number) {
    this.noise({ dur: 0.08, peak: 0.3, filterFreq: 1600, filterType: "bandpass", filterQ: 1.4 }, this.layerGains.perc, t);
    this.noise({ dur: 0.06, peak: 0.18, filterFreq: 1800, filterType: "bandpass", filterQ: 1.4 }, this.layerGains.perc, t + 0.015);
  }
  private arpTo(bus: AudioNode, freq: number, peak: number, t: number, dur = 0.2) {
    this.tone(freq, { type: this.theme.leadWave, dur, attack: 0.002, release: 0.15, peak, filterFreq: 4000 * this.theme.bright }, bus, t);
  }

  private buildThemes(): Record<BiomeId, Theme> {
    return {
      ruinas: {
        root: 96, scale: "phrygian", bright: 1.8, bassWave: "sawtooth", leadWave: "sawtooth", detune: 4, kickDiv: 4,
        bassPattern: [0, null, null, null, null, null, 3, null, 0, null, null, null, 5, null, null, null],
        progression: [0, 1, 0, 2], leadDegrees: [0, 3, 5, 7], leadDiv: 4,
        arpPattern: [0, null, 2, null, null, 1, null, 3, 0, null, 2, null, 1, null, null, null],
        percStyle: "sparse", ambientEvery: 32,
        ambient: (t) => {
          this.arpTo(this.layerGains.amb, this.noteFreq(this.theme.leadDegrees[0], 0), 0.4, t, 0.16);
          this.arpTo(this.layerGains.amb, this.noteFreq(this.theme.leadDegrees[2], 0), 0.35, t + 0.16, 0.08);
        },
        mix: {
          fight: { kick: 0.8, bass: 0.55, pad: 0.3, lead: 0.5, arp: 0.7, perc: 0.75, fx: 0, amb: 0.45, filter: 18000 },
          lobby: { kick: 0, bass: 0, pad: 0.55, lead: 0, arp: 0, perc: 0, fx: 0, amb: 0.25, filter: 18000 },
        },
      },
      volcan: {
        root: 44, scale: "dorian", bright: 0.5, bassWave: "sawtooth", leadWave: "sine", detune: -18, kickDiv: 4,
        bassPattern: [5, null, null, null, null, null, 4, null, 6, null, 6, null, null, null, 6, null],
        progression: [0, 6, 3, 5], leadDegrees: [0, 1, 3, 5], leadDiv: 4,
        arpPattern: [0, null, 1, null, 2, null, 1, null, 3, null, 2, null, 1, null, 0, null],
        percStyle: "tribal", ambientEvery: 32,
        ambient: (t) => {
          this.noise({ dur: 3.2, peak: 0.16, filterFreq: 90, filterType: "lowpass" }, this.layerGains.amb, t);
          this.tone(38, { type: "sine", dur: 0.5, attack: 0.2, release: 0.6, peak: 0.3 }, this.layerGains.amb, t);
        },
        mix: { fight: { kick: 1, bass: 0.65, pad: 0, arp: 0.4, perc: 0.6, fx: 0.15 }, clutch: { kick: 1 } },
      },
      bosque: {
        root: 31, scale: "dorian", bright: 0.3, bassWave: "square", leadWave: "sawtooth", detune: -3, kickDiv: 8,
        bassPattern: [0, null, null, null, null, null, null, null, null, 4, null, null, null, null, null, null],
        progression: [0, 4, 2, 5], leadDegrees: [0, 2, 4, 6], leadDiv: 8,
        arpPattern: [0, null, null, 2, null, null, 1, null, null, 3, null, null, 2, null, null, null],
        percStyle: "tribal", ambientEvery: 64,
        ambient: (t) => {
          this.noise({ dur: 2.6, peak: 0.09, filterFreq: 900, filterType: "bandpass", filterQ: 0.6 }, this.layerGains.amb, t);
          if (Math.random() < 0.5) this.tone(this.noteFreq(this.theme.leadDegrees[3], 3), { type: "triangle", dur: 0.12, attack: 0.005, release: 0.15, peak: 0.1 }, this.layerGains.amb, t + 0.3);
        },
        mix: { fight: { kick: 0.75, bass: 0.75, pad: 0, lead: 0.65, arp: 0.8 } },
      },
      neon: {
        root: 98, scale: "aeolian", bright: 1.55, bassWave: "sawtooth", leadWave: "square", detune: -10, kickDiv: 4,
        bassPattern: [0, null, 0, null, 7, null, 0, null, 0, null, 0, null, 7, null, 0, null],
        progression: [0, 5, 2, 6], leadDegrees: [0, 4, 7, 4], leadDiv: 4,
        arpPattern: [0, null, 2, 3, null, 1, 0, null, 2, 3, null, 1, 0, null, 2, 3],
        percStyle: "pulse", ambientEvery: 64,
        ambient: (t) => {
          this.noise({ dur: 0.9, peak: 0.1, filterFreq: 6000, filterType: "highpass" }, this.layerGains.amb, t);
          this.tone(this.noteFreq(this.theme.leadDegrees[0], 2), { type: "sawtooth", dur: 1.2, attack: 0.4, release: 0.6, peak: 0.12, detune: this.theme.detune * 2, filterFreq: 5000 }, this.layerGains.amb, t);
        },
        mix: { fight: { pad: 0.2, lead: 0.2, arp: 0.55 }, clutch: { arp: 0.8 } },
      },
      nieve: {
        root: 62, scale: "aeolian", bright: 1.15, bassWave: "triangle", leadWave: "triangle", detune: -4, kickDiv: 8,
        bassPattern: [1, null, null, null, 2, null, 3, null, 1, null, null, null, 2, null, null, null],
        progression: [0, 2, 0, 2], leadDegrees: [0, 4], leadDiv: 8,
        arpPattern: [0, null, null, null, 2, null, null, null, 3, null, null, null, 2, null, null, null],
        percStyle: "sparse", ambientEvery: 64,
        ambient: (t) => {
          this.noise({ dur: 2.0, peak: 0.07, filterFreq: 2200, filterType: "bandpass", filterQ: 0.5 }, this.layerGains.amb, t);
          this.tone(this.noteFreq(this.theme.leadDegrees[1], 3), { type: "triangle", dur: 1.0, attack: 0.01, release: 1.4, peak: 0.14, filterFreq: 6000 }, this.layerGains.amb, t);
        },
        mix: { fight: { pad: 0, lead: 0.35, arp: 0.3, fx: 0.4, amb: 0.25 }, lobby: { fx: 0, amb: 1 } },
      },
    };
  }

  /* ---------------------------------------------------------------- secuenciador */
  private playPerc(style: string, step: number, t: number) {
    if (style === "tribal") {
      if (step % 2 === 0) this.hat(t);
      if (step === 3 || step === 7 || step === 11 || step === 15) this.tom(t);
    } else if (style === "pulse") {
      this.hat(t);
      if (step % 4 === 0) this.clap(t);
    } else if (style === "sparse") {
      if (step % 4 === 0) this.softHat(t);
    } else {
      if (step % 2 === 1) this.hat(t);
      if (step === 4 || step === 12) this.snare(t);
    }
  }

  private scheduleStep(step: number, t: number) {
    const th = this.theme;
    const s = step % STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const block = Math.floor(bar / BARS_PER_BLOCK);
    const lastBarOfBlock = bar % BARS_PER_BLOCK === BARS_PER_BLOCK - 1;
    const lastBarOfLoop = bar === BARS_PER_LOOP - 1;
    const chord = th.progression[block % th.progression.length];
    const L = this.layerTargets;
    const kickMuted = lastBarOfLoop && s >= 12;
    if (L.kick > 0.01 && !kickMuted && s % th.kickDiv === 0) this.kick(t);
    const bp = th.bassPattern[s];
    if (L.bass > 0.01 && bp != null) {
      this.tone(this.noteFreq(bp + chord, -1), { type: th.bassWave, dur: STEP_DUR * 3.2, attack: 0.008, release: 0.05, peak: 0.55, filterFreq: 420 * th.bright, filterType: "lowpass", filterQ: 1.2 }, this.layerGains.bass, t);
    }
    if (L.pad > 0.01 && s === 0 && bar % BARS_PER_BLOCK === 0) {
      for (const f of [this.noteFreq(chord, 0), this.noteFreq(chord + 2, 0), this.noteFreq(chord + 4, 0)]) {
        this.tone(f, { type: "triangle", dur: STEP_DUR * STEPS_PER_BAR * BARS_PER_BLOCK, attack: 0.6, release: 0.9, peak: 0.22, filterFreq: 1200 * th.bright, filterType: "lowpass" }, this.layerGains.pad, t);
      }
    }
    if (L.lead > 0.01 && s % th.leadDiv === Math.min(2, th.leadDiv - 1)) {
      const hit = Math.floor(s / th.leadDiv);
      const f = this.noteFreq(th.leadDegrees[hit % th.leadDegrees.length] + chord, 1);
      const dur = STEP_DUR * (th.leadDiv * 0.65);
      this.tone(f, { type: th.leadWave, dur, attack: 0.004, release: 0.06, peak: 0.28, filterFreq: 3200 * th.bright, filterType: "lowpass" }, this.layerGains.lead, t);
      this.tone(f * 1.005, { type: "sawtooth", dur, attack: 0.004, release: 0.06, peak: 0.16, detune: th.detune }, this.layerGains.lead, t);
    }
    if (L.perc > 0.01) {
      this.playPerc(th.percStyle, s, t);
      const fillFrom = lastBarOfLoop ? 8 : 12;
      if (lastBarOfBlock && s >= fillFrom) {
        const i = s - fillFrom;
        this.tom(t);
        if (lastBarOfLoop ? i % 2 === 1 : i === 3) this.snare(t);
      }
    }
    if (L.arp > 0.01) {
      const ai = th.arpPattern[s % th.arpPattern.length];
      if (ai != null) this.tone(this.noteFreq(chord + ARP_TONES[ai % ARP_TONES.length], 2), { type: th.leadWave, dur: STEP_DUR * 0.85, attack: 0.002, release: 0.03, peak: 0.18, filterFreq: 4500 * th.bright, filterType: "lowpass" }, this.layerGains.arp, t);
    }
    if (L.fx > 0.01 && step === LOOP_STEPS - STEPS_PER_BAR) {
      this.noise({ dur: 1.4, peak: 0.14, filterFreq: 300, filterSweepTo: 6000, filterType: "bandpass", filterQ: 2 }, this.layerGains.fx, t);
    }
    if (L.amb > 0.01 && step % th.ambientEvery === 0) th.ambient(t);
  }

  /* setInterval y no requestAnimationFrame: con la pestaña en segundo plano rAF se frena y la
     música se cortaba. Los tiempos igual salen del reloj de audio, así que no hay deriva. */
  private startScheduler() {
    if (this.schedulerRunning) return;
    this.schedulerRunning = true;
    this.stepIndex = 0;
    this.nextStepTime = this.now() + 0.05;
    this.schedulerTimer = window.setInterval(() => {
      if (!this.ctx) return;
      while (this.nextStepTime < this.now() + LOOKAHEAD) {
        this.scheduleStep(this.stepIndex, this.nextStepTime);
        this.nextStepTime += STEP_DUR;
        this.stepIndex = (this.stepIndex + 1) % LOOP_STEPS;
      }
    }, 25);
  }

  private applyState(name: string, rampMs = 550) {
    if (!this.ctx) return;
    const cfg: Record<string, number> = { ...(STATES[name] || STATES.lobby), ...(this.theme.mix[name] || {}) } as Record<string, number>;
    const t = this.now();
    const ramp = rampMs / 1000;
    for (const layer of LAYER_NAMES) {
      const target = clamp01(cfg[layer] || 0);
      this.layerTargets[layer] = target;
      const g = this.layerGains[layer];
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(target, t + ramp);
    }
    this.musicFilter.frequency.cancelScheduledValues(t);
    this.musicFilter.frequency.setValueAtTime(this.musicFilter.frequency.value, t);
    this.musicFilter.frequency.linearRampToValueAtTime(cfg.filter, t + ramp);
  }

  private setState(name: string, rampMs?: number) {
    if (!STATES[name]) return;
    this.currentState = name;
    this.applyState(name, rampMs);
  }

  private duck(amount: number, ms: number) {
    if (!this.ctx) return;
    const t0 = this.now();
    const base = this.settings.music;
    const g = this.musicBus.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(Math.max(0.0001, g.value), t0);
    g.linearRampToValueAtTime(base * (1 - amount), t0 + 0.02);
    g.linearRampToValueAtTime(base, t0 + ms / 1000);
  }

  /** Limita repeticiones del mismo efecto (8 jugadores aterrizando juntos no son 8 golpes de bombo). */
  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    if (now - (this.lastSfx[key] || 0) < ms) return false;
    this.lastSfx[key] = now;
    return true;
  }

  private panFor(x?: number): number | undefined {
    return x == null ? undefined : ((x / WORLD_W) * 2 - 1) * 0.7;
  }

  /* ================================================================ API de eventos */
  readonly on = {
    roundStart: (biome: BiomeId) => {
      if (!this.ready) return;
      this.clutchFired = false;
      this.theme = this.themes[biome] || this.themes.ruinas;
      this.setState("countdown");
      const beep = (i: number) => this.tone([440, 554, 698][i], { type: "triangle", dur: 0.12, attack: 0.003, release: 0.08, peak: 0.35, filterFreq: 5000 });
      beep(0);
      setTimeout(() => this.ready && beep(1), 350);
      setTimeout(() => this.ready && beep(2), 700);
    },
    fightBegin: () => {
      if (!this.ready) return;
      this.setState("fight");
      const t = this.now();
      this.noise({ dur: 0.35, peak: 0.55, filterFreq: 4000, filterType: "lowpass", reverb: true }, undefined, t);
      this.tone(90, { type: "square", dur: 0.3, attack: 0.001, release: 0.25, peak: 0.6, filterFreq: 900, filterType: "lowpass" }, undefined, t);
    },
    swing: (kind: "punch" | "kick", x?: number) => {
      if (!this.ready) return;
      const pan = this.panFor(x);
      if (kind === "kick") this.noise({ dur: 0.12, peak: 0.18, filterFreq: 1800, filterType: "bandpass", filterSweepTo: 500, filterQ: 1 }, undefined, undefined, pan);
      else this.noise({ dur: 0.09, peak: 0.14, filterFreq: 2500, filterType: "bandpass", filterSweepTo: 900, filterQ: 1 }, undefined, undefined, pan);
    },
    hit: (kind: "punch" | "kick", x?: number, heavy = false) => {
      if (!this.ready) return;
      const t = this.now(), pan = this.panFor(x);
      if (kind === "kick") {
        this.noise({ dur: 0.06, peak: 0.35, filterFreq: 3200, filterType: "highpass" }, undefined, t, pan);
        this.noise({ dur: 0.2, peak: 0.42, filterFreq: 1100, filterType: "lowpass", reverb: heavy }, undefined, t, pan);
        this.tone(150, { type: "sine", dur: 0.14, attack: 0.001, release: 0.08, peak: 0.65, pitchTo: 48, pitchTime: 0.18 }, undefined, t, pan);
      } else {
        this.noise({ dur: 0.05, peak: 0.3, filterFreq: 3500, filterType: "highpass" }, undefined, t, pan);
        this.noise({ dur: 0.14, peak: 0.35, filterFreq: 1600, filterType: "lowpass" }, undefined, t, pan);
        this.tone(220, { type: "sine", dur: 0.09, attack: 0.001, release: 0.05, peak: 0.5, pitchTo: 75, pitchTime: 0.12 }, undefined, t, pan);
      }
      this.duck(0.35, 100);
    },
    jump: (x?: number, dbl = false) => {
      if (!this.ready || !this.throttle("jump", 40)) return;
      this.tone(dbl ? 420 : 320, { type: "square", dur: 0.09, attack: 0.002, release: 0.03, peak: 0.2, pitchTo: dbl ? 820 : 620, pitchTime: 0.09, filterFreq: 4000 }, undefined, undefined, this.panFor(x));
    },
    land: (strength: number, x?: number) => {
      if (!this.ready || !this.throttle("land", 45)) return;
      const s = clamp01(strength), t = this.now(), pan = this.panFor(x);
      const freq = lerp(140, 65, s), peak = lerp(0.18, 0.5, s);
      this.tone(freq, { type: "sine", dur: 0.08, attack: 0.001, release: 0.09, peak, pitchTo: freq * 0.6, pitchTime: 0.1 }, undefined, t, pan);
      this.noise({ dur: 0.07, peak: peak * 0.5, filterFreq: 1200, filterType: "lowpass" }, undefined, t, pan);
    },
    ko: (x?: number) => {
      if (!this.ready) return;
      const t = this.now(), pan = this.panFor(x);
      this.noise({ dur: 0.3, peak: 0.5, filterFreq: 2200, filterType: "lowpass", reverb: true }, undefined, t, pan);
      this.tone(480, { type: "sawtooth", dur: 0.32, attack: 0.002, release: 0.2, peak: 0.55, pitchTo: 55, pitchTime: 0.38, filterFreq: 2200, filterType: "lowpass", reverb: true }, undefined, t, pan);
      this.tone(60, { type: "sine", dur: 0.4, attack: 0.001, release: 0.3, peak: 0.7, pitchTo: 30, pitchTime: 0.4 }, undefined, t);
      this.duck(0.5, 140);
    },
    pickup: (x?: number) => {
      if (!this.ready) return;
      const t = this.now(), pan = this.panFor(x);
      [660, 880, 1320].forEach((f, i) => this.tone(f, { type: "triangle", dur: 0.08, attack: 0.002, release: 0.12, peak: 0.18, filterFreq: 7000, reverb: true }, undefined, t + i * 0.05, pan));
    },
    burn: (x?: number) => {
      if (!this.ready || !this.throttle("burn", 120)) return;
      this.noise({ dur: 0.12, peak: 0.08, filterFreq: 2500, filterType: "bandpass", filterQ: 0.8 }, undefined, undefined, this.panFor(x));
    },
    clutch: () => {
      if (!this.ready || this.clutchFired) return;
      this.clutchFired = true;
      this.setState("clutch");
    },
    victory: () => {
      if (!this.ready) return;
      this.setState("silent", 500);
      setTimeout(() => {
        const t = this.now();
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, { type: "square", dur: 0.22, attack: 0.004, release: 0.18, peak: 0.32, filterFreq: 6000, reverb: true }, undefined, t + i * 0.13));
      }, 350);
      setTimeout(() => this.setState("lobby", 900), 2200);
    },
    gameOver: () => { if (this.ready) this.setState("gameOver"); },
    toLobby: () => { if (this.ready) this.setState("lobby"); },
    uiHover: () => { if (this.ready && this.throttle("hover", 30)) this.tone(700, { type: "sine", dur: 0.03, attack: 0.002, release: 0.03, peak: 0.05 }); },
    uiClick: () => { if (this.ready) this.tone(900, { type: "triangle", dur: 0.045, attack: 0.002, release: 0.04, peak: 0.14, pitchTo: 650, pitchTime: 0.05 }); },
    uiBack: () => { if (this.ready) this.tone(600, { type: "triangle", dur: 0.05, attack: 0.002, release: 0.05, peak: 0.12, pitchTo: 420, pitchTime: 0.06 }); },
  };
}

export const audio = new AudioEngine();
