/* Esqueleto del muñeco (V2): calcula dónde está cada articulación en un cuadro, a partir del estado
   de juego. No dibuja nada — los renderers (Pixi y el canvas del menú) lo consumen.

   Cómo se busca que el movimiento sea fluido y no "cuadrado":
   - Ciclos (carrera) con splines Catmull-Rom: la velocidad es continua al pasar por cada pose
     clave. Con un easing de entrada/salida por tramo (lo de antes) el miembro frenaba a cero en
     cada pose y el movimiento se veía a tirones, como stop-motion.
   - Golpes con curvas de GSAP por tramo (carga, latigazo expo, sostén, vuelta con rebote): ahí sí
     se quiere el cambio brusco de velocidad.
   - Resortes amortiguados por articulación (seguimiento con inercia): los brazos llegan un poco
     tarde y se pasan apenas, la cabeza bambolea, el torso se acomoda. Cada acción tiene su
     rigidez: el miembro que pega es muy rígido (golpe seco), el resto más suelto. Reemplaza al
     blend lineal entre poses, que era lo que más se notaba "mecánico" en las transiciones.
   - Poses en ángulos ABSOLUTOS por segmento (0 = colgando, +90 = hacia donde mira, 180 = arriba),
     rodillas y codos que nunca se doblan al revés, y contacto con el piso automático (la cadera
     sale de la pierna de apoyo, con un máximo suave para que no pegue saltitos al cambiar de pie). */

import type { RenderPlayer } from "./art/stickman";
import { ease } from "./ease";

export type Pt = { x: number; y: number };
export type Expr = "open" | "blink" | "focus" | "hurt" | "ko";

export interface Rig {
  hip: Pt; shoulder: Pt; neck: Pt; head: Pt; headR: number; headLean: number;
  /** A = miembro de atrás (se dibuja más oscuro, detrás del torso); B = el de adelante. */
  kneeA: Pt; footA: Pt; kneeB: Pt; footB: Pt;
  elbowA: Pt; handA: Pt; elbowB: Pt; handB: Pt;
  /** Curvatura de la columna (px hacia adelante en el medio del torso). */
  bend: number;
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
  /** Resortes: ángulos actuales y velocidades (legA0, legA1, legB0, legB1, armA0, armA1, armB0, armB1, lean, head). */
  a?: number[]; v?: number[];
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

function sample(tr: { t: number; pose: Pose; ease: string }[], t: number): Pose {
  t = clamp(t, 0, 1);
  for (let i = 0; i < tr.length - 1; i++) {
    const a = tr[i], b = tr[i + 1];
    if (t >= a.t && t <= b.t) return lerpPose(a.pose, b.pose, ease(b.ease)(b.t === a.t ? 1 : (t - a.t) / (b.t - a.t)));
  }
  return tr[tr.length - 1].pose;
}

/** Catmull-Rom cíclico sobre poses clave equiespaciadas: pasa por cada una sin frenar. */
function cyc(keys: Seg[], t: number): Seg {
  const n = keys.length;
  const x = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(x), u = x - i;
  const p0 = keys[(i - 1 + n) % n], p1 = keys[i % n], p2 = keys[(i + 1) % n], p3 = keys[(i + 2) % n];
  const cr = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])];
}

/* ---------------------------------------------------------------- poses y movimientos */
const GUARD: Pose = { armA: [12, 142], armB: [36, 152], legA: [-12, -36], legB: [28, -2], lean: 5 };

/* Carrera en 8 poses (pierna de adelante): contacto, carga, empuje, despegue, recogida con el talón
   arriba, rodilla al frente, estirada y bajada al contacto. La otra pierna va media vuelta
   corrida. Los brazos, opuestos a las piernas, con el codo doblado. */
const RUN_LEG: Seg[] = [[32, 18], [12, -8], [-18, -30], [-34, -62], [-8, -100], [38, -40], [55, 20], [44, 28]];
const RUN_ARM: Seg[] = [[-42, 8], [-12, 66], [52, 138], [22, 104]];

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

/* ---------------------------------------------------------------- resortes */
/* [frecuencia natural (rad/s), amortiguación]. Menos de 1 de amortiguación = se pasa un poco y
   vuelve (brazos, cabeza); cerca de 1 = llega justo (piernas, para no perder el piso). */
type Spring = [number, number];
interface SpringSet { leg: Spring; arm: Spring; lean: Spring; head: Spring; strike?: Spring }
const SPRINGS: Record<string, SpringSet> = {
  idle: { leg: [26, 0.9], arm: [18, 0.55], lean: [14, 0.6], head: [14, 0.42] },
  run: { leg: [50, 0.85], arm: [30, 0.58], lean: [16, 0.55], head: [18, 0.4] },
  air: { leg: [24, 0.62], arm: [16, 0.45], lean: [12, 0.55], head: [14, 0.4] },
  flip: { leg: [45, 0.8], arm: [30, 0.7], lean: [30, 0.8], head: [30, 0.7] },
  punch: { leg: [40, 0.8], arm: [34, 0.6], lean: [30, 0.6], head: [22, 0.45], strike: [100, 0.72] },
  kick: { leg: [45, 0.8], arm: [26, 0.5], lean: [26, 0.6], head: [18, 0.42], strike: [95, 0.72] },
  hurt: { leg: [60, 0.6], arm: [40, 0.38], lean: [55, 0.45], head: [26, 0.3] },
  tumble: { leg: [30, 0.5], arm: [22, 0.4], lean: [20, 0.5], head: [20, 0.4] },
};

function stepSprings(st: RigState, target: number[], fam: string, dtMs: number) {
  const s = SPRINGS[fam] || SPRINGS.idle;
  if (!st.a || !st.v) { st.a = target.slice(); st.v = target.map(() => 0); return; }
  const a = st.a, v = st.v;
  const params: Spring[] = [s.leg, s.leg, s.leg, s.leg, s.arm, s.arm, s.arm, s.arm, s.lean, s.head];
  if (s.strike) {
    if (fam === "punch") params[6] = params[7] = s.strike;
    else params[2] = params[3] = s.strike;
  }
  let left = dtMs / 1000;
  while (left > 1e-6) {
    const h = Math.min(left, 0.004);
    left -= h;
    for (let i = 0; i < a.length; i++) {
      const [w, z] = params[i];
      v[i] += (w * w * (target[i] - a[i]) - 2 * z * w * v[i]) * h;
      a[i] += v[i] * h;
    }
  }
}

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

/** Máximo suave: la cadera pasa de una pierna de apoyo a la otra sin quiebre (a lo sumo k/2 px de más). */
const smax = (a: number, b: number, k = 1.5) => (a + b + Math.sqrt((a - b) * (a - b) + k * k)) / 2;

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
      st.tumble += (target - st.tumble) * (1 - Math.exp(-dt * 0.018));
      if (Math.abs(target - st.tumble) < 0.02) st.tumble = 0;
    }
    // giro de papel al darse vuelta (no en pleno golpe)
    if (st.prevFacing != null && st.prevFacing !== p.facing && !p.attack && p.grounded) { st.turnT = 120; st.turnFrom = st.prevFacing; }
    st.prevFacing = p.facing;
    if (st.turnT) st.turnT = Math.max(0, st.turnT - dt);
  }
  const flipU = S.flipV0 != null ? clamp((p.vy - S.flipV0) / FLIP_DV, 0, 1) : 0;
  const turnU = S.turnT ? ease("sine.inOut")(1 - S.turnT / 120) : 1;
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
  else if (running) {
    fam = "run";
    const w = p.walkCycle || 0;
    // la carrera empieza en la pose de contacto de la pierna de adelante (legB)
    target = { legB: cyc(RUN_LEG, w), legA: cyc(RUN_LEG, w + 0.5), armB: cyc(RUN_ARM, w), armA: cyc(RUN_ARM, w + 0.5), lean: 14 + Math.cos(w * Math.PI * 4) * 2 };
  } else if (hurtW > 0.02) { fam = "hurt"; target = lerpPose(GUARD, { ...HURT, lean: HURT.lean * fromFront }, hurtW); }
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
  let leanT = target.lean;
  if (!p.grounded && fam === "air") leanT += clamp(p.vy / 9, -1, 1) * 4;
  // la cabeza latiguea un poco más que el torso al recibir
  const headT = leanT * 0.6 + (fam === "hurt" ? -16 * fromFront * hurtW : 0);

  // ---- resortes: el esqueleto sigue a la pose objetivo con inercia
  let pose = target, lean = leanT, headLean = headT;
  if (live) {
    const tv = [target.legA[0], target.legA[1], target.legB[0], target.legB[1], target.armA[0], target.armA[1], target.armB[0], target.armB[1], leanT, headT];
    stepSprings(st, tv, fam, dt);
    const a = st.a!;
    pose = { legA: [a[0], a[1]], legB: [a[2], a[3]], armA: [a[4], a[5]], armB: [a[6], a[7]], lean: a[8] };
    lean = a[8];
    headLean = a[9];
  }
  // la columna se curva hacia donde el torso "quiere" ir y todavía no llegó
  const bend = live ? clamp((leanT - lean) * 0.14, -3.5, 3.5) : 0;

  // ---- cadera: los pies de apoyo tocan el piso
  const feet = p.y;
  let hipY: number;
  if (p.grounded) {
    const drop = kicking ? legDrop(pose.legA) : smax(legDrop(pose.legA), legDrop(pose.legB));
    hipY = feet - drop;
  } else hipY = feet - (THIGH + SHIN) * 0.86;
  const hip = { x: p.x, y: hipY };
  const shoulder = { x: hip.x + Math.sin(lean * DEG) * TORSO * facing, y: hip.y - Math.cos(lean * DEG) * TORSO };
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
    // se estira un poco al subir rápido y al caer rápido (lee la velocidad, como en los dibujos)
    const stretch = !p.grounded && flipU === 0 ? clamp((Math.abs(p.vy) - 4) / 16, 0, 1) * 0.07 : 0;
    sy = 1 - sq * 0.18 + pop * 0.16 + stretch;
    sx = 1 + sq * 0.16 - pop * 0.12 - stretch * 0.6;
  }
  if (S.turnT) sx *= Math.max(0.12, Math.abs(Math.cos(turnU * Math.PI)));
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

  // ---- paso de carrera (para el polvito): contacto de cada pie
  let footstep: Pt | null = null;
  if (st && running) {
    const w = p.walkCycle || 0;
    const lw = st.lastWalk ?? w;
    if ((lw < 0.5 && w >= 0.5) || lw > w + 0.5) footstep = { x: p.x, y: feet };
    st.lastWalk = w;
  } else if (st) st.lastWalk = undefined;

  const strike = punching && attackLin > 0.1 && attackLin < 0.7 ? { tip: pts.handB, kind: "punch" as const, progress: attackLin }
    : kicking && attackLin > 0.12 && attackLin < 0.75 ? { tip: pts.footB, kind: "kick" as const, progress: attackLin } : null;

  return {
    ...pts, headR: HEAD_R * (1 + (sx - 1) * 0.3), headLean: headLean + (rot / DEG) * facing, bend: bend * sx, facing,
    expr, strike, spin: flipU > 0 ? flipU : launched ? 1 : 0, footstep, tagY: T(head, true).y,
  };
}
