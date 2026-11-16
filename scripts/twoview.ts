/* "Dos ventanas lado a lado", medido. Levanta el servidor real y conecta dos clientes que replican
   la lógica de game/sessions/online.ts (predicción + reconciliación del propio, interpolación de
   los demás). Mide lo que Dan veía al probar con dos ventanas:

   - DEMORA: desde que un jugador empieza a moverse hasta que la OTRA ventana lo dibuja moviéndose;
   - SUPERPOSICIÓN: uno camina contra el otro y se compara la distancia entre los dos muñecos tal
     como se dibujan en cada ventana con la distancia real en el servidor (los cuerpos se empujan
     suave: en el servidor quedan a ~21 px; menos que eso en pantalla es superponerse).

   Uso:  npx tsx scripts/twoview.ts [perfil]     perfiles: local | internet
   Variables: TV_OLD=1 replica el cliente anterior (sin colisión predicha, buffer de 100 ms; para
   comparar de verdad hay que correrlo con el servidor viejo también). TV_NOSEP=1 apaga el ajuste
   de dibujo en contacto, TV_NOPULL=1 deja solo la separación; TV_PULL_MAX / TV_PULL_EASE /
   TV_INTERP_MIN / TV_SNAP_MS prueban otros valores.

   Resultado (noviembre 2026, timers precisos ≈ VM Linux):
                          antes            después
     demora local         ~130 ms          ~75 ms
     demora internet      ~165 ms          ~127 ms
     empujándose          se cruzaban      misma distancia que el servidor en las dos pantallas
     correcciones/empuje  ~160–196         1–6 */

import "./precise-timers.mjs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import WebSocket from "ws";
import {
  IN_LEFT, IN_RIGHT, TICK_MS,
  applyMoveInput, collidePlatforms, decode, encode, integrateBody, tickMoveTimers, unpackPlayer,
  type MapDef, type NetPlayer, type ServerMsg, type Snapshot,
} from "@lss/shared";
import * as shared from "@lss/shared";

const PROFILE = process.argv[2] || "local";
const OLD = !!process.env.TV_OLD;
const PORT = 19000 + Math.floor(Math.random() * 900);
const INTERP_MIN = OLD ? 100 : Number(process.env.TV_INTERP_MIN) || 0; // 0 = el del cliente nuevo
const SNAP_MS = OLD ? 34 : Number(process.env.TV_SNAP_MS) || 0;

// lo nuevo que exporta shared (si todavía no existe, se corre como el cliente viejo)
const S = shared as unknown as Record<string, unknown>;
const resolveBodies = S.resolveBodyCollisions as ((b: { id: number; x: number; y: number }[]) => void) | undefined;
const NET = (S.NET_TUNING as { INTERP_MIN_MS: number; SNAP_INTERVAL_MS: number } | undefined) || { INTERP_MIN_MS: 100, SNAP_INTERVAL_MS: 34 };
const interpMin = INTERP_MIN || NET.INTERP_MIN_MS;
const snapInterval = SNAP_MS || NET.SNAP_INTERVAL_MS;
const predictCollisions = !OLD && !!resolveBodies;

interface Link { base: number; jitter: number }
/* RTT `base` repartido mitad y mitad; `jitter` es la variación de cada mensaje (como un hilo de
   navegador ocupado + la red). "internet" ≈ Buenos Aires → VM de São Paulo. */
const PROFILES: Record<string, Link> = { local: { base: 1, jitter: 4 }, internet: { base: 40, jitter: 12 } };
const LINK = PROFILES[PROFILE] || PROFILES.local;

class Pipe {
  private lastAt = 0;
  private q: { at: number; fn: () => void }[] = [];
  private timer: NodeJS.Timeout | null = null;
  send(fn: () => void) {
    const at = Math.max(performance.now() + LINK.base / 2 + Math.random() * LINK.jitter, this.lastAt);
    this.lastAt = at;
    this.q.push({ at, fn });
    this.arm();
  }
  private arm() {
    if (this.timer || !this.q.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = performance.now();
      while (this.q.length && this.q[0].at <= now + 0.5) this.q.shift()!.fn();
      this.arm();
    }, Math.max(0, this.q[0].at - performance.now()));
  }
}

type Body = { id: number;
  x: number; y: number; vx: number; vy: number; kbx: number; grounded: boolean; facing: 1 | -1; jumpsLeft: number; jumpBufT: number;
  hitStunT: number; slowT: number; power: { t: number; aire?: boolean } | null; input: { left: boolean; right: boolean }; jumpEdge: boolean;
};
function bodyFrom(np: NetPlayer, ghost: boolean): Body {
  return {
    id: np.id, x: np.x, y: np.y, vx: np.vx, vy: np.vy, kbx: np.kbx, grounded: np.grounded, facing: np.facing, jumpsLeft: np.jumpsLeft,
    jumpBufT: ghost ? 0 : np.jumpBufT, hitStunT: np.hitStunT, slowT: np.slowT, power: np.power ? { ...np.power } : null,
    input: { left: ghost && np.vx < 0, right: ghost && np.vx > 0 }, jumpEdge: ghost ? false : np.jumpEdge,
  };
}
function stepBody(p: Body, bits: number | null, map: MapDef) {
  if (bits !== null) { p.input.left = !!(bits & IN_LEFT); p.input.right = !!(bits & IN_RIGHT); }
  applyMoveInput(p as never);
  const prevFeet = p.y, was = p.grounded;
  integrateBody(p as never, 1);
  tickMoveTimers(p as never, TICK_MS);
  collidePlatforms(p as never, prevFeet, was, map.platforms);
}

interface Pred { me: Body; order: number[]; ghosts: Map<number, Body> }

class Client {
  ws: WebSocket; up = new Pipe(); down = new Pipe();
  id: number | null = null; code: string | null = null; map: MapDef | null = null;
  pred: Pred | null = null; pending: [number, number][] = []; seq = 0; acc = 0;
  offset = NaN; lateness: number[] = []; interpDelay = interpMin;
  buffer: { n: number; players: Map<number, NetPlayer>; roster: number[]; ph: number }[] = [];
  corrX = 0; corrY = 0; want = 0; phase = 0;
  /** lo dibujado en el último cuadro */
  drawn = new Map<number, { x: number; y: number }>();
  frozen = 0; frames = 0; corrections = 0; maxCorr = 0; pendSum = 0; pendN = 0;
  constructor(public name: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.ws.binaryType = "nodebuffer";
    this.ws.on("message", (d) => this.down.send(() => this.onMsg(decode<ServerMsg>(d as Buffer))));
  }
  send(m: unknown) { const buf = encode(m); this.up.send(() => { if (this.ws.readyState === 1) this.ws.send(buf); }); }
  latest() { return this.buffer[this.buffer.length - 1]; }
  onMsg(m: ServerMsg) {
    if (m.t === "joined") { this.id = m.id; this.code = m.code; return; }
    if (m.t !== "s") return;
    const s = m as Snapshot;
    const now = performance.now();
    if (s.m) this.map = s.m;
    if (!this.map) return;
    const sample = s.n * TICK_MS - now;
    if (Number.isNaN(this.offset) || sample - this.offset > 400) this.offset = sample;
    else if (sample > this.offset) this.offset += (sample - this.offset) * 0.5;
    else this.offset += (sample - this.offset) * 0.03;
    this.lateness.push(Math.max(0, this.offset - sample));
    if (this.lateness.length > 120) this.lateness.shift();
    const players = new Map<number, NetPlayer>();
    for (const t of s.p) { const np = unpackPlayer(t); players.set(np.id, np); }
    if (this.buffer.length && s.n <= this.latest().n) this.buffer = [];
    this.buffer.push({ n: s.n, players, roster: s.ro, ph: s.ph });
    if (this.buffer.length > 120) this.buffer.shift();
    this.phase = s.ph;
    this.reconcile();
  }
  reconcile() {
    const e = this.latest();
    const np = this.id !== null ? e.players.get(this.id) : undefined;
    if (!np || !np.alive || e.ph < 1 || e.ph > 3 || !this.map) { this.pred = null; return; }
    let i = 0;
    while (i < this.pending.length && this.pending[i][0] <= np.ack) i++;
    this.pending.splice(0, i);
    if (e.ph === 2) { this.pendSum += this.pending.length; this.pendN++; }
    const before = this.pred ? { x: this.pred.me.x, y: this.pred.me.y } : null;
    const fresh: Pred = { me: bodyFrom(np, false), order: e.roster.slice(), ghosts: new Map() };
    if (predictCollisions) for (const [id, o] of e.players) if (id !== this.id && o.alive) fresh.ghosts.set(id, bodyFrom(o, true));
    for (const [, bits] of this.pending) this.predictTick(fresh, bits);
    if (before) {
      const dx = before.x - fresh.me.x, dy = before.y - fresh.me.y;
      const err = Math.hypot(dx, dy);
      if (err > 1) this.corrections++;
      this.maxCorr = Math.max(this.maxCorr, err);
      if (Math.abs(dx) < 90 && Math.abs(dy) < 90) { this.corrX += dx; this.corrY += dy; } else { this.corrX = 0; this.corrY = 0; }
    }
    this.pred = fresh;
  }
  predictTick(p: Pred, bits: number) {
    stepBody(p.me, bits, this.map!);
    if (!predictCollisions || !p.ghosts.size) return;
    for (const g of p.ghosts.values()) stepBody(g, null, this.map!);
    const bodies: Body[] = [];
    for (const id of p.order) {
      if (id === this.id) bodies.push(p.me);
      else { const g = p.ghosts.get(id); if (g) bodies.push(g); }
    }
    resolveBodies!(bodies);
  }
  /** Un cuadro de dibujo (requestAnimationFrame). */
  frame(dt: number) {
    const e = this.latest();
    const active = !!e && e.ph >= 1 && e.ph <= 3;
    this.acc += dt;
    const out: [number, number][] = [];
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 6) {
      this.acc -= TICK_MS; steps++;
      if (!active) continue;
      const seq = ++this.seq;
      this.pending.push([seq, this.want]);
      out.push([seq, this.want]);
      if (this.pred) this.predictTick(this.pred, this.want);
    }
    if (out.length) this.send({ t: "in", f: out });
    const k = Math.exp(-dt / 45);
    this.corrX *= k; this.corrY *= k;
    if (this.lateness.length >= 10) {
      const sorted = this.lateness.slice().sort((x, y) => x - y);
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const target = Math.max(interpMin, Math.min(260, snapInterval + 12 + p95));
      this.interpDelay += (target - this.interpDelay) * Math.min(1, dt / 1000);
    }
    if (!active || Number.isNaN(this.offset)) return;
    const renderT = performance.now() + this.offset - this.interpDelay;
    this.frames++;
    if (renderT > e.n * TICK_MS) this.frozen++;
    let a = this.buffer[0], b = this.buffer[0];
    for (let i = this.buffer.length - 1; i >= 0; i--) if (this.buffer[i].n * TICK_MS <= renderT) { a = this.buffer[i]; b = this.buffer[Math.min(i + 1, this.buffer.length - 1)]; break; }
    const span = (b.n - a.n) * TICK_MS;
    const f = span > 0 ? Math.max(0, Math.min(1, (renderT - a.n * TICK_MS) / span)) : 1;
    for (const [id, pb] of b.players) {
      if (id === this.id && this.pred) { this.drawn.set(id, { x: this.pred.me.x + this.corrX, y: this.pred.me.y + this.corrY }); continue; }
      const pa = a.players.get(id) || pb;
      this.drawn.set(id, { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f });
    }
    if (predictCollisions && !process.env.TV_NOSEP) this.separate(dt);
    for (const [id, d] of this.drawn) {
      if (id === this.id) continue;
      const prev = this.prevDrawn.get(id);
      if (prev !== undefined && this.track) this.maxStep = Math.max(this.maxStep, Math.abs(d.x - prev) / (dt / TICK_MS));
      this.prevDrawn.set(id, d.x);
    }
  }
  /** Igual que OnlineSession.separateFromMe. */
  sepOff = new Map<number, number>();
  prevDrawn = new Map<number, number>();
  track = false;
  /** mayor avance del otro en un cuadro, en px por tick (caminando es 4,3) */
  maxStep = 0;
  separate(dt: number) {
    const p = this.pred, mine = this.id !== null ? this.drawn.get(this.id) : undefined;
    const k = 1 - Math.exp(-dt / 60);
    for (const [id, r] of this.drawn) {
      if (id === this.id) continue;
      let target = 0, side = 0;
      const g = p && mine ? p.ghosts.get(id) : undefined;
      if (g && mine && p) {
        const gdx = g.x - p.me.x, need = Math.abs(gdx);
        if (need < 34 && Math.abs(g.y - p.me.y) < 52 && Math.abs(r.y - mine.y) < 52) {
          const s = gdx >= 0 ? 1 : -1, drawn = (r.x - mine.x) * s;
          if (drawn > -6) { side = s; target = s * Math.max(process.env.TV_NOPULL ? 0 : -(Number(process.env.TV_PULL_MAX) || 10), need - drawn); }
        }
      }
      let off = this.sepOff.get(id) || 0;
      if (side && target * side > 0 && target * side > off * side) off = target;
      else if (side && target * side < off * side) off += (target - off) * (1 - Math.exp(-dt / (Number(process.env.TV_PULL_EASE) || 150)));
      else off += (target - off) * k;
      if (Math.abs(off) < 0.05) { this.sepOff.delete(id); continue; }
      this.sepOff.set(id, off);
      r.x += off;
    }
  }
  /** Dónde está cada uno en el servidor (último snapshot). */
  server(id: number) { const p = this.latest()?.players.get(id); return p ? { x: p.x, y: p.y } : null; }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const med = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

async function main() {
  const root = path.resolve(import.meta.dirname, "../packages/server");
  const proc = spawn(process.execPath, [path.resolve(root, "../../node_modules/tsx/dist/cli.mjs"), "src/server.ts", "--port", String(PORT)], {
    cwd: root, stdio: "pipe",
    env: { ...process.env, NODE_OPTIONS: "--import=" + pathToFileURL(path.resolve(import.meta.dirname, "precise-timers.mjs")).href },
  });
  await new Promise<void>((res) => proc.stdout!.on("data", (d) => { if (String(d).includes("escuchando")) res(); }));
  const A = new Client("A"), B = new Client("B");
  await wait(300);
  A.send({ t: "create", nick: "A", color: "#35f0e0", hat: "none" });
  while (!A.code) await wait(10);
  B.send({ t: "join", code: A.code, nick: "B", color: "#ff2e88", hat: "none" });
  while (B.id === null) await wait(10);
  A.send({ t: "start" });

  // "requestAnimationFrame" de cada ventana: ~60 Hz con la variación de un navegador real
  let running = true;
  const raf = (c: Client) => {
    let last = performance.now();
    const loop = () => {
      if (!running) return;
      const now = performance.now();
      c.frame(now - last); last = now;
      setTimeout(loop, 16.667 - 2 + Math.random() * 4);
    };
    setTimeout(loop, Math.random() * 16);
  };
  raf(A); raf(B);
  while (A.phase !== 2 || B.phase !== 2) await wait(10);

  const me = (c: Client) => c.id!;
  const other = (c: Client) => (c === A ? B : A);
  /* llevar a cada uno a una x del piso con un control simple sobre su propia predicción */
  async function goTo(c: Client, x: number) {
    for (let t = 0; t < 400; t++) {
      const p = c.pred?.me;
      if (p && p.grounded && p.y > 540 && Math.abs(p.x - x) < 3) { c.want = 0; return; }
      c.want = !p ? 0 : p.x < x ? IN_RIGHT : IN_LEFT;
      await wait(10);
    }
    c.want = 0;
  }
  // x del piso que no quedan debajo de las plataformas de los costados (desde arriba se cae al piso)
  await Promise.all([goTo(A, 420), goTo(B, 760)]);
  await wait(600);

  /* 1) DEMORA: ráfagas cortas alternando dirección; la otra ventana mide cuándo lo ve moverse */
  async function latency(mover: Client, n: number) {
    const viewer = other(mover);
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      const start = viewer.drawn.get(me(mover));
      if (!start) { await wait(100); continue; }
      const sx = start.x;
      const t0 = performance.now();
      mover.want = i % 2 ? IN_LEFT : IN_RIGHT;
      let seen = NaN;
      while (performance.now() - t0 < 1500) {
        const d = viewer.drawn.get(me(mover));
        if (d && Math.abs(d.x - sx) > 1) { seen = performance.now() - t0; break; }
        await wait(1);
      }
      await wait(Math.max(0, 250 - (performance.now() - t0)));
      mover.want = 0;
      if (!Number.isNaN(seen)) samples.push(seen);
      await wait(550);
    }
    return samples;
  }
  const latA = await latency(A, 10);
  const latB = await latency(B, 10);

  /* 2) SUPERPOSICIÓN: uno camina contra el otro (que no se mueve) durante 1.5 s */
  async function push(pusher: Client) {
    const pushee = other(pusher);
    const s0 = pusher.server(me(pushee)), s1 = pusher.server(me(pusher));
    const dir = s0 && s1 && s0.x < s1.x ? -1 : 1;
    if (s0 && s1 && Math.abs(s0.y - s1.y) > 5) console.log("(no están a la misma altura:", s1, s0, ")");
    const rec = { pusherView: [] as number[], pusheeView: [] as number[], server: [] as number[] };
    pusher.want = dir > 0 ? IN_RIGHT : IN_LEFT;
    A.track = B.track = true;
    const t0 = performance.now();
    let contact = NaN;
    while (performance.now() - t0 < 2200) {
      const sv = pusher.server(me(pushee)), sm = pusher.server(me(pusher));
      if (sv && sm && Number.isNaN(contact) && Math.abs(sv.x - sm.x) < 34) contact = performance.now();
      if (!Number.isNaN(contact) && performance.now() - contact > 500) {
        const dv = (c: Client) => { const x = c.drawn.get(me(pusher)), y = c.drawn.get(me(pushee)); return x && y ? (y.x - x.x) * dir : NaN; };
        rec.pusherView.push(dv(pusher));
        rec.pusheeView.push(dv(pushee));
        if (sv && sm) rec.server.push((sv.x - sm.x) * dir);
      }
      if (!Number.isNaN(contact) && performance.now() - contact > 1500) break;
      await wait(5);
    }
    pusher.want = 0;
    await wait(700);
    return rec;
  }
  const corrBefore = A.corrections + B.corrections;
  const p1 = await push(A);
  const p2 = await push(B);
  const corrPush = A.corrections + B.corrections - corrBefore;

  running = false;
  const r = (x: number) => Math.round(x * 10) / 10;
  console.log(`\nperfil ${PROFILE} · cliente ${OLD ? "VIEJO" : "nuevo"} · buffer mín ${interpMin} ms · colisión predicha ${predictCollisions ? "sí" : "no"}`);
  console.table({
    "A se mueve → B lo ve (ms)": { mediana: r(med(latA)), promedio: r(mean(latA)), max: r(Math.max(...latA)) },
    "B se mueve → A lo ve (ms)": { mediana: r(med(latB)), promedio: r(mean(latB)), max: r(Math.max(...latB)) },
  });
  const row = (p: typeof p1) => ({
    "servidor (px)": r(mean(p.server)),
    "ventana del que empuja (px)": r(mean(p.pusherView)),
    "mín en esa ventana": r(Math.min(...p.pusherView)),
    "ventana del empujado (px)": r(mean(p.pusheeView)),
  });
  console.table({ "A empuja a B": row(p1), "B empuja a A": row(p2) });
  console.log("correcciones de predicción durante los empujes:", corrPush, "· mayor corrección:", r(Math.max(A.maxCorr, B.maxCorr)), "px",
    "· buffer de interpolación:", Math.round(A.interpDelay), "/", Math.round(B.interpDelay), "ms",
    "· cuadros congelados:", ((100 * (A.frozen + B.frozen)) / Math.max(1, A.frames + B.frames)).toFixed(1) + "%",
    "· frames sin confirmar (prom.):", r((A.pendSum + B.pendSum) / Math.max(1, A.pendN + B.pendN)),
    "· mayor avance del otro por tick al empujarse:", r(Math.max(A.maxStep, B.maxStep)), "px (caminando: 4,3)");
  proc.kill();
  process.exit(0);
}

void main();
