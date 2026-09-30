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
import { POWER_COLORS, POWER_TYPES, POWERS, type PowerType } from "@lss/shared";
import { drawAccessory, firstActivePower, type RenderPlayer } from "./art/stickman";
import { ease } from "./ease";
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
      // cara de pelea: el párpado de arriba baja hacia el entrecejo (si baja hacia afuera, la cara
      // queda triste — Dan: "parecen sufrir cuando pegan")
      const innerDir = i === 0 ? f : -f;
      const lid = (dx: number) => ey - 1.4 + (Math.sign(dx) === innerDir ? 1.1 : -0.5);
      const q = [P(ex - 1.35 * s, lid(-1)), P(ex + 1.35 * s, lid(1)), P(ex + 1.15 * s, ey + 1.6), P(ex - 1.15 * s, ey + 1.6)];
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

/* ---------------------------------------------------------------- poderes pegados al cuerpo */
/* Lo que se mueve con el esqueleto; las partículas (llamas, escarcha, viento, piedritas) están en
   powerFx.ts. Regla: el que TIENE el poder lo lleva en las armas y en la armadura; el que lo SUFRE
   cambia de color entero (quemado/congelado). */

/** Puño o pie al rojo vivo (fuego): brilla con luz propia, no se sombrea. */
function hotSpot(g: Graphics, c: Pt, r: number) {
  g.circle(c.x, c.y, r + 1.6).fill({ color: 0xff4a1a, alpha: 0.45 });
  g.circle(c.x, c.y, r + 0.3).fill({ color: 0xff8a2a });
  g.circle(c.x - 0.4, c.y - 0.4, r * 0.55).fill({ color: 0xffd27a });
}

/** Guantelete de hielo: tres cristales que salen del puño en la dirección del antebrazo. */
function iceFist(g: Graphics, elbow: Pt, hand: Pt, t: number) {
  const base = Math.atan2(hand.y - elbow.y, hand.x - elbow.x);
  const shards: [number, number][] = [[0, 6.2], [0.8, 4.4], [-0.8, 4.4], [2.4, 3.2], [-2.4, 3.2]];
  for (const [da, len] of shards) {
    const a = base + da + Math.sin(t * 2 + da) * 0.04;
    const tip = { x: hand.x + Math.cos(a) * len, y: hand.y + Math.sin(a) * len };
    const nx = -Math.sin(a) * 1.5, ny = Math.cos(a) * 1.5;
    const mid = { x: hand.x + Math.cos(a) * len * 0.35, y: hand.y + Math.sin(a) * len * 0.35 };
    g.poly([hand.x, hand.y, mid.x + nx, mid.y + ny, tip.x, tip.y, mid.x - nx, mid.y - ny]).fill({ color: 0xcff6ff, alpha: 0.85 });
    g.moveTo(hand.x, hand.y).lineTo(tip.x, tip.y).stroke({ width: 0.6, color: 0xffffff, alpha: 0.9 });
  }
  g.circle(hand.x, hand.y, 3.3).fill({ color: 0xe6fbff, alpha: 0.55 });
}

/** Armadura de piedra (tierra): peto, hombrera, canillera y guantelete. */
const STONE = 0x8a6a3a, STONE_HI = 0xc9a46a, STONE_LO = 0x5a4424;
function stoneArmor(g: Graphics, r: Rig) {
  const ax = r.shoulder.x - r.hip.x, ay = r.shoulder.y - r.hip.y;
  const L = Math.hypot(ax, ay) || 1;
  const ux = ax / L, uy = ay / L, nx = -uy, ny = ux;
  const at = (t: number, w: number) => [r.hip.x + ax * t + nx * w, r.hip.y + ay * t + ny * w];
  const plate = [...at(0.18, 3.9), ...at(0.55, 5.6), ...at(0.92, 4.8), ...at(0.92, -4.8), ...at(0.55, -5.6), ...at(0.18, -3.9)];
  g.poly(plate).fill({ color: STONE });
  g.poly([...at(0.55, 5.6), ...at(0.92, 4.8), ...at(0.92, -4.8), ...at(0.6, -1)]).fill({ color: STONE_HI, alpha: 0.55 });
  const [c1x, c1y] = at(0.38, 1.5), [c2x, c2y] = at(0.62, -1.8), [c3x, c3y] = at(0.8, -0.6);
  g.moveTo(c1x, c1y).lineTo(c2x, c2y).lineTo(c3x, c3y).stroke({ width: 0.7, color: STONE_LO, alpha: 0.9 });
  // hombrera sobre el brazo de adelante
  const sx = r.shoulder.x + (r.elbowB.x - r.shoulder.x) * 0.25, sy = r.shoulder.y + (r.elbowB.y - r.shoulder.y) * 0.25;
  g.ellipse(sx, sy - 0.8, 4.4, 3.2).fill({ color: STONE });
  g.ellipse(sx - 0.8, sy - 1.8, 2.8, 1.3).fill({ color: STONE_HI, alpha: 0.6 });
  // canillera y guantelete
  const lerpP = (p: Pt, q: Pt, k: number): Pt => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
  capsule(g, lerpP(r.kneeB, r.footB, 0.1), 3.0, lerpP(r.kneeB, r.footB, 0.78), 2.5);
  capsule(g, lerpP(r.elbowB, r.handB, 0.35), 2.7, lerpP(r.elbowB, r.handB, 0.9), 2.5);
  g.fill({ color: STONE });
  rim(g, lerpP(r.kneeB, r.footB, 0.1), 3.0, lerpP(r.kneeB, r.footB, 0.78), 2.5, STONE_HI, 0.8);
  rim(g, lerpP(r.elbowB, r.handB, 0.35), 2.7, lerpP(r.elbowB, r.handB, 0.9), 2.5, STONE_HI, 0.8);
}

/** Viento (aire): dos medialunas que giran alrededor del cuerpo. */
function windCrescents(g: Graphics, cx: number, cy: number, t: number, front: boolean) {
  const rx = 19, ry = 31;
  for (let i = 0; i < 2; i++) {
    const a0 = t * 5.2 + i * Math.PI;
    const inFront = Math.sin(a0 + 0.7) > 0;
    if (inFront !== front) continue;
    const pts: number[] = [];
    const span = 1.5, N = 10;
    for (let k = 0; k <= N; k++) { const a = a0 + (span * k) / N; pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry * 0.42 - Math.sin(a * 0.5) * 6 + (i ? 10 : -8)); }
    for (let k = N; k >= 0; k--) {
      const a = a0 + (span * k) / N, th = Math.sin((k / N) * Math.PI) * 2.2;
      pts.push(cx + Math.cos(a) * (rx - th), cy + Math.sin(a) * (ry * 0.42 - th * 0.5) - Math.sin(a * 0.5) * 6 + (i ? 10 : -8));
    }
    g.poly(pts).fill({ color: 0xe6ffd8, alpha: front ? 0.7 : 0.35 });
  }
}

/** Costra de hielo en los pies del congelado. */
function iceCrust(g: Graphics, x: number, y: number, t: number) {
  const spikes: [number, number, number][] = [[-8, 5, -0.35], [-3.5, 8.5, -0.1], [1.5, 10, 0.08], [6, 6.5, 0.3], [9.5, 4, 0.5]];
  for (const [dx, h, lean] of spikes) {
    const bx = x + dx, tx = bx + lean * h, ty = y - h - Math.sin(t * 3 + dx) * 0.3;
    g.poly([bx - 2.4, y + 1, tx, ty, bx + 2.4, y + 1]).fill({ color: 0xcff6ff, alpha: 0.75 });
    g.moveTo(bx - 0.6, y).lineTo(tx, ty).stroke({ width: 0.6, color: 0xffffff, alpha: 0.9 });
  }
  g.ellipse(x, y + 0.5, 12, 2.2).fill({ color: 0xbfefff, alpha: 0.5 });
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

/** Haz de luz vertical al agarrar un poder: suave a los costados y que se desvanece hacia arriba. */
let beamTex: Texture | null = null;
function beamSprite(): Sprite {
  if (!beamTex) {
    const W = 64, H = 128, c = makeCanvas(W, H), ctx = c.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = Math.abs(x / (W - 1) - 0.5) * 2, v = y / (H - 1);
      const a = Math.pow(1 - u, 2.2) * Math.pow(v, 1.4);
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, 0);
    beamTex = Texture.from(c);
  }
  const s = new Sprite(beamTex);
  s.anchor.set(0.5, 1);
  s.visible = false;
  return s;
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
  private ground = new Graphics();
  private beam = beamSprite();
  private echo = new Graphics();
  private smear = swooshMesh();
  private body = new Graphics();
  private fxg = new Graphics();
  private hat = new HatSprite();
  private fade = new AlphaFilter({ alpha: 1 });
  private echoes: Rig[] = [];
  private echoT = 0;
  private fading = false;
  private powerKey = "";
  private powerUpT = 0;
  private lastIdle = -1;

  constructor() {
    this.root.addChild(this.beam, this.ground, this.echo, this.smear, this.body, this.hat.sprite, this.fxg);
  }

  draw(p: RenderPlayer, colorHex: number, hat: string, o: StickDrawOpts): Rig {
    const r = solveRig(p, this.state, o.low);
    this.rig = r;
    const t = p.idleT || 0;
    const dt = this.lastIdle < 0 ? 16.7 : Math.max(0, Math.min(60, (t - this.lastIdle) * 1000));
    this.lastIdle = t;
    const pw = p.power;
    const own = firstActivePower(pw);
    const alive = p.alive;

    // destello al agarrar un poder: el cuerpo se tiñe del color del poder y se apaga
    const key = pw ? POWER_TYPES.filter((k) => pw[k]).join(",") : "";
    if (key !== this.powerKey) { if (key) this.powerUpT = 450; this.powerKey = key; }
    if (this.powerUpT > 0) this.powerUpT = Math.max(0, this.powerUpT - dt);
    const upU = this.powerUpT / 450;

    // color: los estados (quemado/congelado) tiñen el cuerpo entero sin borrar el color del jugador
    let base = colorHex;
    if (p.burnT > 0) {
      base = mixNum(colorHex, 0xff5a1f, 0.5 + Math.sin(t * 19) * 0.12);
      if (p.burnFlashT > 0) base = mixNum(base, 0xffe6a0, Math.min(1, p.burnFlashT / 220) * 0.6);
    } else if (p.slowT > 0) base = mixNum(colorHex, 0xbfefff, 0.55);
    if (upU > 0 && own) base = mixNum(base, mixNum(hexN(POWER_COLORS[own]), 0xffffff, 0.5), ease("power2.in")(upU) * 0.85);
    const main = o.whiten > 0 ? mixNum(base, 0xffffff, o.whiten * 0.75) : base;
    // profundidad sin contornos: atrás más oscuro, torso un punto abajo, lo de adelante a pleno
    const far = mixNum(main, 0x0b0e1a, 0.42);
    const mid = mixNum(main, 0x0b0e1a, 0.12);
    const hi = p.slowT > 0 ? 0xffffff : mixNum(main, 0xffffff, 0.6);
    const f = r.facing;
    const fx = !o.low && alive;
    const fire = fx && !!pw?.fuego, ice = fx && !!pw?.hielo, stone = fx && !!pw?.tierra, wind = fx && !!pw?.aire;
    const kicking = r.strike?.kind === "kick" || (!!p.attack && p.attack.type === "kick");

    // piso: anillo con el tiempo que le queda al poder + columna de luz al agarrarlo
    const gr = this.ground.clear();
    if (alive && pw && key) this.drawTimer(gr, p, pw.t, key.split(",") as PowerType[]);
    if (upU > 0 && own) {
      const c = hexN(POWER_COLORS[own]), u = 1 - upU, e = ease("power2.out")(u);
      gr.ellipse(p.x, p.y + 1, 10 + e * 34, 3 + e * 8).stroke({ width: 2.5 * upU + 0.5, color: c, alpha: upU });
      this.beam.visible = true;
      this.beam.tint = mixNum(c, 0xffffff, 0.35);
      this.beam.alpha = upU * 0.8;
      this.beam.position.set(p.x, p.y + 2);
      this.beam.scale.set((28 * (0.4 + upU * 0.6)) / 64, (30 + 90 * e) / 128);
    } else this.beam.visible = false;
    if (wind) windCrescents(gr, r.hip.x, (r.head.y + p.y) / 2 - 4, t, false);

    // cuerpo, por capas de atrás hacia adelante
    const g = this.body.clear();
    const footA = toe(r.kneeA, r.footA, f, 4.2), footB = toe(r.kneeB, r.footB, f, 4.6);
    const armA: Part = { segs: [[r.shoulder, 2.3, r.elbowA, 2.0], [r.elbowA, 2.0, r.handA, 1.7]], dots: [[r.handA, 2.7]] };
    const legA: Part = { segs: [[r.hip, 2.8, r.kneeA, 2.3], [r.kneeA, 2.3, r.footA, 1.8], [r.footA, 1.8, footA, 1.5]] };
    const torso: Part = { segs: [[r.hip, 3.0, r.shoulder, 3.5], [r.shoulder, 2.2, r.neck, 1.9]] };
    const legB: Part = { segs: [[r.hip, 3.0, r.kneeB, 2.4], [r.kneeB, 2.4, r.footB, 1.9], [r.footB, 1.9, footB, 1.6]] };
    const fistB = r.strike?.kind === "punch" ? 3.3 : 2.9;
    const armB: Part = { segs: [[r.shoulder, 2.5, r.elbowB, 2.1], [r.elbowB, 2.1, r.handB, 1.8]], dots: [[r.handB, fistB]] };
    drawPart(g, armA, far);
    if (fire) hotSpot(g, r.handA, 2.5);
    if (ice) iceFist(g, r.elbowA, r.handA, t);
    drawPart(g, legA, far);
    drawPart(g, torso, mid);
    if (!o.low) rim(g, r.hip, 3.0, r.shoulder, 3.5, hi, 0.55);
    drawHead(g, r, o.head, main, hi, o.low);
    drawPart(g, legB, main);
    if (fire && kicking) hotSpot(g, footB, 2.2);
    drawPart(g, armB, main);
    if (!o.low) {
      rim(g, r.hip, 3.0, r.kneeB, 2.4, hi, 0.5);
      rim(g, r.kneeB, 2.4, r.footB, 1.9, hi, 0.45);
      rim(g, r.shoulder, 2.5, r.elbowB, 2.1, hi, 0.5);
      rim(g, r.elbowB, 2.1, r.handB, 1.8, hi, 0.45);
    }
    if (stone) stoneArmor(g, r);
    if (fire) hotSpot(g, r.handB, fistB - 0.3);
    if (ice) iceFist(g, r.elbowB, r.handB, t + 1);

    // delante del cuerpo: viento que pasa por adelante, hielo en los pies del congelado
    const fg = this.fxg.clear();
    if (wind) windCrescents(fg, r.hip.x, (r.head.y + p.y) / 2 - 4, t, true);
    if (fx && p.slowT > 0 && p.grounded) iceCrust(fg, p.x, p.y, t);

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
    this.updateSmear(p, r, own ? SWOOSH_TINT[own] : main, o.low);

    this.hat.update(hat, r.head, r.headLean * f, f, p.idleT || 0, o.scale);

    // fundido de muerte con AlphaFilter: con alfa por forma se verían los contornos a través del color
    const fading = o.alpha < 1;
    if (fading) this.fade.alpha = o.alpha;
    if (fading !== this.fading) { this.fading = fading; this.root.filters = fading ? [this.fade] : []; }
    return r;
  }

  /** Anillo en el piso con el tiempo que le queda al poder (titila el último segundo y medio). */
  private drawTimer(g: Graphics, p: RenderPlayer, left: number, kinds: PowerType[]) {
    const frac = Math.max(0, Math.min(1, left / POWERS.ORB_POWER_MS));
    const blink = left < 1500 ? (Math.sin(left * 0.03) > 0 ? 1 : 0.3) : 1;
    const rx = 17, ry = 4.4, cx = p.x, cy = p.y + 1.5;
    g.ellipse(cx, cy, rx, ry).stroke({ width: 1.2, color: 0xffffff, alpha: 0.14 * blink });
    const start = -Math.PI / 2, span = Math.PI * 2 * frac;
    const segs = kinds.length;
    for (let i = 0; i < segs; i++) {
      const a0 = start + (span * i) / segs, a1 = start + (span * (i + 1)) / segs;
      const n = Math.max(2, Math.ceil(24 * (a1 - a0) / Math.PI));
      g.moveTo(cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry);
      for (let k = 1; k <= n; k++) { const a = a0 + ((a1 - a0) * k) / n; g.lineTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); }
      g.stroke({ width: 2.4, color: hexN(POWER_COLORS[kinds[i]]), alpha: 0.95 * blink, cap: "round" });
    }
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
    this.smear.tint = mixNum(color, 0xffffff, 0.2);
    // aparece de golpe con el latigazo y se apaga mientras se sostiene el impacto
    this.smear.alpha = Math.max(0, Math.min(1, (0.7 - s.progress) * 3.5, (s.progress - 0.1) * 8)) * 0.85;
  }

  destroy() {
    this.hat.destroy();
    this.root.destroy({ children: true });
  }
}

const SWOOSH_TINT: Record<PowerType, number> = { fuego: 0xffa040, hielo: 0xbff4ff, tierra: 0xd8b47a, aire: 0xe6ffd8 };

const hexCache = new Map<string, number>();
function hexN(h: string): number {
  let n = hexCache.get(h);
  if (n == null) { n = parseInt(h.replace("#", "").slice(0, 6), 16); hexCache.set(h, n); }
  return n;
}
