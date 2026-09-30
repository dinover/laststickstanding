/* Objetos del mundo en Pixi (V2): orbe de poder, zona de Rey de la Colina, portal y agujero de
   vacío del Modo Historia. Reemplazan a los dibujos Canvas 2D de V1 (orbe con emoji, anillos
   "gelatina" temblorosos, círculo punteado).

   - Todo se anima en función de la edad del objeto (bornT) o del reloj de la partida: es
     determinista, se ve igual en todos los clientes y respeta la cámara lenta.
   - Las apariciones usan curvas de GSAP (back/elastic), los vórtices son una textura espiral
     procedural rotando en dos capas, y el vacío deforma lo que tiene alrededor con el
     BulgePinchFilter de pixi-filters (lo aplica el renderer, que conoce la pantalla). */

import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { POWER_COLORS, type PowerType } from "@lss/shared";
import { makeCanvas } from "./art/world";
import { clamp01, ease } from "./ease";

const TAU = Math.PI * 2;

/* ---------------------------------------------------------------- texturas procedurales */
let texCache: { glow: Texture; sphere: Texture; spiral: Texture; zone: Texture } | null = null;

function textures() {
  if (texCache) return texCache;
  // halo suave
  const g = makeCanvas(128, 128), gc = g.getContext("2d")!;
  const gg = gc.createRadialGradient(64, 64, 0, 64, 64, 64);
  gg.addColorStop(0, "rgba(255,255,255,1)");
  gg.addColorStop(0.3, "rgba(255,255,255,.45)");
  gg.addColorStop(1, "rgba(255,255,255,0)");
  gc.fillStyle = gg; gc.fillRect(0, 0, 128, 128);
  // esfera con luz desde arriba a la izquierda (blanco = color del poder al teñirla)
  const s = makeCanvas(96, 96), sc = s.getContext("2d")!;
  const sg = sc.createRadialGradient(36, 32, 2, 48, 48, 48);
  sg.addColorStop(0, "#ffffff");
  sg.addColorStop(0.35, "#e9e9e9");
  sg.addColorStop(0.8, "#8f8f8f");
  sg.addColorStop(1, "#6a6a6a");
  sc.fillStyle = sg; sc.beginPath(); sc.arc(48, 48, 47, 0, TAU); sc.fill();
  // luz de rebote abajo a la derecha
  const rg = sc.createRadialGradient(64, 68, 0, 64, 68, 30);
  rg.addColorStop(0, "rgba(255,255,255,.35)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  sc.fillStyle = rg; sc.beginPath(); sc.arc(48, 48, 47, 0, TAU); sc.fill();
  // espiral de 3 brazos para los vórtices
  const N = 256, sp = makeCanvas(N, N), spc = sp.getContext("2d")!;
  const img = spc.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x - N / 2) / (N / 2), dy = (y - N / 2) / (N / 2);
    const r = Math.hypot(dx, dy);
    if (r > 1) continue;
    const th = Math.atan2(dy, dx);
    const arm = Math.pow(0.5 + 0.5 * Math.cos(3 * (th - 3.2 * Math.log(r + 0.05))), 2.2);
    const fall = Math.pow(r, 0.7) * Math.pow(1 - r, 0.9) * 2.4;
    const a = Math.min(1, arm * fall + fall * 0.18);
    const i = (y * N + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.round(a * 255);
  }
  spc.putImageData(img, 0, 0);
  // disco de zona: transparente al centro, más denso contra el borde
  const z = makeCanvas(256, 256), zc = z.getContext("2d")!;
  const zg = zc.createRadialGradient(128, 128, 0, 128, 128, 128);
  zg.addColorStop(0, "rgba(255,255,255,.03)");
  zg.addColorStop(0.7, "rgba(255,255,255,.1)");
  zg.addColorStop(0.97, "rgba(255,255,255,.3)");
  zg.addColorStop(1, "rgba(255,255,255,0)");
  zc.fillStyle = zg; zc.fillRect(0, 0, 256, 256);
  texCache = { glow: Texture.from(g), sphere: Texture.from(s), spiral: Texture.from(sp), zone: Texture.from(z) };
  return texCache;
}

function sprite(tex: Texture, sizePx: number, tint = 0xffffff, alpha = 1): Sprite {
  const s = new Sprite(tex);
  s.anchor.set(0.5);
  s.width = s.height = sizePx;
  s.tint = tint;
  s.alpha = alpha;
  return s;
}

const hex = (h: string) => parseInt(h.replace("#", "").slice(0, 6), 16);

/* ---------------------------------------------------------------- íconos de poder */
function drawPowerIcon(g: Graphics, type: PowerType, color: number) {
  g.clear();
  if (type === "fuego") {
    g.moveTo(0, -7.5).bezierCurveTo(3, -4, 5.5, -1, 4.6, 2.4).bezierCurveTo(3.8, 5.6, 1.6, 6.8, 0, 6.8)
      .bezierCurveTo(-1.6, 6.8, -3.8, 5.6, -4.6, 2.4).bezierCurveTo(-5.2, -0.4, -3, -2, -2.4, -4.4)
      .bezierCurveTo(-1.2, -2.6, -0.6, -2, 0, -7.5).fill({ color: 0xffffff });
    g.moveTo(0.4, -1.5).bezierCurveTo(2.2, 0.6, 2.8, 2.6, 2.1, 4).bezierCurveTo(1.4, 5.4, -1.4, 5.4, -2.1, 4)
      .bezierCurveTo(-2.6, 2.8, -1.4, 1.4, 0.4, -1.5).fill({ color });
  } else if (type === "hielo") {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI + Math.PI / 2;
      const cx = Math.cos(a), sy = Math.sin(a);
      g.moveTo(-cx * 6.8, -sy * 6.8).lineTo(cx * 6.8, sy * 6.8);
      for (const s of [-1, 1]) {
        const bx = cx * 4.2 * s, by = sy * 4.2 * s;
        for (const w of [-1, 1]) {
          const ba = a + (s > 0 ? 0 : Math.PI) + w * 0.75;
          g.moveTo(bx, by).lineTo(bx + Math.cos(ba) * 2.4, by + Math.sin(ba) * 2.4);
        }
      }
    }
    g.stroke({ width: 1.5, color: 0xffffff, cap: "round" });
  } else if (type === "tierra") {
    g.moveTo(0, -7).lineTo(5.8, -4.6).lineTo(5.4, 0.8).bezierCurveTo(4.8, 3.8, 2.6, 5.8, 0, 7)
      .bezierCurveTo(-2.6, 5.8, -4.8, 3.8, -5.4, 0.8).lineTo(-5.8, -4.6).closePath().fill({ color: 0xffffff });
    g.moveTo(0, -4.4).lineTo(3.4, -3).lineTo(3.1, 0.6).bezierCurveTo(2.7, 2.6, 1.5, 3.8, 0, 4.5).closePath().fill({ color });
  } else {
    g.poly([1.8, -7.6, -4.4, 1.2, -0.6, 1.2, -1.8, 7.6, 4.4, -1.2, 0.6, -1.2]).fill({ color: 0xffffff });
  }
}

/* ---------------------------------------------------------------- orbe de poder */
export class OrbView {
  readonly root = new Container();
  private body = new Container();
  private glow: Sprite;
  private ringBack = new Graphics();
  private sphere: Sprite;
  private spec = new Graphics();
  private icon = new Graphics();
  private ringFront = new Graphics();
  private spawnRing = new Graphics();
  private type = "";

  constructor() {
    const t = textures();
    this.glow = sprite(t.glow, 64, 0xffffff, 0.55);
    this.sphere = sprite(t.sphere, 21);
    this.spec.ellipse(-3.6, -4.2, 3.2, 2.2).fill({ color: 0xffffff, alpha: 0.85 });
    this.spec.circle(3.2, 4.4, 1).fill({ color: 0xffffff, alpha: 0.35 });
    this.icon.alpha = 0.95;
    this.body.addChild(this.glow, this.ringBack, this.sphere, this.spec, this.icon, this.ringFront);
    this.root.addChild(this.spawnRing, this.body);
  }

  update(orb: { type: string; x: number; y: number; bornT: number }) {
    const color = hex(POWER_COLORS[orb.type as PowerType] || "#ffffff");
    if (orb.type !== this.type) {
      this.type = orb.type;
      this.glow.tint = color;
      this.sphere.tint = color;
      drawPowerIcon(this.icon, orb.type as PowerType, color);
    }
    const t = orb.bornT;
    this.root.position.set(orb.x, orb.y + Math.sin(t * 0.004) * 4);
    // aparición: salta desde cero con rebote + anillo que se expande
    const pop = ease("back.out(2.4)")(clamp01(t / 380));
    this.body.scale.set(pop);
    const pulse = 1 + Math.sin(t * 0.008) * 0.08;
    this.glow.scale.set((64 / 128) * pulse * 1.0);
    this.icon.rotation = Math.sin(t * 0.003) * 0.12;
    const sr = this.spawnRing.clear();
    if (t < 520) {
      const u = ease("power2.out")(t / 520);
      sr.circle(0, 0, 8 + u * 30).stroke({ width: 2.4 * (1 - u) + 0.4, color, alpha: 1 - u });
    }
    // anillo inclinado con tres chispas: la mitad de atrás pasa por detrás de la esfera
    const tilt = -0.38, rx = 17, ry = 5.2;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const P = (a: number) => { const x = Math.cos(a) * rx, y = Math.sin(a) * ry; return [x * ct - y * st, x * st + y * ct]; };
    const back = this.ringBack.clear(), front = this.ringFront.clear();
    const arc = (g: Graphics, a0: number, a1: number, alpha: number) => {
      const [x0, y0] = P(a0);
      g.moveTo(x0, y0);
      for (let k = 1; k <= 16; k++) { const [x, y] = P(a0 + ((a1 - a0) * k) / 16); g.lineTo(x, y); }
      g.stroke({ width: 1.1, color, alpha });
    };
    arc(back, Math.PI, TAU, 0.3);
    arc(front, 0, Math.PI, 0.75);
    for (let i = 0; i < 3; i++) {
      const a = ((t * 0.0032 + i / 3) % 1) * TAU;
      const [x, y] = P(a);
      (Math.sin(a) > 0 ? front : back).circle(x, y, Math.sin(a) > 0 ? 1.7 : 1.2).fill({ color: 0xffffff, alpha: Math.sin(a) > 0 ? 1 : 0.5 });
    }
  }
}

/* ---------------------------------------------------------------- vórtice (portal y vacío) */
interface VortexStyle { rim: number; arms: number; core: number; coreAlpha: number; motes: number; dark: boolean }

class VortexView {
  readonly root = new Container();
  protected body = new Container();
  private glow: Sprite;
  private armsA: Sprite;
  private armsB: Sprite;
  private core: Sprite;
  private rim = new Graphics();
  private hole = new Graphics();
  private motes = new Graphics();
  private style: VortexStyle | null = null;
  static readonly RX = 23;
  static readonly RY = 31;

  constructor() {
    const t = textures();
    this.glow = sprite(t.glow, 120, 0xffffff, 0.5);
    this.armsA = sprite(t.spiral, VortexView.RX * 2);
    this.armsB = sprite(t.spiral, VortexView.RX * 1.6);
    this.core = sprite(t.glow, 34);
    // las espirales rotan dentro de un contenedor aplastado: así el giro queda en óvalo vertical
    const oval = (sp: Sprite) => { const w = new Container(); w.scale.set(1, VortexView.RY / VortexView.RX); w.addChild(sp); return w; };
    this.body.addChild(this.glow, this.hole, oval(this.armsA), oval(this.armsB), this.core, this.motes, this.rim);
    this.root.addChild(this.body);
  }

  protected setStyle(s: VortexStyle) {
    if (this.style && this.style.rim === s.rim && this.style.core === s.core) return;
    this.style = s;
    this.glow.tint = s.rim;
    this.glow.alpha = s.dark ? 0.35 : 0.5;
    this.armsA.tint = s.arms;
    this.armsB.tint = s.dark ? s.rim : 0xffffff;
    this.core.tint = s.core;
    this.core.alpha = s.coreAlpha;
    const RX = VortexView.RX, RY = VortexView.RY;
    this.rim.clear();
    this.hole.clear();
    if (s.dark) this.hole.ellipse(0, 0, RX, RY).fill({ color: 0x020106, alpha: 0.92 });
    this.rim.ellipse(0, 0, RX, RY).stroke({ width: 3, color: s.rim });
    this.rim.ellipse(0, 0, RX - 2.4, RY - 2.4).stroke({ width: 1, color: 0xffffff, alpha: s.dark ? 0.25 : 0.6 });
  }

  protected animate(x: number, y: number, t: number) {
    const s = this.style!;
    this.root.position.set(x, y);
    const open = ease("elastic.out(1, 0.55)")(clamp01(t / 700));
    this.body.scale.set(open, open);
    // las dos capas giran en sentidos opuestos
    this.armsA.rotation = t * (s.dark ? 0.0035 : -0.0026);
    this.armsB.rotation = t * (s.dark ? -0.0018 : 0.0041);
    this.core.scale.set((34 / 128) * (1 + Math.sin(t * 0.006) * 0.08));
    // motas que caen en espiral hacia el centro
    const m = this.motes.clear();
    for (let i = 0; i < s.motes; i++) {
      const ph = (t * 0.00055 + i / s.motes) % 1;
      const r = 1 - ease("power2.in")(ph);
      const a = i * 2.39996 + ph * (s.dark ? 5 : -5);
      const mx = Math.cos(a) * VortexView.RX * 1.5 * r, my = Math.sin(a) * VortexView.RY * 1.3 * r;
      m.circle(mx, my, 0.8 + r * 1.2).fill({ color: s.dark ? s.rim : 0xffffff, alpha: Math.sin(ph * Math.PI) * 0.9 });
    }
  }
}

export class PortalView extends VortexView {
  private arrow = new Graphics();
  private color = "";

  constructor() {
    super();
    this.arrow.moveTo(-8, -5).lineTo(0, 3).lineTo(8, -5).stroke({ width: 3.2, color: 0xffffff, cap: "round", join: "round" });
    this.root.addChild(this.arrow);
  }

  update(p: { x: number; y: number; bornT: number; color?: string; boss?: boolean }) {
    const c = p.color || "#35f0e0";
    if (c !== this.color) {
      this.color = c;
      this.setStyle({ rim: hex(c), arms: hex(c), core: 0xffffff, coreAlpha: 0.85, motes: 12, dark: false });
      this.arrow.tint = hex(c);
    }
    this.animate(p.x, p.y, p.bornT);
    this.arrow.visible = !p.boss;
    const bob = ease("sine.inOut")(0.5 + 0.5 * Math.sin(p.bornT * 0.005));
    this.arrow.position.set(0, -VortexView.RY - 16 - bob * 7);
    this.arrow.alpha = clamp01(p.bornT / 500);
  }
}

export class VoidView extends VortexView {
  constructor() {
    super();
    this.setStyle({ rim: 0xa054ff, arms: 0x8a4dff, core: 0x000000, coreAlpha: 0.95, motes: 16, dark: true });
  }

  update(v: { x: number; y: number; bornT: number }) {
    this.animate(v.x, v.y, v.bornT);
  }
}

/* ---------------------------------------------------------------- zona de Rey de la Colina */
export class HillView {
  readonly root = new Container();
  private disc: Sprite;
  private outer = new Graphics();
  private inner = new Graphics();
  private pulse = new Graphics();
  private crown = new Graphics();
  private r = 0;
  private static readonly GOLD = 0xffc247;

  constructor() {
    this.disc = sprite(textures().zone, 100, HillView.GOLD);
    this.crown.poly([-7, 3, -8, -5, -3.6, -1.6, 0, -7.6, 3.6, -1.6, 8, -5, 7, 3]).fill({ color: HillView.GOLD });
    this.crown.rect(-7, 3.6, 14, 2.4).fill({ color: HillView.GOLD });
    this.crown.circle(0, -0.4, 1.3).fill({ color: 0xff2e88 });
    this.root.addChild(this.disc, this.pulse, this.inner, this.outer, this.crown);
  }

  update(h: { x: number; y: number; r: number }, tMs: number) {
    if (h.r !== this.r) {
      this.r = h.r;
      const r = h.r;
      this.disc.width = this.disc.height = r * 2;
      // anillo de 12 segmentos con cortes, como una zona de captura
      const o = this.outer.clear();
      const n = 12, gap = 0.12;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU + gap, a1 = ((i + 1) / n) * TAU - gap;
        o.moveTo(Math.cos(a0) * r, Math.sin(a0) * r).arc(0, 0, r, a0, a1).stroke({ width: 3, color: HillView.GOLD, cap: "round" });
      }
      const inn = this.inner.clear();
      inn.circle(0, 0, r * 0.84).stroke({ width: 1, color: HillView.GOLD, alpha: 0.35 });
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * TAU, r0 = r * 0.84, r1 = r0 - (i % 3 === 0 ? 5 : 2.5);
        inn.moveTo(Math.cos(a) * r0, Math.sin(a) * r0).lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      }
      inn.stroke({ width: 1, color: HillView.GOLD, alpha: 0.5 });
    }
    this.root.position.set(h.x, h.y);
    this.outer.rotation = tMs * 0.00025;
    this.inner.rotation = -tMs * 0.00015;
    // onda que sale del centro cada 1.6 s
    const u = (tMs % 1600) / 1600;
    const e = ease("power2.out")(u);
    this.pulse.clear().circle(0, 0, this.r * e).stroke({ width: 2, color: HillView.GOLD, alpha: (1 - u) * 0.45 });
    this.crown.position.set(0, -this.r - 12 + Math.sin(tMs * 0.004) * 2.5);
  }
}
