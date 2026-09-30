/* Renderer de V2. PixiJS (WebGL) compone la escena y hace el post-proceso; el arte procedural del
   juego se sigue dibujando con Canvas 2D (es vectorial, afinado a mano durante meses y
   reescribirlo en otra API no suma nada), pero en canvases chicos por entidad que se suben como
   texturas. Lo que gana esto sobre V1:

   - Bloom real en GPU para todo lo que brilla (bordes de plataforma, muñecos, orbes, chispas), en
     vez de shadowBlur por trazo — que era lo más caro del cuadro.
   - Partículas en GPU (miles, aditivas), ondas de choque, aberración cromática y viñeta.
   - Resolución nativa de la pantalla (HiDPI), canvas a pantalla completa con el fondo que "cubre"
     y el área de juego que "contiene": nada de franjas negras.
   - Lo estático (fondo, plataformas, púas) se hornea una vez por mapa. */

import { Application, CanvasSource, Container, Graphics, Sprite, Text, Texture, type TextStyleOptions } from "pixi.js";
import { AdvancedBloomFilter, RGBSplitFilter, ShockwaveFilter } from "pixi-filters";
import { WORLD_H, WORLD_W, type GameMode, type MapDef, type Phase } from "@lss/shared";
import { artCfg } from "./art/config";
import { accessoryLift, drawStickman, drawStickShine, type RenderPlayer, type RigAnim, type RigInfo } from "./art/stickman";
import { buildBackground, buildPlatformLayer, drawDecorations, makeCanvas } from "./art/world";
import { drawHill, drawNameTag, drawOrb, drawWorldObjects, HILL_TARGET } from "./art/objects";
import { Camera } from "./camera";
import { hexToNum, makeDotTexture, ParticleSystem } from "./particles";

export interface RenderView {
  map: MapDef;
  players: RenderPlayer[];
  orb: { type: string; x: number; y: number; bornT: number } | null;
  hill: { x: number; y: number; r: number } | null;
  portal: { x: number; y: number; bornT: number; color?: string; boss?: boolean } | null;
  voidHole: { x: number; y: number; bornT: number } | null;
  phase: Phase;
  gameMode: GameMode;
  scores: Record<number, number>;
  meId: number | null;
  timeMs: number;
  /** Pelea de fondo del menú: sin carteles de nombre ni vida. */
  hideTags?: boolean;
  nameFor(id: number): string;
  colorFor(id: number): string;
  hatFor(id: number): string;
  maxHpFor(id: number): number;
}

export interface RenderSettings {
  quality: "high" | "low";
  reduceMotion: boolean;
  dynamicCamera: boolean;
}

/* ---------------------------------------------------------------- canvas → sprite */
class CanvasSprite {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  sprite: Sprite;
  private source: CanvasSource | null = null;
  private scale = 0;
  private w = 0;
  private h = 0;

  constructor(private boxW: number, private boxH: number, private ox: number, private oy: number) {
    this.canvas = makeCanvas(2, 2);
    this.ctx = this.canvas.getContext("2d")!;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /** Prepara el canvas para dibujar en coordenadas de mundo alrededor del ancla (ax, ay). */
  begin(ax: number, ay: number, scale: number): CanvasRenderingContext2D {
    const w = Math.ceil(this.boxW * scale), h = Math.ceil(this.boxH * scale);
    if (scale !== this.scale || w !== this.w || h !== this.h || !this.source) {
      this.scale = scale; this.w = w; this.h = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.source?.destroy();
      this.source = new CanvasSource({ resource: this.canvas });
      this.sprite.texture = new Texture({ source: this.source });
      this.sprite.scale.set(1 / scale);
    }
    const x0 = ax + this.ox, y0 = ay + this.oy;
    this.sprite.position.set(x0, y0);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    return ctx;
  }

  end() {
    this.source?.update();
  }

  destroy() {
    this.sprite.destroy();
    this.source?.destroy();
  }
}

interface Ghost { x: number; y: number; vx: number; vy: number; facing: number; grounded: boolean; attack: RenderPlayer["attack"]; walkCycle: number; idleT: number; squash: number }

interface PlayerGfx {
  body: CanvasSprite;
  tag: CanvasSprite;
  tagKey: string;
  anim: RigAnim;
  trail: Ghost[];
  trailT: number;
  airTrail: Ghost[];
  airT: number;
  seen: number;
}

interface Debris {
  g: Graphics;
  vx: number; vy: number; vr: number; life: number; maxLife: number;
}

interface FloatText {
  t: Text;
  vy: number;
  life: number;
  maxLife: number;
}

const BODY_BOX = { w: 170, h: 175, ox: -85, oy: -135 };
const TAG_BOX = { w: 130, h: 80, ox: -65, oy: -80 };

export class Renderer {
  app = new Application();
  readonly camera = new Camera(WORLD_W, WORLD_H);
  settings: RenderSettings = { quality: "high", reduceMotion: false, dynamicCamera: true };

  private root = new Container();
  private bg = new Container();
  private skySprite = new Sprite(Texture.EMPTY);
  private farSprite = new Sprite(Texture.EMPTY);
  private nearSprite = new Sprite(Texture.EMPTY);
  private world = new Container();
  private glowGroup = new Container();
  private platformSprite = new Sprite(Texture.EMPTY);
  private decoLayer = new Container();
  private decoSprites: CanvasSprite[] = [];
  private objectLayer = new Container();
  private orbSprite = new CanvasSprite(70, 70, -35, -35);
  private hillSprite = new CanvasSprite(250, 250, -125, -125);
  private portalSprite = new CanvasSprite(110, 140, -55, -100);
  private voidSprite = new CanvasSprite(110, 100, -55, -50);
  private playerLayer = new Container();
  private tagLayer = new Container();
  private debrisLayer = new Container();
  private textLayer = new Container();
  private streaks = new Graphics();
  private overlay = new Container();
  private vignette = new Sprite(Texture.EMPTY);
  private flash = new Graphics();

  fx!: ParticleSystem;
  ambient!: ParticleSystem;
  private bloom!: AdvancedBloomFilter;
  private rgb!: RGBSplitFilter;
  private shockwaves: { f: ShockwaveFilter; t: number; dur: number }[] = [];
  private rgbT = 0;
  private flashA = 0;
  private streakList: { x: number; y: number; dir: number; t: number }[] = [];
  private debris: Debris[] = [];
  private floats: FloatText[] = [];
  private gfx = new Map<number, PlayerGfx>();
  private mapKey = "";
  private currentMap: MapDef | null = null;
  private renderScale = 1;
  private viewScale = 1;
  private viewX = 0;
  private viewY = 0;
  private frameNo = 0;
  private ambientAccum = 0;
  private ready = false;
  private rigInfo = {} as RigInfo;

  async init(parent: HTMLElement) {
    await this.app.init({
      resizeTo: parent,
      antialias: true,
      backgroundColor: 0x05060d,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      preference: "webgl",
      powerPreference: "high-performance",
    });
    parent.appendChild(this.app.canvas);
    this.app.canvas.classList.add("game-canvas");

    const dot = makeDotTexture(this.app.renderer, 16);
    this.fx = new ParticleSystem(dot, 2400, true);
    this.ambient = new ParticleSystem(dot, 90, false);

    this.bg.addChild(this.skySprite, this.farSprite, this.nearSprite);
    this.objectLayer.addChild(this.hillSprite.sprite, this.portalSprite.sprite, this.voidSprite.sprite, this.orbSprite.sprite);
    this.glowGroup.addChild(this.platformSprite, this.decoLayer, this.ambient.container, this.objectLayer, this.debrisLayer, this.playerLayer, this.fx.container, this.streaks);
    this.world.addChild(this.glowGroup, this.tagLayer, this.textLayer);
    this.overlay.addChild(this.vignette, this.flash);
    this.root.addChild(this.bg, this.world, this.overlay);
    this.app.stage.addChild(this.root);

    this.bloom = new AdvancedBloomFilter({ threshold: 0.42, bloomScale: 0.85, brightness: 1.0, blur: 5, quality: 5 });
    this.rgb = new RGBSplitFilter({ red: { x: 0, y: 0 }, green: { x: 0, y: 0 }, blue: { x: 0, y: 0 } });
    this.applyQuality();

    this.app.renderer.on("resize", () => this.onResize());
    this.onResize();
    this.app.ticker.stop(); // el loop lo maneja el motor del juego (fixed-step + render)
    this.ready = true;
  }

  applySettings(s: Partial<RenderSettings>) {
    this.settings = { ...this.settings, ...s };
    this.camera.dynamicFraming = this.settings.dynamicCamera;
    this.applyQuality();
  }

  private applyQuality() {
    const low = this.settings.quality === "low";
    artCfg.low = low;
    this.glowGroup.filters = low ? [] : [this.bloom];
    this.updateRootFilters();
    if (this.currentMap) { this.mapKey = ""; this.setMap(this.currentMap); }
  }

  private updateRootFilters() {
    if (!this.bloom) return;
    const f = this.shockwaves.map((s) => s.f) as (ShockwaveFilter | RGBSplitFilter)[];
    if (this.rgbT > 0) f.push(this.rgb);
    this.root.filters = f.length ? f : [];
  }

  private onResize() {
    const W = this.app.screen.width, H = this.app.screen.height;
    this.viewScale = Math.min(W / WORLD_W, H / WORLD_H);
    this.viewX = (W - WORLD_W * this.viewScale) / 2;
    this.viewY = (H - WORLD_H * this.viewScale) / 2;
    const res = this.app.renderer.resolution;
    const rs = Math.max(1, Math.min(2.5, this.viewScale * res));
    const q = this.settings.quality === "low" ? Math.min(rs, 1.25) : rs;
    const newScale = Math.round(q * 4) / 4;
    const scaleChanged = newScale !== this.renderScale;
    this.renderScale = newScale;
    this.buildVignette(W, H);
    this.flash.clear().rect(0, 0, W, H).fill({ color: 0xffffff });
    this.flash.alpha = 0;
    if (scaleChanged && this.currentMap) { this.mapKey = ""; this.setMap(this.currentMap); }
    this.layoutBackground();
    document.documentElement.style.setProperty("--vp-x", this.viewX + "px");
    document.documentElement.style.setProperty("--vp-y", this.viewY + "px");
    document.documentElement.style.setProperty("--vp-w", WORLD_W * this.viewScale + "px");
    document.documentElement.style.setProperty("--vp-h", WORLD_H * this.viewScale + "px");
    document.documentElement.style.setProperty("--vp-scale", String(this.viewScale));
  }

  private buildVignette(W: number, H: number) {
    const c = makeCanvas(Math.max(2, W / 2), Math.max(2, H / 2));
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.35, c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.72);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,.42)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    if (this.vignette.texture !== Texture.EMPTY) this.vignette.texture.destroy(true);
    this.vignette.texture = Texture.from(c);
    this.vignette.width = W;
    this.vignette.height = H;
  }

  private layoutBackground() {
    const W = this.app.screen.width, H = this.app.screen.height;
    const cover = Math.max(W / WORLD_W, H / WORLD_H) * 1.04;
    for (const s of [this.skySprite, this.farSprite, this.nearSprite]) {
      const tw = s.texture.width || 1;
      s.scale.set((WORLD_W * cover) / tw);
      s.position.set((W - WORLD_W * cover) / 2, (H - WORLD_H * cover) / 2);
    }
  }

  /** Hornea fondo + plataformas del mapa (una vez por mapa o al cambiar de resolución). */
  setMap(map: MapDef) {
    const key = map.name + ":" + map.seed + ":" + map.biome + ":" + this.renderScale + ":" + this.settings.quality;
    this.currentMap = map;
    if (key === this.mapKey) return;
    this.mapKey = key;
    {
      const bgScale = Math.min(1.5, this.renderScale);
      const layers = buildBackground(map.biome, map.seed || 1, WORLD_W, WORLD_H, bgScale);
      for (const [s, c] of [[this.skySprite, layers.sky], [this.farSprite, layers.far], [this.nearSprite, layers.near]] as const) {
        if (s.texture && s.texture !== Texture.EMPTY) s.texture.destroy(true);
        s.texture = Texture.from(c);
      }
      this.layoutBackground();
    }
    const plat = buildPlatformLayer(map, WORLD_W, WORLD_H, this.renderScale);
    if (this.platformSprite.texture && this.platformSprite.texture !== Texture.EMPTY) this.platformSprite.texture.destroy(true);
    this.platformSprite.texture = Texture.from(plat);
    this.platformSprite.scale.set(1 / this.renderScale);
    this.ambient.clear();
    // un sprite de decoración por plataforma (enredaderas, brasas, carteles...)
    for (const d of this.decoSprites) d.destroy();
    this.decoSprites = map.platforms.map((pl) => {
      const cs = new CanvasSprite(pl.w + 40, pl.h + 90, -20, -40);
      this.decoLayer.addChild(cs.sprite);
      return cs;
    });
  }

  /* ================================================================ efectos */
  sparks(x: number, y: number, dir: number, color: string) {
    const c = hexToNum(color);
    this.fx.burst(x, y, 10, { minSpd: 3, maxSpd: 4.5, minLife: 80, lifeRange: 90, minSize: 1.6, sizeRange: 1.8, color: c, gravity: 0, drag: 0.012, cone: { dir: dir > 0 ? 0 : Math.PI, spread: 1.4 } });
    this.fx.burst(x, y, 4, { minSpd: 0.5, maxSpd: 1.2, minLife: 120, lifeRange: 80, minSize: 3.5, sizeRange: 2, color: 0xffffff, gravity: 0, drag: 0.01 });
  }

  landingDust(x: number, y: number, strength: number) {
    const n = Math.min(12, 3 + Math.round(strength * 9));
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      this.fx.spawn({
        x: x + side * Math.random() * 6, y: y - Math.random() * 3,
        vx: side * (0.4 + Math.random() * 1.6 * strength), vy: -0.2 - Math.random() * 0.6 * strength,
        life: 260 + Math.random() * 220, size: 1.4 + Math.random() * 1.8, color: 0xdde6ff, alpha: 0.6, gravity: 0.0016, drag: 0.004,
      });
    }
  }

  jumpPuff(x: number, y: number, dbl: boolean) {
    for (let i = 0; i < (dbl ? 8 : 5); i++) {
      const a = Math.PI / 2 + (Math.random() - 0.5) * (dbl ? 2.4 : 1.2);
      this.fx.spawn({ x, y: y - (dbl ? 18 : 0), vx: Math.cos(a) * 1.2, vy: Math.sin(a) * 0.8, life: 220 + Math.random() * 120, size: 1.6 + Math.random(), color: dbl ? 0xc9ffb0 : 0xdde6ff, alpha: 0.55, gravity: 0, drag: 0.006 });
    }
  }

  koBurst(x: number, y: number, color: string) {
    const c = hexToNum(color);
    this.fx.burst(x, y, 70, { minSpd: 1.2, maxSpd: 6, minLife: 380, lifeRange: 520, minSize: 1.6, sizeRange: 3, color: c, gravity: 0.0012, drag: 0.0026 });
    this.fx.burst(x, y, 18, { minSpd: 0.3, maxSpd: 1.5, minLife: 500, lifeRange: 400, minSize: 4, sizeRange: 4, color: 0xffffff, gravity: -0.0002, drag: 0.004 });
  }

  pickupBurst(x: number, y: number, color: string) {
    this.fx.burst(x, y, 28, { minSpd: 1, maxSpd: 3.2, minLife: 300, lifeRange: 300, minSize: 1.8, sizeRange: 2, color: hexToNum(color), gravity: -0.0004, drag: 0.004 });
  }

  embers(x: number, y: number) {
    this.fx.burst(x, y, 5, { minSpd: 0.3, maxSpd: 0.9, minLife: 300, lifeRange: 250, minSize: 1.2, sizeRange: 1, color: 0xff9a3c, gravity: -0.0015, drag: 0.002 });
  }

  sparkle(x: number, y: number, color: string) {
    this.fx.burst(x, y, 16, { minSpd: 0.6, maxSpd: 1.8, minLife: 350, lifeRange: 300, minSize: 1.4, sizeRange: 1.4, color: hexToNum(color), gravity: -0.0006, drag: 0.004 });
  }

  impactStreak(x: number, y: number, dir: number) {
    this.streakList.push({ x, y, dir, t: 90 });
    if (this.streakList.length > 12) this.streakList.shift();
  }

  screenFlash(strength: number) {
    if (this.settings.reduceMotion) strength *= 0.35;
    this.flashA = Math.min(1, this.flashA + strength);
  }

  /** Onda de choque en coordenadas de mundo. */
  shockwave(x: number, y: number, strength: number) {
    if (this.settings.quality === "low" || this.settings.reduceMotion) return;
    if (this.shockwaves.length >= 3) return;
    const p = this.worldToScreen(x, y);
    const f = new ShockwaveFilter({
      center: { x: p.x, y: p.y }, amplitude: 22 * strength, wavelength: 120 * this.viewScale,
      speed: 900 * this.viewScale, brightness: 1.08, radius: 420 * this.viewScale * strength, time: 0,
    });
    this.shockwaves.push({ f, t: 0, dur: 0.55 });
    this.updateRootFilters();
  }

  chroma(ms: number) {
    if (this.settings.quality === "low" || this.settings.reduceMotion) return;
    this.rgbT = Math.max(this.rgbT, ms);
    this.updateRootFilters();
  }

  /** Los palitos del muñeco salen volando al hacer KO. */
  limbDebris(x: number, y: number, color: string, dir: number) {
    const c = hexToNum(color);
    const pieces = [[-7, 0, 7, 0], [-6, 0, 6, 0], [-6, 0, 6, 0], [-6.5, 0, 6.5, 0], [-6.5, 0, 6.5, 0], [-9, 0, 9, 0]];
    pieces.forEach((pc, i) => {
      const g = new Graphics();
      if (i === 0) g.circle(0, 0, 7.6).stroke({ width: 3.6, color: c, cap: "round" });
      else g.moveTo(pc[0], pc[1]).lineTo(pc[2], pc[3]).stroke({ width: 4, color: c, cap: "round" });
      g.position.set(x + (Math.random() - 0.5) * 16, y - 10 - i * 5);
      g.rotation = Math.random() * Math.PI;
      this.debrisLayer.addChild(g);
      this.debris.push({
        g, vx: dir * (1.5 + Math.random() * 4) + (Math.random() - 0.5) * 3, vy: -5 - Math.random() * 6,
        vr: (Math.random() - 0.5) * 0.4, life: 1400, maxLife: 1400,
      });
    });
  }

  damageNumber(x: number, y: number, dmg: number, color: string, big: boolean) {
    const style: TextStyleOptions = {
      fontFamily: "Chakra Petch, sans-serif", fontWeight: "800", fontSize: big ? 22 : 15,
      fill: color, stroke: { color: 0x05060d, width: 4 }, align: "center",
    };
    const t = new Text({ text: String(dmg), style, resolution: Math.min(3, this.renderScale * 1.5) });
    t.anchor.set(0.5);
    t.position.set(x + (Math.random() - 0.5) * 14, y - 18);
    t.scale.set(0.6);
    this.textLayer.addChild(t);
    this.floats.push({ t, vy: -1.4, life: 700, maxLife: 700 });
    if (this.floats.length > 24) { const f = this.floats.shift()!; f.t.destroy(); }
  }

  clearTransient() {
    this.fx.clear();
    for (const d of this.debris) d.g.destroy();
    this.debris = [];
    for (const f of this.floats) f.t.destroy();
    this.floats = [];
    this.streakList = [];
    this.flashA = 0;
    for (const g of this.gfx.values()) { g.trail.length = 0; g.airTrail.length = 0; }
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    const cf = this.camera.frame();
    const s = this.viewScale * cf.zoom;
    const W = this.app.screen.width, H = this.app.screen.height;
    return { x: W / 2 + (x - cf.cx + cf.shakeX) * s, y: H / 2 + (y - cf.cy + cf.shakeY) * s };
  }

  /* ================================================================ cuadro */
  private updateFx(dt: number) {
    this.fx.update(dt);
    this.flashA = Math.max(0, this.flashA - dt * 0.006);
    this.flash.alpha = this.flashA * 0.55;
    for (let i = this.streakList.length - 1; i >= 0; i--) {
      this.streakList[i].t -= dt;
      if (this.streakList[i].t <= 0) this.streakList.splice(i, 1);
    }
    const s = this.streaks.clear();
    for (const st of this.streakList) {
      const a = st.t / 90;
      s.moveTo(st.x - 12 * st.dir, st.y - 1).lineTo(st.x + 12 * st.dir, st.y - 1).stroke({ width: 1.4, color: 0xff5078, alpha: a * 0.85 });
      s.moveTo(st.x - 12 * st.dir, st.y + 1).lineTo(st.x + 12 * st.dir, st.y + 1).stroke({ width: 1.4, color: 0x5adcff, alpha: a * 0.85 });
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      const f = dt / 16.667;
      d.vy += 0.45 * f;
      d.g.x += d.vx * f;
      d.g.y += d.vy * f;
      d.g.rotation += d.vr * f;
      d.g.alpha = Math.min(1, d.life / 500);
      if (d.life <= 0 || d.g.y > WORLD_H + 80) { d.g.destroy(); this.debris.splice(i, 1); }
    }
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const fl = this.floats[i];
      fl.life -= dt;
      const k = fl.life / fl.maxLife;
      fl.t.y += fl.vy * (dt / 16.667);
      fl.vy *= 0.94;
      const pop = k > 0.8 ? 0.6 + (1 - k) * 3 : 1;
      fl.t.scale.set(Math.min(1.1, pop));
      fl.t.alpha = Math.min(1, k * 2.5);
      if (fl.life <= 0) { fl.t.destroy(); this.floats.splice(i, 1); }
    }
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.t += dt / 1000;
      sw.f.time = sw.t;
      if (sw.t >= sw.dur) { this.shockwaves.splice(i, 1); this.updateRootFilters(); }
    }
    if (this.rgbT > 0) {
      this.rgbT = Math.max(0, this.rgbT - dt);
      const a = Math.min(1, this.rgbT / 140) * 4 * this.viewScale;
      this.rgb.red = { x: -a, y: 0 };
      this.rgb.blue = { x: a, y: 0 };
      if (this.rgbT === 0) this.updateRootFilters();
    }
  }

  private updateAmbient(dt: number, map: MapDef) {
    if (artCfg.low) { this.ambient.clear(); return; }
    this.ambientAccum += dt;
    const biome = map.biome;
    if (this.ambientAccum >= 200) {
      this.ambientAccum = 0;
      const W = WORLD_W, rnd = Math.random;
      if (biome === "bosque") this.ambient.spawn({ x: rnd() * W, y: -6, vx: (rnd() - 0.5) * 0.4, vy: 0.3 + rnd() * 0.2, life: 7000, size: 2.4 + rnd() * 1.6, color: 0x8fd45a, alpha: 0.7, gravity: 0, drag: 0, spin: 0.002, shrink: false });
      else if (biome === "volcan") this.ambient.spawn({ x: rnd() * W, y: WORLD_H + 6, vx: (rnd() - 0.5) * 0.3, vy: -0.3 - rnd() * 0.3, life: 7000, size: 1.2 + rnd() * 1.4, color: 0xffb37a, alpha: 0.8, gravity: 0, drag: 0, shrink: false });
      else if (biome === "nieve") this.ambient.spawn({ x: rnd() * W, y: -6, vx: (rnd() - 0.5) * 0.35, vy: 0.25 + rnd() * 0.25, life: 9000, size: 1.4 + rnd() * 1.8, color: 0xeaf4ff, alpha: 0.85, gravity: 0, drag: 0, shrink: false });
      else if (biome === "ruinas") this.ambient.spawn({ x: rnd() * W, y: 100 + rnd() * 380, vx: (rnd() - 0.5) * 0.15, vy: -0.05 - rnd() * 0.05, life: 5000, size: 1 + rnd(), color: 0xcdd6ff, alpha: 0.6, gravity: 0, drag: 0, shrink: false });
      else this.ambient.spawn({ x: rnd() * W, y: 60 + rnd() * 420, vx: (rnd() - 0.5) * 0.12, vy: (rnd() - 0.5) * 0.12, life: 1000, size: 1 + rnd(), color: 0x35f0e0, alpha: 0.9, gravity: 0, drag: 0 });
    }
    this.ambient.update(dt);
  }

  private gfxFor(id: number): PlayerGfx {
    let g = this.gfx.get(id);
    if (!g) {
      g = {
        body: new CanvasSprite(BODY_BOX.w, BODY_BOX.h, BODY_BOX.ox, BODY_BOX.oy),
        tag: new CanvasSprite(TAG_BOX.w, TAG_BOX.h, TAG_BOX.ox, TAG_BOX.oy),
        tagKey: "", anim: {}, trail: [], trailT: 0, airTrail: [], airT: 0, seen: 0,
      };
      this.playerLayer.addChild(g.body.sprite);
      this.tagLayer.addChild(g.tag.sprite);
      this.gfx.set(id, g);
    }
    return g;
  }

  /** Olvida el estado visual de los jugadores (nueva partida / nueva sesión). */
  resetPlayers() {
    for (const g of this.gfx.values()) { g.body.destroy(); g.tag.destroy(); }
    this.gfx.clear();
  }

  private pushGhost(list: Ghost[], p: RenderPlayer, max: number) {
    list.push({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, facing: p.facing, grounded: p.grounded, attack: p.attack ? { ...p.attack } : null, walkCycle: p.walkCycle, idleT: p.idleT, squash: p.squash });
    if (list.length > max) list.shift();
  }

  private drawPlayer(view: RenderView, p: RenderPlayer, now: number, scale: number) {
    const g = this.gfxFor(p.id);
    g.seen = this.frameNo;
    const fading = !p.alive && p.deathFadeT > 0;
    const visible = p.alive || view.phase === "lobby" || fading;
    g.body.sprite.visible = visible;
    g.tag.sprite.visible = visible && !fading && !view.hideTags;
    if (!visible) { g.trail.length = 0; g.airTrail.length = 0; return; }

    let color = view.colorFor(p.id);
    const hat = view.hatFor(p.id);
    // destello blanco al recibir un golpe
    const whiten = Math.max(0, Math.min(1, (p.hitStunT - 60) / 60));
    if (whiten > 0) color = mixWhite(color, whiten * 0.75);

    const ctx = g.body.begin(p.x, p.y, scale);
    const low = artCfg.low;
    if (!low && p.attack) {
      if (now - g.trailT >= 26) { g.trailT = now; this.pushGhost(g.trail, p, 3); }
    } else g.trail.length = 0;
    if (!low && p.power && p.power.aire && p.alive) {
      if (now - g.airT >= 18) { g.airT = now; this.pushGhost(g.airTrail, p, 6); }
    } else g.airTrail.length = 0;
    const drawGhosts = (list: Ghost[], base: number, spread: number) => {
      list.forEach((gh, i) => {
        ctx.save();
        ctx.globalAlpha = base + (i / list.length) * spread;
        drawStickman(ctx, { ...p, ...gh, attack: gh.attack }, color, hat, null);
        ctx.restore();
      });
    };
    if (g.trail.length) drawGhosts(g.trail, 0.1, 0.16);
    if (g.airTrail.length) drawGhosts(g.airTrail, 0.05, 0.34);

    const rig = drawStickman(ctx, p, color, hat, g.anim, this.rigInfo);
    if (!low) drawStickShine(ctx, this.rigInfo);
    g.body.end();
    g.body.sprite.alpha = fading ? Math.max(0, Math.min(1, p.deathFadeT / 420)) : 1;

    // cartel (nombre/vida/poderes), en su propia capa para que el bloom no lo desenfoque
    const hudY = rig.headY - accessoryLift(hat);
    const showHp = view.phase === "fight" || view.phase === "fightIntro" || view.phase === "roundEnd";
    let modeScore: string | null = null, modeColor = "#fff";
    if (view.gameMode === "koth") { modeScore = (view.scores[p.id] || 0) + " / " + HILL_TARGET; modeColor = "rgba(255,194,71,.95)"; }
    else if (view.gameMode === "orbking") { modeScore = (view.scores[p.id] || 0) + "s"; modeColor = "rgba(157,255,79,.95)"; }
    const name = view.nameFor(p.id);
    const isMe = view.meId === p.id;
    const powerKey = p.power ? Object.keys(p.power).filter((k) => k !== "t").join("") : "";
    const tagKey = [name, Math.round(p.hp), showHp, modeScore, powerKey, isMe, view.colorFor(p.id), scale].join("|");
    const anchorY = hudY;
    if (tagKey !== g.tagKey) {
      g.tagKey = tagKey;
      const tctx = g.tag.begin(p.x, anchorY, scale);
      drawNameTag(tctx, { ...p, x: p.x }, { name, color: view.colorFor(p.id), hudY: anchorY, showHp, maxHp: view.maxHpFor(p.id), modeScore, modeColor, isMe });
      g.tag.end();
    } else {
      g.tag.sprite.position.set(p.x + TAG_BOX.ox, anchorY + TAG_BOX.oy);
    }
  }

  render(view: RenderView | null, dt: number) {
    if (!this.ready) return;
    this.frameNo++;
    if (!view) {
      this.world.visible = false;
      this.updateFx(dt);
      this.app.render();
      return;
    }
    this.world.visible = true;
    this.setMap(view.map);

    // cámara
    const targets = view.phase === "fight" || view.phase === "fightIntro"
      ? view.players.filter((p) => p.alive && p.y < WORLD_H).map((p) => ({ x: p.x, y: p.y }))
      : [];
    this.camera.update(dt, targets, this.settings.reduceMotion);
    const cf = this.camera.frame();
    const W = this.app.screen.width, H = this.app.screen.height;
    const s = this.viewScale * cf.zoom;
    this.world.scale.set(s);
    this.world.position.set(W / 2 - (cf.cx - cf.shakeX) * s, H / 2 - (cf.cy - cf.shakeY) * s);
    // parallax del fondo con el shake y el encuadre
    const px = (cf.cx - WORLD_W / 2) * this.viewScale, py = (cf.cy - WORLD_H / 2) * this.viewScale;
    this.farSprite.x = this.skySprite.x - px * 0.08 + cf.shakeX * 0.15 * this.viewScale;
    this.farSprite.y = this.skySprite.y - py * 0.08 + cf.shakeY * 0.15 * this.viewScale;
    this.nearSprite.x = this.skySprite.x - px * 0.18 + cf.shakeX * 0.35 * this.viewScale;
    this.nearSprite.y = this.skySprite.y - py * 0.18 + cf.shakeY * 0.35 * this.viewScale;
    const bgZoom = 1 + (cf.zoom - 1) * 0.25;
    this.bg.scale.set(bgZoom);
    this.bg.position.set((W - W * bgZoom) / 2, (H - H * bgZoom) / 2);

    // resolución de los canvases por entidad: incluye el zoom para que no se vean borrosos
    const entScale = Math.round(Math.min(3, this.renderScale * cf.zoom) * 4) / 4;

    // decoraciones animadas (a 30 Hz alcanza) + objetos
    this.decoLayer.visible = !artCfg.low;
    if (!artCfg.low && this.frameNo % 2 === 0) {
      const ds = Math.min(1.5, entScale);
      view.map.platforms.forEach((pl, i) => {
        const cs = this.decoSprites[i];
        if (!cs) return;
        const dctx = cs.begin(pl.x, pl.y, ds);
        drawDecorations(dctx, view.map, view.timeMs, i);
        cs.end();
      });
    }
    const os = Math.min(2, entScale);
    const hill = view.gameMode === "koth" ? view.hill : null;
    this.hillSprite.sprite.visible = !!hill;
    if (hill) { const c = this.hillSprite.begin(hill.x, hill.y, Math.min(1.5, os)); drawHill(c, hill, view.timeMs); this.hillSprite.end(); }
    this.portalSprite.sprite.visible = !!view.portal;
    if (view.portal) { const c = this.portalSprite.begin(view.portal.x, view.portal.y, os); drawWorldObjects(c, view.portal, null); this.portalSprite.end(); }
    this.voidSprite.sprite.visible = !!view.voidHole;
    if (view.voidHole) { const c = this.voidSprite.begin(view.voidHole.x, view.voidHole.y, os); drawWorldObjects(c, null, view.voidHole); this.voidSprite.end(); }
    this.orbSprite.sprite.visible = !!view.orb;
    if (view.orb) { const c = this.orbSprite.begin(view.orb.x, view.orb.y, os); drawOrb(c, view.orb); this.orbSprite.end(); }

    this.updateAmbient(dt, view.map);

    // jugadores: los muertos atrás, el propio adelante
    const ordered = view.players.slice().sort((a, b) => {
      const ka = (a.alive ? 1 : 0) + (a.id === view.meId ? 2 : 0);
      const kb = (b.alive ? 1 : 0) + (b.id === view.meId ? 2 : 0);
      return ka - kb;
    });
    const now = view.timeMs;
    ordered.forEach((p, i) => {
      this.drawPlayer(view, p, now, entScale);
      const g = this.gfx.get(p.id)!;
      this.playerLayer.setChildIndex(g.body.sprite, Math.min(i, this.playerLayer.children.length - 1));
    });
    for (const [id, g] of this.gfx) {
      if (g.seen !== this.frameNo) { g.body.sprite.visible = false; g.tag.sprite.visible = false; if (this.frameNo - g.seen > 600) { g.body.destroy(); g.tag.destroy(); this.gfx.delete(id); } }
    }

    this.updateFx(dt);
    this.app.render();
  }
}

function mixWhite(hex: string, k: number): string {
  const n = hexToNum(hex);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const m = (c: number) => Math.round(c + (255 - c) * k);
  return "rgb(" + m(r) + "," + m(g) + "," + m(b) + ")";
}
