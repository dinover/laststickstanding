/* Muñeco V2 dibujado con Pixi Graphics (vectores en GPU, sin subir un canvas por jugador por
   cuadro). Consume el esqueleto de rig.ts.

   Qué cambia respecto del arte V1:
   - Miembros con grosor que se afina (muslo → tobillo, hombro → muñeca), puños y pies.
   - Profundidad sin contornos (a Dan los bordes oscuros le daban sensación de dibujo): el brazo
     y la pierna de atrás van más oscuros y detrás del torso, el torso un punto más apagado que los
     miembros de adelante, que además llevan un filo de luz.
   - Cabeza llena con ojos que cambian (parpadeo, concentración al pegar, dolor, KO), o la clásica
     de aro, a elección.
   - Estela de golpe ("swoosh") con una malla de Pixi que cubre el arco real que barrió el puño o
     el pie (muestreado de la curva de animación), en vez de repetir el muñeco entero como fantasma. */

import { AlphaFilter, CanvasSource, Container, Graphics, MeshSimple, Sprite, Texture } from "pixi.js";
import { POWER_COLORS } from "@lss/shared";
import { drawAccessory, firstActivePower, type RenderPlayer } from "./art/stickman";
import { makeCanvas } from "./art/world";
import { solveRig, type Expr, type Pt, type Rig, type RigState } from "./rig";

export type HeadStyle = "face" | "ring";

/** Tinta de los ojos. */
const INK = 0x070a14;
const LIGHT = { x: -0.45, y: -0.89 };
const DEG = Math.PI / 180;
const SMEAR_N = 10;

export function mixNum(a: number, b: number, k: number): number {
  const m = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * k));
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/* ---------------------------------------------------------------- primitivas */
/** Cápsula que se afina de `ra` a `rb` (un trapecio + dos círculos); solo agrega el trazado. */
function capsule(g: Graphics, a: Pt, ra: number, b: Pt, rb: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L > 0.01) {
    const nx = -dy / L, ny = dx / L;
    g.poly([a.x + nx * ra, a.y + ny * ra, b.x + nx * rb, b.y + ny * rb, b.x - nx * rb, b.y - ny * rb, a.x - nx * ra, a.y - ny * ra]);
  }
  g.circle(a.x, a.y, ra);
  g.circle(b.x, b.y, rb);
}

/** Filo de luz sobre el lado iluminado de un segmento. */
function rim(g: Graphics, a: Pt, ra: number, b: Pt, rb: number, color: number, alpha: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1.5) return;
  let nx = -dy / L, ny = dx / L;
  if (nx * LIGHT.x + ny * LIGHT.y < 0) { nx = -nx; ny = -ny; }
  const facing = nx * LIGHT.x + ny * LIGHT.y;
  if (facing < 0.15) return;
  const ka = ra * 0.5, kb = rb * 0.5;
  g.moveTo(a.x + nx * ka + dx * 0.08, a.y + ny * ka + dy * 0.08)
    .lineTo(b.x + nx * kb - dx * 0.08, b.y + ny * kb - dy * 0.08)
    .stroke({ width: Math.min(ra, rb) * 0.62, color, alpha: alpha * Math.min(1, facing * 1.3), cap: "round" });
}

/** Punta del pie: perpendicular a la canilla, hacia adelante (o hacia arriba en una patada). */
function toe(knee: Pt, ankle: Pt, facing: number, len: number): Pt {
  const dx = ankle.x - knee.x, dy = ankle.y - knee.y;
  const L = Math.hypot(dx, dy) || 1;
  return { x: ankle.x + facing * (dy / L) * len, y: ankle.y + facing * (-dx / L) * len };
}

interface Part { segs: [Pt, number, Pt, number][]; dots?: [Pt, number][] }

function partPath(g: Graphics, part: Part, grow: number) {
  for (const [a, ra, b, rb] of part.segs) capsule(g, a, ra + grow, b, rb + grow);
  if (part.dots) for (const [c, r] of part.dots) g.circle(c.x, c.y, r + grow);
}

function drawPart(g: Graphics, part: Part, color: number) {
  partPath(g, part, 0);
  g.fill({ color });
}

/* ---------------------------------------------------------------- cabeza */
const HEAD_RX = 7.9, HEAD_RY = 8.8;

function drawHead(g: Graphics, r: Rig, style: HeadStyle, color: number, hi: number, low: boolean) {
  const { x, y } = r.head;
  const f = r.facing;
  const rot = r.headLean * f * DEG;
  if (style === "ring") {
    g.ellipse(x, y, HEAD_RX, HEAD_RY).stroke({ width: 3.6, color });
    if (!low) arcStroke(g, x, y, HEAD_RX - 0.2, Math.PI * 1.08, Math.PI * 1.42, 1.2, hi, 0.8);
    return;
  }
  g.ellipse(x, y, HEAD_RX, HEAD_RY).fill({ color });
  if (!low) arcStroke(g, x, y, HEAD_RX - 1.9, Math.PI * 1.05, Math.PI * 1.45, 1.7, hi, 0.75);
  drawEyes(g, x, y, f, rot, r.expr);
}

function arcStroke(g: Graphics, x: number, y: number, r: number, a0: number, a1: number, width: number, color: number, alpha: number) {
  g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r).arc(x, y, r, a0, a1).stroke({ width, color, alpha, cap: "round" });
}

function drawEyes(g: Graphics, hx: number, hy: number, f: number, rot: number, expr: Expr) {
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const P = (lx: number, ly: number) => ({ x: hx + lx * cr - ly * sr, y: hy + lx * sr + ly * cr });
  const eyes = [f * 1.0, f * 4.7];
  const ink = { color: INK };
  for (let i = 0; i < 2; i++) {
    const ex = eyes[i], ey = -0.7;
    const s = i === 0 ? 0.9 : 1; // el ojo de atrás apenas más chico: da volumen
    if (expr === "blink") {
      const a = P(ex - 1.3 * s, ey + 0.4), b = P(ex + 1.3 * s, ey + 0.4);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1.1, color: INK, cap: "round" });
    } else if (expr === "focus") {
      // mirada entornada: el párpado de arriba baja hacia el centro de la cara
      const inner = i === 0 ? 1 : -1;
      const q = [P(ex - 1.35 * s, ey - 1.1 + inner * f * 0.7), P(ex + 1.35 * s, ey - 1.1 - inner * f * 0.7), P(ex + 1.2 * s, ey + 1.5), P(ex - 1.2 * s, ey + 1.5)];
      g.poly(q.flatMap((p) => [p.x, p.y])).fill(ink);
    } else if (expr === "hurt") {
      const d = i === 0 ? f : -f;
      const a = P(ex - d * 1.3, ey - 1.5), m = P(ex + d * 1.1, ey), b = P(ex - d * 1.3, ey + 1.5);
      g.moveTo(a.x, a.y).lineTo(m.x, m.y).lineTo(b.x, b.y).stroke({ width: 1.1, color: INK, cap: "round", join: "round" });
    } else if (expr === "ko") {
      const a = P(ex - 1.3, ey - 1.3), b = P(ex + 1.3, ey + 1.3), c = P(ex + 1.3, ey - 1.3), d = P(ex - 1.3, ey + 1.3);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).moveTo(c.x, c.y).lineTo(d.x, d.y).stroke({ width: 1.1, color: INK, cap: "round" });
    } else {
      const c = P(ex, ey);
      g.ellipse(c.x, c.y, 1.15 * s, 2.05 * s).fill(ink);
    }
  }
}

/* ---------------------------------------------------------------- auras (port de V1 a Graphics) */
type AuraKind = "fuego" | "hielo" | "tierra" | "aire";

function auraSegment(g: Graphics, a: Pt, b: Pt, kind: AuraKind, t: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  if (kind === "fuego") {
    for (let i = 0; i < 3; i++) {
      const u = (i + 0.5) / 3;
      const px = a.x + dx * u, py = a.y + dy * u;
      const flick = 0.5 + 0.5 * Math.sin(t * 10 + i * 2.3 + u * 7);
      const reach = 4 + flick * 6, sway = Math.sin(t * 15 + i * 4.1) * 2.5;
      g.poly([px - 2.2, py, px + sway, py - reach, px + 2.2, py]).fill({ color: mixNum(0xff6e23, 0xffd046, flick), alpha: 0.3 + flick * 0.45 });
    }
  } else if (kind === "hielo") {
    for (let j = 0; j < 4; j++) {
      const u = (j + 0.5) / 4;
      const side = j % 2 === 0 ? 1 : -1;
      const sx = a.x + dx * u + nx * 4.6 * side, sy = a.y + dy * u + ny * 4.6 * side;
      const shimmer = 0.45 + 0.32 * Math.sin(t * 2.4 + j * 1.7 + u * 4);
      g.poly([sx, sy - 3.8, sx + 2, sy, sx, sy + 3.8, sx - 2, sy]).fill({ color: 0xaae6ff, alpha: shimmer });
    }
  } else if (kind === "tierra") {
    for (let k = 0; k < 5; k++) {
      const u = ((k + 0.5) / 5) * 0.82 + 0.09;
      const jitter = ((Math.round(a.x) * 7 + Math.round(a.y) * 13 + k * 31) % 5) - 2;
      const ox = a.x + dx * u + nx * (5.4 + jitter), oy = a.y + dy * u + ny * (5.4 + jitter);
      const sz = 2.6 + (k % 3) * 0.6;
      g.poly([ox - sz, oy, ox, oy - sz, ox + sz, oy, ox, oy + sz * 0.9]).fill({ color: k % 2 === 0 ? 0xa07a44 : 0x7c5f35 });
    }
  } else {
    for (let m = 0; m < 2; m++) {
      const u = (t * (0.6 + m * 0.35) + m * 0.5) % 1;
      const tu = Math.max(0, u - 0.16);
      const off = Math.sin(t * 6 + m * 3) * 3.4;
      g.moveTo(a.x + dx * tu + nx * off, a.y + dy * tu + ny * off).lineTo(a.x + dx * u + nx * off, a.y + dy * u + ny * off)
        .stroke({ width: 1.6, color: 0xdcffe1, alpha: 0.55 - u * 0.25, cap: "round" });
    }
  }
}

function orbitAura(g: Graphics, cx: number, midY: number, halfW: number, halfH: number, t: number, color: number) {
  const rx = halfW + 6, ry = (halfH + 4) * 0.85;
  for (let i = 0; i < 3; i++) {
    const ang = t * (2.4 + i * 0.6) + i * ((Math.PI * 2) / 3);
    g.moveTo(cx + Math.cos(ang - 0.45) * rx, midY + Math.sin(ang - 0.45) * ry);
    for (let k = 1; k <= 4; k++) { const aa = ang - 0.45 + (0.45 * k) / 4; g.lineTo(cx + Math.cos(aa) * rx, midY + Math.sin(aa) * ry); }
    g.stroke({ width: 2, color, alpha: 0.6, cap: "round" });
    g.circle(cx + Math.cos(ang) * rx, midY + Math.sin(ang) * ry, 1.9).fill({ color, alpha: 0.95 });
  }
}

/* ---------------------------------------------------------------- accesorio */
/** El accesorio se sigue dibujando con el código V1 (Canvas 2D, afinado a mano), pero en un sprite
    propio que solo se redibuja si cambia (o si es animado); se mueve y rota con la cabeza. */
const ANIMATED_HATS = new Set(["halo", "flame", "propeller", "orbit"]);

class HatSprite {
  sprite = new Sprite(Texture.EMPTY);
  private canvas = makeCanvas(2, 2);
  private source: CanvasSource | null = null;
  private key = "";
  private static readonly BOX = 76;

  constructor() { this.sprite.anchor.set(0.5); }

  update(kind: string, head: Pt, rotDeg: number, facing: number, t: number, scale: number) {
    const visible = !!kind && kind !== "none";
    this.sprite.visible = visible;
    if (!visible) return;
    const key = kind + ":" + facing + ":" + scale;
    if (key !== this.key || ANIMATED_HATS.has(kind)) {
      const px = Math.ceil(HatSprite.BOX * scale);
      if (key !== this.key) {
        this.canvas.width = px; this.canvas.height = px;
        this.source?.destroy();
        this.source = new CanvasSource({ resource: this.canvas });
        this.sprite.texture = new Texture({ source: this.source });
        this.sprite.scale.set(1 / scale);
        this.key = key;
      }
      const ctx = this.canvas.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, px, px);
      ctx.setTransform(scale, 0, 0, scale, px / 2, px / 2);
      drawAccessory(ctx, kind, 0, 0, 0, facing, t);
      this.source!.update();
    }
    this.sprite.position.set(head.x, head.y);
    this.sprite.rotation = rotDeg * DEG;
  }

  destroy() { this.sprite.destroy(); this.source?.destroy(); }
}

/* ---------------------------------------------------------------- estela de golpe */
/* "Swoosh" como en los juegos de pelea: una malla (MeshSimple de Pixi) que cubre el área que barrió
   el miembro en los últimos ~70 ms de animación. Borde exterior = trayectoria de la punta, borde
   interior = trayectoria de la mitad del miembro. La textura se desvanece hacia lo viejo (u) y hacia
   adentro (v), con un filo brillante sobre el borde exterior. */
let swooshTex: Texture | null = null;
function swooshTexture(): Texture {
  if (swooshTex) return swooshTex;
  const W = 128, H = 64;
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    const across = Math.pow(1 - v, 1.6) * 0.75 + (v < 0.1 ? (1 - v / 0.1) * 0.35 : 0);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const along = Math.pow(u, 1.8);
      const a = Math.min(1, across * along);
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  swooshTex = Texture.from(c);
  return swooshTex;
}

function swooshMesh(): MeshSimple {
  const n = SMEAR_N;
  const uvs = new Float32Array(n * 4);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    uvs.set([u, 0, u, 1], i * 4);
    if (i < n - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
  }
  const m = new MeshSimple({ texture: swooshTexture(), vertices: new Float32Array(n * 4), uvs, indices: new Uint32Array(idx) });
  m.visible = false;
  return m;
}

/* ---------------------------------------------------------------- vista del muñeco */
export interface StickDrawOpts {
  low: boolean;
  head: HeadStyle;
  /** 0..1: destello blanco al recibir un golpe. */
  whiten: number;
  /** Resolución del sprite del accesorio. */
  scale: number;
  alpha: number;
}

export class StickView {
  readonly root = new Container();
  readonly state: RigState = {};
  rig: Rig | null = null;
  private echo = new Graphics();
  private smear = swooshMesh();
  private body = new Graphics();
  private fxg = new Graphics();
  private hat = new HatSprite();
  private fade = new AlphaFilter({ alpha: 1 });
  private echoes: Rig[] = [];
  private echoT = 0;
  private fading = false;

  constructor() {
    this.root.addChild(this.echo, this.smear, this.body, this.hat.sprite, this.fxg);
  }

  draw(p: RenderPlayer, colorHex: number, hat: string, o: StickDrawOpts): Rig {
    const r = solveRig(p, this.state, o.low);
    this.rig = r;
    let base = colorHex;
    if (p.burnT > 0) base = hexN(POWER_COLORS.fuego);
    else if (p.slowT > 0) base = hexN(POWER_COLORS.hielo);
    const main = o.whiten > 0 ? mixNum(base, 0xffffff, o.whiten * 0.75) : base;
    // profundidad sin contornos: atrás más oscuro, torso un punto abajo, lo de adelante a pleno
    const far = mixNum(main, 0x0b0e1a, 0.42);
    const mid = mixNum(main, 0x0b0e1a, 0.12);
    const hi = mixNum(main, 0xffffff, 0.6);
    const f = r.facing;

    // cuerpo, por capas de atrás hacia adelante
    const g = this.body.clear();
    const footA = toe(r.kneeA, r.footA, f, 4.2), footB = toe(r.kneeB, r.footB, f, 4.6);
    const armA: Part = { segs: [[r.shoulder, 2.3, r.elbowA, 2.0], [r.elbowA, 2.0, r.handA, 1.7]], dots: [[r.handA, 2.7]] };
    const legA: Part = { segs: [[r.hip, 2.8, r.kneeA, 2.3], [r.kneeA, 2.3, r.footA, 1.8], [r.footA, 1.8, footA, 1.5]] };
    const torso: Part = { segs: [[r.hip, 3.0, r.shoulder, 3.5], [r.shoulder, 2.2, r.neck, 1.9]] };
    const legB: Part = { segs: [[r.hip, 3.0, r.kneeB, 2.4], [r.kneeB, 2.4, r.footB, 1.9], [r.footB, 1.9, footB, 1.6]] };
    const armB: Part = { segs: [[r.shoulder, 2.5, r.elbowB, 2.1], [r.elbowB, 2.1, r.handB, 1.8]], dots: [[r.handB, r.strike?.kind === "punch" ? 3.3 : 2.9]] };
    drawPart(g, armA, far);
    drawPart(g, legA, far);
    drawPart(g, torso, mid);
    if (!o.low) rim(g, r.hip, 3.0, r.shoulder, 3.5, hi, 0.55);
    drawHead(g, r, o.head, main, hi, o.low);
    drawPart(g, legB, main);
    drawPart(g, armB, main);
    if (!o.low) {
      rim(g, r.hip, 3.0, r.kneeB, 2.4, hi, 0.5);
      rim(g, r.kneeB, 2.4, r.footB, 1.9, hi, 0.45);
      rim(g, r.shoulder, 2.5, r.elbowB, 2.1, hi, 0.5);
      rim(g, r.elbowB, 2.1, r.handB, 1.8, hi, 0.45);
    }

    // auras de poder / estados
    const fx = this.fxg.clear();
    if (!o.low && p.alive) {
      const own = firstActivePower(p.power);
      const kind: AuraKind | null = own || (p.burnT > 0 ? "fuego" : p.slowT > 0 ? "hielo" : null);
      const t = p.idleT || 0;
      if (kind) {
        auraSegment(fx, r.hip, r.shoulder, kind, t);
        auraSegment(fx, r.shoulder, { x: r.head.x, y: r.head.y + 8 }, kind, t + 0.4);
        if (kind !== "aire") {
          auraSegment(fx, r.kneeB, r.footB, kind, t + 0.9);
          auraSegment(fx, r.elbowB, r.handB, kind, t + 1.3);
        }
      }
      if (p.power?.aire) orbitAura(fx, r.hip.x, (r.head.y + p.y) / 2 - 4, 17, (p.y - r.head.y) / 2 + 6, t, hexN(POWER_COLORS.aire));
      if (p.burnFlashT > 0) {
        const a = Math.min(1, p.burnFlashT / 220);
        for (let i = 0; i < 5; i++) {
          const seed = (p.id || 0) * 13 + i * 7;
          const ang = (((seed * 37) % 100) / 100) * Math.PI * 2, dist = 3 + (((seed * 53) % 100) / 100) * 12;
          const sx = r.hip.x + Math.cos(ang) * dist * 0.6, sy = r.hip.y - 8 + Math.sin(ang) * dist * 0.4 - (1 - a) * 14;
          fx.circle(sx, sy, 1.6 * a + 0.6).fill({ color: i % 2 === 0 ? 0xffb347 : hexN(POWER_COLORS.fuego), alpha: a * 0.9 });
        }
      }
    }

    // ecos del poder de aire: siluetas planas de los últimos cuadros
    const eg = this.echo.clear();
    if (!o.low && p.alive && p.power?.aire) {
      const now = (p.idleT || 0) * 1000;
      if (now - this.echoT >= 22) { this.echoT = now; this.echoes.push(r); if (this.echoes.length > 5) this.echoes.shift(); }
      this.echoes.forEach((e, i) => {
        const k = (i + 1) / (this.echoes.length + 1);
        const c = mixNum(hexN(POWER_COLORS.aire), main, 0.3);
        for (const part of [
          { segs: [[e.hip, 2.6, e.shoulder, 3], [e.hip, 2.6, e.kneeA, 2], [e.kneeA, 2, e.footA, 1.6], [e.hip, 2.6, e.kneeB, 2], [e.kneeB, 2, e.footB, 1.6],
            [e.shoulder, 2, e.elbowA, 1.8], [e.elbowA, 1.8, e.handA, 1.5], [e.shoulder, 2, e.elbowB, 1.8], [e.elbowB, 1.8, e.handB, 1.5]] as Part["segs"] },
        ]) partPath(eg, part, 0);
        eg.ellipse(e.head.x, e.head.y, HEAD_RX, HEAD_RY);
        eg.fill({ color: c, alpha: 0.05 + k * 0.16 });
      });
    } else this.echoes.length = 0;

    // estela del golpe: el arco real que recorrió la punta en los últimos ~70 ms de animación
    this.updateSmear(p, r, main, o.low);

    this.hat.update(hat, r.head, r.headLean * f, f, p.idleT || 0, o.scale);

    // fundido de muerte con AlphaFilter: con alfa por forma se verían los contornos a través del color
    const fading = o.alpha < 1;
    if (fading) this.fade.alpha = o.alpha;
    if (fading !== this.fading) { this.fading = fading; this.root.filters = fading ? [this.fade] : []; }
    return r;
  }

  private updateSmear(p: RenderPlayer, r: Rig, color: number, low: boolean) {
    const s = r.strike;
    if (low || !s || !p.attack || r.spin > 0) { this.smear.visible = false; return; }
    const kick = s.kind === "kick";
    const dur = p.attack.dur || (kick ? 280 : 140);
    const span = kick ? 0.3 : 0.24;
    const v = this.smear.vertices;
    let len = 0, px = 0, py = 0;
    for (let i = 0; i < SMEAR_N; i++) {
      const u = Math.max(0.06, s.progress - span * (1 - i / (SMEAR_N - 1)));
      const q = i === SMEAR_N - 1 ? r : solveRig({ ...p, attack: { ...p.attack, t: dur * (1 - u) } }, null, false);
      const root = kick ? q.hip : q.shoulder, tip = kick ? q.footB : q.handB;
      const k = kick ? 0.42 : 0.55;
      v[i * 4] = tip.x; v[i * 4 + 1] = tip.y;
      v[i * 4 + 2] = root.x + (tip.x - root.x) * k; v[i * 4 + 3] = root.y + (tip.y - root.y) * k;
      if (i) len += Math.hypot(tip.x - px, tip.y - py);
      px = tip.x; py = tip.y;
    }
    this.smear.visible = len > 4;
    this.smear.tint = mixNum(color, 0xffffff, 0.25);
    // aparece de golpe con el latigazo y se apaga mientras se sostiene el impacto
    this.smear.alpha = Math.max(0, Math.min(1, (0.7 - s.progress) * 3.5, (s.progress - 0.1) * 8)) * 0.85;
  }

  destroy() {
    this.hat.destroy();
    this.root.destroy({ children: true });
  }
}

const hexCache = new Map<string, number>();
function hexN(h: string): number {
  let n = hexCache.get(h);
  if (n == null) { n = parseInt(h.replace("#", "").slice(0, 6), 16); hexCache.set(h, n); }
  return n;
}
