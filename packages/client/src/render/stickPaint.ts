/* Pintor del muñeco V2, independiente del backend: dibuja sobre un "Pen" que puede ser un Graphics
   de Pixi (el juego) o un adaptador de Canvas 2D (el muñeco del menú, ver canvasPen.ts). Así el
   menú muestra exactamente el mismo muñeco que la partida.

   - Miembros que se afinan, puños y pies. Rodillas y codos redondeados: cada miembro es una curva
     (Bézier cúbica con los huesos casi rectos y la articulación suavizada) en vez de dos palos en
     ángulo, que era parte de lo que se veía "cuadrado".
   - La columna se curva con la inercia del torso (rig.bend).
   - Profundidad sin contornos: atrás más oscuro, torso un punto más apagado, filo de luz adelante.
   - Cabeza llena con ojos que cambian, o la clásica de aro.
   - Poderes pegados al cuerpo: el que TIENE el poder lo lleva en las armas y la armadura; el que lo
     SUFRE cambia de color entero (quemado/congelado). Las partículas están en powerFx.ts. */

import { POWER_COLORS, POWER_TYPES, POWERS, type PowerType } from "@lss/shared";
import { firstActivePower, type RenderPlayer } from "./art/stickman";
import { ease } from "./ease";
import type { Expr, Pt, Rig } from "./rig";

export type HeadStyle = "face" | "ring";

type Cap = "round" | "butt" | "square";
type Join = "round" | "miter" | "bevel";
/** Subconjunto de la API de Graphics de Pixi que usa el pintor. */
export interface Pen {
  poly(points: number[]): Pen;
  circle(x: number, y: number, r: number): Pen;
  ellipse(x: number, y: number, rx: number, ry: number): Pen;
  moveTo(x: number, y: number): Pen;
  lineTo(x: number, y: number): Pen;
  arc(x: number, y: number, r: number, a0: number, a1: number): Pen;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): Pen;
  closePath(): Pen;
  fill(style: { color: number; alpha?: number }): Pen;
  stroke(style: { width: number; color: number; alpha?: number; cap?: Cap; join?: Join }): Pen;
}

/** Tinta de los ojos. */
const INK = 0x070a14;
const LIGHT = { x: -0.45, y: -0.89 };
const DEG = Math.PI / 180;
export const HEAD_RX = 7.9, HEAD_RY = 8.8;

export function mixNum(a: number, b: number, k: number): number {
  const m = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * k));
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

const hexCache = new Map<string, number>();
export function hexN(h: string): number {
  let n = hexCache.get(h);
  if (n == null) { n = parseInt(h.replace("#", "").slice(0, 6), 16); hexCache.set(h, n); }
  return n;
}

export const SWOOSH_TINT: Record<PowerType, number> = { fuego: 0xffa040, hielo: 0xbff4ff, tierra: 0xd8b47a, aire: 0xe6ffd8 };

/** Cuánto baja el accesorio respecto del dibujo original (hecho para la cabeza de aro, más ancha):
    así queda puesto y no flotando. La aureola y la órbita flotan a propósito. */
export function hatDrop(kind: string): number {
  return kind === "halo" || kind === "orbit" ? 0.6 : 2.8;
}

/* ---------------------------------------------------------------- primitivas */
function quad(g: Pen, a: Pt, ra: number, b: Pt, rb: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 0.01) return;
  const nx = -dy / L, ny = dx / L;
  g.poly([a.x + nx * ra, a.y + ny * ra, b.x + nx * rb, b.y + ny * rb, b.x - nx * rb, b.y - ny * rb, a.x - nx * ra, a.y - ny * ra]);
}

/** Cápsula que se afina de `ra` a `rb` (un trapecio + dos círculos); solo agrega el trazado. */
export function capsule(g: Pen, a: Pt, ra: number, b: Pt, rb: number) {
  quad(g, a, ra, b, rb);
  g.circle(a.x, a.y, ra);
  g.circle(b.x, b.y, rb);
}

/** Filo de luz sobre el lado iluminado de un segmento. */
export function rim(g: Pen, a: Pt, ra: number, b: Pt, rb: number, color: number, alpha: number) {
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

/* Miembro curvo: Bézier cúbica con los puntos de control sobre cada hueso (al 82% hacia la
   articulación). Los huesos quedan casi rectos y la rodilla/codo se redondea; estirado es una
   línea recta. Se traza como una cadena de cápsulas (robusto aunque la curva se cierre mucho). */
const BEND_K = 0.82;
const CURVE_N = 7;
const curveBuf: Pt[] = Array.from({ length: CURVE_N + 1 }, () => ({ x: 0, y: 0 }));
const radBuf: number[] = new Array(CURVE_N + 1).fill(0);

function sampleLimb(a: Pt, ra: number, j: Pt, rj: number, b: Pt, rb: number) {
  const c1x = a.x + (j.x - a.x) * BEND_K, c1y = a.y + (j.y - a.y) * BEND_K;
  const c2x = b.x + (j.x - b.x) * BEND_K, c2y = b.y + (j.y - b.y) * BEND_K;
  for (let i = 0; i <= CURVE_N; i++) {
    const t = i / CURVE_N, u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    curveBuf[i].x = w0 * a.x + w1 * c1x + w2 * c2x + w3 * b.x;
    curveBuf[i].y = w0 * a.y + w1 * c1y + w2 * c2y + w3 * b.y;
    radBuf[i] = t < 0.5 ? ra + (rj - ra) * t * 2 : rj + (rb - rj) * (t - 0.5) * 2;
  }
}

function curveLimb(g: Pen, a: Pt, ra: number, j: Pt, rj: number, b: Pt, rb: number) {
  sampleLimb(a, ra, j, rj, b, rb);
  g.circle(curveBuf[0].x, curveBuf[0].y, radBuf[0]);
  for (let i = 1; i <= CURVE_N; i++) {
    quad(g, curveBuf[i - 1], radBuf[i - 1], curveBuf[i], radBuf[i]);
    g.circle(curveBuf[i].x, curveBuf[i].y, radBuf[i]);
  }
}

/** Filo de luz a lo largo de un miembro curvo. */
function curveRim(g: Pen, a: Pt, ra: number, j: Pt, rj: number, b: Pt, rb: number, color: number, alpha: number) {
  const cx = b.x - a.x, cy = b.y - a.y;
  const L = Math.hypot(cx, cy);
  if (L < 3) { rim(g, a, ra, j, rj, color, alpha); return; }
  // de qué lado cae la luz: se decide una vez por miembro (con la cuerda), así no salta
  let sgn = 1;
  const cnx = -cy / L, cny = cx / L;
  let facing = cnx * LIGHT.x + cny * LIGHT.y;
  if (facing < 0) { sgn = -1; facing = -facing; }
  if (facing < 0.15) return;
  sampleLimb(a, ra, j, rj, b, rb);
  for (let i = 1; i < CURVE_N; i++) {
    const p0 = curveBuf[i - 1], p1 = curveBuf[i + 1];
    const tx = p1.x - p0.x, ty = p1.y - p0.y, tl = Math.hypot(tx, ty) || 1;
    const nx = (-ty / tl) * sgn, ny = (tx / tl) * sgn;
    const k = radBuf[i] * 0.5;
    const x = curveBuf[i].x + nx * k, y = curveBuf[i].y + ny * k;
    if (i === 1) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke({ width: Math.min(ra, rb) * 0.6, color, alpha: alpha * Math.min(1, facing * 1.3), cap: "round", join: "round" });
}

/** Punto medio de la columna, corrido hacia adelante/atrás según la inercia del torso. */
function spineMid(r: Rig): Pt {
  const vx = r.shoulder.x - r.hip.x, vy = r.shoulder.y - r.hip.y;
  const L = Math.hypot(vx, vy) || 1;
  const off = r.bend * 1.6;
  return { x: r.hip.x + vx * 0.5 + r.facing * (-vy / L) * off, y: r.hip.y + vy * 0.5 + r.facing * (vx / L) * off };
}

/** Punta del pie: perpendicular a la canilla, hacia adelante (o hacia arriba en una patada). */
export function toe(knee: Pt, ankle: Pt, facing: number, len: number): Pt {
  const dx = ankle.x - knee.x, dy = ankle.y - knee.y;
  const L = Math.hypot(dx, dy) || 1;
  return { x: ankle.x + facing * (dy / L) * len, y: ankle.y + facing * (-dx / L) * len };
}

/* ---------------------------------------------------------------- cabeza */
function drawHead(g: Pen, r: Rig, style: HeadStyle, color: number, hi: number, low: boolean) {
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

function arcStroke(g: Pen, x: number, y: number, r: number, a0: number, a1: number, width: number, color: number, alpha: number) {
  g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r).arc(x, y, r, a0, a1).stroke({ width, color, alpha, cap: "round" });
}

function drawEyes(g: Pen, hx: number, hy: number, f: number, rot: number, expr: Expr) {
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
/** Puño o pie al rojo vivo (fuego): brilla con luz propia, no se sombrea. */
function hotSpot(g: Pen, c: Pt, r: number) {
  g.circle(c.x, c.y, r + 1.6).fill({ color: 0xff4a1a, alpha: 0.45 });
  g.circle(c.x, c.y, r + 0.3).fill({ color: 0xff8a2a });
  g.circle(c.x - 0.4, c.y - 0.4, r * 0.55).fill({ color: 0xffd27a });
}

/** Guantelete de hielo: cristales que salen del puño en la dirección del antebrazo. */
function iceFist(g: Pen, elbow: Pt, hand: Pt, t: number) {
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
function stoneArmor(g: Pen, r: Rig) {
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
function windCrescents(g: Pen, cx: number, cy: number, t: number, front: boolean) {
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
function iceCrust(g: Pen, x: number, y: number, t: number) {
  const spikes: [number, number, number][] = [[-8, 5, -0.35], [-3.5, 8.5, -0.1], [1.5, 10, 0.08], [6, 6.5, 0.3], [9.5, 4, 0.5]];
  for (const [dx, h, lean] of spikes) {
    const bx = x + dx, tx = bx + lean * h, ty = y - h - Math.sin(t * 3 + dx) * 0.3;
    g.poly([bx - 2.4, y + 1, tx, ty, bx + 2.4, y + 1]).fill({ color: 0xcff6ff, alpha: 0.75 });
    g.moveTo(bx - 0.6, y).lineTo(tx, ty).stroke({ width: 0.6, color: 0xffffff, alpha: 0.9 });
  }
  g.ellipse(x, y + 0.5, 12, 2.2).fill({ color: 0xbfefff, alpha: 0.5 });
}

/** Anillo en el piso con el tiempo que le queda al poder (titila el último segundo y medio). */
function powerTimer(g: Pen, p: RenderPlayer, left: number, kinds: PowerType[]) {
  const frac = Math.max(0, Math.min(1, left / POWERS.ORB_POWER_MS));
  const blink = left < 1500 ? (Math.sin(left * 0.03) > 0 ? 1 : 0.3) : 1;
  const rx = 17, ry = 4.4, cx = p.x, cy = p.y + 1.5;
  g.ellipse(cx, cy, rx, ry).stroke({ width: 1.2, color: 0xffffff, alpha: 0.14 * blink });
  const start = -Math.PI / 2, span = Math.PI * 2 * frac;
  for (let i = 0; i < kinds.length; i++) {
    const a0 = start + (span * i) / kinds.length, a1 = start + (span * (i + 1)) / kinds.length;
    const n = Math.max(2, Math.ceil((24 * (a1 - a0)) / Math.PI));
    g.moveTo(cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry);
    for (let k = 1; k <= n; k++) { const a = a0 + ((a1 - a0) * k) / n; g.lineTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); }
    g.stroke({ width: 2.4, color: hexN(POWER_COLORS[kinds[i]]), alpha: 0.95 * blink, cap: "round" });
  }
}

/* ---------------------------------------------------------------- muñeco completo */
export interface PaintLayers { ground: Pen; body: Pen; front: Pen }
export interface PaintOpts {
  low: boolean;
  head: HeadStyle;
  /** 0..1: destello blanco al recibir un golpe. */
  whiten: number;
  /** 0..1: destello de "agarré un poder" (1 = recién). */
  powerUp: number;
}

/** Dibuja piso (anillo de poder), cuerpo y lo que va por delante. Devuelve el color principal final. */
export function paintStick(L: PaintLayers, p: RenderPlayer, r: Rig, colorHex: number, o: PaintOpts): { main: number; own: PowerType | null } {
  const t = p.idleT || 0;
  const pw = p.power;
  const own = firstActivePower(pw);
  const alive = p.alive;

  // color: los estados (quemado/congelado) tiñen el cuerpo entero sin borrar el color del jugador
  let base = colorHex;
  if (p.burnT > 0) {
    base = mixNum(colorHex, 0xff5a1f, 0.5 + Math.sin(t * 19) * 0.12);
    if (p.burnFlashT > 0) base = mixNum(base, 0xffe6a0, Math.min(1, p.burnFlashT / 220) * 0.6);
  } else if (p.slowT > 0) base = mixNum(colorHex, 0xbfefff, 0.55);
  if (o.powerUp > 0 && own) base = mixNum(base, mixNum(hexN(POWER_COLORS[own]), 0xffffff, 0.5), ease("power2.in")(o.powerUp) * 0.85);
  const main = o.whiten > 0 ? mixNum(base, 0xffffff, o.whiten * 0.75) : base;
  // profundidad sin contornos: atrás más oscuro, torso un punto abajo, lo de adelante a pleno
  const far = mixNum(main, 0x0b0e1a, 0.42);
  const mid = mixNum(main, 0x0b0e1a, 0.12);
  const hi = p.slowT > 0 ? 0xffffff : mixNum(main, 0xffffff, 0.6);
  const f = r.facing;
  const fx = !o.low && alive;
  const fire = fx && !!pw?.fuego, ice = fx && !!pw?.hielo, stone = fx && !!pw?.tierra, wind = fx && !!pw?.aire;
  const kicking = r.strike?.kind === "kick" || (!!p.attack && p.attack.type === "kick");

  // piso
  const gr = L.ground;
  if (alive && pw) {
    const kinds = POWER_TYPES.filter((k) => pw[k]);
    if (kinds.length) powerTimer(gr, p, pw.t, kinds);
  }
  if (o.powerUp > 0 && own) {
    const e = ease("power2.out")(1 - o.powerUp);
    gr.ellipse(p.x, p.y + 1, 10 + e * 34, 3 + e * 8).stroke({ width: 2.5 * o.powerUp + 0.5, color: hexN(POWER_COLORS[own]), alpha: o.powerUp });
  }
  if (wind) windCrescents(gr, r.hip.x, (r.head.y + p.y) / 2 - 4, t, false);

  // cuerpo, por capas de atrás hacia adelante
  const g = L.body;
  const toeA = toe(r.kneeA, r.footA, f, 4.2), toeB = toe(r.kneeB, r.footB, f, 4.6);
  const fistB = r.strike?.kind === "punch" ? 3.3 : 2.9;
  // brazo de atrás
  curveLimb(g, r.shoulder, 2.3, r.elbowA, 2.0, r.handA, 1.7);
  g.circle(r.handA.x, r.handA.y, 2.7);
  g.fill({ color: far });
  if (fire) hotSpot(g, r.handA, 2.5);
  if (ice) iceFist(g, r.elbowA, r.handA, t);
  // pierna de atrás
  curveLimb(g, r.hip, 2.8, r.kneeA, 2.3, r.footA, 1.8);
  capsule(g, r.footA, 1.8, toeA, 1.5);
  g.fill({ color: far });
  // torso + cuello
  const sm = spineMid(r);
  curveLimb(g, r.hip, 3.0, sm, 3.25, r.shoulder, 3.5);
  capsule(g, r.shoulder, 2.2, r.neck, 1.9);
  g.fill({ color: mid });
  if (!o.low) curveRim(g, r.hip, 3.0, sm, 3.25, r.shoulder, 3.5, hi, 0.55);
  drawHead(g, r, o.head, main, hi, o.low);
  // pierna de adelante
  curveLimb(g, r.hip, 3.0, r.kneeB, 2.4, r.footB, 1.9);
  capsule(g, r.footB, 1.9, toeB, 1.6);
  g.fill({ color: main });
  if (fire && kicking) hotSpot(g, toeB, 2.2);
  // brazo de adelante
  curveLimb(g, r.shoulder, 2.5, r.elbowB, 2.1, r.handB, 1.8);
  g.circle(r.handB.x, r.handB.y, fistB);
  g.fill({ color: main });
  if (!o.low) {
    curveRim(g, r.hip, 3.0, r.kneeB, 2.4, r.footB, 1.9, hi, 0.5);
    curveRim(g, r.shoulder, 2.5, r.elbowB, 2.1, r.handB, 1.8, hi, 0.5);
  }
  if (stone) stoneArmor(g, r);
  if (fire) hotSpot(g, r.handB, fistB - 0.3);
  if (ice) iceFist(g, r.elbowB, r.handB, t + 1);

  // delante del cuerpo: viento que pasa por adelante, hielo en los pies del congelado
  const fg = L.front;
  if (wind) windCrescents(fg, r.hip.x, (r.head.y + p.y) / 2 - 4, t, true);
  if (fx && p.slowT > 0 && p.grounded) iceCrust(fg, p.x, p.y, t);
  return { main, own };
}

/** Silueta plana (ecos del poder de aire). */
export function paintSilhouette(g: Pen, e: Rig, color: number, alpha: number) {
  curveLimb(g, e.hip, 2.6, { x: (e.hip.x + e.shoulder.x) / 2, y: (e.hip.y + e.shoulder.y) / 2 }, 2.8, e.shoulder, 3);
  curveLimb(g, e.hip, 2.6, e.kneeA, 2, e.footA, 1.6);
  curveLimb(g, e.hip, 2.6, e.kneeB, 2, e.footB, 1.6);
  curveLimb(g, e.shoulder, 2, e.elbowA, 1.8, e.handA, 1.5);
  curveLimb(g, e.shoulder, 2, e.elbowB, 1.8, e.handB, 1.5);
  g.ellipse(e.head.x, e.head.y, HEAD_RX, HEAD_RY);
  g.fill({ color, alpha });
}
