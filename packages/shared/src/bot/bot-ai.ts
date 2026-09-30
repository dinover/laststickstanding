/* IA de los NPC. Port directo de V1 (online/public/bot-ai.js): misma lógica, ahora como clase
   atada a una instancia de Sim en vez de globals.

   1. MODELO DEL MUNDO — predict() replica el integrador de stepPlayer con las mismas constantes:
      "si hago esto, ¿dónde termino?" se responde simulando. Así el bot sabe que el vacío existe.
   2. NAVEGACIÓN — por mapa se precalculan links (salto simple, doble o dejarse caer) entre
      plataformas; Dijkstra hacia atrás sobre links da la ruta.
   3. DECISIÓN + MOTOR — la decisión corre cada cfg.thinkMs con histéresis; el motor corre cada
      frame y nunca deja salir del tramo seguro, verifica cada salto antes de despegar y corrige
      en el aire. La dificultad cambia qué tan bien decide, nunca apaga la supervivencia. */

import { PHYS } from "../balance";
import { clamp, hash01 } from "../rng";
import type { Sim } from "../sim/sim";
import type { Player } from "../sim/types";
import type { Hazard, MapDef, Platform } from "../world/types";

export interface BotDifficulty {
  thinkMs: number; thinkJitter: number; reactMs: number;
  attackChance: number; whiffChance: number; whiffPx: number; kickMix: number;
  edgeSense: number; cornerSense: number; swapChance: number; dodgeChance: number;
  spacing: number; hopRate: number; pauseRate: number;
  routeNoise: number; takeoffNoise: number;
}

export type BotDifficultyId = "easy" | "medium" | "hard";

export const BOT_DIFFICULTY: Record<BotDifficultyId, BotDifficulty> = {
  easy: {
    thinkMs: 280, thinkJitter: 90, reactMs: 280,
    attackChance: 0.45, whiffChance: 0.2, whiffPx: 22, kickMix: 0.4,
    edgeSense: 0.35, cornerSense: 0.3, swapChance: 0, dodgeChance: 0,
    spacing: 30, hopRate: 0.05, pauseRate: 0.25, routeNoise: 0.6, takeoffNoise: 0.5,
  },
  medium: {
    thinkMs: 160, thinkJitter: 50, reactMs: 130,
    attackChance: 0.7, whiffChance: 0.07, whiffPx: 14, kickMix: 0.25,
    edgeSense: 0.75, cornerSense: 0.7, swapChance: 0.35, dodgeChance: 0.2,
    spacing: 28, hopRate: 0.08, pauseRate: 0.08, routeNoise: 0.25, takeoffNoise: 0.25,
  },
  hard: {
    thinkMs: 85, thinkJitter: 25, reactMs: 45,
    attackChance: 0.92, whiffChance: 0, whiffPx: 0, kickMix: 0.2,
    edgeSense: 1, cornerSense: 1, swapChance: 0.6, dodgeChance: 0.45,
    spacing: 26, hopRate: 0.1, pauseRate: 0, routeNoise: 0.05, takeoffNoise: 0.08,
  },
};

const PREDICT_MAX_FRAMES = 240;
const EDGE_STOP = 3;
const COMFORT_INSET = 14;
const GUARD_INSET = 20;
const TAKEOFF_STEP = 6;
const MAX_LINK_GAP = 480;
const KIND_PENALTY = { jump: 0, drop: 4, double: 22 } as const;
const HOP_COST = 18;
const STUCK_MS = 2400, BAN_MS = 6000;
const JUMP_COOLDOWN_MS = 260;
const SWAP_COOLDOWN_MS = 4000;
const FEINT_GAP_MS = 3000;
const RESCUE_EVERY_MS = 45;

const C = {
  SPEED: PHYS.SPEED, JUMP_V: PHYS.JUMP_V, GU: PHYS.GRAVITY_UP, GD: PHYS.GRAVITY_DOWN, JUMP_V2: PHYS.JUMP_V2,
  MAX_JUMPS: PHYS.MAX_JUMPS, PW: PHYS.PW, W: PHYS.W, H: PHYS.H,
  AIR_MULT: PHYS.AIR_SPEED_MULT, SLOW_MULT: PHYS.SLOW_MULT, KB_DECAY: PHYS.KB_DECAY,
  KB_SUM: PHYS.KB_DECAY / (1 - PHYS.KB_DECAY),
  MAX_RISE: (PHYS.JUMP_V * PHYS.JUMP_V) / (2 * PHYS.GRAVITY_UP) + (PHYS.JUMP_V2 * PHYS.JUMP_V2) / (2 * PHYS.GRAVITY_UP),
};

type LinkKind = "jump" | "double" | "drop";
interface Link {
  from: number; to: number; kind: LinkKind; side: number;
  lo: number; hi: number; width: number; air: number; landX: number; idx: number;
}
interface Span { lo: number; hi: number; ok: boolean }
interface Aim { lo: number; hi: number }
interface MapInfo {
  plats: Platform[]; hazards: Hazard[]; sig: number; id: number;
  spans: Span[]; aims: (Aim | null)[]; links: Link[][]; all: Link[]; into: number[][];
}
interface SimState { x: number; y: number; vy: number; kbx: number; jumps: number; stunMs: number; slowMs: number; airMs: number }
interface Policy {
  aimLo?: number; aimHi?: number; dir?: number; holdDir?: number; holdUntilY?: number;
  jumpNow?: boolean; jumpAtApex?: boolean; rose?: boolean;
}
interface PredictResult { plat: number; x: number; frames: number; dead: boolean; solid: boolean }
interface AirPlan {
  target: number; aimLo: number; aimHi: number; holdDir?: number; holdUntilY?: number;
  jumpAtApex: boolean; rose: boolean; rescue: boolean;
}
type Intent =
  | { kind: "idle"; goalX?: number }
  | { kind: "hold" | "guard" | "chase"; goalX: number }
  | { kind: "navigate"; goalX?: undefined }
  | { kind: "hop"; aimLo: number; aimHi: number; until: number; goalX?: undefined };
interface MotorOut { dir: number; jump: boolean; attack: "punch" | "kick" | null }
interface TargetInfo { plat: number; x: number; y: number; offstage: boolean }

interface BotState {
  t: number; thinkT: number; dtEma: number; mapId: number;
  intent: Intent; link: Link | null; takeoffX: number | null; verifyFails: number; dropOk: boolean;
  air: AirPlan | null; rescueT: number; rescueDir: number;
  id: number; cfg: BotDifficulty; objPlat: number; V: number[] | null; holding: boolean; holdPlat: number; lastTargetPlat: number;
  banned: Record<string, number>; lastJumpT: number; landT: number; wasGrounded: boolean;
  reactUntil: number; lastStun: number; lastDir: number;
  pendingAttack: { type: "punch" | "kick"; until: number } | null; pauseUntil: number; flipUntil: number; flipSide: number; side: number; lastSwapT: number;
  progressKey: string; bestProgress: number; progressT: number;
  state: string; errorLogged: boolean;
}

function perThink(ratePerSec: number, cfg: BotDifficulty): number {
  return 1 - Math.exp((-ratePerSec * cfg.thinkMs) / 1000);
}
function sign(v: number): number { return v > 0 ? 1 : v < 0 ? -1 : 0; }
function speedOf(p: Player): number {
  return C.SPEED * (p.power && p.power.aire ? C.AIR_MULT : 1) * (p.slowT > 0 ? C.SLOW_MULT : 1);
}
function stateOf(p: Player): SimState {
  return {
    x: p.x, y: p.y, vy: p.vy || 0, kbx: p.kbx || 0, jumps: p.jumpsLeft,
    stunMs: p.hitStunT || 0, slowMs: p.slowT || 0, airMs: p.power && p.power.aire ? p.power.t : 0,
  };
}
function hazardAt(hz: Hazard[], x: number, y: number, PW: number): boolean {
  for (const h of hz) if (x + PW > h.x && x - PW < h.x + h.w && y >= h.y - 4 && y <= h.y + 6) return true;
  return false;
}
function groundState(x: number, y: number): SimState {
  return { x, y, vy: 0, kbx: 0, jumps: C.MAX_JUMPS, stunMs: 0, slowMs: 0, airMs: 0 };
}
function distToInterval(x: number, lo: number, hi: number): number { return x < lo ? lo - x : x > hi ? x - hi : 0; }
function aimDir(x: number, lo: number, hi: number): number { return x < lo ? 1 : x > hi ? -1 : 0; }
function gapX(a: Platform, b: Platform): number {
  if (a.x + a.w < b.x) return b.x - (a.x + a.w);
  if (b.x + b.w < a.x) return a.x - (b.x + b.w);
  return 0;
}

/* Simula frame a frame desde `s` con la política `pol` hasta aterrizar, morir o agotar frames. */
function predict(s: SimState, pol: Policy, info: MapInfo, dts: number): PredictResult {
  const plats = info.plats, hz = info.hazards, PW = C.PW;
  let x = s.x, y = s.y, vy = s.vy, kbx = s.kbx, jumps = s.jumps;
  let stun = s.stunMs, slow = s.slowMs, airP = s.airMs;
  const dtMs = dts * 16.6667, decay = Math.pow(C.KB_DECAY, dts);
  let jumpReq = !!pol.jumpNow, apex = !!pol.jumpAtApex, rose = !!pol.rose || vy < 0;
  const hasAim = pol.aimLo != null;
  for (let f = 1; f <= PREDICT_MAX_FRAMES; f++) {
    if (apex && rose && vy >= 0 && !jumpReq) { jumpReq = true; apex = false; }
    let dir: number;
    if (pol.holdDir && y <= pol.holdUntilY!) dir = pol.holdDir;
    else if (hasAim) dir = x < pol.aimLo! ? 1 : x > pol.aimHi! ? -1 : 0;
    else dir = pol.dir || 0;
    const spd = C.SPEED * (airP > 0 ? C.AIR_MULT : 1) * (slow > 0 ? C.SLOW_MULT : 1);
    const vx = stun > 0 ? 0 : dir * spd;
    if (jumpReq && jumps > 0) { vy = jumps === C.MAX_JUMPS ? C.JUMP_V : C.JUMP_V2; jumps--; rose = true; }
    jumpReq = false;
    vy += (vy < 0 ? C.GU : C.GD) * dts;
    const prevY = y;
    y += vy * dts;
    kbx *= decay;
    if (Math.abs(kbx) < 0.05) kbx = 0;
    x += (vx + kbx) * dts;
    if (x < 14) x = 14; else if (x > C.W - 14) x = C.W - 14;
    stun -= dtMs; slow -= dtMs; airP -= dtMs;
    if (vy >= 0) {
      for (let i = 0; i < plats.length; i++) {
        const pl = plats[i];
        if (prevY <= pl.y + 1 && y >= pl.y && x + PW > pl.x && x - PW < pl.x + pl.w) {
          return { plat: i, x, frames: f, dead: hazardAt(hz, x, pl.y, PW), solid: x >= pl.x && x <= pl.x + pl.w };
        }
      }
    }
    if (y > C.H + 60) return { plat: -1, x, frames: f, dead: true, solid: false };
    if (hz.length && hazardAt(hz, x, y, PW)) return { plat: -1, x, frames: f, dead: true, solid: false };
  }
  return { plat: -1, x, frames: PREDICT_MAX_FRAMES, dead: false, solid: false };
}

function landsOn(r: PredictResult, plat: number): boolean { return r.plat === plat && !r.dead; }

function platUnder(p: Player, plats: Platform[]): number {
  if (!p.grounded) return -1;
  for (let i = 0; i < plats.length; i++) {
    const pl = plats[i];
    if (Math.abs(pl.y - p.y) < 1 && p.x + C.PW > pl.x && p.x - C.PW < pl.x + pl.w) return i;
  }
  return -1;
}

function safeSpan(pl: Platform, hz: Hazard[]): Span {
  let lo = pl.x + EDGE_STOP, hi = pl.x + pl.w - EDGE_STOP;
  for (const h of hz) {
    if (pl.y < h.y - 4 || pl.y > h.y + 6) continue;
    const bLo = h.x - C.PW - 4, bHi = h.x + h.w + C.PW + 4;
    if (bHi <= lo || bLo >= hi) continue;
    if (bLo - lo >= hi - bHi) hi = Math.min(hi, bLo); else lo = Math.max(lo, bHi);
  }
  return { lo, hi, ok: hi - lo >= 4 };
}

function aimOf(sp: Span): Aim | null {
  if (!sp.ok) return null;
  const inset = Math.min(22, (sp.hi - sp.lo) * 0.3);
  return { lo: sp.lo + inset, hi: sp.hi - inset };
}

function jumpRuns(info: MapInfo, a: number, b: number, dbl: boolean): Link[] {
  const A = info.plats[a], sa = info.spans[a], aim = info.aims[b]!;
  const xs: number[] = [];
  for (let x = sa.lo; x < sa.hi; x += TAKEOFF_STEP) xs.push(x);
  xs.push(sa.hi);
  const out: Link[] = [];
  let start = -1;
  const frames: number[] = [], lands: number[] = [];
  for (let i = 0; i <= xs.length; i++) {
    let ok = false;
    if (i < xs.length) {
      const r = predict(groundState(xs[i], A.y), { aimLo: aim.lo, aimHi: aim.hi, jumpNow: true, jumpAtApex: dbl }, info, 1);
      ok = landsOn(r, b) && r.solid;
      frames[i] = r.frames;
      lands[i] = r.x;
    }
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      const mid = (start + i - 1) >> 1;
      out.push({
        from: a, to: b, kind: dbl ? "double" : "jump", side: 0,
        lo: xs[start], hi: xs[i - 1], width: xs[i - 1] - xs[start], air: frames[mid], landX: lands[mid], idx: -1,
      });
      start = -1;
    }
  }
  return out;
}

function dropLink(info: MapInfo, a: number, b: number, side: number): Link | null {
  const A = info.plats[a], sa = info.spans[a], aim = info.aims[b]!;
  if (side < 0 ? sa.lo > A.x + EDGE_STOP + 0.5 : sa.hi < A.x + A.w - EDGE_STOP - 0.5) return null;
  const fx = side < 0 ? A.x - C.PW - 0.5 : A.x + A.w + C.PW + 0.5;
  const r = predict(groundState(fx, A.y), { aimLo: aim.lo, aimHi: aim.hi, holdDir: side, holdUntilY: A.y + 2 }, info, 1);
  if (!landsOn(r, b) || !r.solid) return null;
  const edge = side < 0 ? sa.lo : sa.hi;
  return { from: a, to: b, kind: "drop", side, lo: edge, hi: edge, width: 30, air: r.frames, landX: r.x, idx: -1 };
}

function buildLinks(info: MapInfo): Link[][] {
  const plats = info.plats, n = plats.length, links: Link[][] = [];
  for (let a = 0; a < n; a++) {
    const out: Link[] = [];
    links.push(out);
    if (!info.spans[a].ok) continue;
    for (let b = 0; b < n; b++) {
      if (b === a || !info.spans[b].ok) continue;
      const A = plats[a], B = plats[b];
      if (A.y - B.y > C.MAX_RISE + 6 || gapX(A, B) > MAX_LINK_GAP) continue;
      const singles = jumpRuns(info, a, b, false);
      const wideSingle = singles.some((L) => L.width >= 24);
      out.push(...singles);
      if (!wideSingle) out.push(...jumpRuns(info, a, b, true));
      if (B.y > A.y + 4) {
        const dl = dropLink(info, a, b, -1), dr = dropLink(info, a, b, 1);
        if (dl) out.push(dl);
        if (dr) out.push(dr);
      }
    }
  }
  return links;
}

function mapSignature(plats: Platform[], hz: Hazard[]): number {
  let s = plats.length * 7919 + hz.length * 104729;
  plats.forEach((p, i) => { s += p.x * 3 + p.y * 5 + p.w * 7 + i; });
  for (const h of hz) s += h.x * 11 + h.y * 13 + h.w * 17;
  return s;
}

function linkKey(L: Link): string { return L.from + ">" + L.to + ":" + L.kind + ":" + Math.round(L.lo) + ":" + L.side; }
function isBanned(st: BotState, L: Link): boolean { const u = st.banned[linkKey(L)]; return u !== undefined && u > st.t; }

function linkCost(L: Link, id: number, cfg: BotDifficulty): number {
  const risk = L.width >= 30 ? 0 : (30 - L.width) * 1.1;
  const kindN = L.kind === "double" ? 3 : L.kind === "drop" ? 6 + L.side : 0;
  const noise = 1 + cfg.routeNoise * hash01(id * 7919 + L.from * 131 + L.to * 17 + kindN + Math.round(L.lo));
  return (L.air + KIND_PENALTY[L.kind] + risk + HOP_COST) * noise;
}

function walkFrames(x: number, L: Link, info: MapInfo): number {
  const d = L.kind === "drop"
    ? Math.abs(x - (L.side < 0 ? info.spans[L.from].lo : info.spans[L.from].hi))
    : distToInterval(x, L.lo, L.hi);
  return d / C.SPEED;
}

/* Costo (en frames) de llegar a `goal` después de tomar cada link: Dijkstra hacia atrás sobre
   links, así cuenta lo que se camina en cada plataforma intermedia. */
function linkValues(info: MapInfo, goal: number, st: BotState, id: number, cfg: BotDifficulty): number[] {
  const all = info.all, n = all.length, V: number[] = [], done: boolean[] = [];
  for (let i = 0; i < n; i++) { V.push(all[i].to === goal && !isBanned(st, all[i]) ? 0 : Infinity); done.push(false); }
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let k = 0; k < n; k++) if (!done[k] && V[k] < Infinity && (u < 0 || V[k] < V[u])) u = k;
    if (u < 0) break;
    done[u] = true;
    const M = all[u], through = linkCost(M, id, cfg) + V[u];
    for (const pi of info.into[M.from]) {
      const J = all[pi];
      if (done[J.idx] || J.to === goal || isBanned(st, J)) continue;
      const d = walkFrames(J.landX, M, info) + through;
      if (d < V[J.idx]) V[J.idx] = d;
    }
  }
  return V;
}

function costFrom(st: BotState, info: MapInfo, p: number, x: number): number {
  if (!st.V || p < 0) return Infinity;
  if (p === st.objPlat) return 0;
  let best = Infinity;
  for (const L of info.links[p]) {
    if (isBanned(st, L) || !(st.V[L.idx] < Infinity)) continue;
    const c = walkFrames(x, L, info) + linkCost(L, st.id, st.cfg) + st.V[L.idx];
    if (c < best) best = c;
  }
  return best;
}

function reachableFrom(info: MapInfo, from: number, st: BotState): boolean[] {
  const seen = info.plats.map(() => false);
  const stack = [from];
  seen[from] = true;
  while (stack.length) {
    const u = stack.pop()!;
    for (const L of info.links[u]) if (!seen[L.to] && !isBanned(st, L)) { seen[L.to] = true; stack.push(L.to); }
  }
  return seen;
}

function chooseLink(st: BotState, info: MapInfo, P: number, x: number): Link | null {
  let best: Link | null = null, bestCost = Infinity, curCost = Infinity;
  for (const L of info.links[P]) {
    if (isBanned(st, L) || !(st.V![L.idx] < Infinity)) continue;
    const cost = walkFrames(x, L, info) + linkCost(L, st.id, st.cfg) + st.V![L.idx];
    if (cost < bestCost) { bestCost = cost; best = L; }
    if (L === st.link) curCost = cost;
  }
  if (st.link && curCost <= bestCost * 1.2 + 6) return st.link;
  return best;
}

function pickTakeoff(L: Link, x: number, cfg: BotDifficulty): number | null {
  if (L.kind === "drop") return null;
  const margin = Math.min(L.width / 2, 10);
  let t = clamp(x, L.lo + margin, L.hi - margin);
  t += (Math.random() - 0.5) * L.width * cfg.takeoffNoise;
  return clamp(t, L.lo, L.hi);
}

function pickHoldPlat(st: BotState, info: MapInfo, P: number, tgt: TargetInfo): number {
  const reach = reachableFrom(info, P, st);
  let best = P, bestScore = Infinity, curScore = Infinity;
  for (let i = 0; i < info.plats.length; i++) {
    if (!reach[i] || !info.spans[i].ok) continue;
    const sp = info.spans[i];
    const nx = clamp(tgt.x, sp.lo, sp.hi);
    const score = Math.abs(nx - tgt.x) + Math.abs(info.plats[i].y - tgt.y) * 0.6 + (i === P ? 0 : 40);
    if (score < bestScore) { bestScore = score; best = i; }
    if (i === st.holdPlat) curScore = score;
  }
  if (st.holdPlat >= 0 && st.holdPlat < reach.length && reach[st.holdPlat] && curScore <= bestScore + 40) best = st.holdPlat;
  st.holdPlat = best;
  return best;
}

function clampToSpan(x: number, info: MapInfo, P: number, inset: number): number {
  const sp = info.spans[P];
  const lo = sp.lo + inset, hi = sp.hi - inset;
  if (lo > hi) return (sp.lo + sp.hi) / 2;
  return clamp(x, lo, hi);
}

function newState(): BotState {
  return {
    t: 0, thinkT: 0, dtEma: 16.6667, mapId: 0,
    intent: { kind: "idle" }, link: null, takeoffX: null, verifyFails: 0, dropOk: false,
    air: null, rescueT: -1e9, rescueDir: 0,
    id: 0, cfg: BOT_DIFFICULTY.medium, objPlat: -1, V: null, holding: false, holdPlat: -1, lastTargetPlat: -1,
    banned: {}, lastJumpT: -1e9, landT: 0, wasGrounded: false,
    reactUntil: 0, lastStun: 0, lastDir: 0,
    pendingAttack: null, pauseUntil: 0, flipUntil: 0, flipSide: 0, side: 1, lastSwapT: -1e9,
    progressKey: "", bestProgress: Infinity, progressT: 0,
    state: "IDLE", errorLogged: false,
  };
}

function resetNav(st: BotState, mapId: number): void {
  st.mapId = mapId;
  st.intent = { kind: "idle" }; st.link = null; st.takeoffX = null; st.air = null;
  st.objPlat = -1; st.V = null; st.holdPlat = -1; st.lastTargetPlat = -1;
  st.banned = {}; st.progressKey = ""; st.pendingAttack = null;
}

function failLink(st: BotState, L: Link): void {
  st.banned[linkKey(L)] = st.t + BAN_MS;
  st.link = null; st.takeoffX = null;
  st.intent = { kind: "idle" };
  st.thinkT = 0;
}

export class BotAI {
  private states: Record<number, BotState> = {};
  private mapInfo: MapInfo | null = null;
  private mapSerial = 0;

  constructor(private sim: Sim) {}

  reset(): void {
    this.states = {};
  }

  private getState(id: number): BotState {
    return this.states[id] || (this.states[id] = newState());
  }

  private getMapInfo(map: MapDef): MapInfo {
    const plats = map.platforms, hz = map.hazards || [];
    const sig = mapSignature(plats, hz);
    if (this.mapInfo && this.mapInfo.plats === plats && this.mapInfo.sig === sig) return this.mapInfo;
    const info: MapInfo = { plats, hazards: hz, sig, id: ++this.mapSerial, spans: [], aims: [], links: [], all: [], into: [] };
    for (const pl of plats) {
      const sp = safeSpan(pl, hz);
      info.spans.push(sp);
      info.aims.push(aimOf(sp));
    }
    info.links = buildLinks(info);
    for (let p = 0; p < plats.length; p++) info.into.push([]);
    for (const ls of info.links) for (const L of ls) { L.idx = info.all.length; info.all.push(L); info.into[L.to].push(L.idx); }
    this.mapInfo = info;
    return info;
  }

  private targetInfo(me: Player, info: MapInfo): TargetInfo {
    if (me.grounded) return { plat: platUnder(me, info.plats), x: me.x, y: me.y, offstage: false };
    const inp = me.input || { left: false, right: false };
    const dir = inp.left && !inp.right ? -1 : inp.right && !inp.left ? 1 : 0;
    const r = predict(stateOf(me), { dir }, info, 1);
    if (r.plat >= 0 && landsOn(r, r.plat)) return { plat: r.plat, x: r.x, y: info.plats[r.plat].y, offstage: false };
    return { plat: -1, x: me.x, y: me.y, offstage: !!r.dead };
  }

  private allyAhead(ai: Player, tgt: TargetInfo, side: number): boolean {
    const myD = (ai.x - tgt.x) * side;
    for (const k in this.sim.players) {
      const o = this.sim.players[k];
      if (!o || o === ai || !o.alive || !o.isBot || Math.abs(o.y - ai.y) > 4) continue;
      const d = (o.x - tgt.x) * side;
      if (d > 0 && d < myD) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- decisión */
  private think(id: number, st: BotState, ai: Player, me: Player | null, info: MapInfo, cfg: BotDifficulty): void {
    if (st.pendingAttack && st.pendingAttack.until <= st.t) st.pendingAttack = null;
    const P = platUnder(ai, info.plats);

    if (!me) {
      st.objPlat = -1; st.V = null; st.link = null;
      st.intent = P >= 0 ? { kind: "idle", goalX: clampToSpan(ai.x, info, P, COMFORT_INSET) } : { kind: "idle" };
      if (P >= 0) st.state = "IDLE";
      return;
    }

    const tgt = this.targetInfo(me, info);
    let objPlat = tgt.plat >= 0 ? tgt.plat : st.lastTargetPlat;
    if (tgt.plat >= 0) st.lastTargetPlat = tgt.plat;
    if (objPlat >= info.plats.length) objPlat = -1;
    st.objPlat = objPlat;
    st.V = objPlat >= 0 ? linkValues(info, objPlat, st, id, cfg) : null;
    st.holding = false;
    if (st.V && P >= 0 && !(costFrom(st, info, P, ai.x) < Infinity)) {
      const hp = pickHoldPlat(st, info, P, tgt);
      st.holding = true;
      if (hp !== objPlat) { objPlat = st.objPlat = hp; st.V = linkValues(info, hp, st, id, cfg); }
    }

    this.considerAttack(st, ai, me, info, cfg, tgt);

    if (P < 0) { st.state = st.air && st.air.rescue ? "RECOVER" : "IN_AIR"; return; }

    if (tgt.offstage) {
      st.intent = { kind: "guard", goalX: clampToSpan(me.x, info, P, GUARD_INSET) };
      st.state = "EDGE_GUARD";
    } else if (objPlat < 0 || (objPlat === P && st.holding)) {
      st.intent = { kind: "hold", goalX: clampToSpan(tgt.x, info, P, COMFORT_INSET) };
      st.state = "HOLD";
    } else if (objPlat === P) {
      this.combatIntent(st, ai, me, tgt, P, info, cfg);
    } else {
      const L = chooseLink(st, info, P, ai.x);
      if (L) {
        if (L !== st.link) { st.link = L; st.takeoffX = pickTakeoff(L, ai.x, cfg); st.verifyFails = 0; st.dropOk = false; }
        st.intent = { kind: "navigate" };
        st.state = "NAVIGATE";
      } else {
        st.intent = { kind: "hold", goalX: clampToSpan(tgt.x, info, P, COMFORT_INSET) };
        st.state = "HOLD";
      }
    }
    if (st.intent.kind !== "navigate") st.link = null;
    this.watchProgress(st, ai, info, P);
  }

  private combatIntent(st: BotState, ai: Player, me: Player, tgt: TargetInfo, P: number, info: MapInfo, cfg: BotDifficulty): void {
    const A = this.sim.attacks, pl = info.plats[P];
    const dx = tgt.x - ai.x, adx = Math.abs(dx);
    let side = adx > 6 ? (dx < 0 ? 1 : -1) : st.side;
    if (st.flipUntil > st.t) side = st.flipSide;
    st.side = side;

    const kickPush = A.kick.kbX * C.KB_SUM + A.kick.reach;
    const targetRoom = side > 0 ? tgt.x - (pl.x - C.PW) : pl.x + pl.w + C.PW - tgt.x;
    const myRoom = side > 0 ? pl.x + pl.w + C.PW - ai.x : ai.x - (pl.x - C.PW);

    let spacing = cfg.spacing;
    if (this.allyAhead(ai, tgt, side)) spacing += 38;

    const threatened = me.facing === side && adx < A.kick.reach + 40;
    const cornered = threatened && myRoom < kickPush * 0.6 && targetRoom > myRoom + 40;
    if (cornered && Math.random() < cfg.cornerSense) {
      if (Math.random() < cfg.swapChance && st.t - st.lastSwapT > SWAP_COOLDOWN_MS) {
        const land = tgt.x - side * 60;
        const sp = info.spans[P];
        if (land - 14 >= sp.lo + COMFORT_INSET && land + 14 <= sp.hi - COMFORT_INSET) {
          st.lastSwapT = st.t;
          st.intent = { kind: "hop", aimLo: land - 14, aimHi: land + 14, until: st.t + 300 };
          st.state = "REPOSITION";
          return;
        }
      }
      spacing = Math.min(spacing, 16);
    }
    if (targetRoom < kickPush && Math.random() < cfg.edgeSense) spacing = Math.min(spacing, A.kick.reach - 14);

    let goal: number;
    if (me.attack && me.facing === side && adx < A.kick.reach + 16 && ai.attackCooldown > 80 &&
        myRoom > kickPush && Math.random() < cfg.dodgeChance) {
      goal = ai.x + side * 40;
      st.state = "RETREAT";
    } else if (st.pauseUntil > st.t) {
      goal = ai.x;
      st.state = "CHASE";
    } else if (adx > 120 && Math.random() < perThink(cfg.pauseRate, cfg)) {
      st.pauseUntil = st.t + 250 + Math.random() * 350;
      goal = ai.x;
      st.state = "CHASE";
    } else {
      goal = tgt.x + side * spacing;
      st.state = adx <= A.kick.reach + 6 ? "ATTACK" : "CHASE";
      if (adx > 110 && st.t - st.lastJumpT > FEINT_GAP_MS && Math.random() < perThink(cfg.hopRate, cfg)) {
        const hx = ai.x - side * 70;
        st.intent = { kind: "hop", aimLo: hx - 12, aimHi: hx + 12, until: st.t + 200 };
        return;
      }
    }
    st.intent = { kind: "chase", goalX: clampToSpan(goal, info, P, COMFORT_INSET) };
  }

  private considerAttack(st: BotState, ai: Player, me: Player, info: MapInfo, cfg: BotDifficulty, tgt: TargetInfo): void {
    if (ai.attack || ai.attackCooldown > 90 || st.pendingAttack || st.t < st.reactUntil) return;
    const A = this.sim.attacks;
    const dx = me.x - ai.x, adx = Math.abs(dx);
    if (Math.abs(me.y - ai.y - 10) >= 56) return;
    const slack = Math.random() < cfg.whiffChance ? cfg.whiffPx : 0;
    if (adx > A.kick.reach - 4 + slack) return;
    if (Math.random() > cfg.attackChance) return;

    const pl = me.grounded && tgt.plat >= 0 ? info.plats[tgt.plat] : null;
    let nearEdge = true;
    if (pl) {
      const room = dx > 0 ? pl.x + pl.w + C.PW - me.x : me.x - (pl.x - C.PW);
      nearEdge = room < A.kick.kbX * C.KB_SUM + 24;
    }
    let type: "punch" | "kick";
    if (adx > A.punch.reach - 3) type = "kick";
    else if (nearEdge && Math.random() < cfg.edgeSense) type = "kick";
    else type = Math.random() < cfg.kickMix ? "kick" : "punch";
    st.pendingAttack = { type, until: st.t + 240 };
  }

  private watchProgress(st: BotState, ai: Player, info: MapInfo, P: number): void {
    const it = st.intent;
    let metric: number;
    const key = it.kind + ":" + (st.link ? linkKey(st.link) : "") + ":" + st.objPlat;
    if (it.kind === "navigate") {
      const cf = costFrom(st, info, P, ai.x);
      metric = cf < Infinity ? cf * 10 : 0;
    } else if (it.goalX != null) {
      const gap = Math.abs(ai.x - it.goalX);
      metric = gap <= 8 ? -1 : gap;
    } else metric = -1;

    if (key !== st.progressKey || metric < 0) {
      st.progressKey = key; st.bestProgress = metric < 0 ? Infinity : metric; st.progressT = st.t;
      return;
    }
    if (metric < st.bestProgress - 3) { st.bestProgress = metric; st.progressT = st.t; return; }
    if (st.t - st.progressT < STUCK_MS) return;

    st.progressT = st.t; st.bestProgress = Infinity;
    if (it.kind === "navigate" && st.link) failLink(st, st.link);
    else if (it.kind === "chase") { st.flipSide = -st.side; st.flipUntil = st.t + 2500; }
    st.state = "UNSTUCK";
  }

  /* ---------------------------------------------------------------- motor en el piso */
  private seek(x: number, goal: number, st: BotState, dead: number): number {
    const d = goal - x;
    if (st.lastDir !== 0 && sign(d) === st.lastDir && Math.abs(d) > 1.5) return st.lastDir;
    if (Math.abs(d) <= dead) return 0;
    return sign(d);
  }

  private standableElsewhere(info: MapInfo, P: number, x: number, y: number): boolean {
    for (let i = 0; i < info.plats.length; i++) {
      if (i === P || Math.abs(info.plats[i].y - y) >= 1) continue;
      const sp = info.spans[i];
      if (sp.ok && x >= sp.lo && x <= sp.hi) return true;
    }
    return false;
  }

  /* La regla que ninguna dificultad puede saltearse: un paso que saca el centro del cuerpo del
     tramo seguro no se da (salvo la salida autorizada por un drop/salto ya verificado). */
  private groundSafeDir(st: BotState, ai: Player, info: MapInfo, P: number, dir: number, dts: number, allowSide: number): number {
    if (!dir || dir === allowSide || P < 0) return dir;
    const sp = info.spans[P];
    const nx = ai.x + (dir * speedOf(ai) + (ai.kbx || 0)) * dts;
    if (sp.ok && nx >= sp.lo && nx <= sp.hi) return dir;
    if ((dir > 0 && ai.x < sp.lo) || (dir < 0 && ai.x > sp.hi)) return dir;
    if (this.standableElsewhere(info, P, nx, info.plats[P].y)) return dir;
    st.state = "AVOID_FALL";
    return 0;
  }

  private knockbackCounter(st: BotState, ai: Player, info: MapInfo, P: number): number {
    const kb = ai.kbx || 0;
    if (Math.abs(kb) < 0.3 || ai.hitStunT > 0) return 0;
    const sp = info.spans[P];
    const fx = ai.x + kb * C.KB_SUM;
    if (fx >= sp.lo && fx <= sp.hi) return 0;
    if (this.standableElsewhere(info, P, fx, info.plats[P].y)) return 0;
    st.state = "AVOID_FALL";
    return kb > 0 ? -1 : 1;
  }

  private navStep(st: BotState, ai: Player, info: MapInfo, dts: number, P: number, out: MotorOut): void {
    const L = st.link!, aim = info.aims[L.to], pl = info.plats[P];
    if (!aim) { failLink(st, L); return; }

    if (L.kind === "drop") {
      const sp = info.spans[P];
      out.dir = L.side;
      const nx = ai.x + L.side * speedOf(ai) * dts;
      if ((L.side > 0 && nx > sp.hi) || (L.side < 0 && nx < sp.lo)) {
        if (!st.dropOk) {
          const s = stateOf(ai);
          s.x = L.side < 0 ? pl.x - C.PW - 0.5 : pl.x + pl.w + C.PW + 0.5;
          s.vy = 0;
          const r = predict(s, { aimLo: aim.lo, aimHi: aim.hi, holdDir: L.side, holdUntilY: pl.y + 2 }, info, dts);
          st.dropOk = landsOn(r, L.to);
          if (!st.dropOk) { out.dir = 0; if (!(ai.slowT > 0)) failLink(st, L); return; }
        }
        st.air = { target: L.to, aimLo: aim.lo, aimHi: aim.hi, holdDir: L.side, holdUntilY: pl.y + 2, jumpAtApex: false, rose: false, rescue: false };
      }
      return;
    }

    const tx = st.takeoffX != null ? st.takeoffX : clamp(ai.x, L.lo, L.hi);
    if (Math.abs(ai.x - tx) > 5) { out.dir = this.seek(ai.x, tx, st, 2); return; }
    if (st.t - st.lastJumpT < JUMP_COOLDOWN_MS || st.t - st.landT < 50) return;
    const dbl = L.kind === "double";
    const rj = predict(stateOf(ai), { aimLo: aim.lo, aimHi: aim.hi, jumpNow: true, jumpAtApex: dbl }, info, dts);
    if (landsOn(rj, L.to)) {
      out.jump = true;
      out.dir = aimDir(ai.x, aim.lo, aim.hi);
      st.air = { target: L.to, aimLo: aim.lo, aimHi: aim.hi, jumpAtApex: dbl, rose: true, rescue: false };
      st.state = "JUMP";
      return;
    }
    if (ai.slowT > 0) return;
    st.verifyFails++;
    if (st.verifyFails % 10 === 0) st.takeoffX = L.lo + Math.random() * L.width;
    if (st.verifyFails >= 40) failLink(st, L);
  }

  private hopStep(st: BotState, ai: Player, info: MapInfo, P: number, dts: number, out: MotorOut): void {
    const it = st.intent;
    st.intent = { kind: "idle" };
    if (it.kind !== "hop" || it.until < st.t || st.t - st.lastJumpT < JUMP_COOLDOWN_MS) return;
    const r = predict(stateOf(ai), { aimLo: it.aimLo, aimHi: it.aimHi, jumpNow: true }, info, dts);
    if (!landsOn(r, P) || !r.solid) return;
    out.jump = true;
    out.dir = aimDir(ai.x, it.aimLo, it.aimHi);
    st.air = { target: P, aimLo: it.aimLo, aimHi: it.aimHi, jumpAtApex: false, rose: true, rescue: false };
    st.state = "JUMP";
  }

  private groundMotor(st: BotState, ai: Player, info: MapInfo, dts: number): MotorOut {
    const P = platUnder(ai, info.plats);
    const out: MotorOut = { dir: 0, jump: false, attack: null };
    st.air = null;
    if (P < 0) return out;
    let allowSide = 0;
    if (st.t >= st.reactUntil) {
      const it = st.intent;
      if (it.kind === "navigate" && st.link && st.link.from === P) {
        this.navStep(st, ai, info, dts, P, out);
        if (st.link && st.link.kind === "drop" && st.dropOk) allowSide = st.link.side;
      } else if (it.kind === "hop") {
        this.hopStep(st, ai, info, P, dts, out);
      } else if (it.goalX != null) {
        out.dir = this.seek(ai.x, it.goalX, st, 5);
      }
    }
    if (out.jump) allowSide = out.dir;
    out.dir = this.groundSafeDir(st, ai, info, P, out.dir, dts, allowSide);
    const counter = this.knockbackCounter(st, ai, info, P);
    if (counter) out.dir = counter;
    return out;
  }

  /* ---------------------------------------------------------------- motor en el aire */
  private airDir(ai: Player, air: AirPlan): number {
    if (air.holdDir && ai.y <= air.holdUntilY!) return air.holdDir;
    return aimDir(ai.x, air.aimLo, air.aimHi);
  }

  private airPol(air: AirPlan, jumpNow: boolean, noApex: boolean): Policy {
    return {
      aimLo: air.aimLo, aimHi: air.aimHi, holdDir: air.holdDir, holdUntilY: air.holdUntilY,
      jumpNow, jumpAtApex: !noApex && !jumpNow && air.jumpAtApex, rose: air.rose,
    };
  }

  private airMotor(st: BotState, ai: Player, info: MapInfo, dts: number): MotorOut {
    if (st.t < st.reactUntil) return { dir: st.lastDir, jump: false, attack: null };
    const s = stateOf(ai);
    let air = st.air;
    if (air && air.target >= info.plats.length) air = st.air = null;
    if (air) {
      if (ai.vy < 0) air.rose = true;
      const dir = this.airDir(ai, air);
      const r0 = predict(s, this.airPol(air, false, false), info, dts);
      if (landsOn(r0, air.target)) {
        let jump = false;
        if (air.jumpAtApex && air.rose && ai.vy >= 0 && ai.jumpsLeft > 0) {
          air.jumpAtApex = false;
          jump = !landsOn(predict(s, this.airPol(air, false, true), info, dts), air.target);
        }
        st.state = air.rescue ? "RECOVER" : "IN_AIR";
        return { dir, jump, attack: null };
      }
      if (ai.jumpsLeft > 0 && landsOn(predict(s, this.airPol(air, true, true), info, dts), air.target)) {
        air.jumpAtApex = false;
        st.state = "RECOVER";
        return { dir, jump: true, attack: null };
      }
    }
    return this.rescue(st, ai, info, s, dts);
  }

  private rescue(st: BotState, ai: Player, info: MapInfo, s: SimState, dts: number): MotorOut {
    if (st.t - st.rescueT < RESCUE_EVERY_MS) {
      return { dir: st.air ? this.airDir(ai, st.air) : st.rescueDir, jump: false, attack: null };
    }
    st.rescueT = st.t;
    const plats = info.plats;
    let best: { score: number; aim: Aim; opt: string; plat: number } | null = null;
    const opts = ai.jumpsLeft > 0 ? (s.vy < -1 ? ["none", "now", "apex"] : ["none", "now"]) : ["none"];
    for (let i = 0; i < plats.length; i++) {
      const aim = info.aims[i];
      if (!aim || plats[i].y < ai.y - C.MAX_RISE - 10) continue;
      for (const o of opts) {
        const r = predict(s, { aimLo: aim.lo, aimHi: aim.hi, jumpNow: o === "now", jumpAtApex: o === "apex", rose: s.vy < 0 }, info, dts);
        if (r.plat < 0 || r.dead) continue;
        let d = costFrom(st, info, r.plat, r.x);
        if (!(d < Infinity)) d = 400;
        const score = d + (o === "none" ? 0 : 30) + r.frames * 0.25 + (r.solid ? 0 : 25);
        if (!best || score < best.score) best = { score, aim, opt: o, plat: r.plat };
      }
    }
    st.state = "RECOVER";
    if (best) {
      st.air = {
        target: best.plat, aimLo: best.aim.lo, aimHi: best.aim.hi, jumpAtApex: best.opt === "apex",
        rose: s.vy < 0 || best.opt === "now", rescue: true,
      };
      st.rescueDir = this.airDir(ai, st.air);
      return { dir: st.rescueDir, jump: best.opt === "now", attack: null };
    }
    st.air = null;
    let nearest = -1, nd = Infinity;
    for (let j = 0; j < plats.length; j++) {
      const sp = info.spans[j];
      if (!sp.ok || plats[j].y < ai.y - 40) continue;
      const dd = distToInterval(ai.x, sp.lo, sp.hi);
      if (dd < nd) { nd = dd; nearest = j; }
    }
    st.rescueDir = nearest >= 0 ? aimDir(ai.x, info.spans[nearest].lo, info.spans[nearest].hi) : 0;
    return { dir: st.rescueDir, jump: ai.jumpsLeft > 0 && s.vy >= 0, attack: null };
  }

  /* ---------------------------------------------------------------- golpe */
  private attackMotor(st: BotState, ai: Player, me: Player | null, info: MapInfo, out: MotorOut, dts: number): MotorOut {
    const pa = st.pendingAttack;
    if (!pa || !me) return out;
    if (pa.until <= st.t) { st.pendingAttack = null; return out; }
    if (ai.attack || ai.attackCooldown > 0 || st.t < st.reactUntil) return out;
    const dx = me.x - ai.x, want = dx >= 0 ? 1 : -1;
    if (Math.abs(dx) > 3 && ai.facing !== want) {
      if (!ai.grounded || ai.hitStunT > 0 || out.jump) return out;
      const turn = this.groundSafeDir(st, ai, info, platUnder(ai, info.plats), want, dts, 0);
      if (turn) out.dir = turn;
      return out;
    }
    out.attack = pa.type;
    st.pendingAttack = null;
    return out;
  }

  private release(id: number): void {
    this.sim.handleInput(id, "left", false);
    this.sim.handleInput(id, "right", false);
  }

  private apply(id: number, st: BotState, out: MotorOut): void {
    const dir = out.dir || 0;
    this.sim.handleInput(id, "left", dir < 0);
    this.sim.handleInput(id, "right", dir > 0);
    if (out.jump) { this.sim.handleInput(id, "jump", true); st.lastJumpT = st.t; }
    if (out.attack) this.sim.handleInput(id, out.attack, true);
    st.lastDir = dir;
  }

  private tickInner(id: number, targetId: number, dt: number, cfg: BotDifficulty, st: BotState): void {
    const players = this.sim.players;
    const ai = players[id];
    if (!ai) return;
    st.id = id; st.cfg = cfg;
    if (!(dt >= 0)) dt = 16.6667;
    dt = Math.min(dt, 100);
    st.t += dt;
    st.dtEma += (dt - st.dtEma) * 0.1;

    if (!ai.alive) {
      this.release(id);
      st.state = "DEAD"; st.intent = { kind: "idle" }; st.air = null; st.link = null; st.pendingAttack = null;
      return;
    }
    const map = this.sim.currentMap;
    if (!map || !map.platforms.length) { this.release(id); return; }
    const info = this.getMapInfo(map);
    if (st.mapId !== info.id) resetNav(st, info.id);

    let me: Player | null = players[targetId] || null;
    if (me && !me.alive) me = null;

    const stun = ai.hitStunT || 0;
    if (stun > st.lastStun + 1) st.reactUntil = st.t + cfg.reactMs;
    st.lastStun = stun;
    if (ai.grounded && !st.wasGrounded) {
      st.landT = st.t; st.air = null;
      st.thinkT = Math.min(st.thinkT, cfg.thinkMs * 0.35);
    }
    if (!ai.grounded && st.wasGrounded && !st.air) st.reactUntil = Math.max(st.reactUntil, st.t + cfg.reactMs);
    st.wasGrounded = ai.grounded;

    st.thinkT -= dt;
    if (st.thinkT <= 0) {
      st.thinkT = Math.max(40, cfg.thinkMs + (Math.random() * 2 - 1) * cfg.thinkJitter);
      this.think(id, st, ai, me, info, cfg);
    }

    const dts = clamp(st.dtEma / 16.6667, 0.25, 2.5);
    let out = ai.grounded ? this.groundMotor(st, ai, info, dts) : this.airMotor(st, ai, info, dts);
    out = this.attackMotor(st, ai, me, info, out, dts);
    this.apply(id, st, out);
  }

  /** Un frame de un bot. La IA nunca puede tirar abajo el juego: ante una excepción suelta las teclas. */
  tick(id: number, targetId: number, dt: number, cfg: BotDifficulty = BOT_DIFFICULTY.medium): void {
    const st = this.getState(id);
    try {
      this.tickInner(id, targetId, dt, cfg, st);
    } catch (e) {
      try { this.release(id); } catch { /* sim en estado raro */ }
      st.intent = { kind: "idle" }; st.air = null; st.link = null; st.pendingAttack = null;
      if (!st.errorLogged) { st.errorLogged = true; console.warn("BotAI:", e); }
    }
  }

  inspect(id: number) {
    const st = this.states[id];
    if (!st) return null;
    return {
      state: st.state, intent: st.intent.kind, objPlat: st.objPlat, holding: st.holding,
      link: st.link ? linkKey(st.link) : null, airTarget: st.air ? st.air.target : null,
    };
  }
}
