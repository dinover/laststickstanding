/* Rig del muñeco + animación de correr/saltar/pegar. Port de V1 (stickman.js): mismas poses,
   tablas y tuning. Cambios de V2:
   - El estado de animación (resortes, blends) vive en un objeto RigAnim por jugador, no pegado
     con campos "_x" sobre el objeto de juego (que ahora viene de la red o de la sim).
   - Sin shadowBlur: el brillo lo pone el bloom de WebGL (render/renderer.ts), que es mucho más
     barato y se ve mejor. */

import { POWER_COLORS, type PowerType } from "@lss/shared";
import { artCfg } from "./config";

export interface RenderPlayer {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  grounded: boolean;
  alive: boolean;
  attack: { type: "punch" | "kick"; t: number; dur: number } | null;
  walkCycle: number;
  idleT: number;
  squash: number;
  jumpAnticT: number;
  hitStunT: number;
  hitDir: number;
  power: ({ t: number } & Partial<Record<PowerType, boolean>>) | null;
  burnT: number;
  slowT: number;
  burnFlashT: number;
  hp: number;
  deathFadeT: number;
  /** Saltos que le quedan (el rig nuevo detecta el doble salto para el mortal). */
  jumpsLeft?: number;
  /** Knockback horizontal actual (el rig nuevo lo usa para la voltereta al salir lanzado). */
  kbx?: number;
  isBot?: boolean;
  isHero?: boolean;
}

export interface RigAnim {
  leanSpring?: number;
  headSpring?: number;
  lastIdleTMs?: number;
  strideAsym?: number;
  animState?: string;
  blendT?: number;
  blendFromLegA?: Pose; blendFromLegB?: Pose; blendFromArmA?: Pose; blendFromArmB?: Pose;
  lastLegA?: Pose; lastLegB?: Pose; lastArmA?: Pose; lastArmB?: Pose;
}

export interface RigInfo {
  headX: number; headY: number; hipX: number; hipY: number; shoulderX: number; shoulderY: number;
  cx: number; feet: number; scaleX: number;
}

type Pose = { a: number; b: number };
type Key = { t: number; a: number; b: number };
type Ctx = CanvasRenderingContext2D;

const DEG = Math.PI / 180;
const smoothstep = (u: number) => u * u * (3 - 2 * u);
const easeOutQuad = (u: number) => 1 - (1 - u) * (1 - u);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function sampleTable(table: Key[], phase: number): Pose {
  const t = ((phase % 1) + 1) % 1;
  for (let i = 0; i < table.length - 1; i++) {
    const k0 = table[i], k1 = table[i + 1];
    if (t >= k0.t && t <= k1.t) {
      const u = k1.t === k0.t ? 0 : smoothstep((t - k0.t) / (k1.t - k0.t));
      return { a: lerp(k0.a, k1.a, u), b: lerp(k0.b, k1.b, u) };
    }
  }
  return { a: table[0].a, b: table[0].b };
}

function sampleTableOnce(table: Key[], phase: number, easeFn: (u: number) => number = smoothstep): Pose {
  const t = clamp(phase, 0, 1);
  for (let i = 0; i < table.length - 1; i++) {
    const k0 = table[i], k1 = table[i + 1];
    if (t >= k0.t && t <= k1.t) {
      const u = k1.t === k0.t ? 0 : easeFn((t - k0.t) / (k1.t - k0.t));
      return { a: lerp(k0.a, k1.a, u), b: lerp(k0.b, k1.b, u) };
    }
  }
  const last = table[table.length - 1];
  return { a: last.a, b: last.b };
}

const LEG_KEYS: Key[] = [
  { t: 0.0, a: 36, b: 4 }, { t: 0.14, a: 16, b: 6 }, { t: 0.32, a: -18, b: 8 }, { t: 0.48, a: -34, b: 12 },
  { t: 0.6, a: -14, b: 51 }, { t: 0.76, a: 16, b: 33 }, { t: 0.9, a: 32, b: 12 }, { t: 1.0, a: 36, b: 4 },
];
const ARM_KEYS: Key[] = [
  { t: 0.0, a: -22, b: 9 }, { t: 0.25, a: 65, b: -55 }, { t: 0.5, a: 36, b: -14 }, { t: 0.75, a: -95, b: 45 }, { t: 1.0, a: -12, b: 1 },
];
const PUNCH_ARM_KEYS: Key[] = [
  { t: 0.0, a: -78, b: 120 }, { t: 0.06, a: -90, b: 129 }, { t: 0.2, a: -58, b: 76 }, { t: 0.4, a: 74, b: -75 },
  { t: 0.55, a: 59, b: -29 }, { t: 0.62, a: 40, b: -40 }, { t: 0.8, a: 15, b: -11 }, { t: 0.92, a: -14, b: -4 }, { t: 1.0, a: -20, b: 2 },
];
const KICK_LEG_KEYS: Key[] = [
  { t: 0.0, a: 9, b: 11 }, { t: 0.05, a: -8, b: 3 }, { t: 0.2, a: 59, b: 73 }, { t: 0.4, a: 83, b: 66 }, { t: 0.5, a: 100, b: -12 },
  { t: 0.6, a: 113, b: 0 }, { t: 0.68, a: 113, b: -1 }, { t: 0.85, a: 69, b: 5 }, { t: 0.94, a: 25, b: 41 }, { t: 1.0, a: 20, b: 46 },
];
const IDLE_LEGS: Pose[] = [{ a: -23, b: -7 }, { a: 26, b: 27 }];
const IDLE_ARMS: Pose[] = [{ a: 70, b: -74 }, { a: 50, b: -79 }];
const JUMP_LEGA_KEYS: Key[] = [{ t: 0, a: -3, b: 88 }, { t: 1, a: 10, b: 12 }];
const JUMP_LEGB_KEYS: Key[] = [{ t: 0, a: -34, b: 66 }, { t: 1, a: -14, b: 16 }];
const JUMP_ARMA_KEYS: Key[] = [{ t: 0, a: 121, b: -27 }, { t: 1, a: 46, b: 34 }];
const JUMP_ARMB_KEYS: Key[] = [{ t: 0, a: -102, b: -40 }, { t: 1, a: -22, b: 28 }];
const STANCE = {
  punchLegs: [{ a: -17, b: 25 }, { a: 36, b: 41 }],
  punchGuardArm: [{ a: -14, b: 85 }],
  kickSupportLeg: [{ a: -28, b: -26 }],
  kickArms: [{ a: -60, b: 100 }, { a: 29, b: -30 }],
};
const TUNE = {
  runLean: 19, punchLeanBase: 9.5, punchLeanSnap: 20, kickLeanSnap: 14.5, airLeanMax: 8, idleLeanMix: 0.3,
  runTwist: 4, punchTwist: 5, kickTwist: 9.5, headTwistRunMix: 1,
  hitLean: 28, hitHeadShift: 2,
  runBob: 5.4, headBobRun: 3, headLagPhase: 0.03, pelvisDrive: 3,
  breatheAmp: 1.6, idleBobAmp: 0.3, idleSwayX: 1.5, idleWeightSwayX: 2.3, idleWeightLegSpread: 4,
  idleShoulderRotAmp: 4.4, idleHeadTurnAmp: 3, idleHandDriftAmp: 4.2, armSwayAmp: 5.8,
  headSpringK: 0.32, leanSpringK: 0.42, blendMs: 90, strideAsymAmt: 0.05,
  squashScaleY: 0.4, squashScaleX: 0.31, squashWaveScaleY: 0.08, squashWaveScaleX: 0.05,
  takeoffScaleY: 0.23, takeoffScaleX: 0.2, actionPopSquash: 0.07, actionPopStretch: 0.03,
};
const THIGH = 12.5, SHIN = 13.5, UARM = 10, FARM = 11;

type Aura = { type: PowerType; t: number } | null;
let CURRENT_AURA: Aura = null;

function limbEnd(ox: number, oy: number, angleDeg: number, len: number, facing: number) {
  const rad = angleDeg * DEG;
  return { x: ox + Math.sin(rad) * len * facing, y: oy + Math.cos(rad) * len };
}

function limb(ctx: Ctx, hipX: number, hipY: number, upperAngle: number, jointBend: number, upperLen: number, lowerLen: number,
  facing: number, widthA: number, widthB: number, drawEndDot: boolean, foldAway: boolean) {
  const lowerAngle = foldAway ? upperAngle - jointBend : upperAngle - (upperAngle < 0 ? -1 : 1) * jointBend;
  const mid = limbEnd(hipX, hipY, upperAngle, upperLen, facing);
  const end = limbEnd(mid.x, mid.y, lowerAngle, lowerLen, facing);
  ctx.lineWidth = widthA;
  ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(mid.x, mid.y); ctx.stroke();
  ctx.lineWidth = widthB;
  ctx.beginPath(); ctx.moveTo(mid.x, mid.y); ctx.lineTo(end.x, end.y); ctx.stroke();
  ctx.beginPath(); ctx.arc(mid.x, mid.y, 2, 0, Math.PI * 2); ctx.fill();
  if (drawEndDot) { ctx.beginPath(); ctx.arc(end.x, end.y, 2.4, 0, Math.PI * 2); ctx.fill(); }
  if (CURRENT_AURA) {
    auraSegment(ctx, hipX, hipY, mid.x, mid.y, CURRENT_AURA);
    auraSegment(ctx, mid.x, mid.y, end.x, end.y, CURRENT_AURA);
  }
  return end;
}

function drawOrbitAura(ctx: Ctx, cx: number, midY: number, halfW: number, halfH: number, t: number, color: string) {
  const n = 3, rx = halfW + 6, ry = (halfH + 4) * 0.85;
  ctx.lineWidth = 2;
  for (let i = 0; i < n; i++) {
    const a = t * (2.4 + i * 0.6) + i * ((Math.PI * 2) / n);
    const trailA = a - 0.4;
    const x = cx + Math.cos(a) * rx, y = midY + Math.sin(a) * ry;
    const tx = cx + Math.cos(trailA) * rx, ty = midY + Math.sin(trailA) * ry;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.65;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function firstActivePower(power: RenderPlayer["power"]): PowerType | null {
  if (!power) return null;
  if (power.fuego) return "fuego";
  if (power.hielo) return "hielo";
  if (power.tierra) return "tierra";
  if (power.aire) return "aire";
  return null;
}

function beginPowerAura(p: RenderPlayer) {
  const own = firstActivePower(p.power);
  if (own) CURRENT_AURA = { type: own, t: p.idleT || 0 };
  else if (p.burnT > 0) CURRENT_AURA = { type: "fuego", t: p.idleT || 0 };
  else if (p.slowT > 0) CURRENT_AURA = { type: "hielo", t: p.idleT || 0 };
  else CURRENT_AURA = null;
}

function auraSegment(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, aura: Aura) {
  if (!aura) return;
  const savedFill = ctx.fillStyle, savedStroke = ctx.strokeStyle, savedWidth = ctx.lineWidth;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const t = aura.t;
  if (aura.type === "fuego") {
    for (let i = 0; i < 3; i++) {
      const u = (i + 0.5) / 3;
      const px = x1 + dx * u, py = y1 + dy * u;
      const flick = 0.5 + 0.5 * Math.sin(t * 10 + i * 2.3 + u * 7);
      const reach = 4 + flick * 6;
      const sway = Math.sin(t * 15 + i * 4.1) * 2.5;
      ctx.fillStyle = "rgba(255," + (110 + Math.round(flick * 90)) + ",35," + (0.28 + flick * 0.45).toFixed(2) + ")";
      ctx.beginPath(); ctx.moveTo(px - 2, py); ctx.lineTo(px + sway, py - reach); ctx.lineTo(px + 2, py); ctx.closePath(); ctx.fill();
    }
  } else if (aura.type === "hielo") {
    for (let j = 0; j < 4; j++) {
      const u2 = (j + 0.5) / 4;
      const px2 = x1 + dx * u2, py2 = y1 + dy * u2;
      const shimmer = 0.42 + 0.32 * Math.sin(t * 2.4 + j * 1.7 + u2 * 4);
      const side = j % 2 === 0 ? 1 : -1;
      const sx = px2 + nx * 3.8 * side, sy = py2 + ny * 3.8 * side;
      ctx.fillStyle = "rgba(170,230,255," + shimmer.toFixed(2) + ")";
      ctx.beginPath(); ctx.moveTo(sx, sy - 3.8); ctx.lineTo(sx + 2, sy); ctx.lineTo(sx, sy + 3.8); ctx.lineTo(sx - 2, sy); ctx.closePath(); ctx.fill();
    }
  } else if (aura.type === "tierra") {
    for (let k = 0; k < 5; k++) {
      const u3 = ((k + 0.5) / 5) * 0.82 + 0.09;
      const px3 = x1 + dx * u3, py3 = y1 + dy * u3;
      const jitter = ((Math.round(x1) * 7 + Math.round(y1) * 13 + k * 31) % 5) - 2;
      const ox = px3 + nx * (4.5 + jitter), oy = py3 + ny * (4.5 + jitter);
      const sz = 2.6 + (k % 3) * 0.6;
      ctx.fillStyle = k % 2 === 0 ? "#a07a44" : "#7c5f35";
      ctx.beginPath(); ctx.moveTo(ox - sz, oy); ctx.lineTo(ox, oy - sz); ctx.lineTo(ox + sz, oy); ctx.lineTo(ox, oy + sz * 0.9); ctx.closePath(); ctx.fill();
    }
  } else if (aura.type === "aire") {
    for (let m = 0; m < 2; m++) {
      const u4 = (t * (0.6 + m * 0.35) + m * 0.5) % 1;
      const tailU = Math.max(0, u4 - 0.16);
      const px4 = x1 + dx * u4, py4 = y1 + dy * u4;
      const tx = x1 + dx * tailU, ty = y1 + dy * tailU;
      const off = Math.sin(t * 6 + m * 3) * 3;
      ctx.strokeStyle = "rgba(220,255,225," + (0.55 - u4 * 0.25).toFixed(2) + ")";
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(tx + nx * off, ty + ny * off); ctx.lineTo(px4 + nx * off, py4 + ny * off); ctx.stroke();
    }
  }
  ctx.fillStyle = savedFill; ctx.strokeStyle = savedStroke; ctx.lineWidth = savedWidth;
}

function drawBurnFlash(ctx: Ctx, p: RenderPlayer, cx: number, midY: number, halfH: number) {
  if (!(p.burnFlashT > 0)) return;
  const a = clamp(p.burnFlashT / 220, 0, 1);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 5; i++) {
    const seed = (p.id || 0) * 13 + i * 7;
    const ang = (((seed * 37) % 100) / 100) * Math.PI * 2;
    const dist = 3 + (((seed * 53) % 100) / 100) * 12;
    const rise = (1 - a) * 14;
    const sx = cx + Math.cos(ang) * dist * 0.6;
    const sy = midY - halfH * 0.3 + Math.sin(ang) * dist * 0.4 - rise;
    ctx.globalAlpha = a * (0.5 + 0.5 * Math.sin(seed));
    ctx.fillStyle = i % 2 === 0 ? "#ffb347" : POWER_COLORS.fuego;
    ctx.beginPath(); ctx.arc(sx, sy, 1.6 * a + 0.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function blendPose(fromPose: Pose | undefined, toPose: Pose, frac: number): Pose {
  if (!fromPose) return toPose;
  return { a: lerp(fromPose.a, toPose.a, frac), b: lerp(fromPose.b, toPose.b, frac) };
}

/* ================================================================ accesorios cosméticos */
const HEAD_RX = 7.6, HEAD_RY = 8.8;

/** Cuánto sobresale cada accesorio sobre el centro de la cabeza (medido sobre la tinta real). */
export const ACCESSORY_REACH: Record<string, number> = {
  none: 15, horns: 20, halo: 26, tophat: 26, cap: 17, crown: 20, poop: 23, cowboy: 19,
  party: 28, bunny: 27, antennae: 24, arrow: 15, mohawk: 22, flame: 29, propeller: 29, orbit: 32,
};

export function accessoryLift(kind: string): number {
  const reach = ACCESSORY_REACH[kind] || 0;
  return reach > 17 ? reach - 17 : 0;
}

function accHeadEdgeY(x: number) {
  const u = clamp(x / HEAD_RX, -1, 1);
  return -HEAD_RY * Math.sqrt(1 - u * u);
}

function accPaint(ctx: Ctx, fill: string | null, stroke: string | null, lw?: number) {
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1.4; ctx.stroke(); }
}

export function drawAccessory(ctx: Ctx, kind: string, headX: number, headY: number, headLean: number, facing: number, t: number) {
  if (!kind || kind === "none") return;
  const f = facing < 0 ? -1 : 1;
  let s: number, i: number;
  ctx.save();
  ctx.translate(headX, headY);
  ctx.rotate(headLean * DEG);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (kind === "horns") {
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(s * 3.6, -7.4);
      ctx.quadraticCurveTo(s * 10.8, -10.2, s * 8.8, -18.8);
      ctx.quadraticCurveTo(s * 7.0, -11.4, s * 1.6, -8.4);
      ctx.closePath();
      accPaint(ctx, "#ff3d3d", "#ffb0b0", 1.2);
    }
  } else if (kind === "halo") {
    const hy = -16.5 + Math.sin(t * 2.1) * 0.9;
    ctx.beginPath(); ctx.ellipse(0, hy, 7.4, 2.5, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffe27a"; ctx.lineWidth = 2.2; ctx.stroke();
  } else if (kind === "tophat") {
    ctx.beginPath(); ctx.rect(-11.5, -11.8, 23, 2.6); accPaint(ctx, "#15161f", "#7d87ad", 1.1);
    ctx.beginPath(); ctx.rect(-5.4, -24.8, 10.8, 13.4); accPaint(ctx, "#15161f", "#7d87ad", 1.1);
    ctx.beginPath(); ctx.rect(-5.4, -14.6, 10.8, 2.4); accPaint(ctx, "#ff2e88", null);
  } else if (kind === "cap") {
    ctx.beginPath(); ctx.ellipse(0, -8.4, 8.6, 7.2, 0, Math.PI, Math.PI * 2); ctx.closePath();
    accPaint(ctx, "#2e6bff", "#bcd2ff", 1.2);
    ctx.beginPath();
    ctx.moveTo(f * 1.5, -9);
    ctx.quadraticCurveTo(f * 10, -9.6, f * 13.2, -6.2);
    ctx.quadraticCurveTo(f * 9, -6.2, f * 1.5, -7);
    ctx.closePath();
    accPaint(ctx, "#1f4dc4", "#bcd2ff", 1.2);
    ctx.beginPath(); ctx.arc(0, -15.2, 1.5, 0, Math.PI * 2); accPaint(ctx, "#bcd2ff", null);
  } else if (kind === "crown") {
    ctx.beginPath();
    ctx.moveTo(-8.2, -6.4);
    ctx.lineTo(-8.8, -15.8); ctx.lineTo(-4.2, -12.2); ctx.lineTo(0, -18.6);
    ctx.lineTo(4.2, -12.2); ctx.lineTo(8.8, -15.8); ctx.lineTo(8.2, -6.4);
    ctx.quadraticCurveTo(0, -10.4, -8.2, -6.4);
    ctx.closePath();
    accPaint(ctx, "#ffc247", "#fff3c4", 1.2);
    ctx.beginPath(); ctx.arc(0, -9.2, 1.3, 0, Math.PI * 2); accPaint(ctx, "#ff2e88", null);
  } else if (kind === "poop") {
    ctx.beginPath(); ctx.ellipse(0, -11.4, 8.2, 3.6, 0, 0, Math.PI * 2); accPaint(ctx, "#7a4a24", "#b8834a", 1.2);
    ctx.beginPath(); ctx.ellipse(0.6, -15.4, 5.8, 3.1, 0, 0, Math.PI * 2); accPaint(ctx, "#8a5528", "#b8834a", 1.2);
    ctx.beginPath();
    ctx.moveTo(-3.2, -17.6);
    ctx.quadraticCurveTo(-1.2, -22.8, 2.8, -21.2);
    ctx.quadraticCurveTo(1.4, -18.4, 3.4, -17.4);
    ctx.closePath();
    accPaint(ctx, "#8a5528", "#b8834a", 1.2);
    ctx.beginPath();
    ctx.moveTo(-1.1, -15.6); ctx.arc(-2.4, -15.6, 1.3, 0, Math.PI * 2);
    ctx.moveTo(4.1, -15.6); ctx.arc(2.8, -15.6, 1.3, 0, Math.PI * 2);
    accPaint(ctx, "#f4f7ff", null);
    ctx.beginPath();
    ctx.moveTo(-2.4 + f * 0.5 + 0.6, -15.6); ctx.arc(-2.4 + f * 0.5, -15.6, 0.6, 0, Math.PI * 2);
    ctx.moveTo(2.8 + f * 0.5 + 0.6, -15.6); ctx.arc(2.8 + f * 0.5, -15.6, 0.6, 0, Math.PI * 2);
    accPaint(ctx, "#15161f", null);
  } else if (kind === "cowboy") {
    ctx.beginPath();
    ctx.moveTo(-14.4, -9.4);
    ctx.quadraticCurveTo(0, -14.4, 14.4, -9.4);
    ctx.quadraticCurveTo(0, -5.4, -14.4, -9.4);
    ctx.closePath();
    accPaint(ctx, "#8a5a2b", "#d8a566", 1.2);
    ctx.beginPath();
    ctx.moveTo(-6.4, -10.4);
    ctx.quadraticCurveTo(-7.6, -19.8, 0, -17.4);
    ctx.quadraticCurveTo(7.6, -19.8, 6.4, -10.4);
    ctx.closePath();
    accPaint(ctx, "#9c6832", "#d8a566", 1.2);
    ctx.beginPath(); ctx.rect(-6.5, -12.6, 13, 2.2); accPaint(ctx, "#4a2f16", null);
  } else if (kind === "party") {
    ctx.beginPath(); ctx.moveTo(-6.6, -8.2); ctx.lineTo(6.6, -8.2); ctx.lineTo(f * 3.4, -23.4); ctx.closePath();
    accPaint(ctx, "#ff2e88", "#ffd7ea", 1.2);
    ctx.beginPath();
    ctx.moveTo(f * 0.4 + 1.1, -13.4); ctx.arc(f * 0.4, -13.4, 1.1, 0, Math.PI * 2);
    ctx.moveTo(f * 2.2 + 0.9, -18.2); ctx.arc(f * 2.2, -18.2, 0.9, 0, Math.PI * 2);
    accPaint(ctx, "#ffe27a", null);
    ctx.beginPath(); ctx.arc(f * 3.4, -24.6, 2.3, 0, Math.PI * 2); accPaint(ctx, "#ffe27a", "#fff6cf", 1);
  } else if (kind === "bunny") {
    for (s = -1; s <= 1; s += 2) {
      ctx.save();
      ctx.translate(s * 3.2, -7.2);
      ctx.rotate(s * 0.2);
      ctx.beginPath(); ctx.ellipse(0, -9.4, 3.1, 9.8, 0, 0, Math.PI * 2); accPaint(ctx, "#f0f3ff", "#c3c9e6", 1.1);
      ctx.beginPath(); ctx.ellipse(0, -9.4, 1.4, 6.8, 0, 0, Math.PI * 2); accPaint(ctx, "#ff9ecb", null);
      ctx.restore();
    }
  } else if (kind === "antennae") {
    for (s = -1; s <= 1; s += 2) {
      ctx.strokeStyle = "#9dff4f";
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(s * 3.4, accHeadEdgeY(s * 3.4));
      ctx.quadraticCurveTo(s * 8.6, -14.4, s * 6.2, -19.4);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(s * 6.2, -21, 2.4, 0, Math.PI * 2); accPaint(ctx, "#9dff4f", "#e6ffd0", 1);
    }
  } else if (kind === "arrow") {
    const ay0 = -2.2, ay1 = -6.4;
    ctx.strokeStyle = "#b98a4a";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(f * -15.5, ay0); ctx.lineTo(f * 14.5, ay1); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(f * 20.6, ay1 - 0.7); ctx.lineTo(f * 13.4, ay1 - 3.8); ctx.lineTo(f * 13.8, ay1 + 2.8);
    ctx.closePath();
    accPaint(ctx, "#c9d2f0", "#f4f7ff", 1);
    ctx.strokeStyle = "#ff3d3d";
    ctx.lineWidth = 1.6;
    for (i = 0; i < 3; i++) {
      const px = f * (-15.2 + i * 2.6), py = ay0 - i * 0.35;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + f * 2.3, py - 3.6); ctx.stroke();
    }
  } else if (kind === "mohawk") {
    const mxs = [-6.6, -4.2, -1.6, 1.2, 3.8, 6.4];
    const mhs = [6.2, 9.6, 12.4, 11, 8.4, 5.4];
    ctx.beginPath();
    for (i = 0; i < mxs.length; i++) {
      ctx.moveTo(mxs[i] - 1.5, accHeadEdgeY(mxs[i] - 1.5));
      ctx.lineTo(mxs[i], accHeadEdgeY(mxs[i]) - mhs[i]);
      ctx.lineTo(mxs[i] + 1.5, accHeadEdgeY(mxs[i] + 1.5));
    }
    accPaint(ctx, "#ff2e88", "#ffd7ea", 1);
  } else if (kind === "flame") {
    const wob = Math.sin(t * 7.5), wob2 = Math.sin(t * 11.3 + 1.7) * 0.8;
    const fw = [7.2, 4.6, 2.3], fh = [17.6, 12.4, 7.2], fc = ["#ff5a2e", "#ffc247", "#fff2a8"];
    for (i = 0; i < 3; i++) {
      const tipX = wob * (1.6 + i * 0.7);
      ctx.beginPath();
      ctx.moveTo(-fw[i], -8);
      ctx.quadraticCurveTo(-fw[i] * 0.9 + wob2, -8 - fh[i] * 0.6, tipX, -8 - fh[i]);
      ctx.quadraticCurveTo(fw[i] * 0.9 + wob2, -8 - fh[i] * 0.6, fw[i], -8);
      ctx.closePath();
      ctx.fillStyle = fc[i];
      ctx.fill();
    }
  } else if (kind === "propeller") {
    ctx.beginPath(); ctx.ellipse(0, -8.2, 8.2, 7, 0, Math.PI, Math.PI * 2); ctx.closePath();
    accPaint(ctx, "#2e6bff", "#bcd2ff", 1.2);
    ctx.beginPath(); ctx.rect(-8.1, -9.6, 16.2, 1.8); accPaint(ctx, "#ff2e88", null);
    ctx.strokeStyle = "#bcd2ff";
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, -15.1); ctx.lineTo(0, -18.6); ctx.stroke();
    ctx.save();
    ctx.translate(0, -19.2);
    ctx.rotate(t * 7);
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath(); ctx.ellipse(s * 5, 0, 5, 1.5, 0, 0, Math.PI * 2); accPaint(ctx, "#ffc247", "#fff3c4", 1);
    }
    ctx.restore();
  } else if (kind === "orbit") {
    const ORBIT_N = 5, ORBIT_R = 13, ORBIT_COLORS = ["#ff2ed6", "#35f0e0"];
    for (i = 0; i < ORBIT_N; i++) {
      const oAng = t * 2.4 + (i / ORBIT_N) * Math.PI * 2;
      const ox = Math.cos(oAng) * ORBIT_R, oy = -17 + Math.sin(oAng) * ORBIT_R * 0.42;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(oAng);
      ctx.beginPath();
      ctx.moveTo(0, -3.2); ctx.lineTo(1.8, 0); ctx.lineTo(0, 3.2); ctx.lineTo(-1.8, 0);
      ctx.closePath();
      accPaint(ctx, ORBIT_COLORS[i % 2], "#ffffff", 0.8);
      ctx.restore();
    }
  }
  ctx.restore();
}

/* ================================================================ rig */
const NO_ANIM: RigAnim = {};

/**
 * Dibuja un cuadro del muñeco. `anim` persiste entre cuadros (resortes, blends); para fantasmas
 * de estela se pasa null y el rig queda sin inercia.
 */
export function drawStickman(ctx: Ctx, p: RenderPlayer, color: string, hat: string, anim: RigAnim | null, info?: RigInfo): { headY: number } {
  const A = anim || NO_ANIM;
  const springs = !!anim && !artCfg.low;
  const cx = p.x, feet = p.y;
  const running = p.grounded && p.vx !== 0;
  let scaleX = 1, scaleY = 1;
  if (!artCfg.low) {
    const squash = p.squash || 0;
    const stretch = !p.grounded ? clamp(Math.abs(p.vy) / 14, 0, 1) : 0;
    const jumpAntic = clamp((p.jumpAnticT || 0) / 90, 0, 1);
    const takeoffStretch = jumpAntic * Math.sin(jumpAntic * Math.PI);
    const squashWave = squash > 0 ? Math.sin(squash * Math.PI * 2.4) * squash * squash * 0.35 : 0;
    scaleY = 1 - squash * TUNE.squashScaleY + squashWave * TUNE.squashWaveScaleY + stretch * 0 + takeoffStretch * TUNE.takeoffScaleY;
    scaleX = 1 + squash * TUNE.squashScaleX - squashWave * TUNE.squashWaveScaleX - takeoffStretch * TUNE.takeoffScaleX;
    const actionPop = 1 + clamp(squash, 0, 1) * TUNE.actionPopSquash + clamp(takeoffStretch, 0, 1) * TUNE.actionPopStretch;
    scaleX *= actionPop; scaleY *= actionPop;
  }

  const phaseNow = p.walkCycle || 0;
  const runBob = running ? -Math.abs(Math.sin(phaseNow * Math.PI * 2)) * TUNE.runBob : 0;
  const idleActive = !artCfg.low && p.grounded && !running;
  const breathe = idleActive ? Math.sin(p.idleT * 1.1) * TUNE.breatheAmp : 0;
  const idleBob = idleActive ? Math.sin(p.idleT * 1.6) * TUNE.idleBobAmp + breathe * 0.6 : 0;
  const idleWeight = idleActive ? Math.sin(p.idleT * 0.35) : 0;
  const idleShoulderRot = idleActive ? Math.sin(p.idleT * 0.5 + 1.1) * TUNE.idleShoulderRotAmp : 0;
  const idleHeadTurn = idleActive ? Math.sin(p.idleT * 0.8 + 2.4) * TUNE.idleHeadTurnAmp : 0;
  const idleHandDrift = idleActive ? Math.sin(p.idleT * 1.3 + 0.6) * TUNE.idleHandDriftAmp : 0;

  const pelvisDrive = running && !artCfg.low ? Math.sin(phaseNow * Math.PI * 2 + Math.PI) * TUNE.pelvisDrive * p.facing : 0;
  const bodyH = 37 * scaleY;
  const hipY = feet - bodyH * 0.52 - runBob - idleBob;
  const hipX = cx + pelvisDrive + (idleActive ? Math.sin(p.idleT * 0.7) * TUNE.idleSwayX + idleWeight * TUNE.idleWeightSwayX : 0);

  const punching = !!p.attack && p.attack.type === "punch";
  const kicking = !!p.attack && p.attack.type === "kick";
  const attackDur = p.attack ? p.attack.dur || (kicking ? 280 : 140) : 1;
  const attackLin = p.attack ? clamp(1 - p.attack.t / attackDur, 0, 1) : 0;
  const snap = p.attack ? Math.sin(attackLin * Math.PI) : 0;

  let lean = 0;
  if (running) lean = p.facing * TUNE.runLean;
  else if (punching) lean = p.facing * (TUNE.punchLeanBase + snap * TUNE.punchLeanSnap);
  else if (kicking) lean = -p.facing * snap * TUNE.kickLeanSnap;
  else if (!p.grounded) lean = p.facing * clamp(p.vy / 9, -1, 1) * TUNE.airLeanMax;
  else lean = idleShoulderRot * TUNE.idleLeanMix;

  if (springs) {
    A.leanSpring = A.leanSpring == null ? lean : lerp(A.leanSpring, lean, TUNE.leanSpringK);
    lean = A.leanSpring;
  }

  const hitStun = clamp((p.hitStunT || 0) / 180, 0, 1);
  const hitKick = hitStun * Math.sin(hitStun * Math.PI);
  lean += -(p.hitDir || 1) * hitKick * TUNE.hitLean;

  let twist = 0;
  if (!artCfg.low) {
    if (running) twist = Math.sin(phaseNow * Math.PI * 2 + 0.6) * TUNE.runTwist;
    if (punching) twist += p.facing * snap * TUNE.punchTwist;
    else if (kicking) twist -= p.facing * snap * TUNE.kickTwist;
  }
  const shoulderLean = lean + twist;

  const shoulderY = hipY - bodyH * 0.5 + breathe * 0.5;
  const leanRad = lean * DEG;
  const shoulderRad = shoulderLean * DEG;
  const shoulderX = hipX + Math.sin(shoulderRad) * (hipY - shoulderY);
  const headLagPhase = running ? phaseNow - TUNE.headLagPhase : phaseNow;
  const headBob = running ? -Math.abs(Math.sin(headLagPhase * Math.PI * 2)) * TUNE.headBobRun : 0;
  const headLeanTarget = shoulderLean + (running ? twist * TUNE.headTwistRunMix : idleHeadTurn);
  let headLean: number;
  if (!springs) headLean = headLeanTarget;
  else {
    A.headSpring = A.headSpring == null ? headLeanTarget : lerp(A.headSpring, headLeanTarget, TUNE.headSpringK);
    headLean = A.headSpring;
  }
  const headRad = headLean * DEG;
  const headX = shoulderX + Math.sin(headRad) * 10 - (p.hitDir || 1) * hitKick * TUNE.hitHeadShift;
  const headY = shoulderY - 13 - headBob + idleBob * 0.3;

  if (info) {
    info.hipX = hipX; info.hipY = hipY; info.shoulderX = shoulderX; info.shoulderY = shoulderY;
    info.headX = headX; info.headY = headY; info.cx = cx; info.feet = feet; info.scaleX = scaleX;
  }

  const scaled = scaleX !== 1;
  if (scaled) {
    ctx.save();
    ctx.translate(cx, feet);
    ctx.scale(scaleX, 1);
    ctx.translate(-cx, -feet);
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let drawColor = color;
  if (p.burnT > 0) drawColor = POWER_COLORS.fuego;
  else if (p.slowT > 0) drawColor = POWER_COLORS.hielo;
  ctx.strokeStyle = drawColor;
  ctx.fillStyle = drawColor;

  if (!artCfg.low) {
    beginPowerAura(p);
    if (p.power && p.power.aire) {
      const auraMidY = (headY + feet) / 2 - 4, auraHalfH = (feet - headY) / 2 + 6;
      drawOrbitAura(ctx, hipX, auraMidY, 17, auraHalfH, p.idleT || 0, POWER_COLORS.aire);
      ctx.strokeStyle = drawColor; ctx.fillStyle = drawColor;
    }
  } else CURRENT_AURA = null;

  // transición entre familias de pose + inercia
  const idleTMs = (p.idleT || 0) * 1000;
  const frameDt = A.lastIdleTMs != null ? clamp(idleTMs - A.lastIdleTMs, 0, 60) : 16.6667;
  if (anim) A.lastIdleTMs = idleTMs;
  let strideAsym = A.strideAsym;
  if (strideAsym == null) {
    strideAsym = ((((p.id || 0) * 53 + 7) % 17) / 17) * TUNE.strideAsymAmt - TUNE.strideAsymAmt / 2;
    if (anim) A.strideAsym = strideAsym;
  }
  const stateKey = kicking ? "kick" : !p.grounded ? "air" : running ? "run" : punching ? "punch" : "idle";
  let blendFrac = 1;
  if (springs) {
    if (A.animState == null) A.animState = stateKey;
    if (stateKey !== A.animState) {
      A.animState = stateKey;
      A.blendT = TUNE.blendMs;
      A.blendFromLegA = A.lastLegA; A.blendFromLegB = A.lastLegB;
      A.blendFromArmA = A.lastArmA; A.blendFromArmB = A.lastArmB;
    }
    if ((A.blendT || 0) > 0) A.blendT = Math.max(0, A.blendT! - frameDt);
    blendFrac = (A.blendT || 0) > 0 ? smoothstep(1 - A.blendT! / TUNE.blendMs) : 1;
  }

  // ---- piernas
  let legBLower = SHIN;
  let legATarget: Pose, legBTarget: Pose;
  if (kicking) {
    legATarget = { ...STANCE.kickSupportLeg[0] };
    legBTarget = sampleTableOnce(KICK_LEG_KEYS, attackLin, easeOutQuad);
    legBLower = SHIN + 1;
  } else if (!p.grounded) {
    const tAirLeg = (clamp(p.vy / 9, -1, 1) + 1) / 2;
    legATarget = sampleTableOnce(JUMP_LEGA_KEYS, tAirLeg);
    legBTarget = sampleTableOnce(JUMP_LEGB_KEYS, tAirLeg);
  } else if (running) {
    legATarget = sampleTable(LEG_KEYS, phaseNow);
    legBTarget = sampleTable(LEG_KEYS, phaseNow + 0.5 + strideAsym);
  } else if (punching) {
    legATarget = { ...STANCE.punchLegs[0] };
    legBTarget = { ...STANCE.punchLegs[1] };
  } else {
    legATarget = { a: IDLE_LEGS[0].a + idleWeight * TUNE.idleWeightLegSpread, b: IDLE_LEGS[0].b };
    legBTarget = { a: IDLE_LEGS[1].a - idleWeight * TUNE.idleWeightLegSpread, b: IDLE_LEGS[1].b };
  }
  const legA = springs ? blendPose(A.blendFromLegA, legATarget, blendFrac) : legATarget;
  const legB = springs ? blendPose(A.blendFromLegB, legBTarget, blendFrac) : legBTarget;
  if (springs) { A.lastLegA = legA; A.lastLegB = legB; }
  limb(ctx, hipX, hipY, legA.a, legA.b, THIGH, SHIN, p.facing, 4.6, 3.4, false, true);
  limb(ctx, hipX, hipY, legB.a, legB.b, THIGH, legBLower, p.facing, 4.6, 3.4, false, true);

  // ---- torso
  ctx.lineWidth = 4.8;
  ctx.beginPath();
  ctx.moveTo(hipX, hipY);
  ctx.quadraticCurveTo(hipX + Math.sin(leanRad) * 6, (hipY + shoulderY) / 2, shoulderX, shoulderY);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(hipX, hipY, 2.1, 0, Math.PI * 2); ctx.fill();
  auraSegment(ctx, hipX, hipY, shoulderX, shoulderY, CURRENT_AURA);

  // ---- brazos
  let armBWidthB = 3.2, armADot = false, armBDot = false;
  let armATarget: Pose, armBTarget: Pose;
  if (punching) {
    armATarget = { ...STANCE.punchGuardArm[0] };
    armBTarget = sampleTableOnce(PUNCH_ARM_KEYS, attackLin, easeOutQuad);
    armBWidthB = 3.4; armBDot = true;
  } else if (kicking) {
    armATarget = { ...STANCE.kickArms[0] };
    armBTarget = { ...STANCE.kickArms[1] };
    armADot = true; armBDot = true;
  } else if (!p.grounded) {
    const tAirArm = (clamp(p.vy / 9, -1, 1) + 1) / 2;
    armATarget = sampleTableOnce(JUMP_ARMA_KEYS, tAirArm);
    armBTarget = sampleTableOnce(JUMP_ARMB_KEYS, tAirArm);
  } else if (running) {
    armATarget = sampleTable(ARM_KEYS, phaseNow + 0.5);
    armBTarget = sampleTable(ARM_KEYS, phaseNow + strideAsym);
  } else {
    const armSway = breathe * TUNE.armSwayAmp;
    armATarget = { a: IDLE_ARMS[0].a - armSway + idleHandDrift, b: IDLE_ARMS[0].b };
    armBTarget = { a: IDLE_ARMS[1].a + armSway - idleHandDrift, b: IDLE_ARMS[1].b };
  }
  const armA = springs ? blendPose(A.blendFromArmA, armATarget, blendFrac) : armATarget;
  const armB = springs ? blendPose(A.blendFromArmB, armBTarget, blendFrac) : armBTarget;
  if (springs) { A.lastArmA = armA; A.lastArmB = armB; }
  limb(ctx, shoulderX, shoulderY, armA.a, armA.b, UARM, FARM, p.facing, 4.2, 3.2, armADot, false);
  limb(ctx, shoulderX, shoulderY, armB.a, armB.b, UARM, FARM, p.facing, 4.2, armBWidthB, armBDot, false);

  // ---- cabeza
  ctx.lineWidth = 4.4;
  ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY); ctx.lineTo(headX, headY + 8); ctx.stroke();
  auraSegment(ctx, shoulderX, shoulderY, headX, headY + 8, CURRENT_AURA);
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.ellipse(headX, headY, HEAD_RX, HEAD_RY, 0, 0, Math.PI * 2); ctx.stroke();

  if (hat && hat !== "none") drawAccessory(ctx, hat, headX, headY, headLean, p.facing, p.idleT || 0);
  if (!artCfg.low) drawBurnFlash(ctx, p, hipX, (headY + feet) / 2 - 4, (feet - headY) / 2 + 6);
  CURRENT_AURA = null;
  if (scaled) ctx.restore();
  return { headY };
}

/* Sombreado de volumen (luz arriba, sombra abajo, brillo lateral) sobre el muñeco recién dibujado
   en un canvas limpio: "source-atop" solo tiñe los píxeles del trazo. */
export function drawStickShine(ctx: Ctx, info: RigInfo) {
  const scaleX = Math.abs(info.scaleX || 1);
  const halfW = 15 * scaleX + 14;
  const top = info.headY - 26;
  const bottom = info.feet + 14;
  const left = info.cx - halfW;
  const width = halfW * 2;
  const height = bottom - top;
  if (height <= 0 || width <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  const vert = ctx.createLinearGradient(0, top, 0, bottom);
  vert.addColorStop(0, "rgba(255,255,255,0)");
  vert.addColorStop(0.16, "rgba(255,255,255,.34)");
  vert.addColorStop(0.38, "rgba(255,255,255,.04)");
  vert.addColorStop(0.6, "rgba(0,0,0,0)");
  vert.addColorStop(0.86, "rgba(0,0,0,.26)");
  vert.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = vert;
  ctx.fillRect(left, top, width, height);
  const horiz = ctx.createLinearGradient(left, 0, left + width, 0);
  horiz.addColorStop(0, "rgba(255,255,255,0)");
  horiz.addColorStop(0.22, "rgba(255,255,255,.14)");
  horiz.addColorStop(0.45, "rgba(255,255,255,0)");
  horiz.addColorStop(0.65, "rgba(0,0,0,0)");
  horiz.addColorStop(0.84, "rgba(0,0,0,.16)");
  horiz.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = horiz;
  ctx.fillRect(left, top, width, height);
  ctx.restore();
}
