/* Simulador de red para el netcode online. Levanta el servidor real, conecta un ANFITRIÓN y un
   INVITADO con perfiles de conexión distintos (demora, variación y "microcortes" como los de un
   WiFi, respetando el orden como TCP) y mide lo que vería cada uno:

   - predicción del muñeco propio: cuántas correcciones visibles y de qué tamaño;
   - interpolación de los demás: cuadros en que el buffer se queda sin snapshots (se congela) y
     saltos de posición;
   - cómo ve el anfitrión al invitado: snapshots en que el invitado no avanzó aunque corría
     (se frenó en el servidor esperando su input);
   - ping de red real.

   Uso:  npx tsx scripts/netsim.ts [segundos] [perfil-invitado]
   Perfiles: lan | wifi | wifi-bad | mobile
   Variables: NS_LOG=1 detalla cada corrección grande; NS_OLD=1 ignora el salto pendiente del
   snapshot y NS_FIXED=1 usa el buffer fijo de 100 ms (para comparar con el cliente viejo).

   Resultado que motivó los cambios de octubre 2026 (60 s, invitado con "wifi-bad"): antes 182
   correcciones grandes del muñeco propio, de hasta 180 px; después 1, de 8 px. */

import { spawn } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";
import {
  ATTACKS, IN_JUMP, IN_LEFT, IN_RIGHT, PHYS, TICK_MS,
  applyMoveInput, collidePlatforms, decode, encode, integrateBody, tickMoveTimers, unpackPlayer,
  type MapDef, type NetPlayer, type ServerMsg, type Snapshot,
} from "@lss/shared";

const SECONDS = Number(process.argv[2]) || 20;
const GUEST_PROFILE = process.argv[3] || "wifi";
const ADAPTIVE = process.env.NS_FIXED ? false : true;
const PORT = 19000 + Math.floor(Math.random() * 900);

interface Link { base: number; jitter: number; spikeEvery: number; spikeMs: number }
const PROFILES: Record<string, Link> = {
  lan: { base: 12, jitter: 2, spikeEvery: 0, spikeMs: 0 },
  wifi: { base: 45, jitter: 18, spikeEvery: 4000, spikeMs: 180 },
  "wifi-bad": { base: 70, jitter: 35, spikeEvery: 2500, spikeMs: 300 },
  mobile: { base: 90, jitter: 45, spikeEvery: 3000, spikeMs: 400 },
};

/* Un sentido de la conexión: cada mensaje llega a base/2 + variación, nunca antes que el anterior
   (TCP entrega en orden), y cada tanto un corte retiene todo hasta que termina. */
class Pipe {
  private lastAt = 0;
  private stallUntil = 0;
  private nextSpike: number;
  private q: { at: number; fn: () => void }[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(private l: Link) { this.nextSpike = performance.now() + (l.spikeEvery ? l.spikeEvery * (0.5 + Math.random()) : 1e12); }
  send(fn: () => void) {
    const now = performance.now();
    if (now >= this.nextSpike) { this.stallUntil = now + this.l.spikeMs; this.nextSpike = now + this.l.spikeEvery * (0.5 + Math.random()); }
    let at = now + this.l.base / 2 + Math.random() * this.l.jitter;
    if (at < this.stallUntil) at = this.stallUntil + Math.random() * 4;
    at = Math.max(at, this.lastAt);
    this.lastAt = at;
    this.q.push({ at, fn });
    this.arm();
  }
  /* una sola cola FIFO con un solo timer: nunca reordena (como TCP) */
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

/* ---- réplica de la predicción del cliente (game/sessions/online.ts) */
interface Pred {
  x: number; y: number; vx: number; vy: number; kbx: number; grounded: boolean; facing: 1 | -1;
  jumpsLeft: number; jumpBufT: number; hitStunT: number; slowT: number; power: { t: number; aire?: boolean } | null;
  input: { left: boolean; right: boolean }; jumpEdge: boolean; attack: { type: string; t: number; dur: number } | null; attackCooldown: number;
}
function predFrom(np: NetPlayer): Pred {
  return {
    x: np.x, y: np.y, vx: np.vx, vy: np.vy, kbx: np.kbx, grounded: np.grounded, facing: np.facing, jumpsLeft: np.jumpsLeft,
    jumpBufT: np.jumpBufT, hitStunT: np.hitStunT, slowT: np.slowT, power: np.power ? { ...np.power } : null,
    input: { left: false, right: false }, jumpEdge: process.env.NS_OLD ? false : np.jumpEdge, attack: np.attack ? { ...np.attack } : null, attackCooldown: np.attackCooldown,
  };
}
function predictTick(p: Pred, bits: number, map: MapDef) {
  p.input.left = !!(bits & IN_LEFT); p.input.right = !!(bits & IN_RIGHT);
  if (bits & IN_JUMP) p.jumpEdge = true;
  applyMoveInput(p as never);
  const prevFeet = p.y, was = p.grounded;
  integrateBody(p as never, 1);
  tickMoveTimers(p as never, TICK_MS);
  collidePlatforms(p as never, prevFeet, was, map.platforms);
  if (p.attack) { p.attack.t -= TICK_MS; if (p.attack.t <= 0) p.attack = null; }
  if (p.attackCooldown > 0) p.attackCooldown -= TICK_MS;
}
void ATTACKS; void PHYS;

interface Stats {
  snaps: number; corrections: number; bigCorrections: number; maxErr: number; errSum: number;
  frames: number; frozen: number; jumps: number; pings: number[]; remoteStalls: number; remoteMoving: number;
}

class SimClient {
  ws: WebSocket;
  up: Pipe; down: Pipe;
  id: number | null = null;
  code: string | null = null;
  map: MapDef | null = null;
  pred: Pred | null = null;
  pending: [number, number][] = [];
  seq = 0;
  offset = NaN;
  buffer: { n: number; players: Map<number, NetPlayer>; t: number }[] = [];
  s: Stats = { snaps: 0, corrections: 0, bigCorrections: 0, maxErr: 0, errSum: 0, frames: 0, frozen: 0, jumps: 0, pings: [], remoteStalls: 0, remoteMoving: 0 };
  lastRemoteX: number | null = null;
  lateness: number[] = [];
  delaySum = 0;
  lastMe: NetPlayer | null = null;
  home: number | null = null;
  dir = 1;
  phase = 0;
  lastDrawnRemote: number | null = null;
  playing = false;
  constructor(public name: string, link: Link, public interpDelay: number) {
    this.up = new Pipe(link); this.down = new Pipe(link);
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.ws.binaryType = "nodebuffer";
    this.ws.on("message", (d) => this.down.send(() => this.onMsg(decode<ServerMsg>(d as Buffer))));
  }
  send(m: unknown) { const buf = encode(m); this.up.send(() => { if (this.ws.readyState === 1) this.ws.send(buf); }); }
  onMsg(m: ServerMsg) {
    if (m.t === "joined") { this.id = m.id; this.code = m.code; }
    else if (m.t === "pong") this.s.pings.push(performance.now() - m.ts);
    else if (m.t === "s") this.onSnap(m as Snapshot);
  }
  onSnap(sn: Snapshot) {
    const now = performance.now();
    if (sn.m) this.map = sn.m;
    if (!this.map) return;
    const sample = sn.n * TICK_MS - now;
    if (Number.isNaN(this.offset) || sample - this.offset > 400 || (!ADAPTIVE && Math.abs(sample - this.offset) > 400)) this.offset = sample;
    else if (sample > this.offset) this.offset += (sample - this.offset) * 0.5;
    else this.offset += (sample - this.offset) * 0.03;
    this.lateness.push(Math.max(0, this.offset - sample));
    if (this.lateness.length > 120) this.lateness.shift();
    const players = new Map<number, NetPlayer>();
    for (const t of sn.p) { const np = unpackPlayer(t); players.set(np.id, np); }
    this.buffer.push({ n: sn.n, players, t: now });
    if (this.buffer.length > 60) this.buffer.shift();
    this.playing = sn.ph >= 1 && sn.ph <= 3; // fightIntro / fight / roundEnd (como el cliente)
    this.phase = sn.ph;
    this.s.snaps++;
    // cómo se ve al otro jugador en el servidor
    for (const [pid, np] of players) {
      if (pid === this.id) continue;
      if (this.lastRemoteX !== null && np.alive && np.grounded && Math.abs(np.vx) > 0) {
        this.s.remoteMoving++;
        if (Math.abs(np.x - this.lastRemoteX) < 0.5) this.s.remoteStalls++;
      }
      this.lastRemoteX = np.x;
    }
    // reconciliación
    const me = this.id !== null ? players.get(this.id) : undefined;
    if (!me || !me.alive || !this.playing) { this.pred = null; this.home = null; this.lastMe = null; return; }
    // teletransporte (nueva ronda, reaparición): no es un error de predicción
    const teleported = !!this.lastMe && Math.hypot(me.x - this.lastMe.x, me.y - this.lastMe.y) > 40;
    this.lastMe = me;
    if (teleported) this.pred = null;
    if (this.home === null && me.grounded) this.home = me.x;
    let i = 0;
    while (i < this.pending.length && this.pending[i][0] <= me.ack) i++;
    this.pending.splice(0, i);
    const before = this.pred ? { x: this.pred.x, y: this.pred.y } : null;
    const fresh = predFrom(me);
    for (const [, b] of this.pending) predictTick(fresh, b, this.map);
    if (before) {
      const err = Math.hypot(before.x - fresh.x, before.y - fresh.y);
      this.s.errSum += err;
      if (err > 1) this.s.corrections++;
      if (err > 6) {
        this.s.bigCorrections++;
        if (process.env.NS_LOG && this.s.bigCorrections <= 10) {
          const other = [...players.values()].find((q) => q.id !== this.id);
          console.log(this.name, "err", err.toFixed(1), "pred", before.x.toFixed(1), before.y.toFixed(1), "fresh", fresh.x.toFixed(1), fresh.y.toFixed(1),
            "srv", me.x.toFixed(1), me.y.toFixed(1), "vy", me.vy.toFixed(1), "g", me.grounded, "kb", me.kbx.toFixed(1), "stun", me.hitStunT, "pend", this.pending.length,
            "otherDx", other ? (other.x - me.x).toFixed(1) : "-", "otherDy", other ? (other.y - me.y).toFixed(1) : "-", "ph", this.phase, "ack", me.ack, "jl", me.jumpsLeft, "jb", me.jumpBufT, "pendBits", this.pending.map(([q, b]) => q + ":" + b).join(" "), "sent", this.seq);
        }
      }
      this.s.maxErr = Math.max(this.s.maxErr, err);
    }
    this.pred = fresh;
  }
  /** Un tick de input del cliente (60 Hz). */
  /** Patrulla alrededor de donde apareció (para no caerse del mapa) y salta cada tanto. */
  bits(jump: boolean): number {
    const x = this.pred ? this.pred.x : null;
    if (x !== null && this.home !== null) {
      if (x > this.home + 60) this.dir = -1;
      else if (x < this.home - 60) this.dir = 1;
    }
    return (this.dir > 0 ? IN_RIGHT : IN_LEFT) | (jump ? IN_JUMP : 0);
  }
  tick(bits: number) {
    if (!this.playing) return;
    const seq = ++this.seq;
    this.pending.push([seq, bits]);
    if (this.pred && this.map) predictTick(this.pred, bits, this.map);
    this.send({ t: "in", f: [[seq, bits]] });
  }
  /** Un cuadro de dibujo: ¿hay snapshots alrededor del tiempo de render? */
  frame() {
    if (!this.playing || Number.isNaN(this.offset) || this.buffer.length < 2) return;
    this.s.frames++;
    if (ADAPTIVE && this.lateness.length >= 10) {
      const sorted = this.lateness.slice().sort((x, y) => x - y);
      const target = Math.max(60, Math.min(260, 34 + 12 + sorted[Math.floor(sorted.length * 0.95)]));
      this.interpDelay += (target - this.interpDelay) * Math.min(1, 16.7 / 1000);
    }
    this.delaySum += this.interpDelay;
    const renderT = performance.now() + this.offset - this.interpDelay;
    const last = this.buffer[this.buffer.length - 1];
    if (renderT > last.n * TICK_MS) this.s.frozen++;
    // posición dibujada del otro jugador
    let a = this.buffer[0], b = this.buffer[0];
    for (let i = this.buffer.length - 1; i >= 0; i--) if (this.buffer[i].n * TICK_MS <= renderT) { a = this.buffer[i]; b = this.buffer[Math.min(i + 1, this.buffer.length - 1)]; break; }
    const span = (b.n - a.n) * TICK_MS;
    const f = span > 0 ? Math.max(0, Math.min(1, (renderT - a.n * TICK_MS) / span)) : 1;
    for (const [pid, pb] of b.players) {
      if (pid === this.id) continue;
      const pa = a.players.get(pid);
      if (!pa) continue;
      const x = pa.x + (pb.x - pa.x) * f;
      if (this.lastDrawnRemote !== null && Math.abs(x - this.lastDrawnRemote) > 9) this.s.jumps++;
      this.lastDrawnRemote = x;
    }
  }
}

function report(c: SimClient) {
  const s = c.s;
  const pings = s.pings.slice().sort((a, b) => a - b);
  const med = pings.length ? pings[Math.floor(pings.length / 2)] : 0;
  return {
    cliente: c.name,
    pingMediana: Math.round(med),
    correccionesPorSeg: +(s.corrections / SECONDS).toFixed(2),
    correccionesGrandes: s.bigCorrections,
    errorMaxPx: +s.maxErr.toFixed(1),
    cuadrosCongelados: ((s.frozen / Math.max(1, s.frames)) * 100).toFixed(1) + "%",
    saltosDelOtro: s.jumps,
    otroFrenadoEnServidor: ((s.remoteStalls / Math.max(1, s.remoteMoving)) * 100).toFixed(1) + "%",
    interpMedio: Math.round(c.delaySum / Math.max(1, s.frames)),
  };
}

async function main() {
  const root = path.resolve(import.meta.dirname, "../packages/server");
  const proc = spawn(process.execPath, [path.resolve(root, "../../node_modules/tsx/dist/cli.mjs"), "src/server.ts", "--port", String(PORT)], { cwd: root, stdio: "pipe" });
  await new Promise<void>((res) => proc.stdout!.on("data", (d) => { if (String(d).includes("escuchando")) res(); }));
  const interp = Number(process.env.INTERP) || 100;
  const host = new SimClient("anfitrión (lan)", PROFILES.lan, interp);
  const guest = new SimClient("invitado (" + GUEST_PROFILE + ")", PROFILES[GUEST_PROFILE], interp);
  await new Promise((r) => setTimeout(r, 500));
  host.send({ t: "create", nick: "Host", color: "#35f0e0", hat: "none" });
  while (!host.code) await new Promise((r) => setTimeout(r, 20));
  guest.send({ t: "join", code: host.code, nick: "Guest", color: "#ff2e88", hat: "none" });
  while (guest.id === null) await new Promise((r) => setTimeout(r, 20));
  host.send({ t: "start" });
  // entradas: corren de un lado al otro y saltan cada tanto (el invitado desfasado)
  const t0 = performance.now();
  let acc = 0, last = performance.now(), frameAcc = 0, pingT = 0;
  await new Promise<void>((done) => {
    const iv = setInterval(() => {
      const now = performance.now();
      const dt = now - last; last = now;
      acc += dt; frameAcc += dt; pingT += dt;
      while (acc >= TICK_MS) {
        acc -= TICK_MS;
        const el = now - t0;
        const k = Math.floor(el / 16.667);
        host.tick(host.bits(k % 50 === 0 || k % 50 === 14)); guest.tick(guest.bits(k % 57 === 3 || k % 57 === 19));
      }
      if (frameAcc >= 16.667) { frameAcc = 0; host.frame(); guest.frame(); }
      if (pingT >= 1000) { pingT = 0; host.send({ t: "ping", ts: performance.now() }); guest.send({ t: "ping", ts: performance.now() }); }
      if (now - t0 > SECONDS * 1000) { clearInterval(iv); done(); }
    }, 2);
  });
  console.table([report(host), report(guest)]);
  proc.kill();
  process.exit(0);
}

void main();
