/* Partida online con servidor autoritativo. El netcode nuevo de V2:

   - INPUT POR TICK: el cliente corre su propio reloj a 60 Hz y manda un frame de input por tick
     (estado de izquierda/derecha + flancos de salto/piña/patada) con número de secuencia.
   - PREDICCIÓN + RECONCILIACIÓN del muñeco propio: cada frame se aplica al toque sobre una copia
     local con el MISMO integrador que el servidor (@lss/shared/physics). Cuando llega un snapshot,
     se toma el estado autoritativo en el último frame que el servidor confirmó (ack) y se
     re-simulan los frames que todavía no confirmó. Tu muñeco responde con 0 ms de lag; el error
     residual se corrige suavizado en unos pocos cuadros.
   - INTERPOLACIÓN con buffer para el resto: se dibujan ~100 ms en el pasado entre dos snapshots
     reales, con un reloj de servidor estimado. Sin extrapolar a ciegas como V1 (que dibujaba entre
     los dos últimos snapshots y se pasaba hasta un 40%), así que un paquete tarde no da tirones.
   - EVENTOS: golpes, KOs, aterrizajes, saltos... llegan dentro del snapshot y se reproducen en el
     momento en que se ven, con sus partículas, sacudón y sonido. En V1 los invitados no veían
     ningún efecto de impacto. */

import {
  ATTACKS, IN_JUMP, IN_KICK, IN_LEFT, IN_PUNCH, IN_RIGHT, GAME_MODES, PHASES, PHYS, TICK_MS, POWER_COLORS,
  applyMoveInput, collidePlatforms, integrateBody, orbFromTuple, tickMoveTimers, unpackPlayer,
  type GameMode, type InputKey, type MapDef, type NetPlayer, type Phase, type ServerMsg, type SimEvent, type Snapshot,
} from "@lss/shared";
import { get } from "svelte/store";
import type { Session } from "../session";
import type { Engine } from "../engine";
import { input, type Slot } from "../input";
import type { RenderView } from "../../render/renderer";
import type { RenderPlayer } from "../../render/art/stickman";
import { playSimEvent, type FxContext } from "../fx";
import { net, ping, room } from "../../net/net";
import { settings } from "../../app/persist";
import { banner, pulseFight, hud, type HudPlayer } from "../../app/ui";
import { t, translateMapName } from "../../app/i18n";
import { showFinal, hideFinal } from "../../app/final";
import { showScoreReveal, hideScoreReveal } from "../reveal";
import { audio } from "../../audio/audio";

interface Entry {
  n: number;
  phase: Phase;
  gameMode: GameMode;
  round: number;
  roster: number[];
  scores: Record<number, number>;
  players: Map<number, NetPlayer>;
  orb: ReturnType<typeof orbFromTuple>;
  hill: { x: number; y: number; r: number } | null;
  orbkingTimer: number;
  map: MapDef;
}

interface Pred {
  x: number; y: number; vx: number; vy: number; kbx: number; grounded: boolean; facing: 1 | -1;
  jumpsLeft: number; jumpBufT: number; hitStunT: number; slowT: number;
  power: { t: number; aire?: boolean; [k: string]: unknown } | null;
  input: { left: boolean; right: boolean }; jumpEdge: boolean;
  walkCycle: number; idleT: number; squash: number; jumpAnticT: number;
  attack: { type: "punch" | "kick"; t: number; dur: number } | null; attackCooldown: number;
}

const INTERP_DELAY_MS = 100;
const MAX_BUFFER = 40;

function wrapLerp(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
  return (((a + d * t) % 1) + 1) % 1;
}

export class OnlineSession implements Session {
  readonly kind = "online";
  readonly interactive = false;

  private buffer: Entry[] = [];
  private map: MapDef | null = null;
  private offset = NaN;
  private events: { n: number; e: SimEvent }[] = [];
  private pred: Pred | null = null;
  private pending: [number, number][] = [];
  private outbox: [number, number][] = [];
  private seq = 0;
  private acc = 0;
  private held = new Map<string, boolean>();
  private edgeBits = 0;
  private corrX = 0;
  private corrY = 0;
  private lastPhase: Phase | null = null;
  private finalShown = false;
  private hudT = 0;
  private unsub: () => void;
  private fxCtx: FxContext;
  private lastPad: number | null = null;
  private renderNow = 0;
  /** Métricas de red (se ven en el HUD con "Mostrar FPS"): error de predicción y cadencia. */
  readonly netStats = { predErr: 0, predErrMax: 0, snapsPerSec: 0, bufferMs: 0, pending: 0 };
  private snapCount = 0;
  private snapWindowT = performance.now();

  constructor(private engine: Engine) {
    this.unsub = net.listen((m) => this.onMessage(m));
    this.fxCtx = {
      colorFor: (id) => this.colorFor(id),
      meId: null,
      skipOwnPredicted: true,
      damageNumbers: get(settings).damageNumbers,
      rumble: (id, s, ms) => { if (id === this.myId() && this.lastPad !== null) input.rumble(this.lastPad, s, ms); },
    };
  }

  private myId(): number | null { return get(room).myId; }

  private lobbyPlayer(id: number) { return get(room).players.find((p) => p.id === id); }
  colorFor(id: number) { return this.lobbyPlayer(id)?.color || "#35f0e0"; }
  nameFor(id: number) { return this.lobbyPlayer(id)?.name || t("player.n", { n: id + 1 }); }
  hatFor(id: number) { return this.lobbyPlayer(id)?.hat || "none"; }

  /* ---------------------------------------------------------------- mensajes */
  private onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case "s": this.onSnapshot(msg); break;
      case "started":
        this.resetMatchState();
        hideFinal();
        hideScoreReveal();
        break;
      case "toLobby":
        this.resetMatchState();
        hideFinal();
        hideScoreReveal();
        banner.set(null);
        this.setPhase("lobby");
        break;
      case "joined":
        if (msg.resumed) this.resetMatchState();
        break;
      case "round": {
        hideScoreReveal();
        const map = translateMapName(msg.mapName);
        if (msg.mode === "koth") banner.set(t("hud.koth", { map }));
        else if (msg.mode === "orbking") banner.set(t("hud.orbking", { map }));
        else if (msg.mode === "wins") banner.set(t("hud.round", { n: msg.round }));
        else banner.set(t("hud.roundOf", { n: msg.round, total: msg.totalRounds == null ? "∞" : msg.totalRounds, map }));
        pulseFight();
        if (msg.infinite && msg.round % 5 === 0) {
          const e = this.latest();
          showScoreReveal(e ? e.roster : [], e ? e.scores : {}, msg.stats, (id) => this.nameFor(id), (id) => this.colorFor(id));
        }
        break;
      }
    }
  }

  private resetMatchState() {
    this.buffer = [];
    this.events = [];
    this.pred = null;
    this.pending = [];
    this.corrX = this.corrY = 0;
    this.finalShown = false;
    this.engine.renderer.resetPlayers();
    this.engine.renderer.clearTransient();
  }

  private onSnapshot(s: Snapshot) {
    const now = performance.now();
    if (s.m) this.map = s.m;
    if (!this.map) return; // todavía no llegó el mapa
    const sample = s.n * TICK_MS - now;
    if (Number.isNaN(this.offset) || Math.abs(sample - this.offset) > 400) this.offset = sample;
    else if (sample > this.offset) this.offset += (sample - this.offset) * 0.5;
    else this.offset += (sample - this.offset) * 0.03;

    const players = new Map<number, NetPlayer>();
    for (const tu of s.p) { const np = unpackPlayer(tu); players.set(np.id, np); }
    const scores: Record<number, number> = {};
    for (const [id, sc] of s.sc) scores[id] = sc;
    const entry: Entry = {
      n: s.n, phase: PHASES[s.ph] || "lobby", gameMode: GAME_MODES[s.gm] || "normal", round: s.r, roster: s.ro, scores, players,
      orb: orbFromTuple(s.o), hill: s.h ? { x: s.h[0] / 10, y: s.h[1] / 10, r: s.h[2] } : null, orbkingTimer: s.ok, map: this.map,
    };
    if (this.buffer.length && s.n <= this.buffer[this.buffer.length - 1].n) this.buffer = [];
    this.buffer.push(entry);
    this.snapCount++;
    if (now - this.snapWindowT >= 1000) { this.netStats.snapsPerSec = this.snapCount; this.snapCount = 0; this.snapWindowT = now; }
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    if (s.e) for (const e of s.e) this.events.push({ n: s.n, e });
    this.setPhase(entry.phase);
    this.reconcile(entry);
    if (entry.phase === "final" && !this.finalShown) {
      this.finalShown = true;
      banner.set(null);
      hideScoreReveal();
      const ranked = entry.roster.slice().sort((a, b) => (entry.scores[b] || 0) - (entry.scores[a] || 0));
      showFinal({
        ranked, scores: entry.scores,
        nameFor: (id) => this.nameFor(id), colorFor: (id) => this.colorFor(id), hatFor: (id) => this.hatFor(id),
        canRematch: net.isOwner(), showChangeMode: false, showBackMenu: true,
        unit: entry.gameMode === "orbking" ? "s" : undefined,
      });
    }
  }

  private setPhase(phase: Phase) {
    if (phase === this.lastPhase) return;
    this.lastPhase = phase;
    const playingNow = phase !== "lobby";
    this.engine.setInteractive(playingNow);
    if (!playingNow) { this.pred = null; this.pending = []; }
  }

  private latest(): Entry | null {
    return this.buffer.length ? this.buffer[this.buffer.length - 1] : null;
  }

  /* ---------------------------------------------------------------- predicción */
  private predFrom(np: NetPlayer): Pred {
    return {
      x: np.x, y: np.y, vx: np.vx, vy: np.vy, kbx: np.kbx, grounded: np.grounded, facing: np.facing,
      jumpsLeft: np.jumpsLeft, jumpBufT: np.jumpBufT, hitStunT: np.hitStunT, slowT: np.slowT,
      power: np.power ? { ...np.power } : null,
      input: { left: false, right: false }, jumpEdge: false,
      walkCycle: np.walkCycle, idleT: np.idleT, squash: np.squash, jumpAnticT: np.jumpAnticT,
      attack: np.attack ? { ...np.attack } : null, attackCooldown: np.attackCooldown,
    };
  }

  /** Un tick de predicción. `live` = es el frame de ahora (dispara sonidos/efectos propios). */
  private predictTick(p: Pred, bits: number, map: MapDef, live: boolean) {
    const dt = TICK_MS;
    p.input.left = !!(bits & IN_LEFT);
    p.input.right = !!(bits & IN_RIGHT);
    if (bits & IN_JUMP) p.jumpEdge = true;
    const jump = applyMoveInput(p);
    if (jump.jumped) {
      p.jumpAnticT = 90;
      if (live) { audio.on.jump(p.x, jump.dbl); this.engine.renderer.jumpPuff(p.x, p.y, jump.dbl); }
    }
    if ((bits & (IN_PUNCH | IN_KICK)) && p.attackCooldown <= 0) {
      const type = bits & IN_KICK ? "kick" : "punch";
      const def = ATTACKS[type];
      p.attack = { type, t: def.dur, dur: def.dur };
      p.attackCooldown = def.cooldown * (p.power && p.power.aire ? PHYS.AIR_COOLDOWN_MULT : 1);
      if (live) audio.on.swing(type, p.x);
    }
    const prevFeet = p.y, wasGrounded = p.grounded;
    integrateBody(p, 1);
    if (p.vx !== 0 && wasGrounded) p.walkCycle = (p.walkCycle + dt * 0.0034) % 1;
    p.idleT += dt * 0.001;
    if (p.squash > 0) p.squash = Math.max(0, p.squash - dt * 0.006);
    if (p.jumpAnticT > 0) p.jumpAnticT = Math.max(0, p.jumpAnticT - dt);
    tickMoveTimers(p, dt);
    const landedV = collidePlatforms(p, prevFeet, wasGrounded, map.platforms);
    if (landedV > 5) {
      p.squash = Math.min(1, landedV / 14);
      if (live) { const s = Math.min(1, landedV / 14); this.engine.renderer.landingDust(p.x, p.y, s); audio.on.land(s, p.x); }
    }
    if (p.attack) { p.attack.t -= dt; if (p.attack.t <= 0) p.attack = null; }
    if (p.attackCooldown > 0) p.attackCooldown -= dt;
  }

  private canPredict(e: Entry, np: NetPlayer | undefined): boolean {
    return !!np && np.alive && (e.phase === "fightIntro" || e.phase === "fight" || e.phase === "roundEnd" || e.phase === "final") && np.y < PHYS.H + 40;
  }

  private reconcile(e: Entry) {
    const me = this.myId();
    const np = me !== null ? e.players.get(me) : undefined;
    if (!np || !this.canPredict(e, np)) { this.pred = null; return; }
    // descartar los frames ya aplicados por el servidor
    let i = 0;
    while (i < this.pending.length && this.pending[i][0] <= np.ack) i++;
    if (i) this.pending.splice(0, i);
    const before = this.pred ? { x: this.pred.x, y: this.pred.y } : null;
    const fresh = this.predFrom(np);
    // el ataque propio que ya se está viendo no se "reinicia" por diferencias de un cuadro
    if (this.pred && this.pred.attack && fresh.attack && fresh.attack.type === this.pred.attack.type) fresh.attack = this.pred.attack;
    for (const [, bits] of this.pending) this.predictTick(fresh, bits, e.map, false);
    if (before) {
      const dx = before.x - fresh.x, dy = before.y - fresh.y;
      const err = Math.hypot(dx, dy);
      this.netStats.predErr = this.netStats.predErr * 0.9 + err * 0.1;
      this.netStats.predErrMax = Math.max(this.netStats.predErrMax * 0.995, err);
      if (Math.abs(dx) < 90 && Math.abs(dy) < 90) { this.corrX += dx; this.corrY += dy; }
      else { this.corrX = 0; this.corrY = 0; }
    }
    this.pred = fresh;
  }

  /* ---------------------------------------------------------------- input */
  onInput(slot: Slot, key: InputKey, down: boolean) {
    if (slot.startsWith("gp")) this.lastPad = Number(slot.slice(2));
    if (key === "left" || key === "right") {
      this.held.set(slot + ":" + key, down);
      return;
    }
    if (!down) return;
    if (key === "jump") this.edgeBits |= IN_JUMP;
    else if (key === "punch") this.edgeBits |= IN_PUNCH;
    else if (key === "kick") this.edgeBits |= IN_KICK;
  }

  private heldBits(): number {
    let b = 0;
    for (const [k, v] of this.held) {
      if (!v) continue;
      if (k.endsWith(":left")) b |= IN_LEFT;
      else if (k.endsWith(":right")) b |= IN_RIGHT;
    }
    return b;
  }

  /* ---------------------------------------------------------------- loop */
  update(dt: number) {
    this.fxCtx.damageNumbers = get(settings).damageNumbers;
    this.fxCtx.meId = this.myId();
    const e = this.latest();
    const active = !!e && e.phase !== "lobby" && e.phase !== "final";
    this.acc += dt;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 6) {
      this.acc -= TICK_MS;
      steps++;
      if (!active) { this.edgeBits = 0; continue; }
      const bits = this.heldBits() | this.edgeBits;
      this.edgeBits = 0;
      const seq = ++this.seq;
      this.pending.push([seq, bits]);
      if (this.pending.length > 120) this.pending.shift();
      this.outbox.push([seq, bits]);
      if (this.pred && e) this.predictTick(this.pred, bits, e.map, true);
    }
    if (steps >= 6) this.acc = 0;
    if (this.outbox.length) {
      net.send({ t: "in", f: this.outbox.slice(-12) });
      this.outbox = [];
    }
    // la corrección de predicción se disuelve en ~80 ms
    const k = Math.exp(-dt / 45);
    this.corrX *= k; this.corrY *= k;
    if (Math.abs(this.corrX) < 0.05) this.corrX = 0;
    if (Math.abs(this.corrY) < 0.05) this.corrY = 0;

    // eventos: se reproducen cuando se ve el snapshot que los trajo
    this.renderNow = performance.now();
    const renderT = this.renderNow + this.offset - INTERP_DELAY_MS;
    while (this.events.length && (Number.isNaN(this.offset) || this.events[0].n * TICK_MS <= renderT + 8)) {
      playSimEvent(this.events.shift()!.e, this.engine.renderer, this.fxCtx);
    }
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);

    this.hudT -= dt;
    if (this.hudT <= 0) { this.hudT = 100; this.pushHud(); }
    const last = this.latest();
    this.netStats.bufferMs = last && !Number.isNaN(this.offset) ? Math.round(last.n * TICK_MS - renderT) : 0;
    this.netStats.pending = this.pending.length;
  }

  private pushHud() {
    const e = this.latest();
    const r = get(room);
    const ids = e ? e.roster : r.players.map((p) => p.id);
    const players: HudPlayer[] = ids.map((id) => ({
      id, color: this.colorFor(id), name: this.nameFor(id),
      alive: !e || e.phase === "lobby" || !!e.players.get(id)?.alive,
      score: e ? e.scores[id] || 0 : 0, isMe: id === r.myId,
    }));
    let clock: string | null = null;
    if (e && e.gameMode === "orbking" && (e.phase === "fight" || e.phase === "fightIntro")) {
      const total = Math.max(0, Math.ceil(e.orbkingTimer / 1000));
      clock = Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    }
    const showEnd = !!e && e.phase !== "final" && r.mode === "infinite" && net.isOwner();
    hud.set({
      label: t("hud.room"), code: r.code, endLabel: showEnd ? t("hud.endMatch") : null, players,
      showScores: r.mode === "wins" || r.mode === "rounds" || r.mode === "infinite", clock, ping: get(ping), timer: null,
    });
  }

  view(): RenderView | null {
    const e = this.latest();
    if (!e || e.phase === "lobby") return null;
    const renderT = this.renderNow + this.offset - INTERP_DELAY_MS;
    // snapshots a y b alrededor del tiempo de render
    let a = this.buffer[0], b = this.buffer[0];
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].n * TICK_MS <= renderT) { a = this.buffer[i]; b = this.buffer[Math.min(i + 1, this.buffer.length - 1)]; break; }
    }
    const span = (b.n - a.n) * TICK_MS;
    const f = span > 0 ? Math.max(0, Math.min(1, (renderT - a.n * TICK_MS) / span)) : 1;
    const me = this.myId();
    const players: RenderPlayer[] = [];
    for (const id of b.roster) {
      const pb = b.players.get(id);
      if (!pb) continue;
      if (id === me && this.pred && pb.alive) {
        const p = this.pred;
        players.push({
          ...pb, x: p.x + this.corrX, y: p.y + this.corrY, vx: p.vx, vy: p.vy, facing: p.facing, grounded: p.grounded,
          walkCycle: p.walkCycle, idleT: p.idleT, squash: p.squash, jumpAnticT: p.jumpAnticT, attack: p.attack,
        });
        continue;
      }
      const pa = a.players.get(id);
      if (!pa || pa.alive !== pb.alive || Math.abs(pa.x - pb.x) > 120 || Math.abs(pa.y - pb.y) > 160) { players.push({ ...pb }); continue; }
      const L = (x: number, y: number) => x + (y - x) * f;
      const near = f < 0.5 ? pa : pb;
      let attack = near.attack;
      if (pa.attack && pb.attack && pa.attack.type === pb.attack.type && pb.attack.t <= pa.attack.t) attack = { ...pb.attack, t: L(pa.attack.t, pb.attack.t) };
      players.push({
        ...near,
        x: L(pa.x, pb.x), y: L(pa.y, pb.y), vx: L(pa.vx, pb.vx), vy: L(pa.vy, pb.vy),
        walkCycle: wrapLerp(pa.walkCycle, pb.walkCycle, f), idleT: L(pa.idleT, pb.idleT), squash: L(pa.squash, pb.squash),
        hitStunT: L(pa.hitStunT, pb.hitStunT), deathFadeT: L(pa.deathFadeT, pb.deathFadeT), burnFlashT: L(pa.burnFlashT, pb.burnFlashT),
        jumpAnticT: L(pa.jumpAnticT, pb.jumpAnticT), attack,
      });
    }
    const orb = b.orb && a.orb ? { ...b.orb, bornT: a.orb.bornT + (b.orb.bornT - a.orb.bornT) * f } : b.orb;
    return {
      map: b.map,
      players,
      orb,
      hill: b.hill,
      portal: null,
      voidHole: null,
      phase: e.phase,
      gameMode: e.gameMode,
      scores: e.scores,
      meId: me,
      timeMs: this.renderNow,
      nameFor: (id) => this.nameFor(id),
      colorFor: (id) => this.colorFor(id),
      hatFor: (id) => this.hatFor(id),
      maxHpFor: () => 100,
    };
  }

  dispose() {
    this.unsub();
    this.engine.renderer.resetPlayers();
    banner.set(null);
    hideScoreReveal();
    hideFinal();
  }
}

export { POWER_COLORS };
