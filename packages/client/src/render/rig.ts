/* Esqueleto del muñeco (V2): calcula dónde está cada articulación en un cuadro, a partir del estado
   de juego. No dibuja nada — los renderers (Pixi) lo consumen.

   - Poses en ángulos ABSOLUTOS por segmento (0 = colgando, +90 = hacia donde mira, 180 = arriba),
     con keyframes y una curva de easing POR TRAMO tomada de GSAP (carga lenta, golpe explosivo,
     recuperación con rebote). En V1 todo pasaba por el mismo smoothstep.
   - Contacto con el piso automático: la altura de la cadera sale de las piernas, así los pies nunca
     flotan ni se hunden en ninguna pose.
   - Estados nuevos: guardia con rebote, doble salto con mortal, voltereta al salir lanzado,
     flexión al aterrizar, giro "de papel" al darse vuelta, y expresión en los ojos. */

import type { RenderPlayer } from "./art/stickman";
import { ease } from "./ease";

export type Pt = { x: number; y: number };
export type Expr = "open" | "blink" | "focus" | "hurt" | "ko";

export interface Rig {
  hip: Pt; shoulder: Pt; neck: Pt; head: Pt; headR: number; headLean: number;
  /** A = miembro de atrás (se dibuja más oscuro, detrás del torso); B = el de adelante. */
  kneeA: Pt; footA: Pt; kneeB: Pt; footB: Pt;
  elbowA: Pt; handA: Pt; elbowB: Pt; handB: Pt;
  facing: number;
  expr: Expr;
  /** Punta del golpe en curso (para la estela), o null. */
  strike: { tip: Pt; kind: "punch" | "kick"; progress: number } | null;
  /** 0..1 mientras el cuerpo está en una voltereta/mortal (para efectos). */
  spin: number;
  /** Paso de carrera recién apoyado este cuadro (para el polvito). */
  footstep: Pt | null;
  /** Altura del centro de la cabeza sin contar giros (el cartel no da vueltas con el mortal). */
  tagY: number;
}

export interface RigState {
  lean?: number; headSpring?: number;
  fam?: string; blendT?: number; from?: Pose; last?: Pose;
  lastMs?: number; prevJumps?: number; flipV0?: number; tumble?: number;
  prevFacing?: number; turnT?: number; turnFrom?: number; lastWalk?: number;
}

type Seg = [number, number];
interface Pose { legA: Seg; legB: Seg; armA: Seg; armB: Seg; lean: number }
type Key = { t: number; p: Partial<Pose>; ease?: string };

const DEG = Math.PI / 180;
/** Cuánto tiene que cambiar vy desde el doble salto para completar el mortal (~290 ms de subida). */
const FLIP_DV = 16;
export const THIGH = 13, SHIN = 14, UARM = 10.5, FARM = 11, TORSO = 19, NECK = 5, HEAD_R = 8.2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;


function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const s = (x: Seg, y: Seg): Seg => [lerp(x[0], y[0], t), lerp(x[1], y[1], t)];
  return { legA: s(a.legA, b.legA), legB: s(a.legB, b.legB), armA: s(a.armA, b.armA), armB: s(a.armB, b.armB), lean: lerp(a.lean, b.lean, t) };
}

/** Completa un track: cada key hereda lo que no define de la anterior. */
function track(base: Pose, keys: Key[]): { t: number; pose: Pose; ease: string }[] {
  let cur = base;
  return keys.map((k) => { cur = { ...cur, ...k.p }; return { t: k.t, pose: cur, ease: k.ease || "sine.inOut" }; });
}

function sample(tr: { t: number; pose: Pose; ease: string }[], t: number, loop = false): Pose {
  if (loop) t = ((t % 1) + 1) % 1; else t = clamp(t, 0, 1);
  for (let i = 0; i < tr.length - 1; i++) {
    const a = tr[i], b = tr[i + 1];
    if (t >= a.t && t <= b.t) return lerpPose(a.pose, b.pose, ease(b.ease)(b.t === a.t ? 1 : (t - a.t) / (b.t - a.t)));
  }
  return tr[tr.length - 1].pose;
}

/* ---------------------------------------------------------------- poses y movimientos */
const GUARD: Pose = { armA: [12, 142], armB: [36, 152], legA: [-12, -36], legB: [28, -2], lean: 5 };

const RUN = track(GUARD, [
  { t: 0.0, p: { legA: [36, 32], legB: [-14, -65], armA: [-22, -13], armB: [36, 50], lean: 17 } },
  { t: 0.14, p: { legA: [16, 10], legB: [16, -17] } },
  { t: 0.25, p: { armA: [65, 120], armB: [-95, -50] } },
  { t: 0.32, p: { legA: [-18, -26], legB: [32, 20] } },
  { t: 0.5, p: { legA: [-34, -46], legB: [36, 32], armA: [36, 50], armB: [-22, -13] } },
  { t: 0.64, p: { legA: [-14, -65], legB: [16, 10] } },
  { t: 0.75, p: { armA: [-95, -50], armB: [65, 120] } },
  { t: 0.82, p: { legA: [16, -17], legB: [-18, -26] } },
  { t: 1.0, p: { legA: [36, 32], legB: [-14, -65], armA: [-22, -13], armB: [36, 50] } },
]);

/* Piña recta: se carga un instante, sale explosiva con el hombro detrás del puño, se sostiene el
   impacto y vuelve a la guardia con un rebote. 140 ms reales en total. */
const PUNCH = track(GUARD, [
  { t: 0.0, p: {} },
  { t: 0.12, p: { armB: [16, 166], armA: [6, 150], lean: 0 }, ease: "power1.out" },
  { t: 0.34, p: { armB: [90, 90], armA: [-18, 118], legB: [32, 8], legA: [-30, -36], lean: 20 }, ease: "expo.out" },
  { t: 0.54, p: { armB: [88, 88] }, ease: "none" },
  { t: 1.0, p: { armB: GUARD.armB, armA: GUARD.armA, legB: GUARD.legB, legA: GUARD.legA, lean: GUARD.lean }, ease: "back.out(1.6)" },
]);

/* Patada: recoge la rodilla, la dispara recta, sostiene y vuelve a recoger antes de apoyar. El
   torso contrapesa hacia atrás y los brazos se abren para el equilibrio. 280 ms. */
const KICK = track(GUARD, [
  { t: 0.0, p: {} },
  { t: 0.14, p: { legB: [74, -36], legA: [-14, -24], armA: [-30, 60], armB: [50, 130], lean: -4 }, ease: "power2.out" },
  { t: 0.34, p: { legB: [98, 96], legA: [-16, -24], armA: [-62, -14], armB: [62, 108], lean: -16 }, ease: "expo.out" },
  { t: 0.56, p: { legB: [95, 93] }, ease: "none" },
  { t: 0.8, p: { legB: [58, -16], lean: -6 }, ease: "power2.in" },
  { t: 1.0, p: { legB: GUARD.legB, legA: GUARD.legA, armA: GUARD.armA, armB: GUARD.armB, lean: GUARD.lean }, ease: "power2.out" },
]);

const AIR_UP: Pose = { legA: [-3, -91], legB: [-34, -100], armA: [121, 148], armB: [-64, -26], lean: 6 };
const AIR_DOWN: Pose = { legA: [10, -2], legB: [-14, -30], armA: [46, 74], armB: [-22, 6], lean: 8 };
const TUCK: Pose = { legA: [96, -40], legB: [84, -52], armA: [70, 150], armB: [40, 140], lean: 0 };
const CROUCH: Pose = { legA: [14, -46], legB: [46, -16], armA: [-62, -36], armB: [58, 84], lean: 22 };
/* Golpe recibido de frente: el torso se va para atrás, los brazos quedan colgando hacia el que pegó
   y los pies patinan. Si el golpe vino por la espalda, el mismo cuerpo se dobla hacia adelante. */
const HURT: Pose = { legA: [-26, -36], legB: [24, 10], armA: [44, 84], armB: [72, 112], lean: -20 };

/* ---------------------------------------------------------------- resolución */
/* Articulaciones de verdad: la rodilla solo se dobla hacia adelante (la canilla nunca puede quedar
   más adelantada que el muslo) y el codo solo hacia el otro lado. Se aplica al resolver, así ninguna
   pose, rebote o mezcla entre poses puede quebrar una pierna al revés. */
function limb(o: Pt, a: Seg, l1: number, l2: number, f: number, knee: boolean): [Pt, Pt] {
  const lower = knee ? Math.min(a[1], a[0]) : Math.max(a[1], a[0]);
  const j = { x: o.x + Math.sin(a[0] * DEG) * l1 * f, y: o.y + Math.cos(a[0] * DEG) * l1 };
  return [j, { x: j.x + Math.sin(lower * DEG) * l2 * f, y: j.y + Math.cos(lower * DEG) * l2 }];
}

function legDrop(s: Seg): number {
  return Math.cos(s[0] * DEG) * THIGH + Math.cos(Math.min(s[1], s[0]) * DEG) * SHIN;
}

const NO_STATE: RigState = {};

export function solveRig(p: RenderPlayer & { jumpsLeft?: number; kbx?: number }, st: RigState | null, low = false): Rig {
  const S = st || NO_STATE;
  const live = !!st && !low;
  const nowMs = (p.idleT || 0) * 1000;
  const dt = S.lastMs != null ? clamp(nowMs - S.lastMs, 0, 60) : 16.667;
  if (st) st.lastMs = nowMs;

  const running = p.grounded && p.vx !== 0;
  const punching = !!p.attack && p.attack.type === "punch";
  const kicking = !!p.attack && p.attack.type === "kick";
  const attackLin = p.attack ? clamp(1 - p.attack.t / (p.attack.dur || (kicking ? 280 : 140)), 0, 1) : 0;
  const kb = p.kbx || 0;
  // reacción al golpe: entra de una (cuadro 1 = pose de impacto) y se suelta en los últimos 100 ms
  const hurtW = ease("power2.out")(clamp((p.hitStunT || 0) / 100, 0, 1));
  const launched = !p.grounded && (p.hitStunT || 0) > 30;
  const pushDir = Math.abs(kb) > 0.3 ? Math.sign(kb) : (p.hitDir || 1);
  const fromFront = p.facing === -pushDir ? 1 : -1;

  if (st) {
    // mortal del doble salto: se detecta cuando se gasta el segundo salto en el aire y avanza con la
    // velocidad vertical (no con un reloj), así acompaña la física, la cámara lenta y el hitstop
    if (p.jumpsLeft != null && st.prevJumps != null && !p.grounded && st.prevJumps > 0 && p.jumpsLeft === 0) st.flipV0 = Math.min(p.vy, -6);
    st.prevJumps = p.jumpsLeft;
    if (st.flipV0 != null && (p.grounded || launched || p.vy - st.flipV0 >= FLIP_DV)) st.flipV0 = undefined;
    // voltereta al salir despedido: gira más rápido cuanto más fuerte fue el golpe; al terminar
    // vuelve a la vuelta completa más cercana
    if (launched) st.tumble = (st.tumble || 0) + dt * (0.004 + 0.008 * Math.min(1, Math.abs(kb) / 10)) * pushDir;
    else if (st.tumble) {
      const target = Math.round(st.tumble / (Math.PI * 2)) * Math.PI * 2;
      st.tumble += (target - st.tumble) * Math.min(1, dt * 0.018);
      if (Math.abs(target - st.tumble) < 0.02) st.tumble = 0;
    }
    // giro de papel al darse vuelta (no en pleno golpe)
    if (st.prevFacing != null && st.prevFacing !== p.facing && !p.attack && p.grounded) { st.turnT = 110; st.turnFrom = st.prevFacing; }
    st.prevFacing = p.facing;
    if (st.turnT) st.turnT = Math.max(0, st.turnT - dt);
  }
  const flipU = S.flipV0 != null ? clamp((p.vy - S.flipV0) / FLIP_DV, 0, 1) : 0;
  const turnU = S.turnT ? 1 - S.turnT / 110 : 1;
  const facing = S.turnT && turnU < 0.5 ? (S.turnFrom ?? p.facing) : p.facing;

  // ---- pose objetivo según el estado
  let fam: string;
  let target: Pose;
  if (kicking) { fam = "kick"; target = sample(KICK, attackLin); }
  else if (launched) {
    fam = "tumble";
    const w = Math.sin(nowMs * 0.03);
    target = { legA: [40 + w * 20, -20], legB: [-30 - w * 20, -60], armA: [150 + w * 30, 200], armB: [-140 - w * 25, -110], lean: 0 };
  } else if (flipU > 0 && !punching) { fam = "flip"; target = lerpPose(TUCK, AIR_DOWN, ease("power2.in")(clamp((flipU - 0.7) / 0.3, 0, 1))); }
  else if (!p.grounded) { fam = "air"; target = lerpPose(AIR_UP, AIR_DOWN, ease("sine.inOut")((clamp(p.vy / 9, -1, 1) + 1) / 2)); }
  else if (punching) { fam = "punch"; target = sample(PUNCH, attackLin); }
  else if (running) { fam = "run"; target = sample(RUN, p.walkCycle || 0, true); }
  else if (hurtW > 0.02) { fam = "hurt"; target = lerpPose(GUARD, { ...HURT, lean: HURT.lean * fromFront }, hurtW); }
  else {
    fam = "idle";
    // guardia viva: respiración + rebote de peleador sobre las rodillas
    const t = p.idleT || 0;
    const b = low ? 0 : (Math.sin(t * 5.2) + 1) / 2;
    const br = low ? 0 : Math.sin(t * 1.3);
    target = {
      legA: [GUARD.legA[0] + b * 4, GUARD.legA[1] - b * 6],
      legB: [GUARD.legB[0] + b * 5, GUARD.legB[1] - b * 8],
      armA: [GUARD.armA[0] + br * 3, GUARD.armA[1] - br * 4 + b * 3],
      armB: [GUARD.armB[0] - br * 2, GUARD.armB[1] + br * 3 + b * 3],
      lean: GUARD.lean + br * 1.5,
    };
  }
  // flexión al aterrizar fuerte
  if (p.grounded && (p.squash || 0) > 0.05 && !p.attack && !running) target = lerpPose(target, CROUCH, clamp(p.squash * 1.2, 0, 1));

  // ---- blend corto entre familias de pose
  let pose = target;
  if (live) {
    if (st.fam !== fam) { st.from = st.last; st.blendT = fam === "punch" || fam === "kick" ? 40 : 90; st.fam = fam; }
    if (st.blendT && st.from) {
      st.blendT = Math.max(0, st.blendT - dt);
      const tot = fam === "punch" || fam === "kick" ? 40 : 90;
      pose = lerpPose(st.from, target, ease("power2.out")(1 - st.blendT / tot));
    }
    st.last = pose;
  }

  // ---- torso: inclinación con resorte + latigazo del golpe recibido
  let lean = pose.lean;
  if (!p.grounded && fam === "air") lean += clamp(p.vy / 9, -1, 1) * 4;
  if (live) { st.lean = st.lean == null ? lean : lerp(st.lean, lean, fam === "hurt" ? 0.7 : 0.4); lean = st.lean; }

  // ---- cadera: los pies de apoyo tocan el piso
  const feet = p.y;
  let hipY: number;
  if (p.grounded) {
    const drop = kicking ? legDrop(pose.legA) : Math.max(legDrop(pose.legA), legDrop(pose.legB));
    hipY = feet - drop - (running ? Math.abs(Math.sin((p.walkCycle || 0) * Math.PI * 2)) * 2.2 : 0);
  } else hipY = feet - (THIGH + SHIN) * 0.86;
  const hip = { x: p.x, y: hipY };
  const shoulder = { x: hip.x + Math.sin(lean * DEG) * TORSO * facing, y: hip.y - Math.cos(lean * DEG) * TORSO };
  // la cabeza latiguea un poco más que el torso al recibir
  let headLean = lean * 0.6 + (fam === "hurt" ? -16 * fromFront * hurtW : 0);
  if (live) { st.headSpring = st.headSpring == null ? headLean : lerp(st.headSpring, headLean, 0.3); headLean = st.headSpring; }
  const neck = { x: shoulder.x + Math.sin(headLean * DEG) * NECK * facing, y: shoulder.y - Math.cos(headLean * DEG) * NECK };
  const head = { x: neck.x + Math.sin(headLean * DEG) * HEAD_R * facing, y: neck.y - Math.cos(headLean * DEG) * HEAD_R };

  const [kneeA, footA] = limb(hip, pose.legA, THIGH, SHIN, facing, true);
  const [kneeB, footB] = limb(hip, pose.legB, THIGH, SHIN, facing, true);
  const [elbowA, handA] = limb(shoulder, pose.armA, UARM, FARM, facing, false);
  const [elbowB, handB] = limb(shoulder, pose.armB, UARM, FARM, facing, false);

  // ---- transformaciones de cuerpo entero: squash/stretch, giro de papel, mortal, voltereta
  let sx = 1, sy = 1;
  if (!low) {
    const sq = p.squash || 0;
    const antic = clamp((p.jumpAnticT || 0) / 90, 0, 1);
    const pop = antic * Math.sin(antic * Math.PI);
    sy = 1 - sq * 0.18 + pop * 0.16;
    sx = 1 + sq * 0.16 - pop * 0.12;
  }
  if (S.turnT) sx *= Math.max(0.14, Math.abs(1 - 2 * turnU));
  let rot = 0;
  const pivot = { x: hip.x, y: hip.y };
  // mortal hacia adelante (acelera y frena como una vuelta de verdad) + voltereta al salir despedido
  if (flipU > 0) rot = facing * ease("power2.inOut")(flipU) * Math.PI * 2;
  rot += S.tumble || 0;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const T = (q: Pt, noRot = false): Pt => {
    let x = p.x + (q.x - p.x) * sx, y = feet + (q.y - feet) * sy;
    if (rot && !noRot) { const dx = x - pivot.x, dy = y - pivot.y; x = pivot.x + dx * cr - dy * sr; y = pivot.y + dx * sr + dy * cr; }
    return { x, y };
  };
  const pts = { hip: T(hip), shoulder: T(shoulder), neck: T(neck), head: T(head), kneeA: T(kneeA), footA: T(footA), kneeB: T(kneeB), footB: T(footB), elbowA: T(elbowA), handA: T(handA), elbowB: T(elbowB), handB: T(handB) };

  // ---- ojos
  let expr: Expr = "open";
  if (!p.alive) expr = "ko";
  else if (hurtW > 0.3 || launched) expr = "hurt";
  else if (p.attack) expr = "focus";
  else if (!low) {
    const ph = ((p.id || 0) * 0.37) % 1;
    if ((((p.idleT || 0) * 0.29 + ph) % 1) < 0.03) expr = "blink";
  }

  // ---- paso de carrera (para el polvito)
  let footstep: Pt | null = null;
  if (st && running) {
    const w = p.walkCycle || 0;
    const lw = st.lastWalk ?? w;
    if ((lw < 0.02 && w >= 0.02) || (lw < 0.52 && w >= 0.52) || (lw > w + 0.5)) footstep = { x: p.x, y: feet };
    st.lastWalk = w;
  } else if (st) st.lastWalk = undefined;

  const strike = punching && attackLin > 0.1 && attackLin < 0.7 ? { tip: pts.handB, kind: "punch" as const, progress: attackLin }
    : kicking && attackLin > 0.12 && attackLin < 0.75 ? { tip: pts.footB, kind: "kick" as const, progress: attackLin } : null;

  return {
    ...pts, headR: HEAD_R * (1 + (sx - 1) * 0.3), headLean: headLean + (rot / DEG) * facing, facing,
    expr, strike, spin: flipU > 0 ? flipU : launched ? 1 : 0, footstep, tagY: T(head, true).y,
  };
}
