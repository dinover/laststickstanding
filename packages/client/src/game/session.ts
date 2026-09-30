/* Sesiones de juego. Una sesión = un modo en curso (práctica, campañas, local, online, o el
   "attract mode" de fondo del menú). El motor le da tiempo y la dibuja; la sesión decide todo lo
   demás. SimSession es la base de todos los modos donde la simulación corre en el navegador. */

import {
  BotAI, PLAYER_COLORS, Sim, TICK_MS, type InputKey, type PhaseInfo, type SimEvent,
} from "@lss/shared";
import { get } from "svelte/store";
import type { RenderView } from "../render/renderer";
import type { RenderPlayer } from "../render/art/stickman";
import { playSimEvent, type FxContext } from "./fx";
import type { Engine } from "./engine";
import type { Slot } from "./input";
import { settings } from "../app/persist";
import { hud, type HudPlayer, type HudState } from "../app/ui";

export interface Session {
  readonly kind: string;
  /** true = el motor muestra el HUD y captura input de juego. */
  readonly interactive: boolean;
  update(dt: number): void;
  view(): RenderView | null;
  onInput(slot: Slot, key: InputKey, down: boolean): void;
  dispose(): void;
}

const MAX_STEPS_PER_FRAME = 8;

export abstract class SimSession implements Session {
  abstract readonly kind: string;
  readonly interactive: boolean = true;
  readonly sim: Sim;
  readonly bots: BotAI;
  names: Record<number, string> = {};
  colors: Record<number, string> = {};
  hats: Record<number, string> = {};
  meId: number | null = null;
  paused = false;
  /** Tiempo de sim acumulado (cronómetros de las campañas). */
  simTimeMs = 0;

  protected acc = 0;
  private hitStopMs = 0;
  private prev = new Map<number, { x: number; y: number }>();
  private alpha = 0;
  private hudT = 0;
  protected fxCtx: FxContext;

  constructor(protected engine: Engine) {
    this.sim = new Sim({
      onPhase: (info) => this.onPhase(info),
      onPortalEnter: () => this.onPortalEnter(),
      onVoidEnter: () => this.onVoidEnter(),
    });
    this.bots = new BotAI(this.sim);
    this.fxCtx = {
      colorFor: (id) => this.colorFor(id),
      meId: null,
      skipOwnPredicted: false,
      damageNumbers: get(settings).damageNumbers,
      rumble: (id, s, ms) => this.rumbleFor(id, s, ms),
      hitStop: (ms) => { this.hitStopMs = Math.max(this.hitStopMs, Math.min(60, ms * 0.8)); },
    };
  }

  colorFor(id: number): string {
    return this.colors[id] || PLAYER_COLORS[id % PLAYER_COLORS.length];
  }

  nameFor(id: number): string {
    return this.names[id] || "P" + (id + 1);
  }

  hatFor(id: number): string {
    return this.hats[id] || "none";
  }

  protected onPhase(_info: PhaseInfo): void {}
  protected onPortalEnter(): void {}
  protected onVoidEnter(): void {}
  /** Lógica del modo que corre antes de cada paso de sim (IA de bots, pulsos de poder...). */
  protected preStep(_dt: number): void {}
  /** Después de cada paso (chequear victoria/derrota...). */
  protected postStep(_dt: number): void {}
  protected onSimEvent(_e: SimEvent): void {}
  protected rumbleFor(_id: number, _s: number, _ms: number): void {}
  /** Si devuelve true, la sim no avanza (mensajes de historia en pantalla, pausa). */
  protected frozen(): boolean { return this.paused; }

  abstract onInput(slot: Slot, key: InputKey, down: boolean): void;

  /** La pelea de fondo del menú no muestra números de daño. */
  protected showDamageNumbers = true;

  update(dt: number) {
    this.fxCtx.damageNumbers = this.showDamageNumbers && get(settings).damageNumbers;
    this.fxCtx.meId = this.meId;
    if (this.frozen()) { this.alpha = 1; return; }
    if (this.hitStopMs > 0) {
      this.hitStopMs = Math.max(0, this.hitStopMs - dt);
      return;
    }
    this.acc += dt;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.prev.clear();
      for (const id of this.sim.activeIds()) {
        const p = this.sim.players[id];
        if (p) this.prev.set(id, { x: p.x, y: p.y });
      }
      this.preStep(TICK_MS);
      this.sim.step(TICK_MS);
      this.simTimeMs += TICK_MS;
      for (const e of this.sim.drainEvents()) {
        playSimEvent(e, this.engine.renderer, this.fxCtx);
        this.onSimEvent(e);
      }
      this.postStep(TICK_MS);
      this.acc -= TICK_MS;
      steps++;
      if (this.hitStopMs > 0) { this.acc = 0; break; }
    }
    if (steps >= MAX_STEPS_PER_FRAME) this.acc = 0; // la pestaña estuvo congelada: no recuperar el atraso
    this.alpha = Math.max(0, Math.min(1, this.acc / TICK_MS));
    this.hudT -= dt;
    if (this.hudT <= 0) { this.hudT = 100; this.pushHud(); }
  }

  /** Datos del HUD (lo pisa cada modo para el rótulo y los botones). */
  protected hudBase(): Partial<HudState> {
    return {};
  }

  protected pushHud() {
    const players: HudPlayer[] = this.sim.roster.map((id) => ({
      id, color: this.colorFor(id), name: this.nameFor(id),
      alive: !!this.sim.players[id]?.alive || this.sim.phase === "lobby",
      score: this.sim.scores[id] || 0, isMe: id === this.meId,
    }));
    const base = this.hudBase();
    let clock: string | null = null;
    if (this.sim.gameMode === "orbking" && (this.sim.phase === "fight" || this.sim.phase === "fightIntro")) {
      const total = Math.max(0, Math.ceil(this.sim.orbkingTimer / 1000));
      clock = Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    }
    hud.set({
      label: base.label || "", code: base.code ?? null, endLabel: base.endLabel ?? null,
      players, showScores: base.showScores ?? false, clock, ping: null, timer: base.timer ?? null,
    });
  }

  view(): RenderView {
    const a = this.alpha;
    const players: RenderPlayer[] = [];
    for (const id of this.sim.activeIds()) {
      const p = this.sim.players[id];
      if (!p) continue;
      const pr = this.prev.get(id);
      let x = p.x, y = p.y;
      if (pr && Math.abs(pr.x - p.x) < 80 && Math.abs(pr.y - p.y) < 80) {
        x = pr.x + (p.x - pr.x) * a;
        y = pr.y + (p.y - pr.y) * a;
      }
      players.push({ ...p, x, y });
    }
    const s = this.sim;
    return {
      map: s.currentMap,
      players,
      orb: s.orb,
      hill: s.hill,
      portal: s.portal,
      voidHole: s.voidHole,
      phase: s.phase,
      gameMode: s.gameMode,
      scores: s.scores,
      meId: this.meId,
      timeMs: performance.now(),
      nameFor: (id) => this.nameFor(id),
      colorFor: (id) => this.colorFor(id),
      hatFor: (id) => this.hatFor(id),
      maxHpFor: (id) => s.maxHp(id),
    };
  }

  dispose() {
    this.engine.renderer.resetPlayers();
  }
}
